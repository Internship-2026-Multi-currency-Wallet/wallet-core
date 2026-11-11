import { type ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { EMAIL_QUEUE } from '../src/email/queued-email.service.js';

const sharedRedisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Relays to the shared Redis until `silence()`; from then on it accepts connections without
 * replying. Records when each connection was opened.
 */
class Endpoint {
  readonly openedAt: number[] = [];
  private silent: boolean;
  private readonly sockets = new Set<Socket>();
  private constructor(
    private readonly server: Server,
    silent: boolean,
  ) {
    this.silent = silent;
  }

  static async start(silent: boolean): Promise<Endpoint> {
    const { hostname, port } = new URL(sharedRedisUrl);
    const endpoint: Endpoint = new Endpoint(
      createServer((client) => {
        endpoint.openedAt.push(Date.now());
        endpoint.track(client);
        if (endpoint.silent) return;
        const upstream = endpoint.track(connect({ host: hostname, port: Number(port || 6379) }));
        client.on('data', (data) => endpoint.silent || upstream.write(data));
        upstream.on('data', (data) => endpoint.silent || client.write(data));
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      }),
      silent,
    );
    endpoint.server.listen(0, '127.0.0.1');
    await once(endpoint.server, 'listening');
    return endpoint;
  }

  get url(): string {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    return `redis://127.0.0.1:${address.port}`;
  }

  silence(): void {
    this.silent = true;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private track(socket: Socket): Socket {
    this.sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => this.sockets.delete(socket));
    return socket;
  }
}

type Observed = {
  hookMs: number;
  exitMs: number | undefined;
  exitCode: number | null;
  connectionsAfterShutdown: number;
  drained: boolean;
  output: string;
  stderr: string;
  queue: Queue;
};

/**
 * A child process, not the Jest process: only a real exit shows that nothing (a reconnect, a retry
 * timer, a socket) outlived the shutdown.
 */
describe('EmailWorker shutdown (e2e, real BullMQ in a child process)', () => {
  // Each scenario gets its own queue prefix `<run>-<n>`, so it only sees its own jobs.
  const run = `e2e-worker-shutdown-${process.pid}-${Date.now()}`;
  let scenarios = 0;
  const children = new Set<ChildProcess>();
  const endpoints = new Set<Endpoint>();
  const queues = new Set<Queue>();
  let direct: Redis;

  beforeAll(() => {
    direct = new Redis(sharedRedisUrl);
  });

  afterAll(async () => {
    // Every cleanup runs; the first failure is reported.
    const cleanups = [
      ...[...children].map((child) => () => void child.kill('SIGKILL')),
      ...[...endpoints].map((endpoint) => () => endpoint.stop()),
      ...[...queues].map((queue) => () => queue.close()),
      async () => {
        for await (const keys of direct.scanStream({ match: `${run}-*`, count: 200 })) {
          if ((keys as string[]).length > 0) await direct.del(...(keys as string[]));
        }
      },
      () => direct.quit(),
    ];
    let failure: Error | undefined;
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (err) {
        failure ??= err instanceof Error ? err : new Error(String(err));
      }
    }
    if (failure) throw failure;
  });

  async function scenario(opts: {
    silentFromStart?: boolean;
    sendMs?: number;
    activeJob?: boolean;
    loseRedisFor?: number;
    shutdownOnActive?: boolean;
  }): Promise<Observed> {
    const prefix = `${run}-${++scenarios}`;
    const queue = new Queue(EMAIL_QUEUE, { prefix, connection: direct });
    queues.add(queue);
    const endpoint = await Endpoint.start(opts.silentFromStart ?? false);
    endpoints.add(endpoint);
    const child = fork(
      new URL('./email-worker-process.ts', import.meta.url),
      [endpoint.url, prefix, String(opts.sendMs ?? 0), opts.shutdownOnActive ? 'active' : ''],
      {
        execArgv: ['--import', new URL('./ts-hooks.mjs', import.meta.url).href],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    children.add(child);
    let output = '';
    let stderr = '';
    child.stdout?.on('data', (data: Buffer) => (output += data.toString()));
    child.stderr?.on('data', (data: Buffer) => (stderr += data.toString()));
    let exitAt: number | undefined;
    const exited = once(child, 'exit').then(([code]) => {
      exitAt = Date.now();
      return code as number | null;
    });
    // 'close' comes after 'exit', once stdout and stderr have been fully read.
    const streamsClosed = once(child, 'close');
    const message = (type: string) =>
      new Promise<{ ms?: number }>((resolve) =>
        child.on('message', (m: { type: string; ms?: number }) => m.type === type && resolve(m)),
      );

    if (opts.silentFromStart) {
      await sleep(2000);
    } else {
      await message('ready');
      await sleep(500); // the blocking connection is waiting for jobs
    }
    const closed = message('closed');
    if (opts.activeJob) {
      const sending = message('sending');
      await queue.add('email', {
        template: 'passwordChanged',
        to: `${prefix}@example.com`,
        data: {},
      });
      await sending;
    }
    if (opts.loseRedisFor) {
      endpoint.silence();
      await sleep(opts.loseRedisFor);
    }

    if (!opts.shutdownOnActive) child.send('shutdown');
    const { ms } = await closed;
    const closedAt = Date.now();
    // Long enough for BullMQ's reconnects and retry delays to show if they survived the shutdown.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => (timer = setTimeout(resolve, 15_000)));
    const exitCode = await Promise.race([exited, deadline.then(() => null)]);
    const drained = await Promise.race([
      streamsClosed.then(() => true),
      deadline.then(() => false),
    ]);
    clearTimeout(timer);
    const connectionsAfterShutdown = endpoint.openedAt.filter((t) => t > closedAt).length;
    return {
      hookMs: ms!,
      exitMs: exitAt && exitAt - closedAt,
      exitCode,
      connectionsAfterShutdown,
      drained,
      output,
      stderr,
      queue,
    };
  }

  const expectCleanExit = (observed: Observed, exitWithinMs: number) => {
    expect(observed.connectionsAfterShutdown).toBe(0);
    expect(observed.drained).toBe(true);
    // stdout carries only what the child reports after shutdown; stderr covers its whole life.
    expect(observed.output).toBe('');
    expect(observed.stderr).not.toMatch(/error|unhandled|exception/i);
    expect(observed.exitCode).toBe(0);
    expect(observed.exitMs).toBeLessThan(exitWithinMs);
  };

  it('cold start: Redis never answered', async () => {
    const observed = await scenario({ silentFromStart: true });
    expect(observed.hookMs).toBeLessThan(1500);
    expectCleanExit(observed, 5000);
  }, 30_000);

  it('idle worker with Redis up', async () => {
    const observed = await scenario({});
    expect(observed.hookMs).toBeLessThan(1500);
    expectCleanExit(observed, 5000);
  }, 30_000);

  it('idle worker after Redis stopped answering', async () => {
    // Longer than BullMQ's blocking-wait watchdog (drainDelay + 1 s), whose reset path reconnects.
    const observed = await scenario({ loseRedisFor: 7000 });
    expect(observed.hookMs).toBeLessThan(1500);
    expectCleanExit(observed, 5000);
  }, 40_000);

  it('active send that finishes within the grace period is recorded as completed', async () => {
    const observed = await scenario({ activeJob: true, sendMs: 1000 });
    expect(observed.hookMs).toBeLessThan(2500);
    expectCleanExit(observed, 5000);
    expect(await observed.queue.getJobCounts('completed', 'active')).toEqual({
      completed: 1,
      active: 0,
    });
  }, 30_000);

  it('shutdown between job acquisition and processor entry waits for the send', async () => {
    const observed = await scenario({ activeJob: true, sendMs: 1000, shutdownOnActive: true });
    expect(observed.hookMs).toBeGreaterThanOrEqual(900);
    expect(observed.hookMs).toBeLessThan(2500);
    expectCleanExit(observed, 5000);
    expect(await observed.queue.getJobCounts('completed', 'active')).toEqual({
      completed: 1,
      active: 0,
    });
  }, 30_000);

  it('active send longer than the grace period: closed by force, the job stays active', async () => {
    const observed = await scenario({ activeJob: true, sendMs: 6000 });
    expect(observed.hookMs).toBeGreaterThanOrEqual(2900);
    expect(observed.hookMs).toBeLessThan(5000);
    // close(true) does not cancel the send; the process exits once the send's own work ends.
    expectCleanExit(observed, 5000);
    // Not recorded: BullMQ's stalled check requeues it once the lock expires.
    expect(await observed.queue.getJobCounts('active')).toEqual({ active: 1 });
  }, 30_000);

  it('active send after Redis stopped answering', async () => {
    // The send outlasts the outage and the grace period.
    const observed = await scenario({ activeJob: true, sendMs: 12_000, loseRedisFor: 7000 });
    expect(observed.hookMs).toBeGreaterThanOrEqual(2900);
    expect(observed.hookMs).toBeLessThan(5000);
    expectCleanExit(observed, 5000);
  }, 50_000);
});
