# Client customization

wallet-core serves several clients (`kvitka`, `wisla`, `demo`) from **one codebase and one schema**.
This document says how a client may differ from the platform, which tool to reach for, and how
each tool works. The code lives in `src/customizations/`.

> **Status.**
>
> - **Wired into the application:** `AppModule` imports `CustomizationsModule` before `AuthModule`;
>   `CustomizationsCoreModule` registers `ClientAvailabilityGuard` as a global guard (it runs before
>   `AuthGuard` and `PermissionGuard`) and provides `ClientAvailabilityValidator`; `graphqlOptions()`
>   sets `transformSchema: restrictClientFields(config.client)`. See [Wiring](#7-wiring).
> - **Covered on the real `AppModule`** (without MySQL or Redis) for `demo`, `kvitka` and `wisla`:
>   guard order, root endpoints, fields, graphql-ws, logging and startup validation.
>
> Nothing in production code uses `@Customizable`, `@ClientHook`, `@ClientFeature` or
> `@ClientDisabled` yet.

## 1. Which tool, when

Pick the first row that fits.

| The client needs…                                                  | Use                                        | Why                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------- |
| A different **value** (a flag, a limit, a list)                    | A **setting** (`ClientSettingsService`)    | Data, no code. One line in `settingsCatalog`.                             |
| The same flow with **extra behaviour** before or after a core step | A **hook** (`@Customizable`/`@ClientHook`) | Core code stays client-agnostic; the extra step lives in a client module. |
| An endpoint or a field that **only one client has**                | **`@ClientFeature('<client>')`**           | One shared schema, restricted at runtime.                                 |
| A core endpoint or field that a client **must not have**           | **`@ClientDisabled('<client>')`**          | Same mechanism, as a deny-list.                                           |
| Something that none of the above can express                       | A **client branch**, as a last resort      | Diverges from main; talk to the team first.                               |

Rules that go with every row:

- **No `if (client === 'kvitka')` in core code.** Ask `AppConfig.client` only inside a client module
  (to decide whether it is the active one) and never to branch core behaviour.
- A setting is read with `ClientSettingsService.get('<key>')`; see `src/settings/settings.schema.ts`.
- Hooks and client modules live under `src/customizations/clients/<client>/`. Core modules never
  import from there (ESLint enforces it: `no-restricted-imports`).

### The configured client: `AppConfig.client`

The client of a deployment is `AppConfig.client`, taken from the `CLIENT` environment variable
(`demo`, `kvitka`, `wisla`; default `demo`). There is **no separate `ClientConfig`**: one validated
config object is the single source, and a second abstraction would only forward to it. Everything
in this document (the client modules, the guard, the schema transform) reads `AppConfig.client`.

## 2. How the pieces fit

```
main.ts ─► AppModule ─► CustomizationsModule          (imported before AuthModule)
                          ├─ CustomizationsCoreModule
                          │    ├─ HookRegistry          (per application)
                          │    ├─ ClientHookActivator
                          │    ├─ ClientAvailabilityValidator
                          │    └─ APP_GUARD: ClientAvailabilityGuard
                          ├─ KvitkaModule ┐ onModuleInit:  if (config.client !== me) return;
                          ├─ WislaModule  ├─                activator.subscribe(me)
                          └─ DemoModule   ┘

boot:   onModuleInit (every client module decides)  ─►  onApplicationBootstrap (activator commits)
call:   service.execute() ─► wrapper ─► before hooks ─► original method ─► after hooks

availability:
   @ClientFeature / @ClientDisabled  ──►  metadata  +  field @Extensions
        root endpoint  ──►  ClientAvailabilityGuard  (global, before auth)      ─► NotFoundException
        field          ──►  restrictClientFields     (transformSchema, once)    ─► NotFoundException
        startup        ──►  ClientAvailabilityValidator + checks inside the transform
```

## 3. Hooks

A **hook** is a function of a client module that runs before or after a core service method,
without the core method knowing about any client.

### Marking a core method

```ts
@Injectable()
export class ConversionService {
  @Customizable() // or @Customizable({ propagateExceptions: true })
  async execute(input: ConvertInput): Promise<Conversion> {
    /* core logic */
  }
}
```

Only `async` methods of a **singleton service** can be customized. Controllers, resolvers,
request-scoped and transient providers are rejected at startup (Nest builds their handlers before
the activator runs, so a wrapper would not reliably apply).

### Writing a hook, in a client module

```ts
@Injectable()
export class KvitkaConversionHooks {
  @ClientHook('kvitka', ConversionService, 'execute', 'after')
  addCashback({ result, ctx }: AfterHook<ConversionService, 'execute'>) {
    return { result: { ...result, cashback: 10 } }; // replace the result
  }
}
```

Then list `KvitkaConversionHooks` in `providers` of `KvitkaModule`. The activator only looks at the
providers of the module that subscribed.

The compiler checks that the target is a class, the method is a public async method of it, the phase
is `'before'` or `'after'`, and the handler's parameter and return type fit that method.

### The contract

- A handler changes data only by **returning a replacement**: `{ args }` from a `before` handler,
  `{ result }` from an `after` handler. Returning nothing keeps things as they are. Assigning to the
  payload has no effect.
- `ctx` is scratch space shared by the handlers of one call.
- Handlers run in registration order; `before` hooks, then the core method (exactly once, with the
  last accepted arguments), then `after` hooks.
- If the **core method** throws, its error propagates unchanged and no `after` hook runs.
- If a **handler** fails, it is logged and skipped, and the call carries on. With
  `propagateExceptions: true` the error is rethrown instead (a failing `before` means the core
  method never runs).
- The log line holds only the target, method, phase, handler name and an error category: never the
  message, stack or values.
- There is no copy of `args` or `result` and no rollback: a handler that mutates them in place
  changes them for everyone after it.

### Lifecycle

1. Nest runs **every** `onModuleInit` first. Each client module checks `AppConfig.client` and, if it
   is the active client, calls `activator.subscribe(Module)`, which only records it.
2. Then, at `onApplicationBootstrap`, the activator does one synchronous pass:
   **preflight** (read-only: find hook methods, validate each against the active client, find the
   targets, check they can be wrapped; all problems are collected), then **install** a wrapper on each
   target method, then **register** the hooks, last.
3. If preflight finds a problem, startup fails with one error listing all of them and nothing has
   been changed. Installing a wrapper is not atomic (no rollback), but the registry is written last,
   so a wrapper that was already installed passes calls straight through.
4. Calls made before `onApplicationBootstrap` run without hooks.

Hooks written for a client other than the active one make activation fail: a hook is only valid
in its own client's module.

## 4. Adding a client

1. Add the code to `KNOWN_CLIENTS` in `src/config/env.schema.ts`, and to the `CLIENT` row of the
   README and `.env.example` if the list is quoted there.
2. Create `src/customizations/clients/<client>/<client>.module.ts`, copied from
   `kvitka.module.ts`: import `CustomizationsCoreModule`, inject `AppConfig` and the activator,
   and subscribe only when `config.client` is this client.
3. List the new module in `CustomizationsModule` (`customizations.module.ts`). That is the only
   place that names it.
4. Declare its hook providers in its `providers`, and add its tests (section 9).

`ClientFeature('<client>')` and the hook decorators accept only codes from `KNOWN_CLIENTS`; the
compiler and a runtime check both reject anything else.

## 5. Endpoint and field availability

### Root endpoint versus field

| Target                                                                   | Written as                                     | Enforced by                                | Where it applies |
| ------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------ | ---------------- |
| Resolver **class**, or a `@Query` / `@Mutation` / `@Subscription` method | `@ClientFeature(...)` / `@ClientDisabled(...)` | `ClientAvailabilityGuard` (global guard)   | Before auth      |
| **Plain `@Field`** of an object type                                     | the same decorators on the property            | `restrictClientFields` (`transformSchema`) | When resolved    |
| **`@ResolveField`** method                                               | the same decorators on the method              | `restrictClientFields`                     | When resolved    |

Why two mechanisms: Nest runs **no guard on a field resolver**, and switching on
`fieldResolverEnhancers` would run every global guard (the JWT check, the permission check) on every
field of the whole API. So fields are restricted when the schema is built instead, and cost
nothing per request.

```ts
@ObjectType()
export class Account {
  @Field() id!: string;

  @ClientFeature('wisla')
  @Field(() => String, { nullable: true, description: 'Only for wisla. Errors: NOT_FOUND' })
  wislaNote?: string | null;
}

@Resolver(() => Account)
export class AccountFieldResolver {
  @ClientFeature('wisla')
  @ResolveField(() => String, { nullable: true, description: 'Only for wisla. Errors: NOT_FOUND' })
  wislaBalance(@Parent() account: Account) {
    /* ... */
  }
}

@Resolver()
export class TransferResolver {
  @ClientDisabled('wisla')
  @Mutation(() => Boolean, { description: 'Not for wisla. Errors: NOT_FOUND' })
  cancelTransfer() {
    /* ... */
  }
}
```

### Rules

- `@ClientFeature('a', 'b')` is an **allow-list**: only the listed clients have it.
  `@ClientDisabled('a')` is a **deny-list**: every client but the listed ones has it.
- At least one client, from `KNOWN_CLIENTS`; repeats are stored once.
- Use each decorator **once per target** (list all clients in one call), and **never both on one
  target**: it is an allow-list or a deny-list. Both throw when the class is loaded.
- Restrictions only **narrow**. A restricted class with a restricted method needs the client to be
  allowed by both; a method can never widen its class. The same holds along an inheritance chain.
- The decorators go on a class, an instance method or an instance property. A getter or setter, a
  `static` member or a parameter is rejected when the class is loaded.
- The order relative to `@Field`, `@ResolveField` and other `@Extensions` does not matter.
- An overriding method is a new function: it does not carry the decorators of the method it
  overrides, but the guard still applies the overridden method's restriction (it looks methods up
  by name along the class chain). A `@ResolveField` that a derived resolver overrides under the
  **same** name keeps the base restriction (Nest keeps the first extensions it sees); overriding it
  under **another** schema name fails startup.
