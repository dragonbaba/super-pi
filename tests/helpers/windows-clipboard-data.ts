import assert from "node:assert/strict";
import { readClipboardText } from "../../packages/coding-agent/src/utils/clipboard.ts";
import { runClipboardCommand } from "../../packages/coding-agent/src/utils/clipboard-image.ts";
import { NativeClipboardError } from "../../packages/coding-agent/src/utils/clipboard-native-process.ts";

// A Windows Forms process can exceed the production read deadline while a hosted
// CI runner is starting PowerShell. Keep the production deadline observable in
// the injected seam, but give this in-memory integration fixture its own bound.
const FIXTURE_POWERSHELL_TIMEOUT_MS = 15_000;

/** Run the production STA script with an in-memory Forms source; never set the system clipboard. */
export async function readFormsClipboardFixture(paths: string[], text?: string, signal?: AbortSignal, execute: typeof runClipboardCommand = runClipboardCommand) {
	let calls = 0;
	let helperFailure: unknown;
	const fixtureExecute: typeof runClipboardCommand = execute === runClipboardCommand
		? (command, args, options) => execute(command, args, { ...options, timeoutMs: FIXTURE_POWERSHELL_TIMEOUT_MS })
		: execute;
	const value = await readClipboardText(signal, {
		platform: "win32",
		powerShellRead: async (command, args, options) => {
			calls++;
			const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
			const source = "[System.Windows.Forms.Clipboard]::GetDataObject()";
			assert.equal(script.split(source).length, 2, "replace only the OS clipboard source");
			const fixture = Buffer.from(JSON.stringify({ paths, text }), "utf8").toString("base64");
			const setup = `Add-Type -AssemblyName System.Windows.Forms; $fixture=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fixture}')) | ConvertFrom-Json); $fixtureData=New-Object System.Windows.Forms.DataObject; if ($fixture.paths.Count -gt 0) { $fixtureData.SetData([System.Windows.Forms.DataFormats]::FileDrop, [string[]]$fixture.paths) }; if ($null -ne $fixture.text) { $fixtureData.SetData([System.Windows.Forms.DataFormats]::UnicodeText, [string]$fixture.text) }; `;
			try { return await fixtureExecute(command, [...args.slice(0, -1), Buffer.from(setup + script.replace(source, "$fixtureData"), "utf16le").toString("base64")], options); }
			catch (error) { helperFailure = error; throw error; }
		},
		nativeRead: async () => { throw new NativeClipboardError(`Forms fixture failed: ${String(helperFailure ?? "unexpected fallback")}`, true); },
	});
	assert.equal(calls, signal?.aborted ? 0 : 1);
	return value;
}
