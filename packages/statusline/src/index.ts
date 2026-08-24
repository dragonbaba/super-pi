import type { ExtensionAPI } from "@super-pi/coding-agent";
import { checkRuntimeCompatibility, discoverPiRuntimeVersion } from "./runtime-compat.js";
import { sanitizeTerminalText, unknownTerminalText } from "./terminal-text.js";

export default async function statuslineCompatibilityEntry(pi: ExtensionAPI): Promise<void> {
	const compatibility = checkRuntimeCompatibility(discoverPiRuntimeVersion());
	if (!compatibility.compatible) {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.notify(compatibility.reason, "warning");
		});
		return;
	}

	try {
		const { registerStatusline } = await import("./statusline.js");
		registerStatusline(pi);
	} catch (error) {
		const detail = sanitizeTerminalText(
			error instanceof Error ? error.message : unknownTerminalText(error),
			240,
		);
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) {
				ctx.ui.notify(`pi-statusline could not start on Pi ${compatibility.version}: ${detail}`, "warning");
			}
		});
	}
}

export { checkRuntimeCompatibility, SUPPORTED_SP_LINE } from "./runtime-compat.js";
