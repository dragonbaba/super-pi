import { writeFileSync, watch, existsSync } from "node:fs";
const mode = process.argv[2];
if (mode !== "handoff") writeFileSync(`${mode}.ready.json`, JSON.stringify({ pid: process.pid }));
if (mode === "handoff") {
  process.stdout.write("before handoff\n");
  const watcher = watch(".", () => {
    if (!existsSync("handoff.release")) return;
    watcher.close();
    process.stdout.write("x".repeat(process.argv[3] === "small" ? 16 : 256 * 1024) + "\nHANDOFF-PID:" + process.pid + "\n");
  });
  writeFileSync(`${mode}.ready.json`, JSON.stringify({ pid: process.pid }));
}
else if (mode === "hold") setTimeout(() => process.stdout.write("unexpected deadline\n"), 30_000);
else if (mode === "burst") process.stdout.write("x".repeat(6 * 1024 * 1024), () => process.stdout.write("\nFINAL-SHELL-SENTINEL\n"));
else {
  process.stdout.write(`result:${mode}\n`);
  process.exitCode = mode === "fail" ? 7 : 0;
}
