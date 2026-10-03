import assert from "node:assert/strict";
import test from "node:test";
import { UserMessageComponent } from "../packages/coding-agent/src/modes/interactive/components/user-message.ts";
import { initTheme, getMarkdownTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { legacyUserMessage } from "./helpers/legacy-user-message.ts";

test("user message integrated padding preserves exact ANSI, wrapping, themes and OSC markers", () => {
  for (const theme of ["dark", "light"]) {
    initTheme(theme);
    for (const text of ["", " \n", "hello", "中文🙂 emoji", "**bold** *italic* [link](https://example.test)",
      "3. alpha\n4. beta", "```ts\nconst x = 1;\n```", "| a | b |\n|---|---|\n| A | B |", "a ".repeat(500), "\\*escaped\\*"]) {
      for (const pad of [0, 1, 3]) for (const width of [8, 40, 100]) {
        const previous = legacyUserMessage(text, pad), current = new UserMessageComponent(text, getMarkdownTheme(), pad);
        const expected = previous.render(width);
        if (expected.length) { expected[0] = "\x1b]133;A\x07" + expected[0]; expected[expected.length - 1] = "\x1b]133;B\x07\x1b]133;C\x07" + expected.at(-1); }
        assert.deepEqual(current.render(width), expected, `${theme}/${pad}/${width}/${text.slice(0, 20)}`);
        assert.deepEqual(current.render(width), expected, "cache must not accumulate zone markers");
        current.invalidate(); assert.deepEqual(current.render(width), expected);
      }
    }
  }
});
