import { runInNewContext } from 'node:vm';
import { Controller, Get, Injectable, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { PinoLogger } from 'nestjs-pino';
import 'reflect-metadata';
import {
  CLIENT_DISABLED_KEY,
  CLIENT_FEATURE_KEY,
  ClientDisabled,
  ClientFeature,
} from './client-availability.decorator.js';
import { ClientAvailabilityValidator } from './client-availability.validator.js';

/**
 * Startup validation of class- and method-level availability metadata, on a Nest application
 * without GraphQL (so no schema: the checks that need the built schema are in
 * `client-field-availability.integration.spec.ts`).
 */

const SECRET = 'sk_live_AbC123xyz789';

const logger = { setContext: jest.fn(), error: jest.fn() };

async function validatorFor(options: {
  providers?: Type[];
  controllers?: Type[];
}): Promise<ClientAvailabilityValidator> {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers: options.controllers ?? [],
    providers: [
      ...(options.providers ?? []),
      ClientAvailabilityValidator,
      { provide: PinoLogger, useValue: logger },
    ],
  }).compile();
  return moduleRef.get(ClientAvailabilityValidator);
}

beforeEach(() => {
  logger.error.mockClear();
});

describe('ClientAvailabilityValidator', () => {
  describe('a valid configuration', () => {
    @Resolver()
    @ClientFeature('wisla')
    class WislaQueries {
      @Query(() => String)
      one(): string {
        return 'one';
      }

      @ClientDisabled('demo')
      @Mutation(() => String)
      two(): string {
        return 'two';
      }
    }

    @Resolver()
    class FieldResolvers {
      @ClientFeature('wisla')
      @ResolveField(() => String, { nullable: true })
      restricted(@Parent() parent: unknown): string {
        return String(parent);
      }
    }

    @Controller('plain')
    class PlainController {
      @Get()
      get(): string {
        return 'x';
      }
    }

    @Injectable()
    class PlainService {}

    it('reports nothing for restricted root endpoints, restricted field resolvers and clean controllers and services', async () => {
      const validator = await validatorFor({
        providers: [WislaQueries, FieldResolvers, PlainService],
        controllers: [PlainController],
      });
      expect(validator.check()).toEqual([]);
      expect(() => validator.onApplicationBootstrap()).not.toThrow();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('allows a client-only resolver whose root endpoint AND field resolver are each restricted by method', async () => {
      @Resolver()
      class ClientOnlyResolver {
        @ClientFeature('wisla')
        @Query(() => String)
        wislaQuery(): string {
          return 'q';
        }

        @ClientFeature('wisla')
        @ResolveField(() => String, { nullable: true })
        wislaField(@Parent() parent: unknown): string {
          return String(parent);
        }
      }
      const validator = await validatorFor({ providers: [ClientOnlyResolver] });
      expect(validator.check()).toEqual([]);
    });

    it('allows a class-level restriction on a resolver that has root endpoints only', async () => {
      const validator = await validatorFor({ providers: [WislaQueries] });
      expect(validator.check()).toEqual([]);
    });

    it('is a pure check: it can be repeated with the same answer', async () => {
      @Controller('twice')
      @ClientFeature('wisla')
      class Twice {}
      const validator = await validatorFor({ controllers: [Twice] });
      expect(validator.check()).toEqual(validator.check());
      expect(validator.check()).toHaveLength(1);
    });
  });

  describe('HTTP controllers (the feature is GraphQL-only)', () => {
    @Controller('class-level')
    @ClientFeature('wisla')
    class ClassLevel {
      @Get()
      get(): string {
        return 'x';
      }
    }

    @Controller('method-level')
    class MethodLevel {
      @ClientDisabled('demo')
      @Get()
      get(): string {
        return 'x';
      }
    }

    it('rejects a restriction on the class and on a method', async () => {
      const validator = await validatorFor({ controllers: [ClassLevel, MethodLevel] });
      expect(validator.check()).toEqual([
        'ClassLevel: client availability is GraphQL-only; remove @ClientFeature/@ClientDisabled from this HTTP controller',
        'MethodLevel: client availability is GraphQL-only; remove @ClientFeature/@ClientDisabled from this HTTP controller',
      ]);
    });

    it('rejects a restriction that is inherited from a base class', async () => {
      @Controller('derived')
      class Derived extends ClassLevel {}
      const validator = await validatorFor({ controllers: [Derived] });
      expect(validator.check()).toEqual([
        'Derived: client availability is GraphQL-only; remove @ClientFeature/@ClientDisabled from this HTTP controller',
      ]);
    });
  });

  describe('providers that are not resolvers', () => {
    @Injectable()
    @ClientFeature('wisla')
    class RestrictedService {}

    @Injectable()
    class MethodRestrictedService {
      @ClientDisabled('demo')
      run(): void {}
    }

    it('rejects a restriction on a service class and on a service method', async () => {
      const validator = await validatorFor({
        providers: [RestrictedService, MethodRestrictedService],
      });
      expect(validator.check()).toEqual([
        'RestrictedService: client availability can only be used on a GraphQL resolver (or on a field of a GraphQL type), not on this provider',
        'MethodRestrictedService: client availability can only be used on a GraphQL resolver (or on a field of a GraphQL type), not on this provider',
      ]);
    });

    it('inspects the class of a value or factory provider (Nest finds resolvers by their instance), but not plain values', async () => {
      @Resolver()
      class ByValue {
        @ClientFeature('wisla')
        helper(): string {
          return 'x';
        }
      }
      @Resolver()
      class ByFactory {
        @ClientFeature('wisla')
        helper(): string {
          return 'x';
        }
      }
      const moduleRef = await Test.createTestingModule({
        imports: [DiscoveryModule],
        providers: [
          { provide: 'PLAIN', useValue: { anything: true } },
          { provide: 'NUMBER', useValue: 5 },
          { provide: 'NOTHING', useValue: null },
          { provide: 'VALUE', useValue: new ByValue() },
          { provide: 'FACTORY', useFactory: () => new ByFactory() },
          ClientAvailabilityValidator,
          { provide: PinoLogger, useValue: logger },
        ],
      }).compile();
      expect(moduleRef.get(ClientAvailabilityValidator).check()).toEqual([
        'ByValue.helper: a restricted method must be a @Query, @Mutation, @Subscription or @ResolveField',
        'ByFactory.helper: a restricted method must be a @Query, @Mutation, @Subscription or @ResolveField',
      ]);
    });
  });

  describe('resolvers', () => {
    @Resolver()
    class NotAnEndpoint {
      @ClientFeature('wisla')
      helper(): string {
        return 'x';
      }

      @Query(() => String)
      one(): string {
        return 'one';
      }
    }

    @Resolver()
    @ClientFeature('wisla')
    class ClassLevelWithFields {
      @Query(() => String)
      one(): string {
        return 'one';
      }

      @ResolveField(() => String, { nullable: true })
      field(): string {
        return 'x';
      }
    }

    it('rejects a restricted method that is not a Query, Mutation, Subscription or ResolveField', async () => {
      const validator = await validatorFor({ providers: [NotAnEndpoint] });
      expect(validator.check()).toEqual([
        'NotAnEndpoint.helper: a restricted method must be a @Query, @Mutation, @Subscription or @ResolveField',
      ]);
    });

    it('rejects a class-level restriction on a resolver that has @ResolveField methods', async () => {
      const validator = await validatorFor({ providers: [ClassLevelWithFields] });
      expect(validator.check()).toEqual([
        'ClassLevelWithFields: a class-level restriction does not apply to its @ResolveField methods (Nest runs no guard on them); restrict the fields or the root methods one by one',
      ]);
    });

    it('also rejects it when the restricted class is a base class of the resolver', async () => {
      @Resolver()
      @ClientFeature('wisla')
      class RestrictedBase {
        @Query(() => String)
        one(): string {
          return 'one';
        }
      }
      @Resolver()
      class DerivedWithFields extends RestrictedBase {
        @ResolveField(() => String, { nullable: true })
        field(): string {
          return 'x';
        }
      }
      const validator = await validatorFor({ providers: [DerivedWithFields] });
      expect(validator.check()).toEqual([
        expect.stringContaining('DerivedWithFields: a class-level restriction does not apply'),
      ]);
    });

    it('reports a class that is listed in two places once', async () => {
      const validator = await validatorFor({ providers: [NotAnEndpoint, NotAnEndpoint] });
      expect(validator.check()).toHaveLength(1);
    });
  });

  describe('malformed or conflicting metadata (forged by hand: the decorators refuse both)', () => {
    it('rejects malformed metadata on a class and on a method, never repeating its value', async () => {
      @Resolver()
      class ForgedClass {
        @Query(() => String)
        one(): string {
          return 'one';
        }
      }
      @Resolver()
      class ForgedMethod {
        @Query(() => String)
        two(): string {
          return 'two';
        }
      }
      Reflect.defineMetadata(CLIENT_FEATURE_KEY, [SECRET], ForgedClass);
      Reflect.defineMetadata(CLIENT_DISABLED_KEY, SECRET, ForgedMethod.prototype.two);

      const validator = await validatorFor({ providers: [ForgedClass, ForgedMethod] });
      const problems = validator.check();
      expect(problems).toEqual([
        'ForgedClass: the client availability metadata is malformed',
        'ForgedMethod.two: the client availability metadata is malformed',
      ]);
      expect(JSON.stringify(problems)).not.toContain(SECRET);
    });

    it('rejects an allow-list together with a deny-list on one target', async () => {
      @Resolver()
      class Both {
        @Query(() => String)
        one(): string {
          return 'one';
        }
      }
      Reflect.defineMetadata(CLIENT_FEATURE_KEY, ['wisla'], Both.prototype.one);
      Reflect.defineMetadata(CLIENT_DISABLED_KEY, ['demo'], Both.prototype.one);

      const validator = await validatorFor({ providers: [Both] });
      expect(validator.check()).toEqual([
        'Both.one: @ClientFeature and @ClientDisabled cannot both be used on one target',
      ]);
    });
  });

  describe('class hierarchies', () => {
    it('accepts a resolver whose ancestor comes from another realm', async () => {
      const ForeignBase = runInNewContext('(class ForeignBase {})') as Type;
      @Resolver()
      class FromAnotherRealm extends ForeignBase {
        @ClientFeature('wisla')
        @Query(() => String)
        one(): string {
          return 'one';
        }
      }

      const validator = await validatorFor({ providers: [FromAnotherRealm] });
      expect(validator.check()).toEqual([]);
    });

    it('rejects a resolver whose chain ends in a function that only looks like a Function.prototype', async () => {
      const terminal = (): void => {};
      Object.setPrototypeOf(terminal, Object.create(null));
      ClientFeature('wisla')(terminal as unknown as Type);
      @Resolver()
      class OnMalformed {
        @Query(() => String)
        one(): string {
          return 'one';
        }
      }
      Object.setPrototypeOf(OnMalformed, terminal);

      const validator = await validatorFor({ providers: [OnMalformed] });
      expect(validator.check()).toContain(
        'OnMalformed: the class hierarchy could not be read, so its restrictions are unknown',
      );
    });
  });

  describe('onApplicationBootstrap', () => {
    @Controller('bad-controller')
    @ClientFeature('wisla')
    class BadController {}

    @Injectable()
    @ClientDisabled('demo')
    class BadService {}

    it('fails startup with ONE error that lists every problem, and logs it', async () => {
      const validator = await validatorFor({
        providers: [BadService],
        controllers: [BadController],
      });
      let message = '';
      try {
        validator.onApplicationBootstrap();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(
        'Invalid client availability (2 problems):\n' +
          '- BadController: client availability is GraphQL-only; remove @ClientFeature/@ClientDisabled from this HTTP controller\n' +
          '- BadService: client availability can only be used on a GraphQL resolver (or on a field of a GraphQL type), not on this provider',
      );
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        { problems: expect.arrayContaining([expect.stringContaining('BadService')]) },
        'client availability validation failed',
      );
    });

    it('uses the singular for one problem', async () => {
      const validator = await validatorFor({ controllers: [BadController] });
      expect(() => validator.onApplicationBootstrap()).toThrow(
        /^Invalid client availability \(1 problem\):/,
      );
    });
  });
});
