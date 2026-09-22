import * as _bundledPiAgentCore from "@super-pi/agent-core";
import * as _bundledPiAiCompat from "@super-pi/ai/compat";
import * as _bundledPiAiOauth from "@super-pi/ai/oauth";
import * as _bundledPiAiProviders from "@super-pi/ai/providers/all";
import * as _bundledPiTui from "@super-pi/tui";
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import @super-pi/coding-agent.
import * as _bundledPiCodingAgent from "../../index.ts";

/** Modules available to extensions via virtualModules (for compiled Bun binary). */
export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: _bundledTypebox,
	"typebox/compile": _bundledTypeboxCompile,
	"typebox/value": _bundledTypeboxValue,
	"@sinclair/typebox": _bundledTypebox,
	"@sinclair/typebox/compile": _bundledTypeboxCompile,
	"@sinclair/typebox/value": _bundledTypeboxValue,
	"@super-pi/agent-core": _bundledPiAgentCore,
	"@super-pi/tui": _bundledPiTui,
	"@super-pi/ai": _bundledPiAiCompat,
	"@super-pi/ai/compat": _bundledPiAiCompat,
	"@super-pi/ai/oauth": _bundledPiAiOauth,
	"@super-pi/ai/providers/all": _bundledPiAiProviders,
	"@super-pi/coding-agent": _bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": _bundledPiAgentCore,
	"@mariozechner/pi-tui": _bundledPiTui,
	"@mariozechner/pi-ai": _bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": _bundledPiAiCompat,
	"@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": _bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};
