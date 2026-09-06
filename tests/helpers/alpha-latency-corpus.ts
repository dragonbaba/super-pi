export const ALPHA_LATENCY_BODIES: Record<string, string> = {
  plain: 'stream text', cjk: '中文日志', emoji: '👩‍💻e\u0301', ansi: '\x1b[31mred\x1b[0m',
  // A marker immediately after the last pipe becomes an extra table cell and
  // is legitimately omitted by Markdown. Keep it in its own visible paragraph.
  word: 'x'.repeat(128), markdown: '\n\n## heading\n- item **bold**\n|a|b|\n|-|-|\n|1|2|\n\n',
  fence: '```ts\nconst x = 1;\n```', link: '[link](https://fixture.invalid)', latex: '$x^2$',
};
