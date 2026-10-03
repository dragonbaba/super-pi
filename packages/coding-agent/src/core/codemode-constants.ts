import { Type } from "typebox";
import { CODEMODE_SOURCE_GRAMMAR } from "@super-pi/codemode/source";

export const CODEMODE_NAME = "codemode";
export const CODEMODE_STORE_ENTRY = "codemode-store-v1";
export const CODEMODE_CALL_ENTRY = "codemode-tool-call-v1";
export const CODEMODE_RESULT_ENTRY = "codemode-tool-result-v1";
export const CODEMODE_MUTATION_NAMES: ReadonlySet<string> = new Set(["write", "edit", "delete", "move", "file_batch"]);
export const CODEMODE_PARAMETERS = Type.Object({ code: Type.String({ minLength: 1, maxLength: 128 * 1024 }) }, { additionalProperties: false });
export const CODEMODE_SAMPLING = { type: "grammar" as const, variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } };
export const DIRECT_CONTROL_NAMES: ReadonlySet<string> = new Set([
	"ask_user", "plan_mode_question", "plan_mode_complete", "goal_complete", "goal_blocked", "update_plan",
]);
export const MAX_CODEMODE_RETAINED_CHARS = 1024 * 1024;
export const MAX_CODEMODE_DESCRIPTION_CHARS = 32 * 1024;
export const CODEMODE_DESCRIPTION = `Execute JavaScript to call ordinary tools. This is the default tool entry point.
Use await tools.NAME(args), or await callTool(name, args) for tools activated during this script. Tool results have content, details, isError and a host-issued ref. Failed child calls keep the parent failed even if caught.
Use text(value), console.log(value), image(base64OrImageBlock), or return to report calculations. exit() ends the script successfully. To show an unchanged native result, use await show(result.ref). Only a native read shown this way in an earlier completed turn can qualify for guarded edits; text() output, hidden reads, same-turn reads, stored references and forged fields do not authorize edits. If a displayed read is truncated by the model budget, read a smaller range again.
Shell status is the actual process status. For queries such as grep, handle the documented no-match status explicitly inside the command, preserve unexpected errors, and label the empty result. Do not append an unconditional echo or use a trailing pipeline to hide failure. Empty output alone does not prove a network request succeeded or that there was no leak.
ALL_TOOLS lists the current snapshot. await describeTools([names]) returns current declarations; tools.tool_search can activate allowed tools. Newly activated tools can be called with callTool(name,args) immediately.
store(key,value)/load(key) keep bounded JSON state on this session branch; failed executions do not commit it. Tool side effects are never rolled back. show() results are appended after script text. Do not re-run completed mutations to recover their output.
No Node, filesystem, network or timer globals are available. Each child call goes through normal policy and cancellation. Interaction and Plan/Goal control tools must be called directly.
Optional first line: // @options: {"timeout_ms":60000,"max_output_tokens":4000}
Limits: 256 calls, 4 concurrent trusted reads, serial writes, 60s default / 300s maximum. Combine related operations in one script to amortize worker startup.
max_output_tokens accepts 256..16384 (default 8000), using Super Pi's conservative text estimator; image billing is separate. Larger output is saved through the native capped spill mechanism.
Example: const r = await tools.read({path:"package.json"}); await show(r.ref);
`;
