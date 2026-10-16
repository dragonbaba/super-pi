import { readShellExecution } from "@super-pi/coding-agent";

export interface RetryPolicy {
  maxAttempts: number;
  maxWaitMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

// User-selected R3.4 policy: first attempt + four retries, 1/2/4/8 seconds.
export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 5, maxWaitMs: 15_000, baseDelayMs: 1_000, maxDelayMs: 8_000,
});
export const MAX_RETRY_OPERATIONS = 64;
const TRANSIENT_HTTP_RE = /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?\s*[:=]?\s*)5\d\d\b/iu;
const TRANSIENT_NETWORK_RE = /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b|fetch failed|socket hang up|network (?:error|unavailable)|connection (?:reset|termination)|upstream connect error/iu;

export function isTransientFailure(category: string, text: string, details?: unknown): boolean {
  const execution = readShellExecution(details);
  if (execution) return execution.termination === "timeout";
  if (category !== "runtime_error" && category !== "provider_error" && category !== "timeout") return false;
  return category === "timeout" || TRANSIENT_HTTP_RE.test(text) || TRANSIENT_NETWORK_RE.test(text);
}

/** Configuration is read at extension startup; malformed/zero/unbounded budgets are rejected. */
export function parseRetryPolicy(value: unknown): Readonly<RetryPolicy> {
  if (value === undefined || value === "") return DEFAULT_RETRY_POLICY;
  if (typeof value !== "string") throw new Error("tool-transient-retry must be a JSON object");
  const input = JSON.parse(value) as Record<string, unknown>;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("tool-transient-retry must be a JSON object");
  const policy = { ...DEFAULT_RETRY_POLICY };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(policy, key)) throw new Error(`Unknown tool-transient-retry field: ${key}`);
    const number = input[key];
    const maximum = key === "maxAttempts" ? 20 : key === "maxWaitMs" ? 120_000 : 30_000;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1 || number > maximum) {
      throw new Error(`tool-transient-retry ${key} must be an integer from 1 through ${maximum}`);
    }
    policy[key as keyof RetryPolicy] = number;
  }
  if (policy.baseDelayMs > policy.maxDelayMs) throw new Error("tool-transient-retry baseDelayMs exceeds maxDelayMs");
  return Object.freeze(policy);
}

export class RetryOperation {
  attempts = 0;
  waitMs = 0;
  elapsedWaitMs = 0;
  inFlight = false;
}

export class RetryBudget {
  readonly operations = new Map<string, RetryOperation>();
  policy: Readonly<RetryPolicy> = DEFAULT_RETRY_POLICY;
  evictions = 0;
  saturated = false;

  record(key: string, attemptReserved = false): void {
    let operation = this.operations.get(key);
    if (!operation) {
      if (this.saturated) return;
      if (this.operations.size >= MAX_RETRY_OPERATIONS) {
        // Eviction is visible and closes admissions for missing identities until agent_end.
        // Churning parents/identities can never re-create an evicted retry allowance.
        const oldest = this.operations.keys().next().value;
        if (oldest !== undefined) this.operations.delete(oldest);
        this.evictions++;
        this.saturated = true;
      }
      operation = new RetryOperation();
      this.operations.set(key, operation);
    }
    operation.inFlight = false;
    if (!attemptReserved) operation.attempts++;
  }

  delay(operation: RetryOperation): number {
    return Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** Math.min(operation.attempts - 1, 20));
  }

  refusal(key: string): string | undefined {
    const operation = this.operations.get(key);
    if (!operation) return this.saturated ? "The bounded retry ledger reached capacity; start a fresh user run after inspecting the failures." : undefined;
    if (operation.inFlight) return "A retry of this identical operation is already waiting or executing; await its result.";
    if (operation.attempts >= this.policy.maxAttempts || operation.waitMs + this.delay(operation) > this.policy.maxWaitMs) {
      return "The transient retry budget is exhausted for this operation in this agent run. Preserve the failure, stop automatic retries, and retry in a new user run after the service recovers.";
    }
    return undefined;
  }

  clear(): void { this.operations.clear(); this.evictions = 0; this.saturated = false; }
}

/** One low-frequency backoff lifecycle owns one timer, Promise and abort listener. */
export class RetryWait {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private signal: AbortSignal | undefined;
  private resolve: ((completed: boolean) => void) | undefined;
  private readonly onTimer = (): void => { this.finish(true); };
  private readonly onAbort = (): void => { this.finish(false); };
  private readonly executor = (resolve: (completed: boolean) => void): void => { this.resolve = resolve; };

  start(delayMs: number, signal?: AbortSignal): Promise<boolean> {
    const promise = new Promise<boolean>(this.executor);
    this.signal = signal;
    if (signal?.aborted) { this.finish(false); return promise; }
    signal?.addEventListener("abort", this.onAbort, { once: true });
    this.timer = setTimeout(this.onTimer, delayMs);
    return promise;
  }

  cancel(): void { this.finish(false); }
  private finish(completed: boolean): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.signal = undefined;
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.(completed);
  }
}
