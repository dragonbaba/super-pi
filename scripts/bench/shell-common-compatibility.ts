import { performance } from "node:perf_hooks";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "../../packages/coding-agent/src/core/tools/bash.ts";

function compareNumbers(left: number, right: number): number { return left - right; }

const cwd = mkdtempSync(join(tmpdir(), "sp-shell-bench-"));
const tool = createBashTool(cwd, { exposeSessionEnvironment: false, shellPath: process.env.SP_BENCH_BASH });
const cases = [
  ["ordinary", "printf 'ok\\n'", 12],
  ["complex", "for t in printf cat; do command -v \"$t\" >/dev/null 2>&1; done; { printf out; printf err >&2; } 2>&1 | head -c 16", 12],
  ["large-output", "node -e \"process.stdout.write('x'.repeat(6*1024*1024))\"", 3],
] as const;

try {
  for (const [name, command, runs] of cases) {
    const samples: number[] = [];
    let capped: boolean | undefined;
    let bytes: number | undefined;
    for (let index = 0; index < runs; index++) {
      const start = performance.now();
      const result = await tool.execute(`bench-${name}-${index}`, { command });
      samples.push(performance.now() - start);
      capped = (result.details as { spillFileCapped?: boolean } | undefined)?.spillFileCapped;
      bytes = result.details?.truncation?.totalBytes;
      const path = result.details?.fullOutputPath;
      if (path) {
        unlinkSync(path);
        if (existsSync(path + ".sp-owned")) unlinkSync(path + ".sp-owned");
      }
    }
    samples.sort(compareNumbers);
    process.stdout.write(JSON.stringify({ name, runs, medianMs: Number(samples[Math.floor(samples.length / 2)]!.toFixed(2)), p95Ms: Number(samples[Math.ceil(samples.length * .95) - 1]!.toFixed(2)), bytes, capped }) + "\n");
  }
} finally {
  rmSync(cwd, { recursive: true });
}
