import { writeFileSync } from "node:fs";
const mode = process.argv[2];
writeFileSync(`${mode}.ready.json`, JSON.stringify({ pid: process.pid }));
if (mode === "hold") setTimeout(() => process.stdout.write("unexpected deadline\n"), 30_000);
else if (mode === "burst") process.stdout.write("x".repeat(6 * 1024 * 1024), () => process.stdout.write("\nFINAL-SHELL-SENTINEL\n"));
else {
  process.stdout.write(`result:${mode}\n`);
  process.exitCode = mode === "fail" ? 7 : 0;
}
