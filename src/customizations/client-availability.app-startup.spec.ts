import { Injectable, Module, type Type } from '@nestjs/common';
import { Field, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module.js';
import { Public } from '../auth/public.decorator.js';
import { AppConfig } from '../config/app-config.js';
import type { ClientCode } from '../config/env.schema.js';
import { EventSubscriber } from '../events/event-bus.js';
import { ClientFeature } from './client-availability.decorator.js';

/**
 * GraphQL type metadata is process-wide, so these invalid fixtures need a file of their own.
 */

/** Invalid: a restriction on a service method, which is not an endpoint (the validator). */
@Injectable()
class RestrictedService {
  @ClientFeature('wisla')
  run(): string {
    return 'ran';
  }
}

@Module({ providers: [RestrictedService] })
class RestrictedServiceModule {}

/** Invalid: a restricted NON-NULL field (the schema transform). */
@ObjectType()
class NonNullRestricted {
  @ClientFeature('wisla')
  @Field(() => String)
  secret!: string;
}

@Resolver()
class NonNullRestrictedQueries {
  @Public()
  @Query(() => NonNullRestricted)
  nonNullRestricted(): NonNullRestricted {
    return { secret: 'x' };
  }
}

@Module({ providers: [NonNullRestrictedQueries] })
class NonNullRestrictedModule {}

async function initError(client: ClientCode, fixture: Type): Promise<Error | undefined> {
  const config = AppConfig.fromEnv({
    NODE_ENV: 'production',
    BACKOFFICE_URL: 'https://bo.example.com',
    APP_ENV: 'local',
    CLIENT: client,
    JWT_SECRET: 'availability-spec-test-only-secret-0123456789',
    LOG_LEVEL: 'silent',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule, fixture] })
    .overrideProvider(AppConfig)
    .useValue(config)
    .overrideProvider(EventSubscriber)
    .useValue({ subscribe: () => Promise.resolve(() => Promise.resolve()), close: () => undefined })
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  try {
    return await app.init().then(
      () => undefined,
      (reason: unknown) => reason as Error,
    );
  } finally {
    await app.close().catch(() => undefined);
  }
}

describe.each(['demo', 'kvitka', 'wisla'] as const)(
  'startup validation on the real AppModule, CLIENT=%s',
  (client) => {
    it('fails startup for a restriction on a service (ClientAvailabilityValidator)', async () => {
      const error = await initError(client, RestrictedServiceModule);
      expect(error?.message).toContain('Invalid client availability (');
      expect(error?.message).toContain('RestrictedService');
    });

    it('fails startup for a restricted non-null field (restrictClientFields)', async () => {
      const error = await initError(client, NonNullRestrictedModule);
      expect(error?.message).toContain('Invalid client availability on GraphQL fields');
      expect(error?.message).toContain(
        'NonNullRestricted.secret: a restricted field must be nullable',
      );
    });
  },
);
