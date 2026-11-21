/**
 * The one place the package reads the wall clock, so tests and lint have a
 * single seam to look at. Durations are measured with `performance.now()`,
 * which an NTP correction cannot move; only timestamps meant for people and
 * dashboards come from here.
 */
export function now(): Date {
  return new Date();
}
