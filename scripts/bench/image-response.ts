import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pngFixture, oversizedHeader } from "../../tests/helpers/image-acceptance-fixtures.ts";
const run = promisify(execFile);
const scheduling = process.argv.includes("--natural") ? "natural" : "forced";
const root = mkdtempSync(join(tmpdir(), "sp-image-response-"));
const fixtureDir = join(root, "fixtures"); mkdirSync(fixtureDir);
const screenshot = pngFixture(1920, 1080), large = pngFixture(6000, 3999), bytes = pngFixture(1600, 1600, true);
const inputs = { screenshot, "near-24mp": large, "near-bytes": bytes, multi: bytes, "over-pixels": oversizedHeader(), "over-bytes": Buffer.alloc(10 * 1024 * 1024 + 1), corrupt: screenshot.subarray(0, screenshot.length / 2) };
for (const [name, data] of Object.entries(inputs)) writeFileSync(join(fixtureDir, name + ".png"), data);
console.log(JSON.stringify({ scheduling, targets: { inputOrCancelMs: 100, matchingFrameMs: 150 }, fixtureBytes: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value.length])) }));
try {
	for (const scenario of Object.keys(inputs)) for (const cancel of [false, true]) {
		const childRoot = join(root, `${scenario}-${cancel}`); mkdirSync(childRoot);
		const result = await run(process.execPath, ["--expose-gc", "--experimental-strip-types", resolve("scripts/bench/image-response-child.ts"), childRoot, join(fixtureDir, scenario + ".png"), scenario, String(cancel), scheduling],
			{ windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
		console.log(result.stdout.trim());
	}
} finally { rmSync(root, { recursive: true }); }
