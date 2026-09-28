import { getEncoding } from "js-tiktoken";
import { Session } from "node:inspector/promises";
import { estimateToolOutputTokens } from "../../packages/coding-agent/src/core/tool-output-budget.ts";

const encoding = getEncoding("o200k_base");
const text = "long-single-line=" + "x".repeat(8192);
const content = [{ type: "text" as const, text }];
const profiler = new Session(); profiler.connect();
await profiler.post("Profiler.enable"); await profiler.post("Profiler.start");
const samples = [];
try {
  for (let round = 0; round < 5; round++) for (const exact of [true, false]) {
    const start = performance.now(), cpu = process.cpuUsage();
    const tokens = exact ? encoding.encode(text).length : estimateToolOutputTokens(content).estimatedTokens;
    const used = process.cpuUsage(cpu);
    samples.push({ round, estimator: exact ? "o200k_base" : "super-pi.conservative-v1", codeUnits: text.length, tokens,
      elapsedMs: performance.now() - start, cpuUs: used.user + used.system });
  }
  const { profile } = await profiler.post("Profiler.stop");
  let totalHits = 0, tokenizerHits = 0;
  for (const node of profile.nodes) {
    totalHits += node.hitCount ?? 0;
    if (node.callFrame.url.includes("js-tiktoken")) tokenizerHits += node.hitCount ?? 0;
  }
  console.log(JSON.stringify({ benchmark: "measurement-estimator-overhead", node: process.version, samples, totalHits, tokenizerHits,
    note: "Measurement overhead only. Estimators intentionally have different semantics; these are not provider usage or product speedup figures." }));
} finally { profiler.disconnect(); }
