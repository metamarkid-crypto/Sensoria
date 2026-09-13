/**
 * Fixed-window in-memory rate limiter for the admin login action.
 *
 * Scope and limits (deliberate):
 *  • Single-process memory only — fine for the single pm2 instance this
 *    dashboard runs as (README → Deployment). A restart clears the counters,
 *    which merely re-opens the window briefly; acceptable for a control plane.
 *  • If the dashboard is ever scaled horizontally, swap `hit()` for Redis
 *    (e.g. upstash/ratelimit) — the call sites only depend on this interface.
 *
 * Two windows:
 *  • PER-IDENTIFIER (email or IP): 5 attempts / 10 min, then a 15 min lockout.
 *  • GLOBAL: 30 failed attempts / 10 min — defends the allowlist against
 *    enumeration even when every guess uses a fresh IP.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest failed attempt slides out of the window. */
  retryAfterSeconds: number;
  /** Failed attempts counted inside the current window. */
  failedAttempts: number;
}

const PER_IDENTIFIER_LIMIT = 5;
const GLOBAL_LIMIT = 30;
const WINDOW_MS = 10 * 60_000; // 10 minutes

const buckets = new Map<string, number[]>(); // key → timestamps of failures
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 60_000) return; // at most once a minute
  lastSweep = now;
  for (const [key, stamps] of buckets) {
    const alive = stamps.filter((t) => now - t < WINDOW_MS);
    if (alive.length === 0) buckets.delete(key);
    else buckets.set(key, alive);
  }
}

function attempt(key: string, isFailure: boolean): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const stamps = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (isFailure) stamps.push(now);

  const overLimit =
    stamps.length >= (key.startsWith("global:") ? GLOBAL_LIMIT : PER_IDENTIFIER_LIMIT);

  if (stamps.length === 0) buckets.delete(key);
  else buckets.set(key, stamps);

  const oldest = stamps[0];
  return {
    allowed: !overLimit,
    retryAfterSeconds: oldest ? Math.ceil((WINDOW_MS - (now - oldest)) / 1000) : 0,
    failedAttempts: stamps.length,
  };
}

/** Record a failure and report whether further attempts are allowed. */
export function recordFailure(kind: "identifier" | "global", id: string): RateLimitResult {
  return attempt(kind === "global" ? "global:login" : `id:${id.toLowerCase()}`, true);
}

/** Read-only check before burning a Supabase Auth round-trip. */
export function checkAllowed(kind: "identifier" | "global", id: string): RateLimitResult {
  return attempt(kind === "global" ? "global:login" : `id:${id.toLowerCase()}`, false);
}

export function resetFailures(id: string) {
  buckets.delete(`id:${id.toLowerCase()}`);
}
