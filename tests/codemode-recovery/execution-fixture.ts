import type { TestContext } from "node:test";
import { Type } from "typebox";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { sessionFixture } from "./fixture.ts";

const diagnostic = "ffmpeg version fixture\n" + "configuration: offline diagnostic fixture\n".repeat(48)
  + "[Parsed_volumedetect_0 @ 0] No such filter: 'volumedetect'\nError opening output files: Filter not found\nCommand exited with code 1";

export async function executionFixture(t: TestContext, approvalDelay = 0) {
  const calls: string[] = [], aborted: string[] = [];
  let announceStarted!: () => void;
  const started = new Promise<void>(resolve => { announceStarted = resolve; });
  const extension: ExtensionFactory = pi => {
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName === "probe" && (event.input as { kind?: string }).kind === "approval") {
        const choice = await ctx.ui.select("Synthetic approval", ["allow"], { signal: ctx.signal });
        if (choice !== "allow") return { block: true, reason: "fixture cancelled" };
      }
    });
  };
  const f = await sessionFixture(t, { g2: false, extensions: approvalDelay ? [extension] : [], customTools: [{
    name: "probe", label: "probe", description: "offline result fixture", parameters: Type.Object({
      kind: Type.String(), blob: Type.Optional(Type.String()), id: Type.Optional(Type.String()), delay: Type.Optional(Type.Number()),
    }),
    execute: async (_id: string, args: { kind: string; id?: string; delay?: number }, signal?: AbortSignal) => {
      calls.push(args.kind);
      announceStarted();
      if (args.delay) await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); aborted.push(args.kind); reject(new Error("fixture cancelled")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, args.delay);
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
      return { content: args.kind === "blocks" ? Array.from({ length: 100 }, (_, i) => ({ type: "text" as const, text: `block-${i}` }))
        : [{ type: "text" as const, text: args.kind === "diagnostic" ? diagnostic : args.kind === "failure" ? "expected fixture failure" : `ok ${args.id ?? ""}` }],
        details: {}, isError: args.kind === "failure" || args.kind === "diagnostic" };
    },
  }] });
  let dialogs = 0;
  if (approvalDelay) {
    // Use the real extension wait scope; this selector never displays a real dialog.
    const runner = f.session.extensionRunner;
    await f.session.bindExtensions({ mode: "tui", uiContext: { ...runner.getUIContext(), select: async (_title, _choices, options) => {
      dialogs++;
      return new Promise<string | undefined>(resolve => {
        const signal = options?.signal;
        const finish = (value: string | undefined) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(value); };
        const abort = () => finish(undefined);
        const timer = setTimeout(() => finish("allow"), approvalDelay);
        if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      });
    } } });
  }
  return { ...f, calls, aborted, started, dialogs: () => dialogs };
}
