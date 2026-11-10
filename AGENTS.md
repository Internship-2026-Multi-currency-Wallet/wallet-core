# AGENTS.md — conventions for AI coding agents

This is `wallet-core`, a NestJS 12 + GraphQL (Apollo, code-first) + Knex/MySQL + Redis service, ES modules,
TypeScript 6, Node 26. Read `README.md` first.

## Rules

- **Module per feature.** New functionality goes in its own folder/module (`src/<feature>/`): module, resolver,
  service, models, `*.spec.ts`. Do not put feature code into `app.module.ts` beyond adding the import.
- **Contract first.** GraphQL is code-first; `schema.graphql` is generated (`npm run schema:generate`) and committed.
  API changes = regenerated `schema.graphql` in the same PR. Never hand-edit it.
- **Use the seams, never bypass them.**
  - Who is calling: `@CurrentUser() user: AuthUser`. Anonymous access: `@Public()`. Never parse `Authorization` yourself.
  - Permissions: `@RequirePermission('bo:<area>[:modify]')`.
  - Settings: `ClientSettingsService.get('<key>')`; add a key with one line in `settingsCatalog` (`src/settings/settings.schema.ts`: `schema`, `default`, `public`).
  - Current client: `AppConfig.client`. No `if (client === 'kvitka')` in core code.
  - Rates: inject `RATES_CLIENT`. Events: `EventPublisher` / `EventSubscriber` with names from `src/events/catalog.ts`.
  - Config: inject `AppConfig`; add new env vars to `env.schema.ts` **and** `.env.example`.
- **Redis names** (channels, streams, queues) are always prefixed with `APP_ENV` — use the event helpers
  (`eventChannel`, `eventStream`) and never hard-code a raw name.
- **Logging:** inject `@InjectPinoLogger(MyClass.name) private readonly logger: PinoLogger` and log fields first,
  message second: `logger.info({ conversionId, userId }, 'conversion booked')`; errors as `{ err }`. Include the
  context fields a reader needs (ids, amounts, states). Never log secrets, tokens, passwords, full requests or
  bodies. No `console.*` and no `new Logger()` from `@nestjs/common`. `requestId` is added automatically.
- **Metrics:** inject `Metrics` and create a metric once (`metrics.counter({ name, help, labelNames })`). Label values
  must be bounded: never user ids, request ids, amounts or free text (each distinct value is a new time series).
  See the README section "Metrics".
- **Database:** Knex via the `KNEX` token. Schema changes only through new timestamped migrations
  (`npm run migrate:make -- <name>`); never edit a merged migration. Migrations use `import type` only.
- **Money:** integers in minor units; rates as decimal strings. Never floating point.
- **Comments:** only explain a non-obvious why. Don't restate the code or list the fields below.
- **Imports:** relative ESM imports with a `.js` extension (`./foo.service.js`).
- **Tests are required:** unit tests next to the code (`*.spec.ts`, import `jest` from `@jest/globals`);
  e2e tests in `test/` for API behaviour. Run before finishing:
  `npm run lint && npm run typecheck && npm test && npm run test:e2e` (e2e needs MySQL + Redis: `npm run infra:up`, which runs `../ops/dev.sh up`).
- **No secrets.** This repository is public. No tokens, keys, passwords (other than the local-only placeholders
  in `.env.example`), personal data or machine-specific paths.
- English only. Conventional Commits (`feat(ledger): ...`). Small PRs using `.github/pull_request_template.md`.
