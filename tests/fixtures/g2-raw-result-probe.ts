import { createHash } from 'node:crypto';
import type { AgentToolResult } from '../../packages/agent/src/types.ts';

export const RAW_PROBE_SEED = 0x473253;
export const RAW_MODES = ['small', 'medium', 'large', 'huge', 'single-line', 'errors', 'json', 'cjk', 'ansi', 'image'] as const;
export type RawMode = typeof RAW_MODES[number];
const SIZES: Partial<Record<RawMode, number>> = { small: 1024, medium: 65536, large: 262144, huge: 1048576, 'single-line': 10485760 };

/** Test-only direct AgentToolResult producer. No tool registry, process or file adapter. */
export function g2_raw_result_probe(mode: RawMode, index = 0): AgentToolResult<{
  seed: number; toolCallId: string; sha256: string; bytes: number; codeUnits: number;
  markers: string[]; upstreamTruncated: false;
}> {
  const toolCallId = `g2s-${RAW_PROBE_SEED}-${mode}-${index}`;
  const markers = ['BEGIN', 'MIDDLE', 'END'].map(position => `[${toolCallId}:${position}]`);
  let text: string;
  const size = SIZES[mode];
  if (size) {
    const available = size - markers.join('').length;
    const half = Math.floor(available / 2);
    text = markers[0] + 'x'.repeat(half) + markers[1] + 'y'.repeat(available - half) + markers[2];
  } else if (mode === 'json') {
    text = JSON.stringify({ begin: markers[0], records: Array.from({ length: 10000 }, (_, id) => ({ id, value: 'fixture' })), middle: markers[1], end: markers[2] });
  } else {
    const line = mode === 'errors' ? 'ERROR fixed failure\n' : mode === 'cjk' ? '中文日志：固定种子运行成功。\n' : mode === 'ansi' ? '\x1b[31mfixture error\x1b[0m\n' : 'image companion\n';
    const count = mode === 'image' ? 1 : 5000;
    text = markers[0] + '\n' + line.repeat(count) + markers[1] + '\n' + line.repeat(count) + markers[2];
  }
  const content: AgentToolResult<unknown>['content'] = [{ type: 'text', text }];
  if (mode === 'image') content.push({ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1cAAAAASUVORK5CYII=' });
  return { content, details: { seed: RAW_PROBE_SEED, toolCallId, sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text), codeUnits: text.length, markers, upstreamTruncated: false } };
}

export function parallelRawResults(count: 1 | 4 | 8 | 129) {
  return Array.from({ length: count }, (_, index) => g2_raw_result_probe('medium', index));
}
