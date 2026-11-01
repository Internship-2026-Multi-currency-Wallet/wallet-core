<!-- PR title: Conventional Commits, e.g. "feat(ledger): add idempotency key to ledger entries" -->

## What

Short summary of the change.

## Why

Link to the Asana task + one sentence of context.

## How to test

Steps, or which tests cover it. Screenshots / a short video for UI changes.

## Notes

Contract changes, migrations, follow-ups, anything reviewers should look at first.

## Checklist

- [ ] Lint, type check and tests pass locally (`npm run lint && npm run typecheck && npm test`)
- [ ] Tests added or updated
- [ ] `schema.graphql` regenerated and committed if the GraphQL API changed (contract change → consumers review)
- [ ] New migration instead of editing a merged one
- [ ] No secrets, tokens or personal data