- **GraphQL only.** HTTP controllers (`/health`, diagnostics) are not subject to this. A global guard
  also sees HTTP requests; without metadata it lets them through. Putting the decorators on a
  controller is rejected at startup.
- Put the decorator on the **type's `@Field`** when a field is declared both with `@Field` on the
  type and with `@ResolveField` on a resolver: Nest drops a `@ResolveField`'s extensions in that
  case, and startup fails if the restriction would be lost.
- A subclass that **declares an inherited restricted field again** with `@Field` (under the same
  schema name or another, also with `@Field({ name })`) replaces the base field **together with its
  restriction** (Nest keeps only the subclass's own extensions), and one field cannot carry two
  lists. Repeat the restriction on the redeclared field: the same clients, or fewer (narrowing is
  safe and accepted). A missing or wider restriction fails startup, including an alias that exposes
  the same property under a new name. The same goes for a `@ResolveField` that redeclares a restricted
  one from a base resolver under another name.
- Do not restrict an **`@ArgsType`** class or its properties: Nest flattens it into the arguments of
  the field and keeps no extensions, so nothing would be enforced. Startup fails. Every loaded
  `@ArgsType` class is checked, used or not, because a restriction there is a mistake wherever the
  class ends up.

### A class-level restriction on a resolver that has field resolvers

A class-level `@ClientFeature` / `@ClientDisabled` is enforced by the guard on the class's
`@Query`, `@Mutation` and `@Subscription` methods. It does **not** reach the class's
`@ResolveField` methods: Nest runs no guard on them, and their field belongs to an object type that
**any other query can return**. So a client that is denied the class's root endpoints could still
reach its field resolvers through an unrestricted query. This was reproduced: with a Wisla-only
resolver, `kvitka` got `NOT_FOUND` on the resolver's own query, yet the resolver's `@ResolveField`
ran and returned its data through another query. That is a real exposure, not a style rule, so
startup **fails** (fail closed). It applies to an inherited class-level restriction too.

Restrict each endpoint and each field with its own decorator instead:

```ts
@Resolver(() => Account)
export class WislaAccountResolver {
  @ClientFeature('wisla') // root endpoint: the guard
  @Query(() => Account, { description: 'Only for wisla. Errors: NOT_FOUND' })
  wislaAccount() {
    /* ... */
  }

  @ClientFeature('wisla') // field: the schema transform
  @ResolveField(() => String, { nullable: true, description: 'Only for wisla. Errors: NOT_FOUND' })
  wislaBalance(@Parent() account: Account) {
    /* ... */
  }
}
```

A class-level restriction stays the right tool for a resolver that has root endpoints only. This
does not conflict with the approved API: field resolvers are restricted per field. Making a
class-level restriction cover the class's field resolvers automatically is possible, but must handle
inheritance and decorator order, and is not part of this task.

### Nullability

A restricted field **must be nullable**. A denial answers an error for that field and `null`; for a
non-null field GraphQL would null the whole parent object (and its parent, up to a nullable one),
taking every other field with it. The check runs for every client, including one that may use the
field, so the mistake cannot hide until a denied client calls it.

### One shared schema, runtime restriction

`schema.graphql` is the contract other repositories consume, so there are **no per-client schemas**:
the schema is identical for every client, with or without the restrictions (a test pins this), and a
hidden field remains visible to introspection. "As if it did not exist" means the **call behaves the
same way** as a missing endpoint, not that it is absent from the schema.

Add the convention to the description of every restricted field or endpoint, next to the other
errors it can return:

```
Only for <client>. Errors: NOT_FOUND
```

(for a deny-list: `Not for <client>. Errors: NOT_FOUND`).

### What a client gets

| Target        | Denied client receives                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root endpoint | The root field fails with `Not Found` (a `NotFoundException`). As for any failing root field, `data` is `null` if the field is non-null, and `{ field: null }` if it is nullable |
| Field         | A **partial response**: the field is `null` with an error at its path; other fields are present                                                                                  |

The resolver of a denied field **never runs**. A field the client may use is not touched: it keeps
the resolver Nest built, with its parent, arguments, context and info.

Example, `CLIENT=kvitka` asking for `{ account { id wislaNote } }`:

```json
{
  "data": { "account": { "id": "a1", "wislaNote": null } },
  "errors": [
    {
      "message": "Not Found",
      "path": ["account", "wislaNote"],
      "extensions": { "code": "NOT_FOUND", "status": 404 }
    }
  ]
}
```

**Exception contract.** The guard and a denied field both throw Nest's `NotFoundException` (HTTP 404,
message `Not Found`, no client, feature or reason named), as `AuthGuard` and `PermissionGuard` throw
Nest exceptions. The same exception is thrown in a GraphQL and in an HTTP context, so a single
shared error mapping covers every 404.

