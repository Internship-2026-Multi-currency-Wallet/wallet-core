import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import { DependencyStatus, type Health } from './health.model.js';
import { HealthService } from './health.service.js';

// Probes must never be refused, whatever the path spelling (`/health/`).
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness/readiness probe: 200 when all dependencies are up, 503 otherwise. */
  @Public()
  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<Health & { status: string }> {
    const health = await this.health.check();
    const ok = health.db === DependencyStatus.UP && health.redis === DependencyStatus.UP;
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', ...health };
  }
}
