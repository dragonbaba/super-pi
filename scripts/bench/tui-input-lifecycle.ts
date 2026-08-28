import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { ProcessTerminal } from "../../packages/tui/src/terminal.ts";
import { currentCommit } from "./benchmark.ts";

class ImmediateOutput extends EventEmitter {
	write(_data: string, callback: (error?: Error | null) => void): boolean {
		callback();
		return true;
	}
}

interface DrainState {
	drainInputSource: EventEmitter;
	drainInputActive: boolean;
	drainInputPromise: Promise<void> | undefined;
	drainInputResolve: (() => void) | undefined;
	drainInputReject: ((error: Error) => void) | undefined;
	drainInputTimer: ReturnType<typeof setTimeout> | undefined;
	drainInputTimerHandlesCreated: number;
	drainInputTimerReschedules: number;
	drainInputPreviousHandler: ((data: string) => void) | undefined;
	drainActiveGeneration: number;
	readDrainTime: () => number;
	onDrainInputData: () => void;
	onDrainInputTimer: (generation: number) => void;
}

const inputEvents = 100_000;
const input = new EventEmitter();
const terminal = new ProcessTerminal(new ImmediateOutput() as never);
const state = terminal as unknown as DrainState;
let now = 0;
state.readDrainTime = () => now;
state.drainInputSource = input;
const dataCallback = state.onDrainInputData;
const timerCallback = state.onDrainInputTimer;
const cycle = terminal.drainInput(60_000, 10_000);
const timer = state.drainInputTimer;
if (!timer) throw new Error("drain cycle did not schedule its timer");
let promiseIdentityChanges = 0;
let timerIdentityChanges = 0;
let listenerIdentityChanges = 0;
let timerCallbackIdentityChanges = 0;
let maximumActivePromises = 0;
let maximumTimers = 0;
let maximumResolvers = 0;
let maximumRejectors = 0;
let maximumListeners = 0;
for (let event = 0; event < inputEvents; event++) {
	now = event / 10;
	input.emit("data", "x");
	if (state.drainInputPromise !== cycle) promiseIdentityChanges++;
	if (state.drainInputTimer !== timer) timerIdentityChanges++;
	if (state.onDrainInputData !== dataCallback) listenerIdentityChanges++;
	if (state.onDrainInputTimer !== timerCallback) timerCallbackIdentityChanges++;
	maximumActivePromises = Math.max(maximumActivePromises, state.drainInputPromise ? 1 : 0);
	maximumTimers = Math.max(maximumTimers, state.drainInputTimer ? 1 : 0);
	maximumResolvers = Math.max(maximumResolvers, state.drainInputResolve ? 1 : 0);
	maximumRejectors = Math.max(maximumRejectors, state.drainInputReject ? 1 : 0);
	maximumListeners = Math.max(maximumListeners, input.listenerCount("data"));
}
clearTimeout(timer);
now = 10_000;
state.onDrainInputTimer(state.drainActiveGeneration);
const rescheduledTimer = state.drainInputTimer;
if (!rescheduledTimer) throw new Error("drain cycle did not reschedule after input near its idle boundary");
maximumTimers = Math.max(maximumTimers, state.drainInputTimer ? 1 : 0);
clearTimeout(rescheduledTimer);
now = 20_000;
state.onDrainInputTimer(state.drainActiveGeneration);
await cycle;
const terminalSource = readFileSync("packages/tui/src/terminal.ts", "utf8");
const inputCallbackSource = terminalSource.match(/private readonly onDrainInputData[\s\S]*?\n\t};/)?.[0] ?? "";
const sourceInvariant = {
	promiseAllocationsPerInputEvent: /new Promise/.test(inputCallbackSource) ? 1 : 0,
	inlineTimerCallbacksPerInputEvent: /setTimeout\([^,]+,\s*\(/.test(inputCallbackSource) ? 1 : 0,
	stableTimerGenerationArgument: /setTimeout\(this\.onDrainInputTimer, delay, generation\)/.test(terminalSource),
	monotonicClock: /private readonly readDrainTime = readMonotonicTime/.test(terminalSource),
};
const afterCycle = {
	active: state.drainInputActive,
	promise: state.drainInputPromise === undefined ? 0 : 1,
	timer: state.drainInputTimer === undefined ? 0 : 1,
	resolver: state.drainInputResolve === undefined ? 0 : 1,
	rejector: state.drainInputReject === undefined ? 0 : 1,
	previousHandler: state.drainInputPreviousHandler === undefined ? 0 : 1,
	listeners: input.listenerCount("data"),
};
terminal.dispose();
process.stdout.write(`${JSON.stringify({
	benchmark: "tui-input-lifecycle",
	commit: currentCommit(),
	fixture: "real-event-emitter",
	dynamicCounters: {
		inputEvents,
		cyclePromisesCreated: 1,
		promiseIdentityChanges,
		timerIdentityChanges,
		listenerIdentityChanges,
		timerCallbackIdentityChanges,
		maximumActivePromises,
		maximumTimers,
		maximumResolvers,
		maximumRejectors,
		maximumListeners,
		maximumTimersMeaning: "maximum concurrently active timer handles",
		timerHandlesCreatedPerCycle: state.drainInputTimerHandlesCreated,
		timerReschedulesPerCycle: state.drainInputTimerReschedules,
	},
	sourceInvariant,
	afterCycle,
}, null, 2)}\n`);
