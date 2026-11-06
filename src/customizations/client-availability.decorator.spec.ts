import { Reflector } from '@nestjs/core';
import 'reflect-metadata';
import {
  CLIENT_DISABLED_KEY,
  CLIENT_FEATURE_KEY,
  ClientDisabled,
  ClientFeature,
  clientAvailabilityOf,
  parseClientList,
} from './client-availability.decorator.js';

/* Fixtures: classes and methods the way a resolver would carry the decorators. */

@ClientFeature('wisla')
class WislaOnly {
  anything(): void {}

  @ClientDisabled('demo')
  narrower(): void {}
}

@ClientDisabled('kvitka', 'demo')
class NotForKvitkaOrDemo {}

@ClientFeature('kvitka', 'wisla')
class Both {
  @ClientDisabled('kvitka')
  both(): void {}

  @ClientFeature('wisla', 'wisla', 'kvitka', 'wisla')
  repeated(): void {}

  plain(): void {}
}

describe('@ClientFeature / @ClientDisabled metadata', () => {
  const reflector = new Reflector();

  it('stores the clients of a class and of a method, each under its own key', () => {
    expect(reflector.get(CLIENT_FEATURE_KEY, WislaOnly)).toEqual(['wisla']);
    expect(reflector.get(CLIENT_DISABLED_KEY, WislaOnly)).toBeUndefined();
    expect(reflector.get(CLIENT_DISABLED_KEY, NotForKvitkaOrDemo)).toEqual(['kvitka', 'demo']);
    expect(reflector.get(CLIENT_DISABLED_KEY, WislaOnly.prototype.narrower)).toEqual(['demo']);
    expect(reflector.get(CLIENT_FEATURE_KEY, WislaOnly.prototype.narrower)).toBeUndefined();
  });

  it('reads the same through clientAvailabilityOf, which says nothing for an unmarked target', () => {
    expect(clientAvailabilityOf(WislaOnly)).toEqual({ feature: ['wisla'], disabled: undefined });
    // A class allow-list with a method deny-list: two targets, so they may be combined.
    expect(clientAvailabilityOf(Both.prototype.both)).toEqual({
      feature: undefined,
      disabled: ['kvitka'],
    });
    expect(clientAvailabilityOf(Both.prototype.plain)).toEqual({
      feature: undefined,
      disabled: undefined,
    });
    expect(clientAvailabilityOf(WislaOnly.prototype.anything)).toEqual({
      feature: undefined,
      disabled: undefined,
    });
  });

  it('keeps the order of the clients and stores each client once', () => {
    expect(clientAvailabilityOf(Both.prototype.repeated).feature).toEqual(['wisla', 'kvitka']);
    // The raw metadata too, not only what the reader returns.
    expect(Reflect.getOwnMetadata(CLIENT_FEATURE_KEY, Both.prototype.repeated)).toEqual([
      'wisla',
      'kvitka',
    ]);
  });

  it('stores a frozen list, so it cannot be changed afterwards', () => {
    const feature = clientAvailabilityOf(WislaOnly).feature as string[];
    expect(Object.isFrozen(feature)).toBe(true);
    expect(() => feature.push('demo')).toThrow(TypeError);
    expect(clientAvailabilityOf(WislaOnly).feature).toEqual(['wisla']);
  });

  it('does not wrap or replace the method', () => {
    const method = Both.prototype.both;
    expect(new Both().both).toBe(method);
    expect(method.name).toBe('both');
  });

  it('writes metadata to the class or to the method function, never to the prototype', () => {
    const prototype = WislaOnly.prototype;
    const ours = [CLIENT_FEATURE_KEY, CLIENT_DISABLED_KEY];
    for (const key of ours) {
      expect(Reflect.getMetadataKeys(prototype)).not.toContain(key);
      expect(Reflect.getMetadataKeys(prototype, 'narrower')).not.toContain(key);
    }
    expect(Reflect.hasOwnMetadata(CLIENT_DISABLED_KEY, prototype.narrower)).toBe(true);
  });

  it('works on a symbol-named method', () => {
    const name = Symbol('hidden');
    class Symbolic {
      @ClientFeature('demo')
      [name](): void {}
    }
    expect(clientAvailabilityOf(Symbolic.prototype[name]).feature).toEqual(['demo']);
  });
});

