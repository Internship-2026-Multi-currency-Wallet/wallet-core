import { Query, Resolver } from '@nestjs/graphql';
import { Public } from '../auth/public.decorator.js';
import { Health } from './health.model.js';
import { HealthService } from './health.service.js';

@Resolver(() => Health)
export class HealthResolver {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Query(() => Health, { description: 'Service health. Does not require authentication.' })
  health(): Promise<Health> {
    return this.healthService.check();
  }
}
