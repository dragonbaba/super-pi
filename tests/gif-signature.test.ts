import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectSupportedImageMimeType, detectSupportedImageMimeTypeFromFile } from "../packages/coding-agent/src/utils/mime.ts";
import { processFileArguments } from "../packages/coding-agent/src/cli/file-processor.ts";
import { createReadToolDefinition } from "../packages/coding-agent/src/core/tools/read.ts";

const pixel = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
for (const signature of ["GIF87a", "GIF89a"]) test(`${signature} reaches read and CLI image processing`, async () => {
	const bytes = Buffer.from(pixel); bytes.write(signature);
	const directory = await mkdtemp(join(tmpdir(), "pi087-gif-")); const path = join(directory, "image.dat");
	try {
		await writeFile(path, bytes);
		assert.equal(detectSupportedImageMimeType(bytes), "image/gif");
		assert.equal(await detectSupportedImageMimeTypeFromFile(path), "image/gif");
		const read = await createReadToolDefinition(directory).execute("read", { path }, undefined, undefined, {} as never);
		assert.ok(read.content.some(block => block.type === "image"));
		const cli = await processFileArguments([path]); assert.equal(cli.images.length, 1);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

for (const text of ["GIF", "GIF8", "GIF87", "GIF89", "GIF89b", "GIF is an image format\nordinary text", "gif89a"]) {
	test(`incomplete/text signature remains text at both entries: ${JSON.stringify(text)}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi087-gif-text-")); const path = join(directory, "text.gif");
		try {
			await writeFile(path, text);
			assert.equal(detectSupportedImageMimeType(Buffer.from(text)), null);
			assert.equal(await detectSupportedImageMimeTypeFromFile(path), null);
			const read = await createReadToolDefinition(directory).execute("read", { path }, undefined, undefined, {} as never);
			assert.equal(read.content.some(block => block.type === "image"), false);
			assert.equal(read.content[0].type === "text" ? read.content[0].text : "", text);
			const cli = await processFileArguments([path]); assert.equal(cli.images.length, 0); assert.ok(cli.text.includes(text));
		} finally { await rm(directory, { recursive: true, force: true }); }
	});
}
