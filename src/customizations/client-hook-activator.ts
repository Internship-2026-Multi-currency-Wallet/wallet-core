/**
 * Turns the `@ClientHook` methods of the ACTIVE client's modules into running hooks (E1-3, B2.4a).
 *
 * How a client module takes part (each client module controls its own subscription):
 *
 *   onModuleInit() {
 *     if (this.config.client !== 'kvitka') return;       // not this deployment's client: do nothing
 *     this.activator.subscribe(KvitkaModule);            // only records the module
 *   }
 *
 * Nothing is validated or installed at that point. After EVERY module has initialised (Nest's
 * `onApplicationBootstrap`, which runs once, after all `onModuleInit`s) the activator does, in
 * one synchronous pass:
 *
 *   1. PREFLIGHT, read-only: find the hook methods of the subscribed modules' providers, check each
 *      entry against the active client (`checkClientHook`), find the target instances and check
 *      that each method can be wrapped. Every problem is collected. If there is one, startup fails
 *      with a single error listing all of them, and nothing has been changed.
 *   2. INSTALL a wrapper on every target instance method that has a hook (`wrapMethod`).
 *   3. REGISTER the hooks in the registry (`registerChecked`), last. A wrapper reads the registry on
 *      every call, so until this step the installed wrappers have nothing to run.
 *
 * What is and is not guaranteed: step 1 is all-or-nothing. Step 2 is NOT atomic and there is no
 * rollback; if installing fails half way (only an exotic object can make that happen after a
 * successful preflight) startup fails, the registry is still empty, and the wrappers already
 * installed only pass calls through. Step 3 cannot fail for what the checker produced.
 *
 * Hooks of other clients are never looked at: their modules do not subscribe, so their hook
 * providers are merely constructed (like any provider) and their handlers are never registered.
 */
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, ModulesContainer } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../config/app-config.js';
import type { ClientCode } from '../config/env.schema.js';
import {
  type CheckedHookRegistration,
  type ErasedHandler,
  checkClientHook,
  nameOf,
} from './checked-hook.js';
import { HookRegistry } from './hook-registry.js';
import type { HookFailure } from './hook-runner.js';
import type { HookTarget } from './hook.types.js';
import { checkWrappable, wrapMethod } from './method-wrapper.js';
import { classNameOf, findTargetInstances, scanHookMethods } from './provider-scan.js';

/** A Nest module class (what `subscribe` takes). */
export type ModuleClass = abstract new (...args: never[]) => object;

interface PlannedWrap {
  readonly target: HookTarget;
  readonly method: string;
  readonly instance: object;
}

@Injectable()
export class ClientHookActivator implements OnApplicationBootstrap {
  private readonly staged: ModuleClass[] = [];
  private activated = false;

  constructor(
    @Inject(AppConfig) private readonly config: AppConfig,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(ModulesContainer) private readonly modules: ModulesContainer,
    @Inject(HookRegistry) private readonly registry: HookRegistry,
    // Not `@InjectPinoLogger`: see ClientSettingsService (provider order of nestjs-pino).
    private readonly logger: PinoLogger,
  ) {
    logger.setContext(ClientHookActivator.name);
  }

  /**
   * Records that the hook providers declared in `module` are to be activated. Call it from the
   * client module's `onModuleInit`, and only when it is the active client. The active client is
   * always `AppConfig.client`: hooks written for another client make activation fail.
   */
  subscribe(module: ModuleClass): void {
    if (typeof module !== 'function') {
      throw new TypeError('ClientHookActivator.subscribe() expects a module class');
    }
    if (this.activated) {
      throw new Error(
        `ClientHookActivator.subscribe(${nameOf(module) ?? 'a module'}) is too late: hooks are activated once, at application bootstrap; subscribe from onModuleInit`,
      );
    }
    if (!this.staged.includes(module)) this.staged.push(module);
  }

  onApplicationBootstrap(): void {
    if (this.activated) return;
    this.activated = true;
    const client = this.config.client;

    const { checked, wraps, problems } = this.preflight(client);
    if (problems.length > 0) {
      this.logger.error({ problems }, 'client hook activation failed');
      throw new Error(
        `Client hook activation failed for client "${client}" (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n${problems.map((p) => `- ${p}`).join('\n')}`,
      );
    }

    for (const { target, method, instance } of wraps) {
      const result = wrapMethod(instance, target, method, {
        registry: this.registry,
        onHandlerError: this.reporter(target, method),
      });
      if (!result.ok) {
        const problem = result.problem.message;
        this.logger.error({ problems: [problem] }, 'client hook activation failed');
        throw new Error(
          `Client hook activation failed for client "${client}" while installing wrappers: ${problem}. No client hook was registered.`,
        );
      }
    }
    for (const registration of checked) this.registry.registerChecked(registration);

    // The active client is already on every line (`client` is a base field of the logger).
    this.logger.info({ hooks: checked.length, methods: wraps.length }, 'client hooks activated');
  }

