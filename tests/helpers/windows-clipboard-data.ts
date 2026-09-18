import assert from "node:assert/strict";
import { readClipboardText } from "../../packages/coding-agent/src/utils/clipboard.ts";
import { runClipboardCommand } from "../../packages/coding-agent/src/utils/clipboard-image.ts";

/** Run the production STA script with an in-memory Forms source; never set the system clipboard. */
export async function readFormsClipboardFixture(paths: string[], text?: string, signal?: AbortSignal) {
	let calls = 0;
	const value = await readClipboardText(signal, {
		platform: "win32",
		powerShellRead: async (command, args, options) => {
			calls++;
			const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
			const source = "[System.Windows.Forms.Clipboard]::GetDataObject()";
			assert.equal(script.split(source).length, 2, "replace only the OS clipboard source");
			const fixture = Buffer.from(JSON.stringify({ paths, text }), "utf8").toString("base64");
			const setup = `Add-Type -AssemblyName System.Windows.Forms; $fixture=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fixture}')) | ConvertFrom-Json); $fixtureData=New-Object System.Windows.Forms.DataObject; if ($fixture.paths.Count -gt 0) { $fixtureData.SetData([System.Windows.Forms.DataFormats]::FileDrop, [string[]]$fixture.paths) }; if ($null -ne $fixture.text) { $fixtureData.SetData([System.Windows.Forms.DataFormats]::UnicodeText, [string]$fixture.text) }; `;
			return runClipboardCommand(command, [...args.slice(0, -1), Buffer.from(setup + script.replace(source, "$fixtureData"), "utf16le").toString("base64")], options);
		},
		nativeRead: async () => { assert.fail("successful Forms read must not fall through to native"); },
	});
	assert.equal(calls, signal?.aborted ? 0 : 1);
	return value;
}
