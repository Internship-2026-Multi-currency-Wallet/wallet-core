# wallet-core

The core backend of the white-label multi-currency wallet: authentication & users, staff permissions,
client settings, ledger & balances, conversions, transfers, withdrawals and card top-ups.

Today this repository is a **skeleton**: a NestJS + GraphQL service with health checks and the
_seams_ (dev auth, permissions, settings, rates, events) that let you build features before the
real parts exist. The features themselves are your tasks.

## Stack

NestJS 12 · GraphQL (Apollo Server 5, code-first) · Knex + MySQL 8 · Redis (ioredis) · Jest · ESLint + Prettier ·
Node.js 26 (ES modules, TypeScript 6).

## Run locally

Prerequisites: Node.js 26 (`nvm use`), Docker, and the `ops` repository cloned next to this one (`../ops`).
MySQL and Redis come from `ops`; `npm run infra` calls `../ops/dev.sh` from here:

```sh
npm run infra:up              # MySQL (all databases) + Redis only — no application services
npm install
cp .env.example .env          # optional: the defaults match the ops stack
npm run migrate
DEV_AUTH=true npm run start:dev
```

- GraphQL: <http://localhost:3000/graphql> (Apollo Sandbox in the browser)
- Health: <http://localhost:3000/health> (`200` with `status: degraded` when only Redis is down, `503` when MySQL is down)

Need another service as well? Run it in Docker next to yours, e.g. `npm run infra -- up rates-service`
(several names allowed, `all` = the whole system). Containers reach this service at
`http://host.docker.internal:3000`; it reaches them at `localhost:<port>`. Do not start this service in Docker
while you run it from source (same port).

| Script                             | What it does                                                         |
| ---------------------------------- | -------------------------------------------------------------------- |
| `npm run infra:up`                 | `../ops/dev.sh up`: infrastructure only                              |
| `npm run infra -- up <service...>` | Infrastructure + these services in containers (`all` = everything)   |
| `npm run infra:ps` / `infra:down`  | Status / stop the stack (data is kept)                               |
| `npm run infra -- <command>`       | Any `dev.sh` command: `logs <service>`, `build <service>`, `info`, … |

`./dev.sh up` prints the ports and the env values (`DATABASE_URL`, `REDIS_URL`, URLs of the other services). Docker
needs little memory for the infrastructure; images are built one at a time — give Docker at least 4 GiB if you
run the whole stack. Details: the `ops` README.

```sh
curl -s localhost:3000/graphql -H 'content-type: application/json' \
  -H 'Authorization: Dev 1:wallet' -d '{"query":"{ me { id permissions } }"}'
```

## Scripts

| Script                                        | What it does                                                          |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `npm run start:dev`                           | Start with watch mode (also regenerates `schema.graphql`)             |
| `npm run build` / `npm run start:prod`        | Compile to `dist/` / run the compiled app                             |
| `npm run lint` / `npm run format`             | ESLint (type-aware) / Prettier                                        |
| `npm run typecheck`                           | `tsc --noEmit` over sources, tests and scripts                        |
| `npm test`                                    | Unit tests (`src/**/*.spec.ts`), no database needed                   |
| `npm run test:e2e`                            | End-to-end tests (`test/*.e2e-spec.ts`) against real MySQL + Redis    |
| `npm run test:cov`                            | Unit tests with coverage                                              |
| `npm run schema:generate`                     | Write `schema.graphql` from the resolvers without starting the server |
| `npm run staff:create-admin [-- email]`       | Invite the first admin or re-issue a link (link shown only locally)   |
| `npm run ledger:verify`                       | Check the ledger invariants on the database; exit 1 on a mismatch     |
| `npm run migrate`                             | Apply pending Knex migrations                                         |
| `npm run migrate:make -- <name>`              | Create `migrations/<timestamp>_<name>.ts`                             |
| `npm run migrate:rollback` / `migrate:status` | Roll back the last batch / list migrations                            |

## Environment variables

Validated at startup (`src/config/env.schema.ts`); an invalid value stops the service with a clear message.
See `.env.example`.

