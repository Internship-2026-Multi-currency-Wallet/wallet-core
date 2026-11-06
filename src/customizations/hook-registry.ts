import { Injectable } from '@nestjs/common';
import { type CheckedHookRegistration, isCheckedHookRegistration } from './checked-hook.js';
import type { AfterHandler, BeforeHandler } from './hook-runner.js';
import {
  type CustomizableMethodName,
  HOOK_PHASES,
  type HookPhase,
  type HookTarget,
  type MethodArgs,
  type MethodResult,
  type SingleOnly,
} from './hook.types.js';

/**
 * The handler type for one (service, method, phase): exactly what `runWithHooks` takes in its
 * `before` / `after` lists, so a list from `HookRegistry.handlersFor` can be passed on unchanged.
 */
export type RegisteredHandler<
  TService,
  TMethod extends CustomizableMethodName<TService>,
  TPhase extends HookPhase,
> = TPhase extends 'before'
  ? BeforeHandler<MethodArgs<TService, TMethod>>
  : AfterHandler<MethodArgs<TService, TMethod>, MethodResult<TService, TMethod>>;

/**
 * Both lists for one method with the argument and result types ERASED, in the shape `runWithHooks`
 * takes them. For the method wrapper, which holds a method and its arguments but not their types.
 * See `HookRegistry.erasedHandlersFor`.
 */
export interface ErasedHooks {
  readonly before: readonly BeforeHandler<unknown[]>[];
  readonly after: readonly AfterHandler<unknown[], unknown>[];
}

/** Shared by all registries for "nothing registered". Frozen, so sharing it shares no state. */
const NONE: readonly never[] = Object.freeze([]);
const NO_HOOKS: ErasedHooks = Object.freeze({ before: NONE, after: NONE });

/**
 * Stores hook handlers and hands them out. Nothing else: it does not run handlers (that is
 * `runWithHooks`), find them (a later registrar reads `@ClientHook` metadata), decide which client
 * they belong to, or wrap any method.
 *
 * Contract for what is stored: `handler` is an ordinary callable that is ALREADY BOUND to whatever
 * `this` it needs (`checkClientHook` binds it to the provider instance). The registry keeps it
 * as given and never calls it or looks at its `this`.
 *
 * One instance per application: it is an injectable provider, not a global or a static, so two
 * applications (or two tests) never see each other's registrations.
 *
 * Handlers are keyed by the target class itself (constructor identity, not its name), then by
 * method name and phase. Matching is exact: a subclass is a different target and does not inherit
 * its base class's handlers.
 */
@Injectable()
export class HookRegistry {
  // WeakMap, not Map: the outer key is a class, we only ever look one up by identity and never need
  // to list them, and a WeakMap does not keep a class alive just because it was once registered
  // (relevant for classes created on the fly, e.g. in tests). Its limits, no iteration and no
  // `clear()`, are fine because nothing here needs them: a registry is dropped as a whole with
  // its application. The inner key is a method name (a string), which a WeakMap cannot hold, so
  // that level is a plain Map.
  private readonly byTarget = new WeakMap<
    HookTarget,
    Map<string, Readonly<Record<HookPhase, readonly unknown[]>>>
  >();

