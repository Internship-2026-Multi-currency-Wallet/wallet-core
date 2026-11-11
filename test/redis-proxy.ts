import { createServer, type Server, type Socket, connect } from 'node:net';

/**
 * Isolates outages from shared Redis; assumes plain Redis without authentication on DB 0.
 */
export class RedisProxy {
  private server?: Server;
  private readonly sockets = new Set<Socket>();

  private constructor(
    readonly port: number,
    private readonly target: { host: string; port: number },
  ) {}

  /** Picks a free port and releases it, so another process could take it before `start()`. */
  static async reserve(targetUrl: string): Promise<RedisProxy> {
    const { hostname, port } = new URL(targetUrl);
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    await new Promise((resolve) => probe.close(resolve));
    if (!address || typeof address === 'string') throw new Error('no port');
    return new RedisProxy(address.port, { host: hostname, port: Number(port || 6379) });
  }

  get url(): string {
    return `redis://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((client) => {
      const upstream = connect(this.target);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(this.port, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await closed;
  }
}
