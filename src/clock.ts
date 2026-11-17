// Logical clock: every timestamp in the system comes from here. The base is
// MAKEFUN_TRIAL_NOW (parsed once at startup), the tick advances 1 ms per
// stamp issued, and nowIso/nowSec share the tick — so timestamps are strictly
// increasing and a fixed request sequence yields identical timestamps on
// every run. No wall clock, no randomness. ISO formatting is done by hand
// (civil-from-days) so this module never touches `new Date()` at all.

const FALLBACK_BASE_MS = 1735689600000; // 2025-01-01T00:00:00.000Z = SCENARIO_EPOCH_SEC

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function pad3(n: number): string {
  if (n < 10) return `00${n}`;
  if (n < 100) return `0${n}`;
  return `${n}`;
}

/** Format milliseconds since the Unix epoch as ISO 8601 UTC (like toISOString). */
export function isoFromMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const millis = ms - totalSec * 1000;
  const days = Math.floor(totalSec / 86400);
  const secsOfDay = totalSec - days * 86400;
  const hh = Math.floor(secsOfDay / 3600);
  const mm = Math.floor((secsOfDay % 3600) / 60);
  const ss = secsOfDay % 60;
  // Civil-from-days (Howard Hinnant's algorithm), valid for all int32-range days.
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  const yyyy = year < 0 ? `-${pad2(-year)}` : year < 1000 ? `0${pad3(year)}`.slice(-4) : `${year}`;
  return `${yyyy}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(millis)}Z`;
}

export class Clock {
  private tickMs: number;

  constructor(baseIso: string) {
    const parsed = Date.parse(baseIso);
    this.tickMs = Number.isFinite(parsed) ? parsed : FALLBACK_BASE_MS;
  }

  /** ISO 8601 UTC, advances the tick 1 ms per call (strictly increasing). */
  nowIso(): string {
    const t = this.tickMs;
    this.tickMs += 1;
    return isoFromMs(t);
  }

  /** floor(tickMs / 1000); advances the tick 1 ms per call. */
  nowSec(): number {
    const t = this.tickMs;
    this.tickMs += 1;
    return Math.floor(t / 1000);
  }
}
