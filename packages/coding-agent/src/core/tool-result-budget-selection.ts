import type { ToolResultPresentationCounters } from "./tool-result-presentation.ts";

// Only the rejected greedy branch uses these invocation-local resources.
// The state bound covers 8 * (128 records * 1024 tool-token positions).
// Steps include metadata, both candidate comparisons, traceback and final scan.
export const RESULT_SELECTION_MAX_STATES = 1_048_576;
export const RESULT_SELECTION_MAX_STEPS = 4_194_304;
export const RESULT_SELECTION_MAX_BYTES = 1_048_576;
const FIXED_HEADER_ALLOWANCE = 4096;
const COST_FIELDS = 6;

export class ToolResultBudgetComputationError extends Error {
  readonly code = "result-budget-computation-exhausted";
  readonly stateLimit = RESULT_SELECTION_MAX_STATES;
  readonly stepLimit = RESULT_SELECTION_MAX_STEPS;
  readonly memoryLimit = RESULT_SELECTION_MAX_BYTES;
  readonly limit: "states" | "steps" | "memory";
  readonly checkedStates: number;
  readonly checkedSteps: number;
  readonly requiredStates: number;
  readonly requiredSteps: number;
  readonly requiredBytes: number;
  constructor(limit: "states" | "steps" | "memory", checkedStates: number,
    checkedSteps: number, requiredStates: number, requiredSteps: number, requiredBytes: number) {
    super(`Request preparation blocked: computation-resource-limit; insufficient computation resources (limit=${limit}, checkedStates=${checkedStates}, statesLimit=${RESULT_SELECTION_MAX_STATES}, checkedSteps=${checkedSteps}, stepsLimit=${RESULT_SELECTION_MAX_STEPS}, requiredStates=${requiredStates}, requiredSteps=${requiredSteps}, requiredBytes=${requiredBytes}, memoryLimit=${RESULT_SELECTION_MAX_BYTES}). This does not prove that the result or context budget is insufficient. Reduce the number of results considered together before preparing the request again. Prior tool outcomes are unchanged; do not repeat completed tools.`);
    this.name = "ToolResultBudgetComputationError";
    this.limit = limit;
    this.checkedStates = checkedStates;
    this.checkedSteps = checkedSteps;
    this.requiredStates = requiredStates;
    this.requiredSteps = requiredSteps;
    this.requiredBytes = requiredBytes;
  }
}

/** Scalar costs and choice bits only: no result bodies, callbacks or owner pool.
 * dispose() is paired with the caller's finally, including projection observers.
 * Two backing stores plus a fixed allowance cover the plan and view headers. */
export class ToolResultBudgetSelection {
  private costs: Float64Array | undefined;
  private workspace: ArrayBuffer | undefined;
  private bytes = 0;
  private checkedStates = 0;
  private checkedSteps = 0;
  private deltaSum = 0;
  toolTokens = 0;
  contextTokens = 0;
  bodyResults = 0;
  private readonly count: number;
  private readonly counters: ToolResultPresentationCounters;

