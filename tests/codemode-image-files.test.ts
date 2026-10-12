import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test, { type TestContext } from "node:test";
import type { ImageContent } from "../packages/ai/src/types.ts";
import { saveCodemodeImages } from "../packages/coding-agent/src/core/codemode-images.ts";
import { capCodemodeOutput } from "../packages/coding-agent/src/core/codemode-result.ts";
import { estimateToolOutputTokens } from "../packages/coding-agent/src/core/tool-output-budget.ts";
import { privateOutputFileSystem } from "../packages/coding-agent/src/utils/private-output-file.ts";
import { windowsPrivateOutputDiagnostics } from "../packages/coding-agent/src/utils/windows-private-output.ts";

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

test("Codemode image files deduplicate within a completion and retain only private binary/manifest files", t => {
	ownedTemp(t);
	const source = [image(), image(), image(Buffer.from("ffd8ffe000", "hex")), image(Buffer.from("GIF89a")), image(Buffer.from("RIFF0000WEBP"))];
	const saved = saveCodemodeImages(source)!;
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
	assert.notEqual(saveCodemodeImages([source[0]!])!.manifestPath, saved.manifestPath, "no session/global image cache");
});

test("Codemode image storage caps decoded bytes and count without changing attachments", t => {
	ownedTemp(t);
	const large = Buffer.alloc(8 * 1024 * 1024); PNG.copy(large);
	const exact = image(large);
	const oversized = image(Buffer.concat([large, Buffer.of(0)]));
	const content = [image(Buffer.from("not an image")), { ...image(), data: "iVBORw0KGgo!" }, oversized, exact, exact, image()];
	const saved = saveCodemodeImages(content)!;
	assert.equal(saved.saved, 2); assert.equal(saved.omitted, 4);
	assert.equal(JSON.parse(readFileSync(saved.manifestPath!, "utf8")).images.length, 2);
	assert.equal(content[3], exact);
	const many = saveCodemodeImages(Array.from({ length: 17 }, () => image()))!;
	assert.equal(many.saved, 16); assert.equal(many.omitted, 1);
	assert.equal(readdirSync(many.directory!).length, 2);
	assert.equal(saveCodemodeImages([{ type: "text", text: "no image" }]), undefined);
});

test("Codemode partial storage and manifest failures preserve recovery location; failed owned writes are removed", t => {
	const root = ownedTemp(t), open = privateOutputFileSystem.openSync;
	t.after(() => { privateOutputFileSystem.openSync = open; });
	let opens = 0;
	privateOutputFileSystem.openSync = path => {
		if (++opens === 2) throw Object.assign(new Error("fixture failure"), { code: "ENOSPC" });
		return open(path);
	};
	const saved = saveCodemodeImages([image()])!;
	assert.equal(saved.saved, 1); assert.equal(saved.manifestPath, undefined);
	assert.ok(existsSync(join(saved.directory!, "1.png")));
	assert.match(saved.notice, /manifest unavailable/);
	let failedPath = "";
	privateOutputFileSystem.openSync = path => { failedPath = path; const fd = open(path); closeSync(fd); return fd; };
	const failed = saveCodemodeImages([image()])!;
	assert.equal(failed.saved, 0); assert.equal(failed.directory, undefined);
	assert.equal(existsSync(failedPath), false);
	assert.equal(readdirSync(root).length, 1, "only the successfully saved output remains");
});

test("image manifest notices survive the minimum text cap and preserve native block identity", async t => {
	ownedTemp(t);
	const block = image(), content = [{ type: "text" as const, text: "summary ".repeat(1000) }, block];
	const saved = saveCodemodeImages(content)!;
	const result = await capCodemodeOutput(content, 256, saved.notice);
	assert.ok(result.includes(block));
	assert.ok(result.some(b => b.type === "text" && b.text.includes(saved.manifestPath!)));
	assert.ok(estimateToolOutputTokens(result).estimatedTokens <= 256);
});
