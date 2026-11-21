/**
 * Durations as written in a policy: a whole number of milliseconds, or a
 * number with a unit (`'500ms'`, `'2s'`, `'15m'`, `'1h'`, `'7d'`).
 *
 * BullMQ mixes units: backoff delays and dedupe TTLs are milliseconds, while
 * the `age` of a retention window is SECONDS. A bare number copied from one
 * field into the other is off by a factor of a thousand and nothing notices,
 * so every duration in this package is written with its unit and converted at
 * the one place it is handed to BullMQ.
 */

/** The units a duration string may carry. */
export type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd';

/** Milliseconds as a number, or a number followed by a unit. */
export type Duration = number | `${number}${DurationUnit}`;

const UNIT_MS: Readonly<Record<DurationUnit, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/u;

function isUnit(value: string): value is DurationUnit {
  return Object.hasOwn(UNIT_MS, value);
}

/**
 * Converts a duration to whole milliseconds. Throws a `RangeError` naming
 * `what` for anything that is not a positive, finite duration of at least one
 * millisecond, so a typo in a policy fails at boot instead of becoming a zero.
 */
export function toMilliseconds(duration: Duration, what: string): number {
  let ms: number;

  if (typeof duration === 'number') {
    ms = duration;
  } else {
    const match = PATTERN.exec(duration);
    const unit = match?.[2] ?? '';

    if (!match || !isUnit(unit)) {
      throw new RangeError(
        `${what}: "${duration}" is not a duration such as "500ms", "2s" or "1h".`,
      );
    }

    ms = Number(match[1]) * UNIT_MS[unit];
  }

  if (!Number.isFinite(ms) || ms < 1) {
    throw new RangeError(`${what}: a duration must be at least 1 millisecond.`);
  }

  return Math.round(ms);
}

/** Converts a duration to whole seconds, rounding up so a window never shrinks. */
export function toSeconds(duration: Duration, what: string): number {
  return Math.ceil(toMilliseconds(duration, what) / 1_000);
}