**Wire code.** `@nestjs/apollo` only names the codes of HTTP 400, 401, 403 and 422; the shared
`formatError` on `main` (`src/graphql/format-error.ts`) maps any Nest 404 to `extensions.code =
NOT_FOUND`, for HTTP results and, through `formatExecutionResult`, for graphql-ws results. This module
does not map codes itself: it relies on that shared mapping. `client-field-availability.integration.spec.ts`
boots Apollo with the real `graphqlOptions()`, so it asserts `NOT_FOUND` over HTTP for a denied field
and a denied root endpoint; `test/client-availability.e2e-spec.ts` asserts it on the real `AppModule`, over
HTTP and graphql-ws. The unit specs of the guard and the transform call them without Apollo, so they
assert the `NotFoundException` itself.

The shared `graphqlLoggingPlugin` logs a denied field's `NotFoundException` once, as `warn`
(`HTTP_404`, a 4xx status, without a stack), and Nest does not log it again. The guard throws the
same exception, so a denied root endpoint is logged the same way. Both are pinned on the real
`AppModule` (`test/client-availability.e2e-spec.ts`). Over graphql-ws the plugin does not run (it is an
Apollo HTTP plugin): a denial there is formatted by `formatExecutionResult` and not logged per error,
like every other graphql-ws error.

