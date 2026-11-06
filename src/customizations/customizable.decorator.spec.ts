import { Reflector } from '@nestjs/core';
import {
  CUSTOMIZABLE_KEY,
  Customizable,
  type CustomizableMetadata,
} from './customizable.decorator.js';

interface ConvertInput {
  from: string;
  to: string;
  amountMinor: number;
}

/** Test fixture; has nothing to do with a real conversion service. */
class ConvertService {
  @Customizable()
  async execute(input: ConvertInput): Promise<string> {
    await Promise.resolve();
    return `${input.from}->${input.to}`;
  }

  @Customizable({ propagateExceptions: true })
  strict(): Promise<void> {
    return Promise.resolve();
  }

  @Customizable({})
  emptyOptions(): Promise<void> {
    return Promise.resolve();
  }

  undecorated(): Promise<void> {
    return Promise.resolve();
  }
}

describe('@Customizable', () => {
  const reflector = new Reflector();
  const metadataOf = (method: (...args: never[]) => unknown) =>
    reflector.get<CustomizableMetadata | undefined>(CUSTOMIZABLE_KEY, method);

  it('stores the default options when called without arguments', () => {
    expect(metadataOf(ConvertService.prototype.execute)).toEqual({
      propagateExceptions: false,
    });
  });

  it('fills in defaults for an empty options object', () => {
    expect(metadataOf(ConvertService.prototype.emptyOptions)).toEqual({
      propagateExceptions: false,
    });
  });

  it('stores propagateExceptions: true', () => {
    expect(metadataOf(ConvertService.prototype.strict)).toEqual({ propagateExceptions: true });
  });

  it('marks only the decorated methods', () => {
    expect(metadataOf(ConvertService.prototype.undecorated)).toBeUndefined();
  });

  it('does not wrap the method: it behaves exactly as without the decorator', async () => {
    const service = new ConvertService();
    await expect(service.execute({ from: 'USD', to: 'UAH', amountMinor: 100 })).resolves.toBe(
      'USD->UAH',
    );
    expect(service.execute.name).toBe('execute');
    expect(service.execute).toBe(ConvertService.prototype.execute);
  });

  it('writes metadata to the method function only, never to the prototype', () => {
    const prototype = ConvertService.prototype;
    expect(Reflect.hasOwnMetadata(CUSTOMIZABLE_KEY, prototype.execute)).toBe(true);
    expect(Reflect.getMetadataKeys(prototype)).not.toContain(CUSTOMIZABLE_KEY);
    expect(Reflect.getMetadataKeys(prototype, 'execute')).not.toContain(CUSTOMIZABLE_KEY);
  });

  // The directive below is verified by `npm run typecheck` (jest does not type-check):
  // an unused `@ts-expect-error` is itself a compile error.
  it('rejects a synchronous method at compile time', () => {
    class Invalid {
      // @ts-expect-error a synchronous method cannot be customizable
      @Customizable()
      label(): string {
        return 'x';
      }
    }
    expect(new Invalid().label()).toBe('x');
  });

  describe('inheritance', () => {
    class Inheriting extends ConvertService {}

    class Overriding extends ConvertService {
      override execute(input: ConvertInput): Promise<string> {
        return super.execute(input);
      }
    }

    class Redecorating extends ConvertService {
      @Customizable({ propagateExceptions: true })
      override execute(input: ConvertInput): Promise<string> {
        return super.execute(input);
      }
    }

    it('an inherited, unchanged method is the same function and keeps its metadata', () => {
      expect(Inheriting.prototype.execute).toBe(ConvertService.prototype.execute);
      expect(metadataOf(Inheriting.prototype.execute)).toEqual({ propagateExceptions: false });
    });

    it('an override is a new function: it is NOT customizable unless decorated again', () => {
      expect(metadataOf(Overriding.prototype.execute)).toBeUndefined();
      expect(metadataOf(ConvertService.prototype.execute)).toEqual({ propagateExceptions: false });
    });

    it('a decorated override has its own metadata and leaves the base untouched', () => {
      expect(metadataOf(Redecorating.prototype.execute)).toEqual({ propagateExceptions: true });
      expect(metadataOf(ConvertService.prototype.execute)).toEqual({ propagateExceptions: false });
    });
  });
});

/**
 * Misuse that TypeScript cannot (or can only partly) prevent. The guard must throw BEFORE writing
 * anything: `SetMetadata` given no descriptor would attach the options to the class prototype.
 */
describe('@Customizable on something that is not a method', () => {
  const MESSAGE = '@Customizable() can only decorate a method';
  /** Remembers the prototype that decorators see, so the tests can inspect it after the throw. */
  const seen: { prototype?: object } = {};
  const capture = (target: object, _key: string | symbol, _descriptor: unknown): void => {
    seen.prototype = target;
  };
  const prototypeSeen = (): object => seen.prototype as object;

  beforeEach(() => {
    seen.prototype = undefined;
  });

  it('throws a TypeError on a property, and writes no metadata to the prototype', () => {
    expect(() => {
      class WithProperty {
        @capture
        first(): void {}

        // @ts-expect-error a property is not a method
        @Customizable()
        rate = 1;
      }
      return WithProperty;
    }).toThrow(new TypeError(`${MESSAGE}, not "rate" (a property or accessor)`));

    expect(Reflect.hasMetadata(CUSTOMIZABLE_KEY, prototypeSeen())).toBe(false);
    expect(Reflect.getMetadataKeys(prototypeSeen())).toEqual([]);
    expect(Reflect.getMetadataKeys(prototypeSeen(), 'rate')).not.toContain(CUSTOMIZABLE_KEY);
  });

  it('throws on a getter that returns an async function, which the types accept', () => {
    expect(() => {
      class WithGetter {
        @capture
        first(): void {}

        // Type-checks: the getter's TYPE is an async function (the documented limitation).
        @Customizable()
        get run(): () => Promise<void> {
          return () => Promise.resolve();
        }
      }
      return WithGetter;
    }).toThrow(new TypeError(`${MESSAGE}, not "run" (a property or accessor)`));

    const getter = Object.getOwnPropertyDescriptor(prototypeSeen(), 'run')?.get;
    expect(getter).toBeInstanceOf(Function);
    expect(Reflect.hasMetadata(CUSTOMIZABLE_KEY, getter as object)).toBe(false);
    expect(Reflect.getMetadataKeys(prototypeSeen())).toEqual([]);
    expect(Reflect.getMetadataKeys(prototypeSeen(), 'run')).not.toContain(CUSTOMIZABLE_KEY);
  });
});
