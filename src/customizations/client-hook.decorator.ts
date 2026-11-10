import 'reflect-metadata';
import type { ClientCode } from '../config/env.schema.js';
import type { RegisteredHandler } from './hook-registry.js';
import type { CustomizableMethodName, HookPhase, HookTarget, SingleOnly } from './hook.types.js';

export const CLIENT_HOOK_KEY = 'customizations:clientHook';

/** One registration request. A future registrar reads these to subscribe the handler. */
export interface ClientHookMetadata {
  client: ClientCode;
  /** The class whose method is hooked (a reference, so a registrar can match provider instances). */
  target: HookTarget;
  /** Name of the hooked method. A string at runtime; TypeScript has already checked it exists. */
  method: string;
  phase: HookPhase;
}

/**
 * Declares that the decorated method of a client module is a hook handler:
 *
 *   @ClientHook('kvitka', ConversionService, 'execute', 'after')
 *   addCashback({ result, ctx }: AfterHook<ConversionService, 'execute'>) { ... }
 *
 * This only ATTACHES METADATA (`ClientHookMetadata[]` under `CLIENT_HOOK_KEY`, on the handler
 * function). It registers and runs nothing. The decorator may be stacked: each use adds an entry.
 *
 * Checked by the compiler: `client` is a known `ClientCode`; `target` is a class; `method` is a
 * public async method of it; `phase` is 'before' or 'after'; and the handler as a whole must be
 * the runner's handler type for that method and phase (`RegisteredHandler`, i.e. `BeforeHandler` /
 * `AfterHandler` from `hook-runner.ts`):
 *   - its parameter accepts the payload (`BeforeHook` / `AfterHook`);
 *   - its return value is nothing, or `{ args }` (before) / `{ result }` (after), also as a promise,
 *     with the arguments tuple / result type of the target method. Anything else does not compile:
 *     a bare tuple, a result of another type, the wrong key for the phase, `null`, ...
 * A replacement written as an array literal needs a return annotation, because a decorator gives
 * the handler's body no contextual type: `{ args: [x] }` is inferred as `X[]`, not as a tuple.
 * `target`, `method` and `phase` must each be ONE value, not a union (see `SingleOnly`): with a
 * union the handler is only checked against the union of the possible handler types, so one that
 * is right for just one member would be accepted. Narrow a union first. Literals, as normally
 * written at a decorator site, are unaffected.
 * NOT checkable by types, so a registrar must verify at startup: that the target method really
 * carries `@Customizable()` (decorators are invisible to the type system; this also catches a
 * `method` that names an async function-valued field, see `CustomizableMethodName`), and that the
 * handler belongs to a provider of the right client module. The decorator itself must sit on a
 * method; on a property or a getter it throws (a getter returning a function type-checks).
 * A method inherited unchanged keeps its metadata; an override is a new function and must be
 * decorated again.
 *
 * Compile-time checking is only as good as the code that was compiled: a handler written with
 * `as`/`any`, or plain JavaScript, can still return the wrong thing, which `runWithHooks` then
 * catches at runtime, but only its SHAPE (an `args` array / a `result` key), not the element or
 * result types.
 *
 * `target` is only stored, never touched: a circular import may leave it unusable while
 * decorators run.
 */
export function ClientHook<
  TTarget extends HookTarget,
  TMethod extends CustomizableMethodName<InstanceType<TTarget>>,
  TPhase extends HookPhase,
>(
  client: ClientCode,
  target: TTarget & SingleOnly<TTarget>,
  method: TMethod & SingleOnly<TMethod>,
  phase: TPhase & SingleOnly<TPhase>,
) {
  // `THandler` is a generic bounded by the expected handler type. Writing the bound directly as
  // `TypedPropertyDescriptor<ExpectedHandler>` would not work: that type is invariant, so every
  // handler whose return type is merely a subtype (`void`, `Promise<void>`, `{ args }`, ...) would
  // be rejected. The bound is the type the registry stores and the runner runs, so the three
  // cannot drift apart.
  return <THandler extends RegisteredHandler<InstanceType<TTarget>, TMethod, TPhase>>(
    _prototype: object,
    key: string | symbol,
    descriptor: TypedPropertyDescriptor<THandler>,
  ): void => {
    // A property decorator gets no `descriptor`, an accessor has no `value`. TypeScript accepts a
    // getter that returns a function, so this is the check that rejects it. Nothing is written
    // before it passes.
    const handler = (descriptor as TypedPropertyDescriptor<THandler> | undefined)?.value;
    if (typeof handler !== 'function') {
      throw new TypeError(
        `@ClientHook() can only decorate a method, not "${String(key)}" (a property or accessor)`,
      );
    }
    const existing = Reflect.getOwnMetadata(CLIENT_HOOK_KEY, handler) as
      ClientHookMetadata[] | undefined;
    const entry: ClientHookMetadata = { client, target, method, phase };
    Reflect.defineMetadata(CLIENT_HOOK_KEY, [...(existing ?? []), entry], handler);
  };
}