  /** Step 1: read-only. Returns what to install and register, or the problems found. */
  private preflight(client: ClientCode): {
    checked: CheckedHookRegistration[];
    wraps: PlannedWrap[];
    problems: string[];
  } {
    const problems: string[] = [];
    const checked: CheckedHookRegistration[] = [];
    const wraps: PlannedWrap[] = [];
    if (this.staged.length === 0) return { checked, wraps, problems };

    // A subscribed class that is not a module of this application would silently activate nothing.
    const known = new Set<unknown>([...this.modules.values()].map((module) => module.metatype));
    for (const module of this.staged) {
      if (!known.has(module)) {
        problems.push(
          `${nameOf(module) ?? '(anonymous class)'}: this module is not part of the application, so it cannot be activated (subscribe the module that declares the hook providers, and import it)`,
        );
      }
    }

    // Hook methods of the subscribed modules' own providers.
    const hookProviders = this.staged.flatMap((module) =>
      this.discovery.getProviders({ include: [module] }),
    );
    const scan = scanHookMethods(hookProviders);
    problems.push(...scan.problems.map((p) => p.message));

    // Two instances of the SAME concrete class would both run the same hook on every call. Different
    // concrete classes may inherit one decorated function: each registers it bound to its own instance
    // and runs once, so only the pair (concrete class, handler) is compared, never the function alone.
    const firstInstance = new Map<object | null, Map<ErasedHandler, object>>();
    for (const method of scan.found) {
      const concreteClass = Object.getPrototypeOf(method.instance) as object | null;
      const handlers = firstInstance.get(concreteClass) ?? new Map<ErasedHandler, object>();
      firstInstance.set(concreteClass, handlers);
      const first = handlers.get(method.handler);
      if (first === undefined) handlers.set(method.handler, method.instance);
      else if (first !== method.instance) {
        problems.push(
          `${classNameOf(method.instance)}.${method.name}: more than one instance of this hook provider is subscribed, so the handler would run twice per call`,
        );
      }
    }

    for (const { instance, handler, entries } of scan.found) {
      for (const entry of entries) {
        const result = checkClientHook(entry, handler, instance, client);
        if (result.ok) checked.push(result.registration);
        else problems.push(...result.problems.map((p) => p.message));
      }
    }

    // Which methods of which targets need a wrapper, then on which instances.
    const methodsByTarget = new Map<HookTarget, Set<string>>();
    for (const { target, method } of checked) {
      const methods = methodsByTarget.get(target) ?? new Set<string>();
      methods.add(method);
      methodsByTarget.set(target, methods);
    }
    const allProviders = this.discovery.getProviders();
    for (const [target, methods] of methodsByTarget) {
      const targets = findTargetInstances(allProviders, target);
      problems.push(...targets.problems.map((p) => p.message));
      for (const instance of targets.found) {
        for (const method of methods) {
          const result = checkWrappable(instance, target, method);
          if (result.ok) wraps.push({ target, method, instance });
          else problems.push(result.problem.message);
        }
      }
    }
    return { checked, wraps, problems };
  }

  /**
   * The `onHandlerError` of one wrapped method: logs that an ignored hook failed, with fields that
   * identify it and nothing derived from the call (see `failureFields`). Handler errors that are
   * rethrown (`propagateExceptions`) never get here.
   */
  private reporter(target: HookTarget, method: string): (failure: HookFailure) => void {
    const targetName = safeIdentifier(nameOf(target), '(anonymous class)');
    const methodName = safeIdentifier(method, '(invalid method)');
    return (failure) => {
      this.logger.error(
        { target: targetName, method: methodName, ...failureFields(failure) },
        'client hook failed and was ignored',
      );
    };
  }
}

/**
 * Source names (class, method, handler) are the only strings that are logged as they are. They are
 * read from the classes themselves, never from metadata values or from a thrown value, and are
 * cut to a printable shape here. That shape check is formatting, NOT a confidentiality guarantee:
 * it is why nothing that comes from a runtime value is ever passed through it (see `errorTypeOf`).
 */
const IDENTIFIER = /^[\w$.]{1,80}$/;

function safeIdentifier(value: unknown, fallback: string): string {
  return typeof value === 'string' && IDENTIFIER.test(value) ? value : fallback;
}

/**
 * The fields logged for an ignored hook failure. Nothing comes from the error's contents: the
 * handler's NAME (source code, see `IDENTIFIER`) and a FIXED CATEGORY of the error (`errorTypeOf`).
 * The error's message, stack, cause, class name and properties are never read, so a message that
 * embeds a token or an amount, or an error class named after one, cannot reach the log; the hook's
 * arguments, result and context are never seen here at all.
 */
export function failureFields(failure: HookFailure): {
  phase: HookFailure['phase'];
  index: number;
  handler: string;
  errorType: string;
} {
  return {
    phase: failure.phase,
    index: failure.index,
    handler: safeIdentifier(failure.handler.replace(/^(bound )+/, ''), '(unnamed handler)'),
    errorType: errorTypeOf(failure.error),
  };
}

/** The built-in error classes, most specific first, with the fixed label each one is reported as. */
const ERROR_CATEGORIES: readonly (readonly [object, string])[] = [
  [EvalError.prototype, 'EvalError'],
  [RangeError.prototype, 'RangeError'],
  [ReferenceError.prototype, 'ReferenceError'],
  [SyntaxError.prototype, 'SyntaxError'],
  [TypeError.prototype, 'TypeError'],
  [URIError.prototype, 'URIError'],
  [AggregateError.prototype, 'AggregateError'],
  [Error.prototype, 'Error'],
];

/**
 * A fixed category, never text taken from the thrown value. A non-object is its `typeof`; an object
 * is the nearest BUILT-IN error class on its prototype chain (a custom `class PaymentError extends
 * Error` is `Error`, whatever it is called); anything else is `object`. The chain is walked through
 * `Object.getPrototypeOf` only and compared by identity, so no property of the error is read and its
 * `constructor` or `name` cannot influence the result. `unknown`: the chain could not be inspected
 * (e.g. a proxy whose traps throw).
 */
function errorTypeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return typeof error;
  try {
    let holder: unknown = Object.getPrototypeOf(error);
    for (let depth = 0; depth < 100 && typeof holder === 'object' && holder !== null; depth += 1) {
      const category = ERROR_CATEGORIES.find(([prototype]) => prototype === holder);
      if (category) return category[1];
      holder = Object.getPrototypeOf(holder);
    }
    return 'object';
  } catch {
    return 'unknown';
  }
}
