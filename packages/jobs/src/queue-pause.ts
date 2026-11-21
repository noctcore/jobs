import type { Queue } from 'bullmq';

/**
 * Stopping a queue for a while because its downstream said "not now", without
 * ever making a stop that is already running shorter.
 *
 * `queue.rateLimit(ms)` REPLACES what is there: BullMQ keeps one key per queue
 * for both the limiter's window and a pause, and sets it with the new expiry.
 * Two refusals asking for different waits (fifteen minutes because a quota is
 * used up, one second because of a burst) leave whichever was written last,
 * so the short one cuts the long one.
 *
 * So the time left is read first, from Redis through BullMQ's
 * `getRateLimitTtl` (the key is shared by every replica and outlives a
 * restart), and the key is written only to make the stop longer. It is asked
 * with the worker's `max`, which is how BullMQ tells a pause from a limiter
 * window that is merely open (it answers 0 for the second).
 *
 * Read then write is two commands, and one worker runs several jobs at once,
 * so calls on one instance take turns. That is why there is exactly one
 * `QueuePause` per queue: the runtime builds it with the queue and every
 * worker of that queue shares it. Between two replicas the two commands can
 * still interleave; the worst case is a pause cut short, after which the next
 * refusal pauses the queue again.
 */
export class QueuePause {
  private lastTurn: Promise<void> = Promise.resolve();

  constructor(
    private readonly queue: Pick<Queue, 'getRateLimitTtl' | 'rateLimit'>,
    private readonly limiterMax: () => number,
  ) {}

  /**
   * Keeps the queue from handing out jobs for at least `ms` from now. Resolves
   * to how long it is stopped for: `ms`, or what is left of a longer stop.
   */
  forAtLeast(ms: number): Promise<number> {
    if (!Number.isFinite(ms) || ms < 1) {
      return Promise.reject(new RangeError('A queue pause must be at least 1 millisecond.'));
    }

    const turn = this.lastTurn.then(() => this.extendTo(Math.round(ms)));

    // The next caller waits for this one whether or not it worked.
    this.lastTurn = turn.then(
      () => undefined,
      () => undefined,
    );

    return turn;
  }

  private async extendTo(ms: number): Promise<number> {
    const left = await this.queue.getRateLimitTtl(this.limiterMax());

    if (left >= ms) return left;

    await this.queue.rateLimit(ms);

    return ms;
  }
}
