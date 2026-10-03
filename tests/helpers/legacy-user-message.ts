import { Box, Container, Markdown } from "../../packages/tui/src/index.ts";
import { getMarkdownTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
/** Previous production renderer, retained only for exact output/allocation comparisons. */
export function legacyUserMessage(text: string, pad = 1): Container {
  const container = new Container(), box = new Box(pad, 1, value => theme.bg("userMessageBg", value));
  box.addChild(new Markdown(text, 0, 0, getMarkdownTheme(), { color: value => theme.fg("userMessageText", value) },
    { preserveOrderedListMarkers: true, preserveBackslashEscapes: true }));
  container.addChild(box);
  return container;
}
