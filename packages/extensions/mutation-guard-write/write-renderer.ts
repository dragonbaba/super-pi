import type { ToolDefinition } from "@super-pi/coding-agent";
import { RELEASE_COMPONENT_RENDER_CACHE, Text } from "@super-pi/tui";

/** Presentation only: never infer a successful mutation from human-readable output. */
function writeStatus(receipt: any, isError: boolean): string {
  if (receipt?.operation === "write" && receipt.mutationReceiptVersion) {
    if (receipt.status === "partial") return "Partial write — verify current state";
    if (receipt.status === "cancelled" || receipt.status === "failed_no_change") {
      const status = receipt.status === "cancelled" ? "Write cancelled" : "Write failed — no change";
      return receipt.requiresVerification ? `${status} — verify ${receipt.commit?.retainedTemporary ? "retained temporary" : "current state"}` : status;
    }
    if (receipt.status === "state_unknown" || receipt.requiresVerification) return "Write state unknown — verify current state";
    if (!isError && receipt.ok === true && receipt.stateChanged === true && receipt.category === "success") {
      if (receipt.created === true) return "Added";
      if (typeof receipt.previousSha256 === "string" && receipt.commit?.outcome === "committed") return "Modified";
    }
  }
  return isError ? "Write failed — inspect result" : "Write status unverified";
}

class WriteResultText extends Text {
  receipt: unknown;
  source: unknown;
  path: unknown;
  error = false;
  summary = "";
  override [RELEASE_COMPONENT_RENDER_CACHE](): void {
    this.receipt = this.source = this.path = undefined;
    this.summary = "";
    this.setText("");
    super[RELEASE_COMPONENT_RENDER_CACHE]();
  }
}

export const renderWriteResult: NonNullable<ToolDefinition<any, any>["renderResult"]> = function renderWriteResult(result, options, _theme, context) {
  const component = context.lastComponent instanceof WriteResultText ? context.lastComponent : new WriteResultText("", 0, 0);
  const path = (context.args as { path?: unknown } | undefined)?.path;
  if (!component.summary || component.receipt !== result.details || component.source !== result.content || component.path !== path || component.error !== context.isError) {
    component.receipt = result.details;
    component.source = result.content;
    component.path = path;
    component.error = context.isError;
    component.summary = `${writeStatus(result.details, context.isError)} ${typeof path === "string" ? path : "[unknown path]"}`;
  }
  const primary = result.content[0];
  component.setText(options.isPartial ? "Write running" : options.expanded && primary?.type === "text" ? `${component.summary}\n${primary.text}` : component.summary);
  return component;
};
