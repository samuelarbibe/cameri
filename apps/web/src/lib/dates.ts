/**
 * The router types timestamps as `Date`, but there is no tRPC transformer on the
 * link, so what actually arrives is an ISO string. Every date that crosses the
 * wire goes through here rather than being trusted at its declared type.
 */
export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toTime(value: Date | string): number {
  return toDate(value).getTime();
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

export function relativeTime(value: Date | string): string {
  const elapsed = Date.now() - toTime(value);
  for (const [unit, ms] of UNITS) {
    if (elapsed >= ms) return RELATIVE.format(-Math.floor(elapsed / ms), unit);
  }
  return "just now";
}

/** Test durations span three orders of magnitude, so the unit is picked per value. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Rounded to whole seconds *before* splitting: rounding the remainder on its
  // own lets it reach 60 and print "5m 60s".
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * Axis ticks want a wall-clock time, not an elapsed one. Zoomed in far enough
 * that ticks are sub-second, every label would otherwise read the same, so the
 * caller asks for milliseconds.
 */
export function formatClock(ms: number, millis = false): string {
  const label = new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return millis ? `${label}.${String(Math.floor(ms) % 1000).padStart(3, "0")}` : label;
}
