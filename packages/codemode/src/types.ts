import type { CodemodeWasmModule } from "./wasm.ts";

export interface CodemodeToolContext {
	/** Host-issued identity within this execution, shared by tools and globals. */
	callId: number;
	/**
	 * Aborted when the script finishes (including unawaited calls), the
	 * execution times out, the caller aborts, or the sandbox is closed.
	 */
	signal: AbortSignal;
}

/** A JSON Schema document. Only used to render declarations; values are not validated against it. */
export type CodemodeJsonSchema = { [key: string]: unknown } | boolean;

export interface CodemodeTool {
	/**
	 * The script calls tools as `tools.<id>(args)`, where `<id>` is the name with characters that
	 * are not valid in identifiers replaced by `_`, suffixed `_2`, `_3`, ... when names collide
	 * (see `assignCodemodeIdentifiers`), and also as
	 * `tools["<name>"](args)`. Globals are called as `<name>(args)` and must be identifiers, or
	 * `<namespace>.<member>`, which groups them into a frozen namespace object.
	 */
	name: string;
	/** Shown as a doc comment in {@link renderDeclarations}, and listed in `ALL_TOOLS` for tools. */
	description?: string;
	/** Schema of the single argument. Rendered as the parameter type; `unknown` when omitted. */
	inputSchema?: CodemodeJsonSchema;
	/** Schema of the resolved value. Rendered as the promise type; `unknown` when omitted. */
	outputSchema?: CodemodeJsonSchema;
	/** Globals only: `execute` receives all call arguments as an array instead of the first one. */
	spread?: boolean;
	/**
	 * Globals only: TypeScript parameter list and return type for {@link renderDeclarations}, for
	 * example `(type: string, id?: string): Promise<Model[]>`. Replaces the rendering from the schemas.
	 */
	signature?: string;
	/**
	 * `args` is whatever the script passed, after a JSON round trip. The return
	 * value must be JSON-serializable; a thrown error surfaces in the script as
	 * an `Error` with the same message.
	 */
	execute(args: unknown, context: CodemodeToolContext): Promise<unknown> | unknown;
}

/**
 * One item of the script's output, in the order the script produced it: `text()` and `console.*`
 * produce text items, `image()` image items. `data` is base64.
 */
export type CodemodeOutputItem = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type CodemodeCallStatus = "ok" | "error" | "cancelled";

export interface CodemodeCall {
	id?: number;
	failureHandled?: boolean;
	name: string;
	status: CodemodeCallStatus;
	durationMs: number;
}
/** Error/cancellation metadata only; successful globals stay outside result.calls. */
export interface CodemodeUnobservedGlobal {
	id: number;
	name: string;
	status: "error" | "cancelled";
	error?: string;
}

export type CodemodeErrorKind =
	/** The script threw or failed to parse. `name` and `stack` come from the script's error. */
	| "script"
	/** The configured execution budget expired. The worker was terminated. */
	| "timeout"
	/** The caller's signal fired or the sandbox was closed. The worker was terminated. */
	| "aborted"
	/** The worker or VM failed outside the script's control (for example a wasm trap or a missing worker file). */
	| "sandbox";

export interface CodemodeError {
	kind: CodemodeErrorKind;
	name?: string;
	message: string;
	stack?: string;
}

/** Keys the script changed with `store()`. Only successful executions report writes. */
export interface CodemodeStoreWrites {
	set: Record<string, unknown>;
	/** Keys stored as `undefined`. */
	delete: string[];
}

/** `output` is kept for failed executions too, up to the failure. `exit()` completes with `value: undefined`. */
export type CodemodeResult =
	| {
			ok: true;
			value: unknown;
			output: CodemodeOutputItem[];
			calls: CodemodeCall[];
			storeWrites: CodemodeStoreWrites;
			handledCallIds?: number[];
			unobservedGlobals?: CodemodeUnobservedGlobal[];
	  }
	| { ok: false; error: CodemodeError; output: CodemodeOutputItem[]; calls: CodemodeCall[]; handledCallIds?: number[]; unobservedGlobals?: CodemodeUnobservedGlobal[] };

export interface CodemodeSandboxOptions {
	tools?: CodemodeTool[];
	/**
	 * Functions exposed as top-level identifiers instead of on `tools`, for host helpers such as
	 * attaching an image to the result. They behave like tools (JSON round trip, promise result)
	 * but are not recorded in `result.calls`. Names must be identifiers and may not shadow the
	 * built-in globals (`tools`, `ALL_TOOLS`, `console`, `text`, `image`, `exit`, `store`, `load`).
	 */
	globals?: CodemodeTool[];
	/**
	 * Execution budget in milliseconds, interpreted by timeoutMode. Positive integer,
	 * at most 300000 ms. Default: 60000. The budget cannot be disabled.
	 */
	timeoutMs?: number;
	/**
	 * Default: wall time, including tools. Active time excludes confirmed VM waits
	 * for host tools/helpers; startup, computation and bridge delivery still count.
	 * Active mode requires the caller to bound/cancel host work independently.
	 */
	timeoutMode?: "wall" | "active";
	/**
	 * Maximum memory the QuickJS VM may allocate. Allocations beyond it fail inside the script as
	 * `InternalError: out of memory`. Default and maximum: 256 MiB; minimum: 1 MiB.
	 */
	memoryLimitBytes?: number;
	/**
	 * Compiled `quickjs-wasi/quickjs.wasm`, usually from {@link loadQuickJSWasm}. Default:
	 * `loadQuickJSWasm()`, the file in the installed `quickjs-wasi` package. Pass it when that file
	 * is not on disk, for example in a Bun compiled executable.
	 */
	wasm?: CodemodeWasmModule | Promise<CodemodeWasmModule>;
	/**
	 * Worker entry that imports `@super-pi/codemode/worker`. Default: this package's own
	 * worker file. Pass it when this package is bundled, since the default is resolved relative to
	 * the module that creates the sandbox. Bun compiled executables require the relative string
	 * specifier of an embedded build entrypoint; other hosts usually use a URL.
	 */
	workerUrl?: string | URL;
	/** Reuse one Worker with fresh VMs/ports. Default: false. Retire at 30 s idle, 64 runs or >64 MiB WASM. */
	reuseWorker?: boolean;
}

export interface CodemodeExecuteOptions {
	signal?: AbortSignal;
	/** Overrides the sandbox default for this execution. */
	timeoutMs?: number;
	/**
	 * Values the script reads with `load(key)`. Must be JSON-serializable. The script's own
	 * `store()` calls come back as `result.storeWrites`; persisting them is up to the caller.
	 */
	store?: Readonly<Record<string, unknown>>;
}
