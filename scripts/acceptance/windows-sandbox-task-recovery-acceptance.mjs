// A new run against the repaired source bundle; the section 68 failure archive
// and its original entry are retained as historical evidence.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTaskAcceptance, taskSourceManifest } from "./windows-sandbox-task-acceptance.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.length !== 5 || process.argv[2] !== "--run-repaired-task-once" || process.argv[3] !== "--source-bundle") {
        throw new Error("Explicit repaired source bundle required");
    }
    if (taskSourceManifest().sha256 !== process.argv[4]) throw new Error("Repaired source bundle changed");
    if (!(await runTaskAcceptance(process.argv[4])).passed) process.exitCode = 1;
}
