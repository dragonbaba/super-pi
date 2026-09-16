import { runBashResponsiveness } from "../../tests/helpers/bash-responsiveness-fixture.ts";
import { currentCommit, readIntegerOption } from "./benchmark.ts";
import { execFileSync } from "node:child_process";

const rootIndex = process.argv.indexOf("--source-root");
const sourceRoot = rootIndex < 0 ? undefined : process.argv[rootIndex + 1];
const results = [];
for (let run = 0; run < readIntegerOption("--runs", 1); run++) {
	for (const scenario of ["short", "long", "output-then-quiet", "off-tail"] as const) results.push({ run, ...await runBashResponsiveness(scenario, sourceRoot) });
}
console.log(JSON.stringify({ harnessCommit: currentCommit(), sourceCommit: execFileSync("git", ["-C", sourceRoot ?? process.cwd(), "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceRoot: sourceRoot ?? "current worktree", results }, null, 2));
