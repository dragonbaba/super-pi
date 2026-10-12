import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute, toNamespacedPath } from "node:path";
import test, { type TestContext } from "node:test";
import type { ImageContent } from "../packages/ai/src/types.ts";
import { saveCodemodeImages } from "../packages/coding-agent/src/core/codemode-images.ts";
import { capCodemodeOutput } from "../packages/coding-agent/src/core/codemode-result.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";
import { privateOutputFileSystem } from "../packages/coding-agent/src/utils/private-output-file.ts";
import { windowsPrivateOutputDiagnostics } from "../packages/coding-agent/src/utils/windows-private-output.ts";
import { createToolResultPresentationOwner } from "../packages/coding-agent/src/core/tool-result-presentation.ts";

const PNG = Buffer.from("89504e470d0a1a0a00000000", "hex");
function image(bytes = PNG): ImageContent { return { type: "image", data: bytes.toString("base64"), mimeType: "image/png" }; }
function ownedTemp(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "sp-image-files-test-"));
	const previous = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR };
	process.env.TMP = root; process.env.TEMP = root; process.env.TMPDIR = root;
	t.after(() => {
		for (const key of ["TMP", "TEMP", "TMPDIR"] as const) {
			if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
		}
		assert.equal(dirname(root), tmpdir());
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}

test("Codemode image files deduplicate within a completion and retain only private binary/manifest files", async t => {
	ownedTemp(t);
	const source = [image(), image(), image(Buffer.from("ffd8ffe000", "hex")), image(Buffer.from("GIF89a")), image(Buffer.from("RIFF0000WEBP"))];
	const saved = (await saveCodemodeImages(source))!;
	const manifest = JSON.parse(readFileSync(saved.manifestPath!, "utf8"));
	assert.equal(saved.saved, 5); assert.equal(saved.omitted, 0);
	assert.equal(manifest.images[0].path, manifest.images[1].path);
	assert.equal(readdirSync(saved.directory!).length, 5);
	assert.deepEqual(readFileSync(manifest.images[0].path), PNG);
	assert.deepEqual(manifest.images.map((entry: any) => entry.path.slice(entry.path.lastIndexOf("."))), [".png", ".png", ".jpg", ".gif", ".webp"]);
	const files = [...new Set<string>(manifest.images.map((entry: any) => entry.path)), saved.manifestPath!];
	if (process.platform === "win32") {
		const acls = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
$paths = ConvertFrom-Json $env:PI_IMAGE_ACL_PATHS
@($paths | ForEach-Object {
  $acl = [System.IO.File]::GetAccessControl($_)
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  @{protected=$acl.AreAccessRulesProtected; owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; user=$user; count=$rules.Count; sid=$rules[0].IdentityReference.Value; inherited=$rules[0].IsInherited}
}) | ConvertTo-Json -Compress
`], { encoding: "utf8", windowsHide: true, env: { ...process.env, PI_IMAGE_ACL_PATHS: JSON.stringify(files) } }));
		for (const acl of acls) { assert.equal(acl.protected, true); assert.equal(acl.owner, acl.user); assert.equal(acl.count, 1); assert.equal(acl.sid, acl.user); assert.equal(acl.inherited, false); }
		assert.equal(windowsPrivateOutputDiagnostics().nativeHandles, 0);
		assert.equal(windowsPrivateOutputDiagnostics().tokenHandles, 0);
	} else for (const path of files) assert.equal(statSync(path).mode & 0o777, 0o600);
	assert.notEqual((await saveCodemodeImages([source[0]!]))!.manifestPath, saved.manifestPath, "no session/global image cache");
});

test("Codemode image storage caps decoded bytes and count without changing attachments", async t => {
	ownedTemp(t);
	const large = Buffer.alloc(8 * 1024 * 1024); PNG.copy(large);
	const exact = image(large);
	const oversized = image(Buffer.concat([large, Buffer.of(0)]));
	const content = [image(Buffer.from("not an image")), { ...image(), data: "iVBORw0KGgo!" }, oversized, exact, exact, image()];
	const saved = (await saveCodemodeImages(content))!;
	assert.equal(saved.saved, 2); assert.equal(saved.omitted, 4);
	assert.equal(JSON.parse(readFileSync(saved.manifestPath!, "utf8")).images.length, 2);
	assert.equal(content[3], exact);
	const many = (await saveCodemodeImages(Array.from({ length: 17 }, () => image())))!;
	assert.equal(many.saved, 16); assert.equal(many.omitted, 1);
	assert.equal(readdirSync(many.directory!).length, 2);
	assert.equal(saveCodemodeImages([{ type: "text", text: "no image" }]), undefined);
});

test("Codemode partial storage and manifest failures preserve recovery location; failed owned writes are removed", async t => {
	const root = ownedTemp(t), open = privateOutputFileSystem.openSync;
	t.after(() => { privateOutputFileSystem.openSync = open; });
	let opens = 0;
	privateOutputFileSystem.openSync = path => {
		if (++opens === 2) throw Object.assign(new Error("fixture failure"), { code: "ENOSPC" });
		return open(path);
	};
	const saved = (await saveCodemodeImages([image()]))!;
	assert.equal(saved.saved, 1); assert.equal(saved.manifestPath, undefined);
	assert.ok(existsSync(join(saved.directory!, "1.png")));
	assert.match(saved.notice, /manifest unavailable/);
	let failedPath = "";
	privateOutputFileSystem.openSync = path => { failedPath = path; const fd = open(path); closeSync(fd); return fd; };
	const failed = (await saveCodemodeImages([image()]))!;
	assert.equal(failed.saved, 0); assert.equal(failed.directory, undefined);
	assert.equal(existsSync(failedPath), false);
	assert.equal(readdirSync(root).length, 1, "only the successfully saved output remains");
});

test("image manifest notices survive the minimum text cap and preserve native block identity", async t => {
	ownedTemp(t);
	const block = image(), content = [{ type: "text" as const, text: "summary ".repeat(1000) }, block];
	const saved = (await saveCodemodeImages(content))!;
	const result = await capCodemodeOutput(content, 256, saved.notice);
	assert.ok(result.includes(block));
	assert.ok(result.some(b => b.type === "text" && b.text.includes(saved.manifestPath!)));
	assert.ok(estimateToolOutputTokens(result).estimatedTokens <= 256);
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "capped-image-notice")!;
	try {
		const visible = owner.create(result, "image-cap")!.modelContent;
		for (const part of visible) if (part.type === "text" && part.text.includes(saved.directory!)) assert.ok(part.text.includes(saved.manifestPath!));
		assert.ok(estimateToolOutputTokens(visible).estimatedTokens <= 128);
	} finally { owner.release(); owner.dispose(); }
});

test("image metadata near a projection budget boundary retains affordable complete read groups", () => {
	for (let index = 0; index < 16; index++) {
		const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 1024 }, "image-read-boundary")!;
		const content: any[] = [
			{ type: "text", text: "[CODEMODE_OK] Child calls: 3.\nread: completed\npictures: completed\nread: completed\n[Image files: read /tmp/sp-images/" + "x".repeat(index * 12) + "/images.json. Temporary.]" },
			{ type: "text", text: "padding ".repeat(1000) },
			{ type: "text", readBoundary: "lines", text: "1#4518|leading\n" },
			{ type: "text", readBoundary: "metadata", text: "[Snapshot edit] snapshot=snap_91lNAK4Y4Y-Zhy2e7EQfkw; editable lines=1-1. Use this snapshot and its LINE#ID anchors together." },
			{ type: "text", text: "Image reading is disabled." },
			{ type: "text", readBoundary: "lines", text: "1#1DE8|hello\n2#1020|world\n" },
			{ type: "text", readBoundary: "metadata", text: "[Snapshot edit] snapshot=snap_e4IEylMPftC-LWU4GwTYkA; editable lines=1-2. Use this snapshot and its LINE#ID anchors together." },
		];
		try {
			const projected = owner.create(content, `image-${index}`)!.modelContent;
			assert.ok(projected.some(b => b.type === "text" && b.text.includes("|hello")), `metadata variant ${index}`);
			assert.ok(estimateToolOutputTokens(projected).estimatedTokens <= 1024);
		} finally { owner.release(); owner.dispose(); }
	}
});

test("review: relative and deep temporary roots cannot invalidate completed image output", async t => {
	const root = ownedTemp(t), cwd = process.cwd();
	mkdirSync(join(root, "relative"));
	try {
		process.chdir(root);
		process.env.TMP = process.env.TEMP = process.env.TMPDIR = "relative";
		const saved = (await saveCodemodeImages([image()]))!;
		assert.ok(isAbsolute(saved.manifestPath!), "persisted image paths must not depend on the original cwd");
		const manifest = JSON.parse(readFileSync(saved.manifestPath!, "utf8"));
		assert.ok(isAbsolute(manifest.images[0].path));
	} finally { process.chdir(cwd); }
	const deep = join(root, ...Array.from({ length: 8 }, (_, i) => `${i}-` + "a0b1c2d3".repeat(10)));
	mkdirSync(deep, { recursive: true });
	process.env.TMP = process.env.TEMP = process.env.TMPDIR = toNamespacedPath(deep);
	for (const text of ["summary", "summary ".repeat(1000)]) {
		const block = image(), saved = (await saveCodemodeImages([block]))!;
		assert.ok(saved.manifestPath, saved.notice);
		const result = await capCodemodeOutput([{ type: "text", text: text + "\n" + saved.notice }, block], 256, saved.notice);
		assert.ok(result.includes(block));
		assert.ok(estimateToolOutputTokens(result).estimatedTokens <= 256);
		assert.ok(result.some(b => b.type === "text" && b.text.includes("saved result metadata")));
		assert.ok(existsSync(saved.manifestPath!));
	}
});

test("image completion yields to the event loop during large private writes", async t => {
	ownedTemp(t);
	const bytes = Buffer.alloc(8 * 1024 * 1024); PNG.copy(bytes);
	let responsive = false;
	const tick = setImmediate(() => { responsive = true; });
	t.after(() => clearImmediate(tick));
	const saved = await saveCodemodeImages([image(bytes)]);
	assert.equal(saved!.saved, 1);
	assert.equal(responsive, true, "private image persistence must yield before it completes");
});

test("optional image files are reclaimed when their space prevents text recovery", async t => {
	ownedTemp(t);
	const block = image(), saved = (await saveCodemodeImages([block]))!;
	const imagePath = JSON.parse(readFileSync(saved.manifestPath!, "utf8")).images[0].path;
	const open = privateOutputFileSystem.openSync;
	t.after(() => { privateOutputFileSystem.openSync = open; });
	let spillPath = "", denied = 0;
	privateOutputFileSystem.openSync = path => {
		if (path.endsWith(".log")) {
			if (existsSync(imagePath)) { denied++; throw Object.assign(new Error("space consumed by optional images"), { code: "ENOSPC" }); }
			spillPath = path;
		}
		return open(path);
	};
	const content = [{ type: "text" as const, text: saved.notice + "\n" + "recovery payload ".repeat(1000) }, block];
	const result = await capCodemodeOutput(content, 256, saved.notice, saved);
	assert.equal(denied, 1);
	assert.ok(spillPath, "free optional image space and retry text persistence once");
	assert.match(readFileSync(spillPath, "utf8"), /recovery payload/);
	assert.equal(existsSync(imagePath), false);
	assert.equal(saved.saved, 0);
	assert.ok(result.includes(block));
});

test("an atomic image prefix that cannot fit remains recoverable after JSONL-shaped resume", () => {
	const prefix = "[Image files: read /tmp/" + "a0b1c2d3".repeat(80) + "/images.json.]";
	const content = [{ type: "text" as const, text: prefix + "\n" + "trailing output ".repeat(200), projectionPrefix: prefix.length }];
	const owner = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "atomic-image")!;
	const presentation = owner.create(content, "image-call")!;
	assert.equal(presentation.version, 2);
	if (presentation.version !== 2) return;
	assert.ok(presentation.modelContent.every(b => b.type !== "text" || !b.text.includes("/tmp/")), "omit the path atomically instead of presenting a fragment");
	const cursor = presentation.continuation.cursor;
	owner.release(); owner.dispose();
	const messages = JSON.parse(JSON.stringify([{ role: "toolResult", toolCallId: "image-call", toolName: "codemode", content, isError: false, timestamp: 1 }]));
	const resumed = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "atomic-image")!;
	try {
		const recovered = resumed.readContinuation(cursor, messages, 4096);
		assert.ok(recovered.content.some(b => b.type === "text" && b.text.includes(prefix)));
		messages[0].content[0].projectionPrefix = 1;
		const changed = createToolResultPresentationOwner({ enabled: true, budgetTokens: 128 }, "atomic-image")!;
		try { assert.throws(() => changed.readContinuation(cursor, messages, 4096), { code: "stale-cursor" }); }
		finally { changed.dispose(); }
	} finally { resumed.dispose(); }
});
