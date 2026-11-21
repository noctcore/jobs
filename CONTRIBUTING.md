# Contributing

## Before you start

- Open an issue with one of the forms first for anything larger than a small fix, so we agree on
  the shape before you write code. A stricter default or a trap the package should prevent goes in
  the "Feature or safer default" form.
- A vulnerability never goes in a public issue: see [SECURITY.md](SECURITY.md).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Layout

```
packages/jobs/src
  duration.ts, redis-url.ts, connections.ts   units, the Redis URL, the two connection policies
  policy.ts, dedupe.ts                         defineQueue and its types, the dedupe choices
  job-context.ts, telemetry.ts                 the context envelope, metrics/tracing/error seams and adapters
  job-queue.ts, queue-pause.ts                 the producer side
  job-host.ts, job-runner.ts                   the worker side
  decorators.ts, jobs.runtime.ts, jobs.module.ts   the Nest wiring, workers and sweeps
  shutdown.ts                                  drain, close, flush, re-raise
packages/jobs/tests                            unit and type tests
packages/jobs/tests/integration                *.int.test.ts against real Redis
```

## Checks

```sh
bun run services:up          # docker compose: Redis on 6395, Redis with a password on 6396
bun run gate                 # everything CI runs, in order
bun run services:down
```

`bun run gate` runs `format:check`, `build`, `typecheck`, `lint`, `check:api`, `check:deps`,
`check:workflows`, `check:package`, `test` and `test:integration`.

- `test:integration` reads `REDIS_URL` and `REDIS_AUTH_URL` (values in `.env.example`, matching
  `docker-compose.yml`). Without them the integration suites skip locally; CI sets
  `JOBS_REQUIRE_SERVICES=1` so they can never skip there.
- `bun run format` rewrites every file with Prettier; `format:check` only reports.
- `bun run lint` uses type information, so never run it with `--cache`. `bunx eslint . --fix`
  applies the blank-line rules.
- `bun run check:api` compares the public API (runtime export names and the emitted declarations)
  with the report in `api/`. When a change to the API is intended, run `bun run api:update` after
  the build and commit the new report with the change.
- `bun run check:deps` fails when the package gains a runtime dependency that is not in
  `scripts/runtime-dependencies.json`. The package has none, and adding one needs a reason.

## Conventions

- Commits are `type(scope): lowercase summary`, one logical change each.
- Every source module starts with a comment that says which trap or mistake it exists for.
- A default that prevents a trap gets a test that shows the trap: an integration test on real Redis
  when the behaviour lives in Redis, a type test (`@ts-expect-error`) when the protection is a type.
- Library code logs through Nest's `Logger` with a static message and a fields object, never
  `console`.
- No em or en dashes in code, comments or docs.
- One blank line between logical steps: lint asks for one before a `return`, after a run of
  declarations, and around blocks and multi-line statements.
- A lint exception goes in a scoped `files` override in `eslint.config.js` with the reason, never
  in an inline disable comment.

## Required checks

| Gate | CI job | Locally |
|---|---|---|
| Formatting, types, lint, API report, runtime deps, workflows, package shape | `build · lint · typecheck · package shape` | `bun run gate` (first eight steps) |
| Unit and type tests | `test`, `test · windows` | `bun run test` |
| Integration on real Redis | `integration · redis` | `bun run services:up && bun run test:integration` |
| The oldest peers the ranges allow | `peer range floor` | see `.github/workflows/ci.yml` |
| A changeset on every package change | `changeset status` | `bun run changeset` |
| CodeQL, dependency review | `codeql`, `dependency review` | CI only |

## Changesets

A pull request that changes the published package carries a changeset (`bun run changeset`).
Changes that release nothing opt out with `bun run changeset --empty`.

## Releasing

Releases go out through the `release` workflow. The flow and the owner-only steps are in
[RELEASING.md](RELEASING.md).
