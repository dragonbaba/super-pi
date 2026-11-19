import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const adapter = new URL("../dist/api/openai-codex-responses.js", import.meta.url);
const digest = createHash("sha256").update(readFileSync(adapter)).digest("hex");
writeFileSync(new URL("./codex-adapter-build.js", adapter), `export const CODEX_ADAPTER_BUILD = "${digest}";\n`);
