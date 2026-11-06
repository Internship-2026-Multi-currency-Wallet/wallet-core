import { SetMetadata } from '@nestjs/common';
import type { AsyncMethod } from './hook.types.js';

export const CUSTOMIZABLE_KEY = 'customizations:customizable';

export interface CustomizableOptions {
  /** Rethrow an error from a hook handler instead of logging and ignoring it. Default `false`. */
  propagateExceptions?: boolean;
}

/** What is stored on the method: the options with their defaults filled in. */
export type CustomizableMetadata = Required<CustomizableOptions>;

/**
 * Marks a core service method as a place where client hooks may run:
 *
 *   @Customizable()
 *   async execute(input: ConvertInput): Promise<Conversion> { ... }
 *
 * This only ATTACHES METADATA (read it with `Reflector.get(CUSTOMIZABLE_KEY, method)`); the method
 * is not wrapped here. Running `before` handlers -> method -> `after` handlers is a later step.
 *
 * Async methods only: the generic constraint makes a synchronous method a compile error, because
 * handlers are awaited and would silently turn it into an async one.
 *
 * Methods only, checked at runtime too: TypeScript cannot tell a method from a function-valued
 * field or getter (see `CustomizableMethodName`), and a property decorator gets no descriptor at
 * all. Such a use throws a `TypeError` BEFORE anything is written, because `SetMetadata` would
 * otherwise attach the metadata to the class prototype.
 */
export function Customizable(options: CustomizableOptions = {}) {
  const metadata: CustomizableMetadata = {
    propagateExceptions: options.propagateExceptions ?? false,
  };
  return <TMethod extends AsyncMethod>(
    target: object,
    key: string | symbol,
    descriptor: TypedPropertyDescriptor<TMethod>,
  ): void => {
    // `descriptor` is `undefined` for a property; `value` is `undefined` for an accessor.
    const method = (descriptor as TypedPropertyDescriptor<TMethod> | undefined)?.value;
    if (typeof method !== 'function') {
      throw new TypeError(
        `@Customizable() can only decorate a method, not "${String(key)}" (a property or accessor)`,
      );
    }
    // Same storage as `@Public()` / `@RequirePermission()`: metadata on the method function.
    SetMetadata(CUSTOMIZABLE_KEY, metadata)(target, key, descriptor);
  };
}