/**
 * What inheritance does to the metadata. These pin the facts the guard design rests on: a lookup
 * that follows the prototype chain would LOSE a restriction, so the guard has to read own metadata.
 */
describe('inheritance', () => {
  @ClientFeature('wisla', 'kvitka')
  class Base {
    @ClientDisabled('kvitka')
    handler(): void {}

    @ClientDisabled('demo')
    redecorated(): void {}

    undecorated(): void {}
  }

  class Silent extends Base {}

  @ClientFeature('wisla')
  class Narrowing extends Base {}

  @ClientFeature('demo')
  class TryingToWiden extends Base {}

  class Overriding extends Base {
    override handler(): void {}
  }

  class Redecorating extends Base {
    @ClientDisabled('wisla')
    override redecorated(): void {}
  }

  it('an inheriting class has no metadata of its own, but a plain lookup still finds its base', () => {
    expect(clientAvailabilityOf(Silent)).toEqual({ feature: undefined, disabled: undefined });
    expect(Reflect.getMetadata(CLIENT_FEATURE_KEY, Silent)).toEqual(['wisla', 'kvitka']);
  });

  it('a subclass annotation is its own and leaves the base untouched', () => {
    expect(clientAvailabilityOf(Narrowing).feature).toEqual(['wisla']);
    expect(clientAvailabilityOf(Base).feature).toEqual(['wisla', 'kvitka']);
  });

  it('a plain lookup on a subclass HIDES the base restriction, which is why own metadata is stored', () => {
    expect(clientAvailabilityOf(TryingToWiden).feature).toEqual(['demo']);
    expect(Reflect.getMetadata(CLIENT_FEATURE_KEY, TryingToWiden)).toEqual(['demo']);
    // Both are still there to be intersected along the chain by walking it with own lookups.
    expect(clientAvailabilityOf(Object.getPrototypeOf(TryingToWiden) as object).feature).toEqual([
      'wisla',
      'kvitka',
    ]);
  });

  it('an inherited, unchanged method is the same function and keeps its metadata', () => {
    expect(Silent.prototype.handler).toBe(Base.prototype.handler);
    expect(clientAvailabilityOf(Silent.prototype.handler).disabled).toEqual(['kvitka']);
  });

  it('an override is a new function with NO metadata: the restriction is not carried over', () => {
    expect(Overriding.prototype.handler).not.toBe(Base.prototype.handler);
    expect(clientAvailabilityOf(Overriding.prototype.handler)).toEqual({
      feature: undefined,
      disabled: undefined,
    });
    expect(Reflect.getMetadata(CLIENT_DISABLED_KEY, Overriding.prototype.handler)).toBeUndefined();
  });

  it('a decorated override has its own metadata and leaves the overridden method untouched', () => {
    expect(clientAvailabilityOf(Redecorating.prototype.redecorated).disabled).toEqual(['wisla']);
    expect(clientAvailabilityOf(Base.prototype.redecorated).disabled).toEqual(['demo']);
  });
});

