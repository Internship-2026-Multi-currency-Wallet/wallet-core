import { Module } from '@nestjs/common';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import { DiscoveryModule } from '@nestjs/core';
import { ApolloDriver } from '@nestjs/apollo';
import { ArgsType, Args, Field, GraphQLModule, Query, Resolver } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import { graphqlOptions } from '../graphql/graphql.config.js';
import { ClientFeature } from './client-availability.decorator.js';
import { ClientAvailabilityValidator } from './client-availability.validator.js';
import { restrictClientFields } from './client-field-availability.js';

/**
 * Kept in a file of its own: `TypeMetadataStorage` is process-wide, so an `@ArgsType` class defined
 * here would be seen by every other application booted in the same file.
 *
 * Nest flattens an `@ArgsType` into the field's arguments and drops the property extensions on the
 * way, so a restriction there would silently do nothing. The validator rejects it.
 */
@ArgsType()
class SearchArgs {
  @ClientFeature('wisla')
  @Field(() => String, { nullable: true })
  secret?: string | null;
}

@ClientFeature('wisla')
@ArgsType()
class FilterArgs {
  @Field(() => String, { nullable: true })
  by?: string | null;
}

@Resolver()
class SearchQueries {
  @Query(() => String, { nullable: true })
  search(@Args() args: SearchArgs): string | null {
    return args.secret ?? null;
  }

  @Query(() => String, { nullable: true })
  filter(@Args() args: FilterArgs): string | null {
    return args.by ?? null;
  }
}

describe('a restriction on an @ArgsType property', () => {
  it('stops the application at startup, for a restricted property and a restricted class, because neither would be enforced', async () => {
    const config = AppConfig.fromEnv({ NODE_ENV: 'test', CLIENT: 'kvitka' });
    const base = graphqlOptions(config, { setContext: () => undefined } as unknown as PinoLogger);

    @Module({
      imports: [
        DiscoveryModule,
        GraphQLModule.forRoot<ApolloDriverConfig>({
          ...base,
          driver: ApolloDriver,
          autoSchemaFile: true,
          transformSchema: restrictClientFields('kvitka'),
        }),
      ],
      providers: [
        SearchQueries,
        ClientAvailabilityValidator,
        { provide: PinoLogger, useValue: { setContext: () => undefined, error: () => undefined } },
      ],
    })
    class TestModule {}

    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    try {
      const error = await app.init().then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );
      expect(error?.message).toContain(
        'SearchArgs.secret: client availability is not supported on an @ArgsType property',
      );
      expect(error?.message).toContain(
        'FilterArgs: client availability is not supported on an @ArgsType class',
      );
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});
