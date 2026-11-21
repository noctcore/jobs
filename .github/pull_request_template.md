<!--
Title: a conventional commit with a scope, for example `fix(jobs): keep the pause when a shorter one is asked for`.
Keep this short. CONTRIBUTING.md has the long version.
-->

## Summary

<!-- What changes and why, in one or two sentences. For a default: the trap it prevents and what it leaves alone. -->

Closes #

## Checklist

- [ ] A changeset in `.changeset/` (`bun run changeset`), written for a consumer reading the changelog. A weakened default or a removed check is major during 1.x and minor during 0.x, with a "Behaviour change" note. Changes that release nothing use `bun run changeset --empty`.
- [ ] `bun run gate` passes locally (it needs `bun run services:up` for the integration suite)
- [ ] If the public API changed on purpose, `bun run api:update` ran and the new report in `api/` is committed
- [ ] A new source module starts with a comment that says which trap or mistake it exists for
- [ ] No secrets, real hostnames, IPs or email addresses in code, fixtures or docs (use `example.com`)
- [ ] Commits are small `type(scope): lowercase summary` commits, with no em or en dashes and no AI attribution lines

## Test plan

<!-- Commands run, cases covered, what a reviewer can try. -->