describe('invalid clients are rejected when the decorator is created', () => {
  // Plain JavaScript or a cast gets past the compiler; the runtime check must catch it.
  const call = (decorator: (...clients: never[]) => unknown, ...clients: unknown[]) =>
    decorator(...(clients as never[]));

  it.each([ClientFeature, ClientDisabled])('%p rejects an empty list', (decorator) => {
    expect(() => call(decorator)).toThrow(/needs at least one client; known: demo, kvitka, wisla/);
  });

  it.each([ClientFeature, ClientDisabled])('%p rejects an unknown client', (decorator) => {
    expect(() => call(decorator, 'kvitka', 'nope')).toThrow(
      /got an unknown client; known: demo, kvitka, wisla/,
    );
  });

  it.each([[undefined], [null], [5], [{}], [['wisla']], ['Wisla'], [' wisla'], ['WISLA'], ['']])(
    'rejects the value %p',
    (value) => {
      expect(() => call(ClientFeature, value)).toThrow(TypeError);
      expect(() => call(ClientDisabled, value)).toThrow(TypeError);
    },
  );

  it('never repeats the rejected value, however much it looks like an identifier', () => {
    const secret = 'sk_live_AbC123xyz789';
    for (const decorator of [ClientFeature, ClientDisabled]) {
      try {
        call(decorator, secret);
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });

  it('writes nothing when the clients are invalid', () => {
    expect(() => {
      @(call(ClientFeature, 'nope') as ClassDecorator)
      class Invalid {}
      return Invalid;
    }).toThrow(TypeError);
  });
});

describe('invalid targets are rejected', () => {
  /** Remembers the prototype the decorators see, so the tests can inspect it after a throw. */
  const seen: { prototype?: object } = {};
  const capture = (target: object, _key: string | symbol, _descriptor: unknown): void => {
    seen.prototype = target;
  };

  beforeEach(() => {
    seen.prototype = undefined;
  });

  it.each([
    ['ClientFeature', ClientFeature],
    ['ClientDisabled', ClientDisabled],
  ])('@%s on a static property throws and writes nothing', (name, decorator) => {
    expect(() => {
      class WithStatic {
        @capture
        first(): void {}

        @decorator('wisla')
        static rate = 1;
      }
      return WithStatic;
    }).toThrow(
      new TypeError(
        `@${name}() can only decorate a class, an instance method or an instance property, not "rate" (an accessor, static member or parameter)`,
      ),
    );
    for (const key of [CLIENT_FEATURE_KEY, CLIENT_DISABLED_KEY]) {
      expect(Reflect.getMetadataKeys(seen.prototype as object)).not.toContain(key);
      expect(Reflect.getMetadataKeys(seen.prototype as object, 'rate')).not.toContain(key);
    }
  });

  it.each([ClientFeature, ClientDisabled])(
    '%p on a getter, which the types accept, throws',
    (decorator) => {
      expect(() => {
        class WithGetter {
          // Type-checks: the getter's TYPE is a function.
          @decorator('wisla')
          get run(): () => void {
            return () => undefined;
          }
        }
        return WithGetter;
      }).toThrow(/not "run"/);
    },
  );

  it.each([ClientFeature, ClientDisabled])('%p on a setter throws', (decorator) => {
    expect(() => {
      class WithSetter {
        // Type-checks too: only the runtime check rejects an accessor.
        @decorator('wisla')
        set rate(_value: number) {}
      }
      return WithSetter;
    }).toThrow(/not "rate"/);
  });

  it.each([ClientFeature, ClientDisabled])('%p on a static method throws', (decorator) => {
    expect(() => {
      class WithStatic {
        @decorator('wisla')
        static helper(): void {}
      }
      return WithStatic;
    }).toThrow(/not "helper"/);
  });

  it.each([ClientFeature, ClientDisabled])('%p on a parameter throws', (decorator) => {
    expect(() => {
      class WithParameter {
        // @ts-expect-error a parameter is not a class or a method
        run(@decorator('wisla') _value: number): void {}
      }
      return WithParameter;
    }).toThrow(/not "run"/);
  });

  it.each([ClientFeature, ClientDisabled])(
    '%p on a constructor parameter throws and leaves no metadata on the class',
    (decorator) => {
      // Parameter decorators run last to first, so `capture` (on the last parameter) sees the
      // class before the decorator under test (on the first) throws.
      let decoratedClass: object | undefined;
      const capture = (target: object, _key: string | symbol | undefined, _index: number): void => {
        decoratedClass = target;
      };
      expect(() => {
        class WithConstructorParameter {
          constructor(
            // @ts-expect-error a parameter is not a class or a method
            @decorator('wisla') _first: number,
            @capture _second: number,
          ) {}
        }
        return WithConstructorParameter;
      }).toThrow(TypeError);

      expect(decoratedClass).toBeInstanceOf(Function);
      expect(clientAvailabilityOf(decoratedClass as object)).toEqual({
        feature: undefined,
        disabled: undefined,
      });
      for (const key of [CLIENT_FEATURE_KEY, CLIENT_DISABLED_KEY]) {
        expect(Reflect.hasOwnMetadata(key, decoratedClass as object)).toBe(false);
      }
    },
  );

  it('a real class decorator, with no third argument, is still accepted', () => {
    @ClientFeature('demo')
    class Fine {
      constructor(readonly value: number) {}
    }
    expect(clientAvailabilityOf(Fine)).toEqual({ feature: ['demo'], disabled: undefined });
  });
});

describe('the same decorator twice on one target', () => {
  it.each([
    ['ClientFeature', ClientFeature],
    ['ClientDisabled', ClientDisabled],
  ])('@%s twice on a class throws and keeps the first list', (name, decorator) => {
    expect(() => {
      @decorator('kvitka')
      @decorator('wisla')
      class Twice {}
      return Twice;
    }).toThrow(
      new TypeError(`@${name}() is already used on class Twice; list all clients in one call`),
    );
  });

  it.each([
    ['ClientFeature', ClientFeature],
    ['ClientDisabled', ClientDisabled],
  ])('@%s twice on a method throws', (name, decorator) => {
    expect(() => {
      class Twice {
        @decorator('kvitka')
        @decorator('wisla')
        run(): void {}
      }
      return Twice;
    }).toThrow(new TypeError(`@${name}() is already used on "run"; list all clients in one call`));
  });

  it('keeps the first list intact after the rejected second use', () => {
    const decorate = ClientFeature('wisla');
    class Target {
      run(): void {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      Target.prototype,
      'run',
    ) as PropertyDescriptor;
    decorate(Target.prototype, 'run', descriptor);
    expect(() => ClientFeature('kvitka')(Target.prototype, 'run', descriptor)).toThrow(TypeError);
    expect(clientAvailabilityOf(Target.prototype.run).feature).toEqual(['wisla']);
  });

  it('allows the same decorator on different targets, and the two decorators on different targets', () => {
    expect(clientAvailabilityOf(WislaOnly).feature).toEqual(['wisla']);
    expect(clientAvailabilityOf(Both).feature).toEqual(['kvitka', 'wisla']);
    expect(clientAvailabilityOf(Both.prototype.both).disabled).toEqual(['kvitka']);
  });
});

describe('on an instance property (a GraphQL field)', () => {
  const SYMBOLIC: unique symbol = Symbol('symbolic');

  class WithProperties {
    @ClientFeature('wisla', 'kvitka')
    allowed?: string;

    @ClientDisabled('demo')
    denied?: string;

    plain?: string;

    @ClientFeature('wisla')
    [SYMBOLIC]?: string;
  }

  it('stores the clients on the PROTOTYPE under the property key, and reads them back', () => {
    const prototype = WithProperties.prototype;
    expect(clientAvailabilityOf(prototype, 'allowed')).toEqual({
      feature: ['wisla', 'kvitka'],
      disabled: undefined,
    });
    expect(clientAvailabilityOf(prototype, 'denied')).toEqual({
      feature: undefined,
      disabled: ['demo'],
    });
    expect(clientAvailabilityOf(prototype, 'plain')).toEqual({
      feature: undefined,
      disabled: undefined,
    });
    expect(clientAvailabilityOf(prototype, SYMBOLIC).feature).toEqual(['wisla']);
  });

  it('keeps properties apart from each other and from the class itself', () => {
    expect(clientAvailabilityOf(WithProperties)).toEqual({
      feature: undefined,
      disabled: undefined,
    });
    expect(clientAvailabilityOf(WithProperties.prototype)).toEqual({
      feature: undefined,
      disabled: undefined,
    });
    expect(Reflect.hasOwnMetadata(CLIENT_DISABLED_KEY, WithProperties.prototype, 'allowed')).toBe(
      false,
    );
  });

  it('stores a frozen list', () => {
    const stored = Reflect.getOwnMetadata(
      CLIENT_FEATURE_KEY,
      WithProperties.prototype,
      'allowed',
    ) as string[];
    expect(Object.isFrozen(stored)).toBe(true);
  });

  it('does not define anything on the prototype object itself', () => {
    expect(Object.hasOwn(WithProperties.prototype, 'allowed')).toBe(false);
    expect(Reflect.getMetadataKeys(WithProperties.prototype)).not.toContain(CLIENT_FEATURE_KEY);
  });

  it('an own-metadata read does not see a base class property (a subclass must not hide it)', () => {
    class Base {
      @ClientFeature('wisla')
      shared?: string;
    }
    class Derived extends Base {}
    expect(clientAvailabilityOf(Derived.prototype, 'shared')).toEqual({
      feature: undefined,
      disabled: undefined,
    });
    expect(clientAvailabilityOf(Base.prototype, 'shared').feature).toEqual(['wisla']);
  });

  it.each([
    ['ClientFeature', ClientFeature],
    ['ClientDisabled', ClientDisabled],
  ])('@%s twice on one property throws', (name, decorator) => {
    expect(() => {
      class Twice {
        @decorator('kvitka')
        @decorator('wisla')
        field?: string;
      }
      return Twice;
    }).toThrow(
      new TypeError(`@${name}() is already used on "field"; list all clients in one call`),
    );
  });

  it('rejects a malformed property list when it is read, with the fixed message', () => {
    Reflect.defineMetadata(CLIENT_FEATURE_KEY, 'wisla', WithProperties.prototype, 'plain');
    expect(() => clientAvailabilityOf(WithProperties.prototype, 'plain')).toThrow(
      new TypeError(
        '@ClientFeature metadata is malformed: expected a non-empty list of known clients',
      ),
    );
    Reflect.deleteMetadata(CLIENT_FEATURE_KEY, WithProperties.prototype, 'plain');
  });
});

describe('@ClientFeature and @ClientDisabled cannot be on the same target', () => {
  const MESSAGE = (first: string, second: string, where: string): TypeError =>
    new TypeError(
      `@${first}() and @${second}() cannot both be used on ${where}; a target is either an allow-list or a deny-list`,
    );

  it('rejects a class, whichever decorator comes first', () => {
    expect(() => {
      @ClientFeature('wisla')
      @ClientDisabled('kvitka')
      class A {}
      return A;
    }).toThrow(MESSAGE('ClientFeature', 'ClientDisabled', 'class A'));
    expect(() => {
      @ClientDisabled('kvitka')
      @ClientFeature('wisla')
      class B {}
      return B;
    }).toThrow(MESSAGE('ClientDisabled', 'ClientFeature', 'class B'));
  });

  it('rejects a method, whichever decorator comes first', () => {
    expect(() => {
      class A {
        @ClientFeature('wisla')
        @ClientDisabled('kvitka')
        run(): void {}
      }
      return A;
    }).toThrow(MESSAGE('ClientFeature', 'ClientDisabled', '"run"'));
    expect(() => {
      class B {
        @ClientDisabled('kvitka')
        @ClientFeature('wisla')
        run(): void {}
      }
      return B;
    }).toThrow(MESSAGE('ClientDisabled', 'ClientFeature', '"run"'));
  });

  it('rejects a property, whichever decorator comes first', () => {
    expect(() => {
      class A {
        @ClientFeature('wisla')
        @ClientDisabled('kvitka')
        field?: string;
      }
      return A;
    }).toThrow(MESSAGE('ClientFeature', 'ClientDisabled', '"field"'));
    expect(() => {
      class B {
        @ClientDisabled('kvitka')
        @ClientFeature('wisla')
        field?: string;
      }
      return B;
    }).toThrow(MESSAGE('ClientDisabled', 'ClientFeature', '"field"'));
  });

  it('keeps the first decorator and writes nothing for the rejected second one', () => {
    class Target {
      run(): void {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      Target.prototype,
      'run',
    ) as PropertyDescriptor;
    ClientFeature('wisla')(Target.prototype, 'run', descriptor);
    expect(() => ClientDisabled('kvitka')(Target.prototype, 'run', descriptor)).toThrow(TypeError);
    expect(clientAvailabilityOf(Target.prototype.run)).toEqual({
      feature: ['wisla'],
      disabled: undefined,
    });
  });

  it('is fine on different targets of one class, and on a class and its subclass', () => {
    @ClientFeature('wisla', 'kvitka')
    class Outer {
      @ClientDisabled('kvitka')
      run(): void {}

      @ClientDisabled('demo')
      field?: string;
    }
    @ClientDisabled('demo')
    class Inner extends Outer {}
    expect(clientAvailabilityOf(Outer).feature).toEqual(['wisla', 'kvitka']);
    expect(clientAvailabilityOf(Outer.prototype.run).disabled).toEqual(['kvitka']);
    expect(clientAvailabilityOf(Outer.prototype, 'field').disabled).toEqual(['demo']);
    expect(clientAvailabilityOf(Inner).disabled).toEqual(['demo']);
  });
});

describe('parseClientList', () => {
  it('reads a stored list: de-duplicated, ordered, frozen', () => {
    const list = parseClientList('ClientFeature', ['wisla', 'kvitka', 'wisla']);
    expect(list).toEqual(['wisla', 'kvitka']);
    expect(Object.isFrozen(list)).toBe(true);
  });

  it.each([[undefined], [null], ['wisla'], [[]], [['nope']], [['wisla', 1]], [{ length: 1 }]])(
    'rejects %p with the fixed message and names the decorator',
    (value) => {
      expect(() => parseClientList('ClientDisabled', value)).toThrow(
        new TypeError(
          '@ClientDisabled metadata is malformed: expected a non-empty list of known clients',
        ),
      );
    },
  );
});

/**
 * Metadata that is present but was not written by the decorators (forged or damaged). Reading it
 * must fail with a fixed message: dropping it would turn a deny-list into "no restriction".
 */
describe('malformed metadata is rejected when it is read', () => {
  const FEATURE_MESSAGE =
    '@ClientFeature metadata is malformed: expected a non-empty list of known clients';
  const DISABLED_MESSAGE =
    '@ClientDisabled metadata is malformed: expected a non-empty list of known clients';
  const SECRET = 'sk_live_AbC123xyz789';

  const keys = [
    ['ClientFeature', CLIENT_FEATURE_KEY, FEATURE_MESSAGE],
    ['ClientDisabled', CLIENT_DISABLED_KEY, DISABLED_MESSAGE],
  ] as const;

  const malformed: [string, unknown][] = [
    ['a string', 'wisla'],
    ['a wrongly cased client', ['WISLA']],
    ['an unknown client', ['nope']],
    ['a valid client next to an unknown one', ['wisla', 'nope']],
    ['an empty list', []],
    ['a number in the list', ['wisla', 1]],
    ['null in the list', [null]],
    ['a nested list', [['wisla']]],
    ['a list with a hole', new Array<unknown>(1)],
    ['an object', { 0: 'wisla', length: 1 }],
    ['null', null],
    ['undefined, explicitly written', undefined],
    ['a number', 5],
    ['a client-shaped secret', [SECRET]],
  ];

  describe.each(keys)('%s', (_name, key, message) => {
    it.each(malformed)('rejects %s on a class', (_case, value) => {
      class Target {}
      Reflect.defineMetadata(key, value, Target);
      expect(() => clientAvailabilityOf(Target)).toThrow(new TypeError(message));
    });

    it('rejects it on a method function too', () => {
      class Target {
        run(): void {}
      }
      Reflect.defineMetadata(key, 'wisla', Target.prototype.run);
      expect(() => clientAvailabilityOf(Target.prototype.run)).toThrow(new TypeError(message));
    });

    it('never repeats the malformed value in the message', () => {
      class Target {}
      Reflect.defineMetadata(key, [SECRET, { token: SECRET }], Target);
      try {
        clientAvailabilityOf(Target);
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as Error).message).toBe(message);
        expect((error as Error).message).not.toContain(SECRET);
      }
    });

    it('rejects a proxy list whose length cannot be read, with our error only', () => {
      const hostile = new Proxy(['wisla'], {
        get(target, property, receiver) {
          if (property === 'length') throw new Error(SECRET);
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
      class Target {}
      Reflect.defineMetadata(key, hostile, Target);

      let caught: unknown;
      try {
        clientAvailabilityOf(Target);
      } catch (error) {
        caught = error;
      }
      expect(caught).toEqual(new TypeError(message));
      expect((caught as TypeError).message).not.toContain(SECRET);
      expect((caught as TypeError).cause).toBeUndefined();
    });

    it('rejects a revoked proxy as the list, with our error only', () => {
      const { proxy, revoke } = Proxy.revocable(['wisla'], {});
      revoke();
      class Target {}
      Reflect.defineMetadata(key, proxy, Target);
      expect(() => clientAvailabilityOf(Target)).toThrow(new TypeError(message));
    });

    it('rejects a list whose elements cannot be read', () => {
      const hostile = ['wisla'];
      Object.defineProperty(hostile, 0, {
        get() {
          throw new Error(SECRET);
        },
      });
      class Target {}
      Reflect.defineMetadata(key, hostile, Target);
      expect(() => clientAvailabilityOf(Target)).toThrow(new TypeError(message));
    });
  });

  it('rejects the target when only ONE of the two lists is malformed (no partial result)', () => {
    class Target {}
    Reflect.defineMetadata(CLIENT_FEATURE_KEY, ['wisla'], Target);
    Reflect.defineMetadata(CLIENT_DISABLED_KEY, 'wisla', Target);
    expect(() => clientAvailabilityOf(Target)).toThrow(new TypeError(DISABLED_MESSAGE));
  });

  it("does not treat inherited malformed metadata as the target's own", () => {
    class Base {}
    Reflect.defineMetadata(CLIENT_DISABLED_KEY, 'wisla', Base);
    class Derived extends Base {}
    expect(clientAvailabilityOf(Derived)).toEqual({ feature: undefined, disabled: undefined });
    expect(() => clientAvailabilityOf(Base)).toThrow(TypeError);
  });

  describe('valid metadata is still read', () => {
    it('reads a list written by hand in the same shape the decorators write', () => {
      class Target {}
      Reflect.defineMetadata(CLIENT_DISABLED_KEY, ['kvitka', 'wisla'], Target);
      expect(clientAvailabilityOf(Target).disabled).toEqual(['kvitka', 'wisla']);
    });

    it('removes repeats, keeps the order, and returns a frozen copy', () => {
      class Target {}
      const stored = ['wisla', 'kvitka', 'wisla'];
      Reflect.defineMetadata(CLIENT_FEATURE_KEY, stored, Target);

      const { feature } = clientAvailabilityOf(Target);
      expect(feature).toEqual(['wisla', 'kvitka']);
      expect(Object.isFrozen(feature)).toBe(true);
      expect(feature).not.toBe(stored);

      stored.push('demo'); // changing the stored list later does not change what was returned
      expect(feature).toEqual(['wisla', 'kvitka']);
    });

    it('reads every known client', () => {
      class Target {}
      Reflect.defineMetadata(CLIENT_FEATURE_KEY, ['demo', 'kvitka', 'wisla'], Target);
      expect(clientAvailabilityOf(Target).feature).toEqual(['demo', 'kvitka', 'wisla']);
    });
  });
});

/**
 * Compile-time checks. Jest does not type-check; `npm run typecheck` does, and an UNUSED
 * `@ts-expect-error` is itself a compile error, so each directive below is a real assertion.
 */
describe('compile-time checks', () => {
  it('require at least one client, and only known ones', () => {
    // @ts-expect-error at least one client is required
    const empty = (): unknown => ClientFeature();
    // @ts-expect-error at least one client is required
    const emptyDisabled = (): unknown => ClientDisabled();
    // @ts-expect-error 'nope' is not a client
    const unknown = (): unknown => ClientFeature('nope');
    // @ts-expect-error one unknown client among valid ones
    const mixed = (): unknown => ClientDisabled('wisla', 'nope');
    // @ts-expect-error clients are case-sensitive
    const wrongCase = (): unknown => ClientFeature('Wisla');
    // @ts-expect-error a list is not a client
    const array = (): unknown => ClientFeature(['wisla']);
    // @ts-expect-error a string that is only known at runtime is not a client
    const widened = (client: string): unknown => ClientFeature(client);

    // They are not called: only their types matter. Valid forms compile:
    const valid: unknown[] = [
      ClientFeature('wisla'),
      ClientFeature('kvitka', 'wisla', 'demo'),
      ClientDisabled('demo'),
    ];
    expect(valid).toHaveLength(3);
    expect([empty, emptyDisabled, unknown, mixed, wrongCase, array, widened]).toHaveLength(7);
  });

  it('accept a spread of a known tuple but not of a plain array', () => {
    const tuple: ['wisla', 'kvitka'] = ['wisla', 'kvitka'];
    const plain: ('wisla' | 'kvitka')[] = ['wisla'];
    expect(ClientFeature(...tuple)).toBeInstanceOf(Function);
    // @ts-expect-error a plain array may be empty
    const spread = (): unknown => ClientFeature(...plain);
    expect(spread).toBeInstanceOf(Function);
  });
});
