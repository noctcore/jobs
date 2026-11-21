# Product: the @noctcore/jobs docs site

register: brand

## What it is

The public docs for `@noctcore/jobs`, a thin layer over BullMQ 6 for NestJS that makes the safe
choice the default: typed queues with required policies, a required dedupe on every enqueue,
fail-fast producers, jittered and bounded retries, sweeps that run once per tick, and a shutdown
that waits for running jobs. The site has two jobs. The landing page shows the one idea (each
default exists because of a trap, and each trap is closed by a named part of the package). Start,
Guides, Migrating and Reference are reading pages that must be calm and fast before anything else.

## Users

- **Backend developers choosing a job library.** Skeptical, ten minutes, read the sample before the
  copy. They want to know what it changes about BullMQ, what it refuses to do, and when it is the
  wrong tool.
- **Developers wiring it in.** Back many times for one option, one dedupe kind, one shutdown number.
  They need the sidebar, search and Reference to be boring.
- **Developers migrating** from raw BullMQ or `@nestjs/bullmq`, one queue at a time, looking for a
  mapping table and the differences to plan for.

## Brand

- **Voice words:** calm, exact, accountable. A default is stated, then the trap that makes it
  necessary, then where it lives.
- **Look:** the noctcore night and paper palette shared with noctcore/auth and noctcore/harness; the
  jobs mark (a worker's frame holding one job, the next waiting at the entrance); routes continuous
  in blue, stopped traps dashed and capped in copper.
- **Copy rules:** first person singular where the author speaks; no em or en dashes; no "blazing",
  "seamless", "enterprise-grade".

## Strategic principles

1. **Code is evidence.** Samples with a file name live in `snippets/` and are typechecked against
   the package sources on every site build.
2. **Both themes are first class.** Night leads; day is not a palette swap.
3. **Quiet structure.** Hierarchy from type and spacing; cards only where a card is the affordance.
4. **No unverified claims.** Comparisons with other tools stay at "when it is a bad fit"; nothing
   about another project that has not been checked against its own docs.
