import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const samples = [];
for (let index = 0; index < 5; index++) {
  const child = spawnSync(process.execPath, ["--expose-gc", "--experimental-strip-types", fileURLToPath(new URL("./native-file-commit.ts", import.meta.url))], { encoding: "utf8", windowsHide: true });
  if (child.status !== 0) throw new Error(`Native cost process ${index} failed: ${child.error ?? child.stderr}\n${child.stdout}`);
  samples.push(JSON.parse(child.stdout));
}
console.log(JSON.stringify({ processes: samples.length, samples, claim: "Observed costs only; main-thread sampling excludes worker/native allocations. No speedup claim." }, null, 2));