  /**
   * Adds a handler after the ones already registered for the same target class, method and phase
   * (registration order is execution order). Registering the same function twice registers it
   * twice: there is no de-duplication.
   *
   * Checked by the compiler: the method is a public async method of the class, and the handler fits
   * that method and phase (`BeforeHandler` / `AfterHandler`). `target`, `method` and `phase` must
   * each be ONE value, not a union (see `SingleOnly`): narrow a union first, then register. Code
   * that works from type-erased metadata does not use this method (that would take a cast): it goes
   * through `checkClientHook` and `registerChecked`. The two runtime checks below are a backstop for
   * plain JavaScript and `as` casts.
   */
  register<
    TTarget extends HookTarget,
    TMethod extends CustomizableMethodName<InstanceType<TTarget>>,
    TPhase extends HookPhase,
  >(
    target: TTarget & SingleOnly<TTarget>,
    method: TMethod & SingleOnly<TMethod>,
    phase: TPhase & SingleOnly<TPhase>,
    handler: RegisteredHandler<InstanceType<TTarget>, TMethod, TPhase>,
  ): void {
    if (!HOOK_PHASES.includes(phase)) {
      throw new TypeError(`Unknown hook phase "${String(phase)}"`);
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`The ${phase} handler for "${method}" must be a function`);
    }
    this.add(target, method, phase, handler);
  }

  /**
   * The registration path for type-erased metadata (see `checked-hook.ts`): files an already
   * checked hook exactly where `register` would, with the same ordering and snapshot rules, so
   * `handlersFor` returns it like any other.
   *
   * Only an object made by `checkClientHook` is accepted, which is verified at RUNTIME, so a forged
   * object or a cast does not get through. That check is also all this method relies on: it does
   * not look at the handler's types, because nothing at runtime can. `client` is not used here; the
   * registry never decides who a handler belongs to.
   */
  registerChecked(checked: CheckedHookRegistration): void {
    if (!isCheckedHookRegistration(checked)) {
      throw new TypeError('registerChecked() only accepts the result of checkClientHook()');
    }
    this.add(checked.target, checked.method, checked.phase, checked.handler);
  }

  /** The one writer. Callers have already validated what they pass. */
  private add(target: HookTarget, method: string, phase: HookPhase, handler: unknown): void {
    let methods = this.byTarget.get(target);
    if (!methods) {
      methods = new Map();
      this.byTarget.set(target, methods);
    }
    const current = methods.get(method) ?? NO_HOOKS;
    // Copy on write: a list that has been handed out is never changed afterwards. Registration
    // happens once at startup, retrieval on every call, so the cost is on the cheap side. The pair
    // is frozen too, so whoever holds it cannot swap a list.
    methods.set(
      method,
      Object.freeze({ ...current, [phase]: Object.freeze([...current[phase], handler]) }),
    );
  }

  /**
   * The handlers registered for this class, method and phase, in registration order; empty if there
   * are none. The returned list is frozen and is a snapshot: handlers registered later are not
   * added to it, and nothing done to it can change the registry.
   */
  handlersFor<
    TTarget extends HookTarget,
    TMethod extends CustomizableMethodName<InstanceType<TTarget>>,
    TPhase extends HookPhase,
  >(
    target: TTarget,
    method: TMethod,
    phase: TPhase,
  ): readonly RegisteredHandler<InstanceType<TTarget>, TMethod, TPhase>[] {
    // The one type assertion: storage is type-erased (`unknown`), because one map holds lists for
    // many different methods. It is sound because the only writers are `register`, which accepts only
    // a handler whose type matches the very (target, method, phase) it is filed under, and
    // `registerChecked`, whose handlers are shape-checked only (see `checked-hook.ts`).
    return (this.byTarget.get(target)?.get(method)?.[phase] ?? NONE) as readonly RegisteredHandler<
      InstanceType<TTarget>,
      TMethod,
      TPhase
    >[];
  }

  /**
   * Both lists for a method, with all argument and result types erased: the form `runWithHooks`
   * needs when the caller (the method wrapper) only has the method and its runtime arguments.
   * Same snapshot rules as `handlersFor`. Prefer `handlersFor` wherever the types are known.
   */
  erasedHandlersFor(target: HookTarget, method: string): ErasedHooks {
    // A type assertion, same reasoning as above: only `add` writes, and it files each handler under
    // the (target, method, phase) it was accepted for. That every handler really fits `unknown[]`
    // arguments is the erasure itself: it holds because the wrapper passes this method's own
    // arguments, which is the premise of the erased path and cannot be checked here.
    return (this.byTarget.get(target)?.get(method) as ErasedHooks | undefined) ?? NO_HOOKS;
  }
}
