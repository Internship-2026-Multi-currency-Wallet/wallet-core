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

  /** Redis-only outages must not trigger restarts because clients reconnect automatically. */
  @Public()
  @Get()
  async get(@Res({ passthrough: true }) res: Response): Promise<Health & { status: string }> {
    const health = await this.health.check();
    const dbUp = health.db === DependencyStatus.UP;
    const ok = dbUp && health.redis === DependencyStatus.UP;
    res.status(dbUp ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', ...health };
  }
}
