/** The trap to answer pairs the landing page shows, each linked to the page that explains it. */
export interface TrapRow {
  readonly failure: string;
  readonly answer: string;
  readonly module: string;
  readonly href: string;
}

export const TRAPS: readonly TrapRow[] = [
  {
    failure: 'An enqueue hangs the request while Redis restarts',
    answer: 'The producer has its own connection: no offline queue, one retry, a 3 s bound. During a known outage add() refuses at once.',
    module: 'producer connection',
    href: '/jobs/guides/connections/',
  },
  {
    failure: 'A dedupe stops working once the job is removed',
    answer: 'Every add() picks a dedupe, held in its own Redis key, so retention never ends a window early. Keys are hashed.',
    module: 'dedupe',
    href: '/jobs/guides/dedupe/',
  },
  {
    failure: 'One outage turns into a synchronised retry storm',
    answer: 'A retrying policy needs expo() or fixed(), jittered by default. Zero jitter or a hand-written backoff does not compile.',
    module: 'defineQueue',
    href: '/jobs/guides/queues-and-policies/',
  },
  {
    failure: 'Completed and failed jobs fill Redis',
    answer: 'Retention for both is required and always has an age.',
    module: 'keep',
    href: '/jobs/guides/queues-and-policies/#retention',
  },
  {
    failure: 'A failure alert fires on every attempt, or never',
    answer: 'onFinalFailure and the error reporter run once, on the attempt that ends the job.',
    module: 'JobHost',
    href: '/jobs/guides/workers/',
  },
  {
    failure: 'A cron runs once per replica, or moves with the server’s zone',
    answer: 'Sweeps are BullMQ job schedulers: one run per tick however many replicas upsert them, and a cron needs its tz.',
    module: '@Sweep',
    href: '/jobs/guides/sweeps/',
  },
  {
    failure: 'A deploy kills jobs halfway',
    answer: 'Workers drain, bounded, before the app closes; then the queues and the producer close and telemetry flushes.',
    module: 'installGracefulShutdown',
    href: '/jobs/guides/shutdown/',
  },
];