| Variable                   | Default                                            | Meaning                                                                                                  |
| -------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `PORT`                     | `3000`                                             | HTTP port                                                                                                |
| `METRICS_PORT`             | `9464`                                             | Internal port of `GET /metrics` (see [Metrics](#metrics)). Must differ from `PORT`                       |
| `METRICS_HOST`             | `127.0.0.1` (Docker image: `0.0.0.0`)              | Address `GET /metrics` listens on                                                                        |
| `NODE_ENV`                 | `development`                                      | `production` disables writing `schema.graphql`                                                           |
| `APP_ENV`                  | `local`                                            | Environment: `local`, `staging`, `kvitka-uat`, `wisla-uat`. Prefix of all Redis keys                     |
| `DATABASE_URL`             | `mysql://wallet:wallet@localhost:3306/wallet_core` | MySQL database of this service                                                                           |
| `REDIS_URL`                | `redis://localhost:6379`                           | Redis for events and the email queue                                                                     |
| `CLIENT`                   | `demo`                                             | Client this deployment serves: `demo`, `kvitka`, `wisla`                                                 |
| `DEV_AUTH`                 | `false`                                            | Accept `Authorization: Dev …` headers (see below). Refused at startup when `APP_ENV` is a client UAT     |
| `EMAIL_PREVIEW_ENABLED`    | `false`                                            | Serve email template previews at `/dev/email-preview`. Refused at startup when `APP_ENV` is a client UAT |
| `EMAIL_TRANSPORT`          | `smtp`                                             | `resend`, `smtp` or `fake`. Production outside `local` requires `resend`                                 |
| `EMAIL_FROM`               | `no-reply@wallet.shatori.com`                      | Sender address of all emails                                                                             |
| `RESEND_API_KEY`           | unset                                              | Resend API key. Required with `EMAIL_TRANSPORT=resend`                                                   |
| `SMTP_URL`                 | `smtp://localhost:1025`                            | SMTP server for `EMAIL_TRANSPORT=smtp` (`smtp:` or `smtps:`), Mailpit locally                            |
| `CORS_ORIGINS`             | `http://localhost:5173,http://localhost:5174`      | Allowed browser origins                                                                                  |
| `BACKOFFICE_URL`           | `http://localhost:5174`                            | Back office URL for staff email links; required in production, not a local host                          |
| `BOOTSTRAP_ADMIN_EMAIL`    | empty                                              | Invite this admin on start when no admin exists in any status (ignored otherwise)                        |
| `APP_VERSION`              | from `package.json`                                | Version reported by `health`                                                                             |
| `LOG_LEVEL`                | `info`                                             | Log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                                  |
| `JWT_SECRET`               | local-only value (`.env.example`)                  | HS256 secret shared with rates-service and treasury-service. Required with `NODE_ENV=production`         |
| `JWT_ISSUER`               | `wallet-core`                                      | `iss` claim of the issued tokens                                                                         |
| `JWT_ACCESS_TTL`           | `15m`                                              | Access token lifetime: `<number><s\|m\|h\|d>`                                                            |
| `JWT_REFRESH_TTL`          | `30d`                                              | Session (refresh token) lifetime, counted from login                                                     |
| `THROTTLE_TTL_SECONDS`     | `60`                                               | Length of the rate-limit window, in seconds                                                              |
| `THROTTLE_LIMIT_ANONYMOUS` | `120`                                              | Requests per window without a token (counted per client IP)                                              |
| `THROTTLE_LIMIT_USER`      | `600`                                              | Requests per window for a logged-in user or staff member (counted per id)                                |

## GraphQL contract

The schema is **code-first**: resolvers and `@ObjectType`s are the source of truth, and the generated
`schema.graphql` at the repository root is **committed**. It is the contract other repositories
(`client-web`, `back-office`, other services) build against — the frontends download it from `main`.

- `npm run start:dev` and the e2e tests regenerate it; `npm run schema:generate` does it without a database.
- A PR that changes the API must include the regenerated `schema.graphql`. That diff is what consumers review.

Current API: `health { service version appEnv client db redis }` (public) and `me { id kind permissions strategy }`.
Ledger: query `balances`, subscription `balanceChanged` (live changes of the caller) and mutation `testCredit` (local and staging only).

## Ledger

Double-entry bookkeeping in `src/ledger/`: money only moves as an **operation**, a set of signed **entries** that sum to zero
in every currency. Amounts are integers in minor units (`bigint` in code, text in GraphQL).

| Table        | Holds                                                                                   |
| ------------ | --------------------------------------------------------------------------------------- |
| `accounts`   | One row per owner and currency, with the stored `balance` and `version`                 |
| `operations` | One row per posting: `type`, a globally unique `idempotency_key`, a content fingerprint |
| `entries`    | The signed lines of an operation. Never updated or deleted                              |

Account types: `user` (created by the first posting that names it), `platform` (`funding` is the source of top-ups and
test credits) and `external`.

A feature posts through `LedgerService` (never through SQL) and prefixes the idempotency key with the operation type:

```ts
await this.ledger.post({
  type: 'transfer', // add the type to OperationType in ledger.types.ts
  idempotencyKey: `transfer:${transferId}`,
  entries: [
    { account: userAccount(senderId, 'UAH'), amount: -amount },
    { account: userAccount(receiverId, 'UAH'), amount },
  ],
});
```

- **Rules.** Each currency of an operation sums to zero (otherwise a plain `Error`: a bug in the caller). A user balance never
  goes below zero: `INSUFFICIENT_FUNDS`. Platform and external accounts may. They must already exist
  (created by a migration or the feature's setup), otherwise `post` throws `Unknown ledger account`.
- **Idempotency.** The same key and the same content is a replay: `replayed: true`, nothing is written, so do not repeat side
  effects. The same key with other content is `IDEMPOTENCY_CONFLICT`.
- **Stored balance and `version`.** `balance` is kept equal to the sum of the account's entries in the same transaction. `version`
  grows by 1 each time a posting writes the account.
- **Live updates.** After a new posting commits, `balance.changed` is published per affected user (Redis pub/sub, a UI hint,
  not a guarantee) and reaches the client as the `balanceChanged` subscription. A frontend subscribes first, then reads
  `balances`, and keeps the value with the larger `version`.
- **`testCredit`** mints fake money from `funding`. It is in the schema everywhere, but answers `NOT_FOUND` on `kvitka-uat` and `wisla-uat`.
- **`npm run ledger:verify`** recomputes the invariants from the entries and exits with 1 on a mismatch: stored balance =
  sum of entries, each currency and each operation sums to zero, `version` = number of operations on the account. It only
  reads (one consistent snapshot, so it is safe on a running system), needs only the database and lists at most 20
  rows per check. Run it after a migration or when a balance looks wrong. Locally: `npm run ledger:verify`. In a deployed
  container there is no Nest CLI and no `src` (only `dist` and the production dependencies): `node dist/ledger-verify.js`.
- **Local database drift.** A database used by the ledger e2e tests before they restored the `funding` version may show a
  `version` mismatch; `npm run migrate:rollback && npm run migrate` resets the ledger tables.

## Rate limits

Every request that reaches a resolver or a controller is counted against a key, and once the limit is reached
further requests are refused until the window ends. The global guard lives in `src/throttling` (`@nestjs/throttler`
with our own Redis storage). It runs after `AuthGuard`, so it knows who the caller is.

| Caller          | Key              | Default limit per window |
| --------------- | ---------------- | ------------------------ |
| Not logged in   | `ip:<client IP>` | 120                      |
| Logged-in user  | `user:<id>`      | 600                      |
| Logged-in staff | `staff:<id>`     | 600                      |

The window is 60 seconds. Limits and window come from `THROTTLE_LIMIT_ANONYMOUS`, `THROTTLE_LIMIT_USER` and
`THROTTLE_TTL_SECONDS` (see the environment variables above). To change a limit on an environment, set the variable
there (the mentor does it in Dokploy) and redeploy.

- **Fixed window.** The first request starts the window. Once the limit is exceeded, requests are refused until that
  window ends: limit hit at 0:10 of a 60 s window means refused until 1:00, not until 1:10. `Retry-After` is the
  number of seconds left in the window.
- **One HTTP request counts once**, however many top-level fields a GraphQL request has.
- **Shared and per service.** Counters live in Redis under `<APP_ENV>:throttle:<service>:<key>` (e.g.
  `staging:throttle:wallet-core:user:42`), so all instances of a service share them and they survive a restart.
  The service name in the key makes each service count on its own, although all backends share one Redis.
- **Client IP.** Express trusts one proxy hop (`trust proxy = 1`, `src/configure-app.ts`, because Traefik is the
  only proxy), so the IP is the last `X-Forwarded-For` entry. A client cannot invent a new IP by adding entries.
- **Not counted:** `GET /health` (the controller is marked `@SkipThrottle()`), `GET /metrics` (its own HTTP server on
  `METRICS_PORT`, outside Nest, so no guard runs) and everything that arrives over the WebSocket (subscriptions).
  The GraphQL query `health` is counted like any other query.
- **Known limits (follow-ups):** a guard runs only when a resolver or controller is about to be called, so these
  requests are not counted: refused by `AuthGuard` (401) or `PermissionGuard` (403), GraphQL introspection
  (`__schema`, `__type`), and GraphQL documents that cannot be parsed or fail validation.
- **Logging.** Only the first refused request of a caller in a window is logged (`request throttled`), so a flood of
  refused requests does not flood the logs.
- **Redis down.** Requests pass without a limit and a warning is logged at most once a minute. The `X-RateLimit-*`
  headers then show a full budget and mean nothing.
- An allowed response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds left);
  a refused one carries `Retry-After`.

### Error format (the contract for frontends)

GraphQL (the HTTP status stays 200, as for any GraphQL error):

```json
{
  "errors": [
    {
      "message": "Too many requests, try again later",
      "extensions": { "code": "TOO_MANY_REQUESTS", "retryAfterSeconds": 42 }
    }
  ]
}
```

REST: status `429` and the header `Retry-After: 42`. In both cases the number is the seconds until the window ends;
wait that long before retrying.

| Code                | When                        | Extra fields        |
| ------------------- | --------------------------- | ------------------- |
| `TOO_MANY_REQUESTS` | the limit of the key is hit | `retryAfterSeconds` |

## Logging

Structured JSON logs via [`nestjs-pino`](https://github.com/iamolegga/nestjs-pino) (`src/logging/`). One line per
event with `time`, `level`, `service`, `appEnv`, `client`, `context` (class) and `msg`; inside an HTTP request, a
GraphQL operation or an event handler also `requestId`. Locally (`npm run start:dev`, `NODE_ENV=development`) the
output is pretty-printed; deployed it is JSON and goes to Grafana (<https://logs.wallet.shatori.com>, see the
handbook's `logging.md`).

```ts
constructor(@InjectPinoLogger(LedgerService.name) private readonly logger: PinoLogger) {}

this.logger.info({ userId, conversionId, amount }, 'conversion booked'); // fields first, then a message
this.logger.error({ err, conversionId }, 'conversion failed'); // pass errors as `err`
```

- **`requestId`**: taken from the incoming `x-request-id` header (or generated) and returned in the response
  header. GraphQL subscriptions get one per websocket connection (`x-request-id` in `connectionParams`).
  `EventPublisher` puts it into the event meta and `EventSubscriber` handlers log with the same id, so one search
  shows a request across services. `POST /diagnostics/ping` (authenticated) publishes `system.ping`, which every
  backend logs — a quick end-to-end trace check.
- **Access log**: one line per HTTP request — method, path, GraphQL operation (`query Me`), status, `durationMs`.
  No bodies, no headers. `/health` probes are logged at `debug`.
- **Secrets are redacted** (`authorization`, `cookie`, `password`, `token`, `secret`, `apiKey`, … at any of the
  first four levels; see `SECRET_KEYS` in `src/logging/logger.options.ts`). Still: never log secrets or whole
  request objects on purpose.
- **`LOG_LEVEL`**: `fatal`, `error`, `warn`, `info` (default), `debug`, `trace`, `silent` (e2e tests default to `silent`).
- Do not use `console.*` or `new Logger()` from `@nestjs/common` in application code.

## Metrics

Prometheus metrics via [`prom-client`](https://github.com/siimon/prom-client) (`src/metrics/`). Alloy scrapes them
every 15 s and Grafana shows them on the _Server_ and _Services_ dashboards (see the handbook's `metrics.md`).

- **Where**: `GET /metrics` on its own small HTTP server on `METRICS_PORT` (default `9464`), not on `PORT`;
  `GET /metrics` on the app port is a 404. If the port is busy, the service starts anyway and logs an error. Running
  several backends from source, give each its own port (`METRICS_PORT=9465 npm run start:dev`).
- **Who can reach it**: run directly on a machine, the server listens on `127.0.0.1` only (`METRICS_HOST`). The
  Docker image sets `METRICS_HOST=0.0.0.0`: the port is not published, so only containers on the same Docker
  network (Alloy, on the server: other apps on `dokploy-network`) reach it, never the internet. Traefik routes the
  public domain to `PORT` only. Metrics carry no ids, amounts or secrets.
- **Labels on every series**: `service` (`wallet-core`) and `env` (`APP_ENV`).

| Metric                          | Type      | Labels              | Meaning                                                                   |
| ------------------------------- | --------- | ------------------- | ------------------------------------------------------------------------- |
| `http_requests_total`           | counter   | `operation, status` | HTTP requests, except `/health`, `/metrics` and CORS preflights           |
| `http_request_duration_seconds` | histogram | `operation`         | Request duration; buckets 5 ms … 10 s                                     |
| `graphql_errors_total`          | counter   | `operation, code`   | Failed GraphQL requests by the error code the client sees (once per code) |
| `graphql_ws_connections`        | gauge     | —                   | Open GraphQL websocket connections                                        |
| `events_published_total`        | counter   | `type`              | Events published through `EventPublisher`                                 |
| `process_*`, `nodejs_*`         | default   | —                   | CPU, memory, heap, event-loop lag, GC, start time (prom-client defaults)  |

- **`operation`**: the operation type and its first root field (`query me`, `mutation convert`), or the route of a
  REST request (`POST /diagnostics/ping`). The client's own operation name is not used, because any client can
  invent names and every new one would be a new time series. Unparsable GraphQL, requests that matched no route and
  anything past the cap of 100 distinct values go into one bucket, `(unknown)`.
- **Websocket operations**: they add to `graphql_errors_total` but not to `http_requests_total`, so an error ratio
  for an operation that also runs over the websocket can go above 100%. A subscription counts a code once per event
  that fails, not once per subscription. Errors raised before execution (parse, validation) are
  `GRAPHQL_VALIDATION_FAILED` under `(unknown)`, as over HTTP.
- **Adding a metric**: inject `Metrics` and create it once, in the constructor or factory, with bounded labels only:

```ts
constructor(@Inject(Metrics) metrics: Metrics) {
  this.published = metrics.counter({
    name: 'events_published_total',
    help: 'Events published, by event type',
    labelNames: ['type'],
  });
}

this.published.inc({ type: name });
```

- **Label rules**: every distinct label value is a new time series in Prometheus. Never use user ids, request ids,
  amounts, emails or free text as label values; those belong in logs.
- **Check locally**: `curl localhost:9464/metrics`.

## Seams

Seams let you write business logic now and swap the stand-in for the real thing later without touching that logic.

### Auth — `src/auth`

A global `AuthGuard` asks the registered `AuthStrategy` list who the caller is. Every endpoint requires
authentication unless it is marked `@Public()`.

Real users send the access token from `login`: `Authorization: Bearer <jwt>`. `JwtAuthStrategy` verifies it
locally (HS256 with `JWT_SECRET`, issuer, expiry, claims), the same way rates-service and treasury-service do.
The token's `aud` says who it is for: `wallet` gives `user.kind = 'client'`, `backoffice` gives `'staff'`
(`KIND_BY_AUDIENCE` in `src/auth/access-token.ts`). A token without a known `aud` gets 401.
`me` accepts both token kinds (client and staff) and returns `kind`.

With `DEV_AUTH=true` the `DevAuthStrategy` also accepts:

```
Authorization: Dev <userId>:<perm1,perm2>
Authorization: Dev 1:wallet
Authorization: Dev 100:bo:users,bo:users:modify
```

It works for HTTP, GraphQL queries/mutations and GraphQL subscriptions (send `{ "Authorization": "Dev 1:wallet" }`
as graphql-ws `connectionParams`). With `DEV_AUTH=false` only the Bearer token is accepted.
The header has no user type yet (E1-13): a `bo` or `bo:…` permission makes the dev user `staff`, else `client`.

`DEV_AUTH=true` is allowed only with `APP_ENV=local` or `staging`; in a client UAT (`*-uat`) the service refuses to start.

```ts
@Query(() => Balance)
balance(@CurrentUser() user: AuthUser) { /* user.id, user.kind, user.permissions */ }

@Public()
@Query(() => PublicSettings)
publicSettings() { ... }
```

**Another way to authenticate:** implement `AuthStrategy` (`src/auth/auth-strategy.ts`) and register it in
`AuthModule` under `AUTH_STRATEGIES`. Nothing else changes.

### Permissions — `src/permissions`

```ts
@RequirePermission('bo:users:modify')
@Mutation(() => User)
blockUser(...) { ... }
```

All listed permissions are required (class-level or method-level); missing → **403**. In dev mode you choose the
permissions in the header, e.g. `Dev 100:bo:users,bo:users:modify`.

#### Staff roles

Staff permissions and roles are defined in one file, `src/staff/permissions.ts`. Names follow
`bo:<area>` (view) and `bo:<area>:modify` (change). Only permissions that guard an endpoint exist; a new
back-office feature adds its own permissions there and extends the roles.

| Permission           | Guards                                                                        |
| -------------------- | ----------------------------------------------------------------------------- |
| `bo`                 | Every staff member: `staffMe`, `changeOwnStaffPassword`. Never given to users |
| `bo:staff`           | `staffMembers`                                                                |
| `bo:staff:modify`    | `inviteStaff`, `resendStaffInvitation`, `deactivateStaff`, `changeStaffRole`  |
| `bo:settings`        | `staffSettings`, `settingHistory`                                             |
| `bo:settings:modify` | `updateSetting`, `resetSetting`                                               |

| Role         | Permissions                                                             |
| ------------ | ----------------------------------------------------------------------- |
| `ADMIN`      | all of the above                                                        |
| `FINANCE`    | `bo`, `bo:settings`, `bo:settings:modify` (`bo:users` comes with users) |
| `SUPPORT`    | `bo` (users and transactions views come with their features)            |
| `COMPLIANCE` | `bo` (KYC review and transactions views come with their features)       |

In dev mode act as a staff member with e.g. `Dev 1:bo,bo:staff,bo:staff:modify`.

#### Staff sessions

`staffLogin` is separate from the user `login`. The session lasts 8 hours from login and is not extended. The
refresh token travels only in the httpOnly `staff_refresh_token` cookie (path `/graphql`, SameSite=Strict), never in
the user's `refresh_token`. Lockout works as for users: 5 wrong passwords in a row lock the account for 15 minutes
(`ACCOUNT_LOCKED`). `staffLogout` ends the cookie's session and clears the cookie.
`staffRefreshSession` rotates the cookie and issues an access token with the current role; it does not extend the session, and a user `refresh_token` cookie never works on it (nor the staff cookie on `refreshSession`).

### Client settings — `src/settings`

```ts
const phone = await settings.get('auth.phoneRequiredAt'); // 'signup' | 'firstTransfer' | 'never'
const google = await settings.get('auth.googleLogin'); // boolean
```

`ClientSettingsService.get(key)` is typed by `settingsCatalog` in `src/settings/settings.schema.ts`. **Defaults live in
the code**: each setting has a zod schema, a default and a `public` flag, so a fresh environment works with an empty
database. The database keeps **only overrides** (`client_settings`; one environment = one client = one database) and
every change in `client_setting_changes` (who, when, old → new). No override → the default applies; a stored value
that fails the schema is ignored with a warning. Every read goes to the database, so a change applies without a redeploy.

To add a setting: add one line to `settingsCatalog` (`schema`, `default`, `public`). Public settings reach the client
apps (`publicSettings`); staff read and change all of them (`staffSettings`, `updateSetting`, `resetSetting`,
`settingHistory`) with `bo:settings` / `bo:settings:modify`.

### Current client — `AppConfig`

`AppConfig.client` is the `CLIENT` this deployment serves. Inject `AppConfig` instead of reading `process.env`.
Client-specific behaviour (hooks, client-only endpoints and fields) is described in [CUSTOMIZATIONS.md](CUSTOMIZATIONS.md).

### Rates — `src/rates`

```ts
constructor(@Inject(RATES_CLIENT) private readonly rates: RatesClient) {}
const { mid } = await this.rates.getRate('USD', 'UAH'); // '41.50000000'
```

Bound to `FixedRatesClient` (fixed UAH/USD/EUR/PLN/USDT rates, exact cross rates via USD). When `rates-service`
is live, bind the real client in `RatesModule`.

### Email — `src/email`

```ts
constructor(private readonly email: EmailService) {}
await this.email.send('staffInvitation', to, { link });
```

With `EMAIL_TRANSPORT=fake` (the default for tests) it is bound to `FakeEmailService`: it delivers nothing, keeps the
last 1000 calls in `sent`, and logs only the template (never the link or recipient). In tests read recordings via
`(app.get(EmailService) as FakeEmailService).sent`, or override `EmailService` with your own `FakeEmailService`
instance. No BullMQ objects are created in fake mode.

**Delivery.** With `EMAIL_TRANSPORT=resend|smtp`, `send()` only enqueues a job on the BullMQ queue `email` (Redis keys
`<APP_ENV>:email:*`) and resolves once it is stored; if Redis does not answer within 5 s it rejects with
`EmailEnqueueError`; such a send may still be delivered later if Redis comes back (the add can land late), so do not
treat it as "definitely not sent". `EmailWorker` (5 concurrent jobs) renders the template and sends it through the transport with the
idempotency key `<APP_ENV>/<job id>`, so a re-run does not duplicate mail on Resend. A failed send is retried up to
8 attempts with exponential backoff (5 s, 10 s, 20 s, ...). A permanent transport error (`retryable: false`) fails the
job at once. Failed jobs are kept for 48 hours (at most 1000). Logs carry job id, template and attempt, never the
recipient, data or link.
While Redis is down, queue and worker reconnect with backoff.

**Shutdown.** The worker stops taking jobs and gives running sends a grace period of 3 s to finish and have their
outcome recorded in Redis, then closes without waiting for Redis. Closing does not cancel a send that is still running:
it may complete, fail or be cut off when the process exits, and its outcome is not recorded. The job stays active and
BullMQ's stalled-job check puts it back in the queue once its 30 s lock expires (when a worker runs again), so it may
be sent twice: Resend deduplicates by the idempotency key, SMTP does not. This is separate from the uncertain outcome
of a timed-out enqueue above, which exists with or without a shutdown.

**Local delivery with Mailpit.** If `ops` does not start Mailpit yet, run it yourself
(`docker run -p 1025:1025 -p 8025:8025 axllent/mailpit`), set `EMAIL_TRANSPORT=smtp` and `SMTP_URL=smtp://localhost:1025`
(as in `.env.example`), then read the mail at http://localhost:8025.

Notes: the e2e tests use the `staging:email` prefix on the local Redis, so they do not interfere with a local dev server (`local:email`).

**Preview.** With `EMAIL_PREVIEW_ENABLED=true` (only `local` and `staging`; `.env.example` enables it) the service
serves `GET /dev/email-preview` (list of templates) and `GET /dev/email-preview/<name>` (the rendered HTML with
sample data). No authentication; with the flag off both answer 404.

**Adding a template:**

1. Add its data type to `EmailTemplates` in `src/email/email.service.ts`.
2. Create `src/email/templates/<name>.ts` exporting a function that returns `Content` (`subject`, `text`, body).
3. Register it in `builders` and `sampleData` in `src/email/templates/index.ts`.
4. Check it in the preview at `/dev/email-preview/<name>`.
5. Add a render test to `src/email/templates/render.spec.ts`.

### Events — `src/events`

`catalog.ts` is the typed contract for Redis events, **identical in all three backends**:

| Event                  | Transport                       | Name                          |
| ---------------------- | ------------------------------- | ----------------------------- |
| `rate.tick`            | Redis pub/sub (fire-and-forget) | channel `rate.tick`           |
| `conversion.completed` | Redis Stream (must not be lost) | stream `conversion.completed` |
| `balance.changed`      | Redis pub/sub (live UI hint)    | channel `balance.changed`     |
| `system.ping`          | Redis pub/sub (diagnostics)     | channel `system.ping`         |

```ts
await publisher.publish('conversion.completed', event); // XADD
const off = await subscriber.subscribe('rate.tick', (tick, meta) => ...); // SUBSCRIBE; meta.requestId
```

Stream consumers use consumer groups (`XREADGROUP` + `XACK`) and `decodeStreamEntry()`.
Change the catalog only via a contract PR in all three repositories.

**Redis down.** The service starts and keeps serving without Redis. A publication made while disconnected fails at
once (`POST /diagnostics/ping` answers `503`) and is never sent later. Subscriptions are restored automatically when
Redis is back, and `subscribe()` resolves only once Redis has confirmed the subscription. An in-flight command may be
resent after reconnect; a timeout does not prove non-delivery.

**Environment prefix.** Several environments may share one Redis, so every channel and stream is prefixed with
`APP_ENV`: `staging:rate.tick`, `kvitka-uat:conversion.completed`. The helpers add the prefix; when you need a raw
name (e.g. a stream consumer) use `eventStream(appConfig.appEnv, 'conversion.completed')` / `eventChannel(...)`.

## Project layout

```
src/
  auth/          dev auth seam: AuthGuard, AuthStrategy, @CurrentUser, @Public, `me`
  permissions/   @RequirePermission + guard
  settings/      ClientSettingsService (settingsCatalog defaults + DB overrides) and the settings API
  rates/         RatesClient + FixedRatesClient
  email/         EmailService contract, queue + worker, FakeEmailService
  events/        event catalog + publisher/subscriber
  health/        GET /health and `health` query
  config/        env validation + AppConfig
  database/      Knex (KNEX token)    redis/   ioredis (REDIS token)
  ledger/        LedgerService (double-entry postings, balances), `balances` / `balanceChanged`, ledger:verify
  graphql/       Apollo options
  metrics/       Prometheus registry, request metrics, GET /metrics on METRICS_PORT
migrations/      Knex migrations (timestamped)
test/            e2e tests
schema.graphql   generated GraphQL contract (committed)
```

One module per feature (`src/ledger/`, `src/conversion/`, …). Shared files (`app.module.ts`, `schema.graphql`)
change in small, dedicated PRs.

## Deployment

Every push to `main` (→ `staging`), `client/kvitka-uat` and `client/wisla-uat` runs `.github/workflows/deploy.yml`,
a thin caller of `ops/.github/workflows/deploy-service.yml`: the image is built in GitHub Actions, pushed to
`ghcr.io/internship-2026-multi-currency-wallet/wallet-core:<env>-<sha>` (and `<env>-latest`), the environment's Dokploy
application is redeployed, and the job waits until `/health` reports the new commit SHA as `version`.
The container runs `npm run migrate && node dist/main.js`, so migrations are applied on every deploy.

| Environment  | Branch              | URL                                                                     | `CLIENT` | `DEV_AUTH` |
| ------------ | ------------------- | ----------------------------------------------------------------------- | -------- | ---------- |
| `staging`    | `main`              | <https://staging-wallet-core.wallet.shatori.com/graphql> · `/health`    | `demo`   | `true`     |
| `kvitka-uat` | `client/kvitka-uat` | <https://kvitka-uat-wallet-core.wallet.shatori.com/graphql> · `/health` | `kvitka` | `false`    |
| `wisla-uat`  | `client/wisla-uat`  | <https://wisla-uat-wallet-core.wallet.shatori.com/graphql> · `/health`  | `wisla`  | `false`    |

Deployed configuration (set in Dokploy, not in Git): `APP_ENV`, `CLIENT`, `DEV_AUTH`, `DATABASE_URL` (database
`<env>_wallet_core`), `REDIS_URL`, `CORS_ORIGINS` (`https://<env>.wallet.shatori.com`,
`https://<env>-admin.wallet.shatori.com`), `NODE_OPTIONS`; `APP_VERSION` is baked into the image by CI.
Details: the `ops` README (_Deployment_).

## Docker

```sh
docker build -t wallet-core .
docker run --rm -p 3000:3000 -e DATABASE_URL=... -e REDIS_URL=... wallet-core
```

Multi-stage build on `node:26-alpine`, runs as the non-root `node` user. Run migrations with
`npm run migrate` inside the container (the `ops` compose stack does this on start).
