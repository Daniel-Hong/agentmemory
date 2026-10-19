import { getEnvVar } from "../config.js";

// Bounded retry for transient rate-limit / unavailable responses. Attempts is
// total tries (initial + retries). Retries are bounded by a TOTAL elapsed
// deadline — not per-attempt — so the worst case never blows past the caller's
// timeout budget or the iii invocation timeout. A single retry delay is capped
// low so a hostile Retry-After header can't dominate the budget.
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 5000;
// Absolute ceiling on the total budget, kept well under the iii 180s invocation
// timeout so retries + sleeps + per-attempt timeouts can never overrun it.
const HARD_BUDGET_CAP_MS = 170000;
// A retry only makes sense if there's room for at least a token attempt after
// the sleep; without this floor we'd sleep, fire, and get instantly cut off.
const MIN_ATTEMPT_FLOOR_MS = 100;
const RETRY_STATUS = new Set([429, 503]);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse a Retry-After header into a delay in milliseconds. Supports both the
 * integer-seconds form and the HTTP-date form. Returns undefined when absent
 * or unparseable, so the caller falls back to exponential backoff. Negative
 * or past values clamp to 0.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (trimmed === "") return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }

  return undefined;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const parsed =
    timeoutMs ??
    Number.parseInt(getEnvVar("AGENTMEMORY_LLM_TIMEOUT_MS") ?? "60000", 10);
  const ms = Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;

  // The caller's timeout is the TOTAL budget for all attempts + sleeps, hard
  // capped so we never approach the iii invocation timeout.
  const budgetMs = Math.min(ms, HARD_BUDGET_CAP_MS);
  const start = Date.now();

  const ctl = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([init.signal, ctl.signal])
    : ctl.signal;
  const timer = setTimeout(() => ctl.abort(), budgetMs);
  try {
    let response = await fetch(url, { ...init, signal });
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      if (!RETRY_STATUS.has(response.status)) break;

      const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
      const backoff = 500 * 2 ** (attempt - 1);
      const delay = Math.min(retryAfter ?? backoff, MAX_RETRY_DELAY_MS);
      const remaining = budgetMs - (Date.now() - start);
      if (delay + MIN_ATTEMPT_FLOOR_MS > remaining) break;

      // Release discarded responses without waiting for their body to finish.
      await response.body?.cancel().catch(() => {});
      await sleep(delay);
      response = await fetch(url, { ...init, signal });
    }

    // Every caller consumes non-streaming JSON/text; headers alone are not completion.
    const body = response.body === null ? null : await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
  }
}
