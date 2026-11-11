import { jest } from '@jest/globals';
import type { Response } from 'express';
import { HealthController } from './health.controller.js';
import { DependencyStatus, type Health } from './health.model.js';
import type { HealthService } from './health.service.js';

const identity = { service: 'wallet-core', version: '0.0.0', appEnv: 'local', client: 'demo' };

async function probe(db: DependencyStatus, redis: DependencyStatus) {
  const health: Health = { ...identity, db, redis };
  const service = { check: jest.fn(() => Promise.resolve(health)) };
  const res = { status: jest.fn() };
  const body = await new HealthController(service as unknown as HealthService).get(
    res as unknown as Response,
  );
  return { code: res.status.mock.calls[0]?.[0], body };
}

describe('HealthController', () => {
  const { UP, DOWN } = DependencyStatus;

  it('200 ok when everything is up', async () => {
    await expect(probe(UP, UP)).resolves.toMatchObject({ code: 200, body: { status: 'ok' } });
  });

  it('200 degraded when only Redis is down', async () => {
    await expect(probe(UP, DOWN)).resolves.toMatchObject({
      code: 200,
      body: { status: 'degraded', db: 'UP', redis: 'DOWN' },
    });
  });

  it.each([
    [DOWN, UP],
    [DOWN, DOWN],
  ])('503 when the database is down (db=%s, redis=%s)', async (db, redis) => {
    await expect(probe(db, redis)).resolves.toMatchObject({
      code: 503,
      body: { status: 'degraded', db: 'DOWN' },
    });
  });
});
