import { runInNewContext } from 'node:vm';
import { type ExecutionContext, NotFoundException } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import 'reflect-metadata';
import { AppConfig } from '../config/app-config.js';
import type { ClientCode } from '../config/env.schema.js';
import {
  CLIENT_DISABLED_KEY,
  CLIENT_FEATURE_KEY,
  ClientDisabled,
  ClientFeature,
} from './client-availability.decorator.js';
import {
  ClientAvailabilityGuard,
  collectAvailability,
  isAvailableTo,
} from './client-availability.guard.js';

const CLIENTS: readonly ClientCode[] = ['demo', 'kvitka', 'wisla'];

/** The context Nest builds for a resolver: the instantiated class and the method it calls. */
function contextFor(
  cls: new () => object,
  handler: object,
  type: string = 'graphql',
): ExecutionContext {
  return {
    getType: () => type,
    getClass: () => cls,
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

function guardFor(client: ClientCode): ClientAvailabilityGuard {
  return new ClientAvailabilityGuard(AppConfig.fromEnv({ CLIENT: client, NODE_ENV: 'test' }));
}

/** Which clients may call `cls.prototype[method]`, by running the real guard once per client. */
function availableTo(cls: new () => object, method: string | symbol): ClientCode[] {
  const handler = (cls.prototype as Record<string | symbol, object>)[method];
  return CLIENTS.filter((client) => {
    try {
      return guardFor(client).canActivate(contextFor(cls, handler));
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      return false;
    }
  });
}

const ALL: ClientCode[] = ['demo', 'kvitka', 'wisla'];
const NONE: ClientCode[] = [];

describe('ClientAvailabilityGuard', () => {
  describe('endpoints without restrictions', () => {
    class Plain {
      query(): void {}
    }

    it.each(CLIENTS)('lets CLIENT=%s through', (client) => {
      expect(guardFor(client).canActivate(contextFor(Plain, Plain.prototype.query))).toBe(true);
    });
  });

  describe('@ClientFeature is an allow-list', () => {
    @ClientFeature('wisla')
    class WislaClass {
      first(): void {}
      second(): void {}
    }

    class MethodLevel {
      @ClientFeature('kvitka', 'wisla')
      shared(): void {}

      @ClientFeature('wisla')
      wislaOnly(): void {}

      open(): void {}
    }

    it('on a class, applies to every method', () => {
      expect(availableTo(WislaClass, 'first')).toEqual(['wisla']);
      expect(availableTo(WislaClass, 'second')).toEqual(['wisla']);
    });

    it('on a method, applies to that method only', () => {
      expect(availableTo(MethodLevel, 'shared')).toEqual(['kvitka', 'wisla']);
      expect(availableTo(MethodLevel, 'wislaOnly')).toEqual(['wisla']);
      expect(availableTo(MethodLevel, 'open')).toEqual(ALL);
    });
  });

  describe('@ClientDisabled is a deny-list', () => {
    @ClientDisabled('wisla')
    class NoWisla {
      first(): void {}
    }

    class MethodLevel {
      @ClientDisabled('kvitka', 'demo')
      wislaOnlyByElimination(): void {}

      open(): void {}
    }

    it('on a class, hides every method from the listed clients only', () => {
      expect(availableTo(NoWisla, 'first')).toEqual(['demo', 'kvitka']);
    });

    it('on a method, hides that method only', () => {
      expect(availableTo(MethodLevel, 'wislaOnlyByElimination')).toEqual(['wisla']);
      expect(availableTo(MethodLevel, 'open')).toEqual(ALL);
    });
  });

  describe('class and method restrictions combine by intersection', () => {
    @ClientFeature('kvitka', 'wisla')
    class Narrowing {
      @ClientFeature('wisla', 'demo')
      overlap(): void {}

      @ClientFeature('demo')
      disjoint(): void {}

      @ClientDisabled('kvitka')
      denies(): void {}

      plain(): void {}
    }

    @ClientDisabled('demo')
    class DeniedClass {
      @ClientFeature('demo', 'wisla')
      wantsDemo(): void {}

      @ClientDisabled('wisla')
      deniesMore(): void {}
    }

    it('a method can narrow the class allow-list, never widen it', () => {
      expect(availableTo(Narrowing, 'plain')).toEqual(['kvitka', 'wisla']);
      expect(availableTo(Narrowing, 'overlap')).toEqual(['wisla']);
      expect(availableTo(Narrowing, 'disjoint')).toEqual(NONE);
      expect(availableTo(Narrowing, 'denies')).toEqual(['wisla']);
    });

    it('a method allow-list cannot lift a class deny-list', () => {
      expect(availableTo(DeniedClass, 'wantsDemo')).toEqual(['wisla']);
      expect(availableTo(DeniedClass, 'deniesMore')).toEqual(['kvitka']);
    });
  });

  describe('contradictory rules', () => {
    /**
     * The decorators refuse an allow-list and a deny-list on ONE target, so that case can only be
     * metadata written by hand (damaged or forged). The guard must still answer sensibly: both
     * lists apply, as for any two restrictions.
     */
    const forge = (
      target: object,
      feature: readonly ClientCode[],
      disabled: readonly ClientCode[],
    ): void => {
      Reflect.defineMetadata(CLIENT_FEATURE_KEY, feature, target);
      Reflect.defineMetadata(CLIENT_DISABLED_KEY, disabled, target);
    };

    class SameTarget {
      run(): void {}
    }
    forge(SameTarget, ['wisla'], ['wisla']);

    class SameMethod {
      run(): void {}

      partly(): void {}
    }
    forge(SameMethod.prototype.run, ['wisla'], ['wisla']);
    forge(SameMethod.prototype.partly, ['kvitka', 'wisla'], ['wisla']);

    @ClientFeature('wisla')
    class ClassVersusMethod {
      @ClientDisabled('wisla')
      run(): void {}

      @ClientDisabled('demo')
      partly(): void {}
    }

    it('make the endpoint unavailable to every client', () => {
      expect(availableTo(SameTarget, 'run')).toEqual(NONE);
      expect(availableTo(SameMethod, 'run')).toEqual(NONE);
      expect(availableTo(ClassVersusMethod, 'run')).toEqual(NONE);
    });

    it('only remove the clients they contradict about', () => {
      expect(availableTo(SameMethod, 'partly')).toEqual(['kvitka']);
      expect(availableTo(ClassVersusMethod, 'partly')).toEqual(['wisla']);
    });
  });

  describe('inheritance of class-level restrictions', () => {
    @ClientFeature('kvitka', 'wisla')
    class Base {
      run(): void {}
    }
    class Silent extends Base {}

    @ClientFeature('wisla', 'kvitka', 'demo')
    class TriesToWiden extends Base {}

    @ClientFeature('demo')
    class Unrelated extends Base {}

    @ClientDisabled('kvitka')
    class AddsDenial extends Base {}

    class Middle extends Base {}
    @ClientDisabled('wisla')
    class Leaf extends Middle {}

    it('a subclass without annotations keeps the restriction of its base', () => {
      expect(availableTo(Silent, 'run')).toEqual(['kvitka', 'wisla']);
    });

    it('a subclass annotation cannot widen the restriction of its base', () => {
      expect(availableTo(TriesToWiden, 'run')).toEqual(['kvitka', 'wisla']);
    });

    it('a subclass annotation that shares no client with its base leaves no client', () => {
      expect(availableTo(Unrelated, 'run')).toEqual(NONE);
    });

    it('a subclass can add a denial to its base', () => {
      expect(availableTo(AddsDenial, 'run')).toEqual(['wisla']);
    });

    it('collects the whole chain, across an unannotated middle class', () => {
      expect(availableTo(Leaf, 'run')).toEqual(['kvitka']);
    });
  });

  describe('overridden methods keep the restrictions of what they override', () => {
    class Base {
      @ClientFeature('wisla', 'kvitka')
      endpoint(): void {}

      @ClientDisabled('demo')
      other(): void {}

      free(): void {}

      @ClientFeature('wisla')
      [Symbol.for('hidden')](): void {}
    }

    class Overriding extends Base {
      override endpoint(): void {}
      override free(): void {}
      [Symbol.for('hidden')](): void {}
    }

    class Redecorating extends Base {
      @ClientFeature('kvitka')
      override endpoint(): void {}

      @ClientFeature('demo')
      override other(): void {}
    }

    class TriesToWiden extends Base {
      @ClientFeature('wisla', 'kvitka', 'demo')
      override endpoint(): void {}
    }

    class Deep extends Overriding {
      override endpoint(): void {}
    }

    class AddsDenial extends Base {
      @ClientDisabled('wisla')
      override endpoint(): void {}
    }

    it('the override has no metadata of its own, yet the base restriction still applies', () => {
      expect(Overriding.prototype.endpoint).not.toBe(Base.prototype.endpoint);
      expect(availableTo(Base, 'endpoint')).toEqual(['kvitka', 'wisla']);
      expect(availableTo(Overriding, 'endpoint')).toEqual(['kvitka', 'wisla']);
    });

    it('restrictions are found by name, also two overrides deep and for symbol names', () => {
      expect(availableTo(Deep, 'endpoint')).toEqual(['kvitka', 'wisla']);
      expect(availableTo(Overriding, Symbol.for('hidden'))).toEqual(['wisla']);
    });

    it('an undecorated override of an unrestricted method stays unrestricted', () => {
      expect(availableTo(Overriding, 'free')).toEqual(ALL);
    });

    it('a decorated override narrows, and cannot widen, what it overrides', () => {
      expect(availableTo(Redecorating, 'endpoint')).toEqual(['kvitka']);
      expect(availableTo(TriesToWiden, 'endpoint')).toEqual(['kvitka', 'wisla']);
      expect(availableTo(AddsDenial, 'endpoint')).toEqual(['kvitka']);
    });

    it('an override whose annotation shares no client with the base leaves no client', () => {
      // The base denies demo; the override allows only demo.
      expect(availableTo(Redecorating, 'other')).toEqual(NONE);
    });
  });

  describe('one function under several names (aliases)', () => {
    class Base {
      @ClientFeature('wisla')
      b(): void {}
    }

    /**
     * `a` and `b` are the SAME function on the subclass; `b` overrides the restricted `Base.b`. Nest
     * may reach the handler under either name, so the restriction of `Base.b` has to apply either way.
     */
    function withAlias(order: 'a-first' | 'b-first'): new () => object {
      class Derived extends Base {}
      const handler = (): void => undefined;
      const names = order === 'a-first' ? ['a', 'b'] : ['b', 'a'];
      for (const name of names) {
        Object.defineProperty(Derived.prototype, name, {
          value: handler,
          writable: true,
          configurable: true,
        });
      }
      return Derived;
    }

    it('applies the restriction of an ancestor method with the OTHER name', () => {
      const Derived = withAlias('a-first');
      expect(availableTo(Derived, 'a')).toEqual(['wisla']);
      expect(availableTo(Derived, 'b')).toEqual(['wisla']);
    });

    it('gives the same answer whatever order the names were declared in', () => {
      expect(availableTo(withAlias('a-first'), 'a')).toEqual(
        availableTo(withAlias('b-first'), 'a'),
      );
      expect(availableTo(withAlias('a-first'), 'b')).toEqual(
        availableTo(withAlias('b-first'), 'b'),
      );
      expect(availableTo(withAlias('b-first'), 'a')).toEqual(['wisla']);
    });

    it('also finds an alias that an ancestor declares', () => {
      class Root {
        @ClientFeature('kvitka', 'wisla')
        guarded(): void {}
      }
      class Middle extends Root {}
      const handler = (): void => undefined;
      // The subclass defines the function under a new name AND under the guarded one.
      class Leaf extends Middle {}
      Object.defineProperty(Leaf.prototype, 'other', { value: handler, configurable: true });
      Object.defineProperty(Leaf.prototype, 'guarded', { value: handler, configurable: true });
      expect(availableTo(Leaf, 'other')).toEqual(['kvitka', 'wisla']);
    });

    it('combines the restrictions of every name by intersection', () => {
      class Two {
        @ClientFeature('kvitka', 'wisla')
        first(): void {}

        @ClientFeature('wisla', 'demo')
        second(): void {}
      }
      class Child extends Two {}
      const handler = (): void => undefined;
      Object.defineProperty(Child.prototype, 'first', { value: handler, configurable: true });
      Object.defineProperty(Child.prototype, 'second', { value: handler, configurable: true });
      expect(availableTo(Child, 'first')).toEqual(['wisla']);
    });

    it('an alias of an unrestricted method adds nothing', () => {
      class Plain {
        run(): void {}
      }
      class Child extends Plain {}
      Object.defineProperty(Child.prototype, 'again', {
        value: Plain.prototype.run,
        configurable: true,
      });
      expect(availableTo(Child, 'again')).toEqual(ALL);
    });
  });

  describe('a long inheritance chain', () => {
    /** `depth` empty subclasses on top of an annotated root, so the restriction is far up. */
    function deepChain(depth: number): new () => object {
      class Root {
        run(): void {}
      }
      ClientFeature('wisla')(Root);
      let current: new () => object = Root;
      for (let level = 0; level < depth; level += 1) {
        current = class extends current {};
      }
      return current;
    }

    it.each([5, 99, 100, 101, 150, 500])('applies a root restriction %i levels up', (depth) => {
      expect(availableTo(deepChain(depth), 'run')).toEqual(['wisla']);
    });

    it('finds a method restriction on an ancestor that is far up too', () => {
      class Root {
        @ClientFeature('kvitka')
        run(): void {}
      }
      let current: new () => object = Root;
      for (let level = 0; level < 200; level += 1) {
        current = class extends current {};
      }
      class Leaf extends (current as new () => Root) {
        override run(): void {}
      }
      expect(availableTo(Leaf, 'run')).toEqual(['kvitka']);
    });
  });

  describe('a class chain that cannot be walked to its end', () => {
    class Plain {
      run(): void {}
    }
    const unavailable = (handlerClass: object): boolean => {
      try {
        return !guardFor('wisla').canActivate(
          contextFor(handlerClass as new () => object, Plain.prototype.run),
        );
      } catch (error) {
        return error instanceof NotFoundException;
      }
    };

    it('is unavailable when reading a prototype throws', () => {
      const hostile = new Proxy(class {}, {
        getPrototypeOf() {
          throw new Error('trap');
        },
      });
      expect(unavailable(hostile)).toBe(true);
      expect(collectAvailability(hostile, Plain.prototype.run).problems).toEqual([
        { code: 'unresolved-class-chain', where: '(anonymous class)' },
      ]);
    });

    it('is unavailable, and does not loop, when the chain is a cycle', () => {
      const cyclic: object = new Proxy(class {}, {
        getPrototypeOf() {
          return cyclic;
        },
      });
      expect(unavailable(cyclic)).toBe(true);
    });

    it('is unavailable when the chain ends in something that is not a class', () => {
      class Odd {
        run(): void {}
      }
      Object.setPrototypeOf(Odd, { notAClass: true });
      expect(unavailable(Odd)).toBe(true);
    });

    it('reaches the end of a chain that includes a class from another realm', () => {
      // A foreign class ends in ITS realm's Function.prototype, which is not ours.
      const ForeignBase = runInNewContext('(class ForeignBase { run() {} })') as new () => object;
      @ClientFeature('wisla')
      class FromAnotherRealm extends ForeignBase {}

      expect(
        collectAvailability(FromAnotherRealm, ForeignBase.prototype.run as object).problems,
      ).toEqual([]);
      expect(availableTo(FromAnotherRealm, 'run')).toEqual(['wisla']);
    });

    it('collects the restrictions of foreign ancestors, from several realms', () => {
      const realmA = runInNewContext('(class A { run() {} })') as new () => object;
      const RealmB = runInNewContext('class B extends base {}; B', {
        base: realmA,
      }) as typeof realmA;
      ClientFeature('kvitka', 'wisla')(realmA);
      @ClientDisabled('wisla')
      class Local extends RealmB {}

      expect(collectAvailability(Local, realmA.prototype.run as object).problems).toEqual([]);
      expect(availableTo(Local, 'run')).toEqual(['kvitka']);
    });

    describe('a terminal that only looks like a Function.prototype', () => {
      class Resolver {
        query(): void {}
      }
      const malformed = (): (() => void) => {
        const terminal = (): void => {};
        Object.setPrototypeOf(terminal, Object.create(null));
        return terminal;
      };
      const expectFailClosed = (cls: new () => object): void => {
        expect(collectAvailability(cls, Resolver.prototype.query).problems).toEqual([
          { code: 'unresolved-class-chain', where: nameOfClass(cls) },
        ]);
        expect(availableTo(cls, 'query')).toEqual(NONE);
      };
      const nameOfClass = (cls: object): string => (cls as { name: string }).name;

      it('is not an end when it carries a restriction', () => {
        const terminal = malformed();
        ClientFeature('wisla')(terminal as unknown as new () => object);
        class OnRestricted extends Resolver {}
        Object.setPrototypeOf(OnRestricted, terminal);
        expectFailClosed(OnRestricted);
      });

      it('is not an end without any metadata either', () => {
        class OnPlain extends Resolver {}
        Object.setPrototypeOf(OnPlain, malformed());
        expectFailClosed(OnPlain);
      });

      it('is not an end with a forged constructor backlink', () => {
        const terminal = malformed();
        function Forged(): void {}
        Forged.prototype = terminal;
        Object.defineProperty(terminal, 'constructor', { value: Forged });
        class OnForged extends Resolver {}
        Object.setPrototypeOf(OnForged, terminal);
        expectFailClosed(OnForged);
      });

      it('is not an end when it is a real foreign Function.prototype that carries a restriction', () => {
        const foreignFunctionPrototype = runInNewContext('Function.prototype') as object;
        Reflect.defineMetadata(CLIENT_FEATURE_KEY, ['wisla'], foreignFunctionPrototype);
        class OnDecoratedNative extends Resolver {}
        Object.setPrototypeOf(OnDecoratedNative, foreignFunctionPrototype);
        expectFailClosed(OnDecoratedNative);
      });
    });

    it('is fine when the chain ends in null, as a class with a null prototype does', () => {
      class Orphan {
        run(): void {}
      }
      Object.setPrototypeOf(Orphan, null);
      expect(availableTo(Orphan, 'run')).toEqual(ALL);
    });
  });

  describe('class-level and method-level restrictions across a chain', () => {
    @ClientFeature('kvitka', 'wisla')
    class Base {
      @ClientFeature('wisla')
      run(): void {}
    }
    @ClientDisabled('wisla')
    class Child extends Base {
      override run(): void {}
    }

    it('combines the class chain with every definition of the method', () => {
      expect(availableTo(Base, 'run')).toEqual(['wisla']);
      expect(availableTo(Child, 'run')).toEqual(NONE);
    });
  });

  describe('a handler that is not a method of the class chain', () => {
    const standalone = (): void => undefined;

    class WithoutMethodRestrictions {
      other(): void {}
    }
    @ClientFeature('wisla')
    class ClassRestricted {}
    class WithMethodRestriction {
      @ClientFeature('wisla')
      guarded(): void {}
    }
    class Shadowing {
      @ClientFeature('wisla')
      run(): void {}
    }

    const through = (cls: new () => object, handler: object): ClientCode[] =>
      CLIENTS.filter((client) => {
        try {
          return guardFor(client).canActivate(contextFor(cls, handler));
        } catch {
          return false;
        }
      });

    it('is allowed when nothing on the chain could be lost', () => {
      expect(through(WithoutMethodRestrictions, standalone)).toEqual(ALL);
    });

    it('still gets the class-level restrictions', () => {
      expect(through(ClassRestricted, standalone)).toEqual(['wisla']);
    });

    it('is unavailable when the chain has a method-level restriction it cannot match', () => {
      expect(through(WithMethodRestriction, standalone)).toEqual(NONE);
      expect(collectAvailability(WithMethodRestriction, standalone).problems).toEqual([
        { code: 'unresolved-handler', where: 'WithMethodRestriction' },
      ]);
    });

    it("still honours the handler's own annotation, as an instance-level function", () => {
      // An own property of the instance is not on the prototype, so it is found by identity only.
      const instanceLevel = Shadowing.prototype.run.bind(null);
      expect(through(Shadowing, instanceLevel)).toEqual(NONE);
    });
  });

  describe('malformed metadata is never read as permission', () => {
    const forge = (key: string, target: object, value: unknown): void => {
      Reflect.defineMetadata(key, value, target);
    };

    it.each([CLIENT_DISABLED_KEY, CLIENT_FEATURE_KEY])(
      'on the class (%s): nobody passes',
      (key) => {
        class Target {
          run(): void {}
        }
        forge(key, Target, 'wisla');
        expect(availableTo(Target, 'run')).toEqual(NONE);
      },
    );

    it.each([CLIENT_DISABLED_KEY, CLIENT_FEATURE_KEY])(
      'on the method (%s): nobody passes',
      (key) => {
        class Target {
          run(): void {}
          other(): void {}
        }
        forge(key, Target.prototype.run, ['WISLA']);
        expect(availableTo(Target, 'run')).toEqual(NONE);
        expect(availableTo(Target, 'other')).toEqual(ALL); // other methods are unaffected
      },
    );

    it('on an ancestor class: nobody passes, even with a valid annotation on the subclass', () => {
      class Base {
        run(): void {}
      }
      forge(CLIENT_DISABLED_KEY, Base, []);
      @ClientFeature('wisla')
      class Child extends Base {}
      expect(availableTo(Child, 'run')).toEqual(NONE);
    });

    it('on the overridden base method: nobody passes', () => {
      class Base {
        run(): void {}
      }
      forge(CLIENT_DISABLED_KEY, Base.prototype.run, ['nope']);
      class Child extends Base {
        override run(): void {}
      }
      expect(availableTo(Child, 'run')).toEqual(NONE);
    });

    it('a valid list next to a malformed one does not rescue the endpoint', () => {
      @ClientFeature('wisla')
      class Target {
        run(): void {}
      }
      forge(CLIENT_DISABLED_KEY, Target, 5);
      expect(availableTo(Target, 'run')).toEqual(NONE);
    });

    it('is reported by collectAvailability with source names and no values', () => {
      const secret = 'sk_live_AbC123xyz789';
      class Base {
        run(): void {}
      }
      forge(CLIENT_DISABLED_KEY, Base.prototype.run, [secret]);
      class Child extends Base {
        override run(): void {}
      }
      forge(CLIENT_FEATURE_KEY, Child, secret);

      const { problems } = collectAvailability(Child, Child.prototype.run);
      expect(problems).toEqual([
        { code: 'malformed-metadata', where: 'Child' },
        { code: 'malformed-metadata', where: 'Base.run' },
      ]);
      expect(JSON.stringify(problems)).not.toContain(secret);
    });
  });

  describe('the error', () => {
    @ClientFeature('wisla')
    class WislaOnly {
      run(): void {}
    }
    class Broken {
      run(): void {}
    }
    Reflect.defineMetadata(CLIENT_DISABLED_KEY, 'wisla', Broken);

    const thrownFor = (cls: new () => object, client: ClientCode, type?: string): unknown => {
      try {
        guardFor(client).canActivate(contextFor(cls, cls.prototype.run as object, type));
      } catch (error) {
        return error;
      }
      return undefined;
    };

    it('is a Nest NotFoundException with the fixed default message, naming no client or feature', () => {
      const error = thrownFor(WislaOnly, 'kvitka') as NotFoundException;
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.getStatus()).toBe(404);
      expect(error.message).toBe('Not Found');
    });

    it('is identical for a restricted endpoint and for malformed metadata', () => {
      const restricted = thrownFor(WislaOnly, 'demo') as NotFoundException;
      const broken = thrownFor(Broken, 'wisla') as NotFoundException;
      expect(broken).toBeInstanceOf(NotFoundException);
      expect(broken.message).toBe(restricted.message);
      expect(broken.getResponse()).toEqual(restricted.getResponse());
    });

    it.each(['graphql', 'http'])('is the same exception in a %s context', (type) => {
      const error = thrownFor(WislaOnly, 'kvitka', type) as NotFoundException;
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.getResponse()).toEqual(new NotFoundException().getResponse());
      expect(thrownFor(WislaOnly, 'wisla', type)).toBeUndefined();
    });
  });

  describe('the guard itself', () => {
    it('does not call the handler, and reads only the class and the handler of the context', () => {
      const calls: string[] = [];
      class Target {
        @ClientFeature('wisla')
        run(): void {
          calls.push('run');
        }
      }
      const context = {
        getType: () => 'graphql',
        getClass: () => {
          calls.push('getClass');
          return Target;
        },
        getHandler: () => {
          calls.push('getHandler');
          return Target.prototype.run;
        },
        switchToHttp: () => {
          throw new Error('must not be used');
        },
      } as unknown as ExecutionContext;

      expect(guardFor('wisla').canActivate(context)).toBe(true);
      expect(calls).toEqual(['getClass', 'getHandler']);
    });

    it("works with Nest's own ExecutionContext, built the way the GraphQL explorer builds it", () => {
      @ClientFeature('wisla')
      class Resolver {
        query(): void {}
      }
      // GuardsConsumer: new ExecutionContextHost(args, instance.constructor, callback)
      const context = new ExecutionContextHost([], Resolver, new Resolver().query);
      context.setType('graphql');

      expect(guardFor('wisla').canActivate(context)).toBe(true);
      expect(() => guardFor('kvitka').canActivate(context)).toThrow(NotFoundException);
    });

    it('is synchronous', () => {
      class Plain {
        run(): void {}
      }
      expect(guardFor('demo').canActivate(contextFor(Plain, Plain.prototype.run))).toBe(true);
    });
  });
});

describe('isAvailableTo', () => {
  it('requires every allow-list and no deny-list to name the client', () => {
    const rules = { feature: [['kvitka', 'wisla'], ['wisla']], disabled: [['demo']] } as const;
    expect(CLIENTS.filter((client) => isAvailableTo(client, rules))).toEqual(['wisla']);
    expect(isAvailableTo('demo', { feature: [], disabled: [] })).toBe(true);
  });
});
