export const ALPHA_LATENCY_BODIES: Record<string, string> = {
  plain: 'stream text', cjk: '中文日志', emoji: '👩‍💻e\u0301', ansi: '\x1b[31mred\x1b[0m',
  word: 'x'.repeat(128), markdown: '## heading\n- item **bold**\n|a|b|\n|-|-|\n|1|2|',
  fence: '```ts\nconst x = 1;\n```', link: '[link](https://fixture.invalid)', latex: '$x^2$',
};
