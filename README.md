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
- Health: <http://localhost:3000/health>

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
| `npm run migrate`                             | Apply pending Knex migrations                                         |
| `npm run migrate:make -- <name>`              | Create `migrations/<timestamp>_<name>.ts`                             |
| `npm run migrate:rollback` / `migrate:status` | Roll back the last batch / list migrations                            |

## Environment variables

Validated at startup (`src/config/env.schema.ts`); an invalid value stops the service with a clear message.
See `.env.example`.

| Variable          | Default                                            | Meaning                                                                                              |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `PORT`            | `3000`                                             | HTTP port                                                                                            |
| `METRICS_PORT`    | `9464`                                             | Internal port of `GET /metrics` (see [Metrics](#metrics)). Must differ from `PORT`                   |
| `NODE_ENV`        | `development`                                      | `production` disables writing `schema.graphql`                                                       |
| `APP_ENV`         | `local`                                            | Environment: `local`, `staging`, `kvitka-uat`, `wisla-uat`. Prefix of all Redis keys                 |
| `DATABASE_URL`    | `mysql://wallet:wallet@localhost:3306/wallet_core` | MySQL database of this service                                                                       |
| `REDIS_URL`       | `redis://localhost:6379`                           | Redis for events                                                                                     |
| `CLIENT`          | `demo`                                             | Client this deployment serves: `demo`, `kvitka`, `wisla`                                             |
| `DEV_AUTH`        | `false`                                            | Accept `Authorization: Dev …` headers (see below). Refused at startup when `APP_ENV` is a client UAT |
| `CORS_ORIGINS`    | `http://localhost:5173,http://localhost:5174`      | Allowed browser origins                                                                              |
| `APP_VERSION`     | from `package.json`                                | Version reported by `health`                                                                         |
| `LOG_LEVEL`       | `info`                                             | Log level: `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                              |
| `JWT_SECRET`      | local-only value (`.env.example`)                  | HS256 secret shared with rates-service and treasury-service. Required with `NODE_ENV=production`     |
| `JWT_ISSUER`      | `wallet-core`                                      | `iss` claim of the issued tokens                                                                     |
| `JWT_ACCESS_TTL`  | `15m`                                              | Access token lifetime: `<number><s\|m\|h\|d>`                                                        |
| `JWT_REFRESH_TTL` | `30d`                                              | Session (refresh token) lifetime, counted from login                                                 |

## GraphQL contract

The schema is **code-first**: resolvers and `@ObjectType`s are the source of truth, and the generated
`schema.graphql` at the repository root is **committed**. It is the contract other repositories
(`client-web`, `back-office`, other services) build against — the frontends download it from `main`.

- `npm run start:dev` and the e2e tests regenerate it; `npm run schema:generate` does it without a database.
- A PR that changes the API must include the regenerated `schema.graphql`. That diff is what consumers review.

Current API: `health { service version appEnv client db redis }` (public) and `me { id kind permissions strategy }`.

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

- **Where**: `GET /metrics` on its own small HTTP server on `METRICS_PORT` (default `9464`), not on `PORT`. That port
  has no public domain, so the metrics are not reachable from the internet; `GET /metrics` on the app port is a 404.
  If the port is busy, the service starts anyway and logs an error. Running several backends from source, give
  each its own port (`METRICS_PORT=9465 npm run start:dev`).
- **Labels on every series**: `service` (`wallet-core`) and `env` (`APP_ENV`).

| Metric                          | Type      | Labels              | Meaning                                                                   |
| ------------------------------- | --------- | ------------------- | ------------------------------------------------------------------------- |
| `http_requests_total`           | counter   | `operation, status` | HTTP requests, except `/health`, `/metrics` and CORS preflights           |
| `http_request_duration_seconds` | histogram | `operation`         | Request duration; buckets 5 ms … 10 s                                     |
| `graphql_errors_total`          | counter   | `operation, code`   | Failed GraphQL requests by the error code the client sees (once per code) |
| `graphql_ws_connections`        | gauge     | —                   | Open GraphQL websocket connections                                        |
| `events_published_total`        | counter   | `type`              | Events published through `EventPublisher`                                 |
| `process_*`, `nodejs_*`         | default   | —                   | CPU, memory, heap, event-loop lag, GC, start time (prom-client defaults)  |

- **`operation`**: the GraphQL operation as in the access log (`query Me`, `mutation Convert`), or the route of a REST
  request (`POST /diagnostics/ping`). Anonymous or unparsable GraphQL, requests that matched no route and names past
  the cap of 100 distinct values all go into one bucket, `(unknown)`: operation names come from the client.
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
The client customization module (hooks, client-only endpoints) is a separate task.

### Rates — `src/rates`

```ts
constructor(@Inject(RATES_CLIENT) private readonly rates: RatesClient) {}
const { mid } = await this.rates.getRate('USD', 'UAH'); // '41.50000000'
```

Bound to `FixedRatesClient` (fixed UAH/USD/EUR/PLN/USDT rates, exact cross rates via USD). When `rates-service`
is live, bind the real client in `RatesModule`.

### Events — `src/events`

`catalog.ts` is the typed contract for Redis events, **identical in all three backends**:

| Event                  | Transport                       | Name                          |
| ---------------------- | ------------------------------- | ----------------------------- |
| `rate.tick`            | Redis pub/sub (fire-and-forget) | channel `rate.tick`           |
| `conversion.completed` | Redis Stream (must not be lost) | stream `conversion.completed` |
| `system.ping`          | Redis pub/sub (diagnostics)     | channel `system.ping`         |

```ts
await publisher.publish('conversion.completed', event); // XADD
const off = await subscriber.subscribe('rate.tick', (tick, meta) => ...); // SUBSCRIBE; meta.requestId
```

Stream consumers use consumer groups (`XREADGROUP` + `XACK`) and `decodeStreamEntry()`.
Change the catalog only via a contract PR in all three repositories.

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
  events/        event catalog + publisher/subscriber
  health/        GET /health and `health` query
  config/        env validation + AppConfig
  database/      Knex (KNEX token)    redis/   ioredis (REDIS token)
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
