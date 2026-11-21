# Changesets

This folder holds [changesets](https://github.com/changesets/changesets): one Markdown file per pending
change, recording how `@noctcore/jobs` bumps and why. Add one with `bun run changeset` and commit it with
the change.

During 0.x, a change that weakens a default or removes a check, or one that changes behaviour a running
app would notice (a job that ran before now refused, a different key in Redis), is `minor` with a
"Behaviour change" paragraph. New features are `minor`. Fixes are `patch`. From 1.0, breaking changes are
`major`. See `SECURITY.md`.