## 6. Startup validation

Mistakes stop the application at startup, with **one error listing every problem**, never at
the first request. Messages name classes, methods, types and fields, and never a value from the
metadata.

| Check                                                                                                                                | Where                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| Client codes are known; at least one; each decorator once; not both decorators on one target                                         | Decorators (when the class is loaded) |
| Extension is well formed; not both lists on one field                                                                                | `restrictClientFields` (schema build) |
| A restricted field is **nullable**                                                                                                   | `restrictClientFields`                |
| Only fields of **object types** are restricted (not an interface or an input type)                                                   | `restrictClientFields`                |
| No restriction on an **HTTP controller**                                                                                             | `ClientAvailabilityValidator`         |
| No restriction on a provider that is not a resolver (a service)                                                                      | `ClientAvailabilityValidator`         |
| A restricted resolver method is a Query, Mutation, Subscription or `@ResolveField`                                                   | `ClientAvailabilityValidator`         |
| No class-level restriction on a resolver that has `@ResolveField` methods (it would not apply)                                       | `ClientAvailabilityValidator`         |
| No restriction on the class of a GraphQL type (restrict its fields)                                                                  | `ClientAvailabilityValidator`         |
| A restricted `@ResolveField` really reached its schema field (Nest may drop it)                                                      | `ClientAvailabilityValidator`         |
| A restriction on a base type's field survives (at least as strict) a subclass that declares the field again, also under another name | `ClientAvailabilityValidator`         |
| No restriction on an `@ArgsType` class or property; none on an input-type or interface field, even if a subclass redeclares it       | `ClientAvailabilityValidator`         |
| Metadata is not malformed (forged or damaged)                                                                                        | Validator, guard, transform           |

