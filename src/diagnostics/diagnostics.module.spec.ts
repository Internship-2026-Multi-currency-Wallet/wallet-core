import { jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import type { AuthUser } from '../auth/auth-user.js';
import type { AppConfig } from '../config/app-config.js';
import type { EventPublisher, EventSubscriber, Unsubscribe } from '../events/event-bus.js';
import { DiagnosticsController, DiagnosticsModule } from './diagnostics.module.js';

function fakeLogger() {
  return { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
}

const user = { id: 'u1' } as AuthUser;
const config = { serviceName: 'wallet-core' } as AppConfig;
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('DiagnosticsController.ping', () => {
  it('answers 503 and logs a safe reason when publishing fails', async () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:6379'), {
      code: 'ECONNREFUSED',
    });
    const publisher = { publish: jest.fn(() => Promise.reject(error)) };
    const logger = fakeLogger();
    const controller = new DiagnosticsController(
      publisher as unknown as EventPublisher,
      config,
      logger as unknown as PinoLogger,
    );

    await expect(controller.ping(user)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(logger.warn).toHaveBeenCalledWith(
      { userId: 'u1', reason: 'ECONNREFUSED' },
      'system.ping publication failed or timed out',
    );
  });
});

describe('DiagnosticsModule', () => {
  it('does not block startup on the subscription and unsubscribes once it completed', async () => {
    let confirm!: (off: Unsubscribe) => void;
    const subscriber = {
      subscribe: jest.fn(() => new Promise<Unsubscribe>((resolve) => (confirm = resolve))),
    };
    const module = new DiagnosticsModule(
      subscriber as unknown as EventSubscriber,
      fakeLogger() as unknown as PinoLogger,
    );

    expect(module.onModuleInit()).toBeUndefined(); // returns at once, Redis still down
    const off = jest.fn(() => Promise.resolve());
    confirm(off);
    await tick();
    module.onModuleDestroy();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('logs a failed subscription instead of crashing', async () => {
    const subscriber = {
      subscribe: jest.fn(() =>
        Promise.reject(Object.assign(new Error('x'), { name: 'ReplyError', message: 'NOPERM x' })),
      ),
    };
    const logger = fakeLogger();
    new DiagnosticsModule(
      subscriber as unknown as EventSubscriber,
      logger as unknown as PinoLogger,
    ).onModuleInit();
    await tick();
    expect(logger.warn).toHaveBeenCalledWith({ reason: 'NOPERM' }, expect.any(String));
  });

  it('finishes destruction while UNSUBSCRIBE is pending and handles its later rejection', async () => {
    let fail!: (error: unknown) => void;
    const off = jest.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    const subscriber = { subscribe: jest.fn(() => Promise.resolve<Unsubscribe>(off)) };
    const logger = fakeLogger();
    const module = new DiagnosticsModule(
      subscriber as unknown as EventSubscriber,
      logger as unknown as PinoLogger,
    );
    module.onModuleInit();
    await tick();

    expect(module.onModuleDestroy()).toBeUndefined(); // returns although UNSUBSCRIBE is pending
    expect(off).toHaveBeenCalledTimes(1);
    fail(new Error('Connection is closed.'));
    await tick();
    expect(logger.debug).toHaveBeenCalledWith({ reason: 'Error' }, expect.any(String));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('cancels a subscription that completes during shutdown', async () => {
    let confirm!: (off: Unsubscribe) => void;
    const subscriber = {
      subscribe: jest.fn(() => new Promise<Unsubscribe>((resolve) => (confirm = resolve))),
    };
    const module = new DiagnosticsModule(
      subscriber as unknown as EventSubscriber,
      fakeLogger() as unknown as PinoLogger,
    );
    module.onModuleInit();
    module.onModuleDestroy();
    const off = jest.fn(() => Promise.resolve());
    confirm(off);
    await tick();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
