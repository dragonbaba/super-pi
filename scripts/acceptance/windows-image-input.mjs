import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { syncBuiltinESMExports } from "node:module";

const kind = process.argv[2];
if (kind !== "multimodal" && kind !== "auxiliary") throw new Error("Usage: node --experimental-strip-types scripts/acceptance/windows-image-input.mjs multimodal|auxiliary [--check|--startup-check]");
const root = mkdtempSync(join(tmpdir(), "sp-native-image-"));
// Isolate before importing application modules, including module-level config paths.
const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|TERM|TERM_PROGRAM|WT_SESSION|WT_PROFILE_ID|COLORTERM|LANG|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i;
const isolatedEnvironment = {};
for (const [name, value] of Object.entries(process.env)) if (allowed.test(name)) isolatedEnvironment[name] = value;
process.env = isolatedEnvironment;
process.env.SP_CODING_AGENT_DIR = join(root, "agent"); process.env.SP_OFFLINE = "1";
process.env.SP_CODING_AGENT_SESSION_DIR = join(root, "sessions");
// Deny outbound sockets even if an unexpected provider path is taken.
Socket.prototype.connect = function () { throw new Error("Network disabled in offline image acceptance"); };
globalThis.fetch = async () => { throw new Error("External fetch disabled in offline image acceptance"); };
syncBuiltinESMExports();
const { offlineImageRuntime } = await import("../../tests/helpers/offline-image-runtime.ts");
const { pngFixture } = await import("../../tests/helpers/image-acceptance-fixtures.ts");
const { InteractiveMode } = await import("../../packages/coding-agent/src/modes/interactive/interactive-mode.ts");
const fixtures = join(root, "outside-workspace"); mkdirSync(fixtures);
for (const name of ["截图测试 中文.png", "second image.png"]) writeFileSync(join(fixtures, name), pngFixture(800, 600));
const log = join(root, "events.jsonl"); let count = 0;
const f = await offlineImageRuntime(root, kind === "auxiliary", undefined, event => { if (++count <= 256) appendFileSync(log, JSON.stringify(event) + "\n"); });
process.chdir(f.cwd);
writeFileSync(join(root, "run.json"), JSON.stringify({ kind, node: process.version, platform: process.platform, tty: Boolean(process.stdin.isTTY),
	terminalProgram: process.env.TERM_PROGRAM ?? null, windowsTerminal: Boolean(process.env.WT_SESSION), shell: process.env.COMSPEC,
	root, fixtures, log, nativeInputExecuted: false }, null, 2));
console.log(`OFFLINE ${kind}\nRun directory: ${root}\nExplorer fixtures: ${fixtures}\nEvents: ${log}\nNo external network or user model configuration. Alt+V uses the REAL clipboard. Use only non-sensitive screenshots.`);
if (process.argv.includes("--check")) {
	try { await f.session.prompt("SDK transport self-check (not native input acceptance)", { images: [{ type: "image", data: pngFixture(8, 8).toString("base64"), mimeType: "image/png" }] });
		if (f.counts.main !== 1 || f.counts.vision !== (kind === "auxiliary" ? 1 : 0)) throw new Error("Offline transport check failed");
		console.log(JSON.stringify({ check: "SDK transport only", counts: f.counts }));
	} finally { await f.close(); }
} else {
	const mode = new InteractiveMode(f.host, { tuiMode: "regular" });
	if (process.argv.includes("--startup-check")) { try { await mode.init(); } finally { await mode.stop(); await f.close(); } console.log("Startup check only; native gestures not executed"); }
	else await mode.run();
}