The guard also **fails closed** at request time: malformed metadata, or a handler it cannot match to a
method on a class chain that has method-level restrictions, throws the same `NotFoundException` for
every client.

Root-endpoint restrictions are enforced by the guard; the transform deliberately skips the root
types (Query, Mutation, Subscription), so a root restriction without the guard registered is **not
enforced**. That is why the guard must be wired together with the transform.

## 7. Wiring

| Piece                         | Where                                                                  | When it runs                                                  |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| `CustomizationsModule`        | `AppModule` imports, **before** `AuthModule`                           | Scanned before the auth module                                |
| `ClientAvailabilityGuard`     | `CustomizationsCoreModule`: `{ provide: APP_GUARD, useClass: ... }`    | Every request, first of the global guards                     |
| `ClientAvailabilityValidator` | `CustomizationsCoreModule` `providers` (`DiscoveryModule` is imported) | `onApplicationBootstrap`, after the GraphQL schema is built   |
| `restrictClientFields`        | `graphqlOptions()`: `transformSchema: restrictClientFields(client)`    | Once, when the schema is built (`GraphQLModule.onModuleInit`) |

**Guard order.** Nest applies global guards in the order it scans the modules that register them
(depth first, in `imports` order). `CustomizationsModule`, and with it `CustomizationsCoreModule`,
comes before `AuthModule` in `AppModule`, so the order is `ClientAvailabilityGuard`, `AuthGuard`,
`PermissionGuard`: a hidden endpoint answers `NOT_FOUND` whatever the caller's authentication
state, and an available endpoint keeps the normal authentication and permission checks.
`auth.module.ts` is untouched. Moving `CustomizationsModule` after `AuthModule` breaks
`test/client-availability.e2e-spec.ts`, which asserts the order through `ApplicationConfig`.

The guard passes HTTP requests that carry no metadata (`/health`, the diagnostics controller, the
email template preview).

**Schema file.** `schema.graphql` is written from the schema before `transformSchema` runs
(`transformAutoSchemaFile` is not set), and the transform does not change the shape anyway, so
`npm run schema:generate` produces the same file as before. The API did not change.

**Still open.**

