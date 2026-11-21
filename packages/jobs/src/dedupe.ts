import { createHash } from 'node:crypto';

import type { DeduplicationOptions } from 'bullmq';

import { toMilliseconds, type Duration } from './duration';

/**
 * Dedupe is a required, explicit choice on every `add()`.
 *
 * The traps it closes:
 *
 * - A fixed or caller-built `jobId` as the dedupe key. A repeated jobId is a
 *   silent no-op, and it only dedupes while the first job is still RETAINED:
 *   a burst of completions that evicts it reopens the window early, and a
 *   failed job kept in the dead-letter set blocks every repeat of that id for
 *   as long as it is kept (one forgot-password request swallowing the next
 *   week of them). This package never lets the caller set a jobId; BullMQ
 *   assigns a fresh one, and dedupe goes through BullMQ's `deduplication`
 *   option, whose window is independent of retention.
 * - A key a client controls (a request id header). Whoever pins the header
 *   silently drops everyone's jobs that share it. Build keys from values the
 *   server minted.
 * - A raw value in the key. Keys often hold an address or a token, and
 *   deduplication ids are stored in Redis in plain sight. Keys are hashed with
 *   SHA-256 here, so the stored id says nothing about the value.
 * - A colon in the key. A colon is how BullMQ builds its own keys, and a key
 *   with one in it is usually a Redis key or a jobId pasted in by mistake.
 *   It is refused.
 */

declare const dedupeBrand: unique symbol;

/** A dedupe key: one string, or parts that are joined in order. */
export type DedupeKey = string | readonly string[];

/** A dedupe choice built by one of the `dedupe` helpers. */
export type Dedupe =
  | { readonly [dedupeBrand]: true; readonly kind: 'none' }
  | {
      readonly [dedupeBrand]: true;
      readonly kind: 'window' | 'until' | 'debounce';
      readonly id: string;
      readonly ttlMs?: number;
    };

const MAX_KEY_LENGTH = 1_024;

/** Hashes a dedupe key to the id BullMQ stores. Throws on an empty part or a colon. */
export function dedupeId(key: DedupeKey): string {
  const parts = typeof key === 'string' ? [key] : key;

  if (parts.length === 0) throw new TypeError('A dedupe key needs at least one part.');

  for (const part of parts) {
    if (typeof part !== 'string' || part.length === 0) {
      throw new TypeError('A dedupe key part must be a non-empty string.');
    }

    if (part.includes(':')) {
      throw new TypeError(
        'A dedupe key must not contain ":" (it looks like a Redis key or a jobId). Pass the parts as an array instead.',
      );
    }

    if (part.includes('\u0000')) throw new TypeError('A dedupe key must not contain NUL.');
  }

  const joined = parts.join('\u0000');

  if (joined.length > MAX_KEY_LENGTH) {
    throw new TypeError(`A dedupe key must be at most ${MAX_KEY_LENGTH} characters.`);
  }

  return createHash('sha256').update(joined).digest('hex');
}

function make(kind: 'window' | 'until' | 'debounce', key: DedupeKey, ttl?: Duration): Dedupe {
  const id = dedupeId(key);

  if (ttl === undefined) return { kind, id } as Dedupe;

  return { kind, id, ttlMs: toMilliseconds(ttl, `dedupe.${kind} ttl`) } as Dedupe;
}

/** The dedupe helpers every `add()` picks from. */
export const dedupe = {
  /**
   * Throttle: the first job with this key runs; repeats within `ttl` of it
   * are dropped, whether the first job is still waiting, already finished, or
   * failed and kept in the dead-letter set. After `ttl` a repeat is a new job.
   */
  window(key: DedupeKey, ttl: Duration): Dedupe {
    return make('window', key, ttl);
  },

  /**
   * Until settled: repeats are dropped while the first job with this key is
   * waiting, delayed or running (retries included); once it completes or
   * fails for good, the next one is a new job.
   */
  until(key: DedupeKey): Dedupe {
    return make('until', key);
  },

  /**
   * Debounce: the job waits `wait` before it runs, and each repeat within that
   * time replaces its payload and restarts the wait, so only the last one runs.
   */
  debounce(key: DedupeKey, wait: Duration): Dedupe {
    return make('debounce', key, wait);
  },

  /** No dedupe: every call is a new job. Say so explicitly. */
  none(): Dedupe {
    return { kind: 'none' } as Dedupe;
  },
} as const;

/** What a dedupe choice adds to BullMQ's job options. */
export function dedupeJobOptions(choice: Dedupe): {
  deduplication?: DeduplicationOptions;
  delay?: number;
} {
  switch (choice.kind) {
    case 'none':
      return {};

    case 'until':
      return { deduplication: { id: choice.id } };

    case 'window':
      return { deduplication: { id: choice.id, ttl: choice.ttlMs ?? 1 } };

    case 'debounce':
      return {
        deduplication: { id: choice.id, ttl: choice.ttlMs ?? 1, extend: true, replace: true },
        delay: choice.ttlMs ?? 1,
      };
  }
}