  constructor(count: number, counters: ToolResultPresentationCounters) {
    this.count = count;
    this.counters = counters;
    counters.contextualChoiceCalls = (counters.contextualChoiceCalls ?? 0) + 1;
    const requiredBytes = count * COST_FIELDS * Float64Array.BYTES_PER_ELEMENT + FIXED_HEADER_ALLOWANCE;
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes > RESULT_SELECTION_MAX_BYTES) this.fail("memory", 0, 0, requiredBytes);
    this.costs = new Float64Array(count * COST_FIELDS);
    this.bytes = requiredBytes;
    counters.contextualChoiceActivePlans = (counters.contextualChoiceActivePlans ?? 0) + 1;
    this.accountBytes(requiredBytes, this.costs.byteLength);
  }

  private accountBytes(bytes: number, backingBytes = bytes): void {
    this.counters.contextualChoiceActiveBytes = (this.counters.contextualChoiceActiveBytes ?? 0) + bytes;
    this.counters.contextualChoicePeakBytes = Math.max(this.counters.contextualChoicePeakBytes ?? 0, this.counters.contextualChoiceActiveBytes);
    this.counters.contextualChoiceAllocatedBackingBytes = (this.counters.contextualChoiceAllocatedBackingBytes ?? 0) + backingBytes;
  }

  private fail(limit: "states" | "steps" | "memory", states: number, steps: number, bytes: number): never {
    this.counters.contextualChoiceResourceFailures = (this.counters.contextualChoiceResourceFailures ?? 0) + 1;
    throw new ToolResultBudgetComputationError(limit, this.checkedStates, this.checkedSteps, states, steps, bytes);
  }

  set(index: number, minimumTool: number, minimumContext: number, fullTool: number, fullContext: number, minimumIsSource: boolean): void {
    const data = this.costs!;
    const offset = index * COST_FIELDS;
    const full = fullTool < minimumTool || fullTool === minimumTool && fullContext < minimumContext;
    const baseTool = full ? fullTool : minimumTool;
    const baseContext = full ? fullContext : minimumContext;
    const delta = (full ? minimumTool : fullTool) - baseTool;
    const gain = baseContext - (full ? minimumContext : fullContext);
    data[offset] = full ? 1 : 0;
    data[offset + 1] = baseTool;
    data[offset + 2] = baseContext;
    data[offset + 3] = Number.isFinite(delta) && gain > 0 ? delta : 0;
    data[offset + 4] = Number.isFinite(delta) && gain > 0 ? gain : 0;
    data[offset + 5] = minimumIsSource ? 1 : 0;
    this.toolTokens += baseTool;
    this.contextTokens += baseContext;
    if (Number.isFinite(delta) && gain > 0) this.deltaSum += delta;
    this.checkedSteps++;
  }

  /** Exact 0/1 selection over additional tool cost, maximizing context savings.
   * A packed traceback reconstructs choices without retaining source objects. */
  solve(toolBudget: number, contextBudget: number): boolean {
    const data = this.costs!;
    if (this.toolTokens > toolBudget) return false;
    if (this.contextTokens <= contextBudget) {
      this.countBodies();
      return true;
    }
    const width = Math.min(toolBudget - this.toolTokens, this.deltaSum) + 1;
    const states = this.count * width;
    const steps = this.checkedSteps + 4 * states + 3 * width + 2 * this.count;
    const rowBytes = 2 * width * Float64Array.BYTES_PER_ELEMENT;
    const traceBytes = Math.ceil(states / 8);
    const requiredBytes = this.bytes + rowBytes + traceBytes;
    if (!Number.isSafeInteger(states) || states > RESULT_SELECTION_MAX_STATES) this.fail("states", states, steps, requiredBytes);
    if (!Number.isSafeInteger(steps) || steps > RESULT_SELECTION_MAX_STEPS) this.fail("steps", states, steps, requiredBytes);
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes > RESULT_SELECTION_MAX_BYTES) this.fail("memory", states, steps, requiredBytes);
    this.workspace = new ArrayBuffer(rowBytes + traceBytes);
    this.bytes = requiredBytes;
    this.accountBytes(rowBytes + traceBytes);
    const rows = new Float64Array(this.workspace, 0, 2 * width);
    const trace = new Uint8Array(this.workspace, rowBytes, traceBytes);
    rows.fill(Number.NEGATIVE_INFINITY);
    rows[0] = 0;
    this.checkedSteps += 2 * width;
    let previous = 0;
    let next = width;
    for (let index = 0; index < this.count; index++) {
      const offset = index * COST_FIELDS;
      const delta = data[offset + 3]!;
      const gain = data[offset + 4]!;
      for (let used = 0; used < width; used++) {
        const unchanged = rows[previous + used]!;
        const changed = gain > 0 && delta <= used ? rows[previous + used - delta]! + gain : Number.NEGATIVE_INFINITY;
        if (changed > unchanged) {
          rows[next + used] = changed;
          const bit = index * width + used;
          trace[bit >>> 3] = trace[bit >>> 3]! | 1 << (bit & 7);
        } else rows[next + used] = unchanged;
        this.checkedStates++;
        this.checkedSteps += 4;
      }
      const swap = previous;
      previous = next;
      next = swap;
    }
    let selected = -1;
    let bestGain = 0;
    for (let used = 0; used < width; used++) {
      const gain = rows[previous + used]!;
      bestGain = Math.max(bestGain, gain);
      if (this.contextTokens - gain <= contextBudget && selected < 0) selected = used;
      this.checkedSteps++;
    }
    if (selected < 0) {
      this.contextTokens -= bestGain;
      return false;
    }
    this.toolTokens += selected;
    this.contextTokens -= rows[previous + selected]!;
    for (let index = this.count - 1; index >= 0; index--) {
      const bit = index * width + selected;
      const offset = index * COST_FIELDS;
      if (trace[bit >>> 3]! & 1 << (bit & 7)) {
        data[offset] = data[offset] === 1 ? 0 : 1;
        selected -= data[offset + 3]!;
      }
      this.checkedSteps++;
    }
    this.countBodies();
    return true;
  }

  private countBodies(): void {
    const data = this.costs!;
    for (let index = 0; index < this.count; index++) {
      const offset = index * COST_FIELDS;
      if (data[offset] === 0 && data[offset + 5] === 0) this.bodyResults++;
    }
    this.checkedSteps += this.count;
  }

  keepsFullSource(index: number): boolean { return this.costs![index * COST_FIELDS] === 1; }

  dispose(): void {
    if (!this.costs) return;
    this.costs = undefined;
    this.workspace = undefined;
    this.counters.contextualChoiceActiveBytes = (this.counters.contextualChoiceActiveBytes ?? 0) - this.bytes;
    this.counters.contextualChoiceActivePlans = (this.counters.contextualChoiceActivePlans ?? 0) - 1;
    this.counters.contextualChoiceStates = (this.counters.contextualChoiceStates ?? 0) + this.checkedStates;
    this.counters.contextualChoiceSteps = (this.counters.contextualChoiceSteps ?? 0) + this.checkedSteps;
    this.bytes = 0;
  }
}