1. **Keep the e2e suite green** (`npm run infra:up`, then `npm run test:e2e`). The real-`AppModule`
   specs stub the Redis subscriber and use no database; the e2e suite boots the same `AppModule` on
   MySQL and Redis, so its existing `/health`, diagnostics, email-preview, auth and logging tests
   also run through the wired guard and transform.
2. **No production endpoint or field is restricted yet.** The first real `@ClientFeature` /
   `@ClientDisabled` adds the `Only for <client>. Errors: NOT_FOUND` description (section 5) and
   regenerates `schema.graphql`.
3. **Not verified on a deployed environment** (staging or a client UAT).

## 8. Not supported (on purpose)

- **Subscriptions as restricted fields.** Only the root subscription is restricted (by the guard).
  The transform wraps `resolve`, not `subscribe`.
- Restricting an **interface or input type** field, or a **GraphQL type class**.
- A restriction on a **getter, setter, static member or parameter**.
- A class-level restriction on a resolver with `@ResolveField` methods.
- A restriction on an `@ArgsType` class or property, or on a base-type field that a subclass
  declares again with a wider restriction (or none).
- Per-client **schemas**, or hiding fields from introspection.
- Hook targets that are controllers, resolvers or non-singleton providers.
- **Production demo behaviour**: demo types and demo hooks exist in tests only.

## 9. Testing

Everything is testable without MySQL or Redis, the real guard order included.

- **Per client.** Build the application config for the client under test:
  `AppConfig.fromEnv({ NODE_ENV: 'test', CLIENT: 'wisla' })`, and run the same test for
  `kvitka`, `wisla` and `demo` (`describe.each`).
- **Hooks**: see `customizations.module.spec.ts` (the production client modules with test-only hook
  providers) and `client-hook-activator.spec.ts`.
- **Field availability**: `client-field-availability.spec.ts` (the transform on plain graphql-js
  schemas) and `client-field-availability.integration.spec.ts` (a booted Nest + Apollo application
  with test-only demo types, once per client).
- **Startup validation**: `client-availability.validator.spec.ts`, and
  `client-availability.args.spec.ts` for `@ArgsType` (a file of its own, see the next point).
- **The wired application**: `test/client-availability.e2e-spec.ts` (run by `npm run test:e2e`)
  boots the real `AppModule` once per client with test-only restricted endpoints and fields: guard order, `NOT_FOUND` before
  authentication (no credentials, invalid JWT, no permissions), the normal auth flow for an allowed
  client, partial responses, graphql-ws queries and subscriptions, and logging.
  `client-availability.app-startup.spec.ts` checks that invalid metadata stops `app.init()`. Neither
  needs MySQL or Redis, so neither exercises them: the Knex pool and Redis connect lazily and
  nothing queries them, the Redis `EventSubscriber` is stubbed, and `NODE_ENV=production` keeps
  `schema.graphql` from being written.
- Nest keeps GraphQL type metadata **process-wide** (`TypeMetadataStorage`). A deliberately invalid
  `@ArgsType` class defined in a spec file is seen by every application booted in that file, so keep
  such a fixture in a spec file of its own.
- Assert **both** sides: the allowed client gets the value, the denied one gets the error **and the
  resolver did not run**. Check that unrestricted fields are unaffected.
- Define demo types and demo hooks in the test, never in `src/`.
- Run `npm run lint && npm run typecheck && npm run format:check && npm test && npm run build`;
  add `npm run test:e2e` when MySQL and Redis are up (`npm run infra:up`).

## 10. Onboarding checklist for a new client

- [ ] Code added to `KNOWN_CLIENTS`; README and `.env.example` updated.
- [ ] `clients/<client>/<client>.module.ts` created with the gate on `AppConfig.client`.
- [ ] Module listed in `CustomizationsModule`.
- [ ] Settings differences expressed as settings, not code.
- [ ] Hooks only where a core flow needs extra steps; each hook covered per client.
- [ ] Client-only endpoints and fields use `@ClientFeature`; fields are nullable and carry the
      `Only for <client>. Errors: NOT_FOUND` description.
- [ ] Tests run for every client; no `if (client === ...)` in core code.
- [ ] `schema.graphql` regenerated (`npm run schema:generate`) when the API changed.
