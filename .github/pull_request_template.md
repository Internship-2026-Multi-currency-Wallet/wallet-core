<!-- PR title: Conventional Commits, e.g. "feat(ledger): add idempotency key to ledger entries" -->

## What

Short summary of the change.

## Why

Link to the Asana task + one sentence of context.

## How to test

Steps, or which tests cover it. Screenshots / a short video for UI changes.

## Environment variables

None.
<!-- New, changed, renamed or removed variables? Replace "None." with a table (no secret values!):
| Variable | Purpose | staging | kvitka-uat | wisla-uat |
|---|---|---|---|---|
The mentor sets them in Dokploy and confirms here — merge only after that.
https://github.com/Internship-2026-Multi-currency-Wallet/handbook/blob/main/workflow.md#environment-variables -->

## Notes

Contract changes, migrations, follow-ups, anything reviewers should look at first.

## Checklist

- [ ] Lint, type check and tests pass locally (`npm run lint && npm run typecheck && npm test`)
- [ ] Tests added or updated
- [ ] `schema.graphql` regenerated and committed if the GraphQL API changed (contract change → consumers review)
- [ ] New migration instead of editing a merged one
- [ ] New env variables are in the env schema and `.env.example`, and listed above
- [ ] No secrets, tokens or personal data
