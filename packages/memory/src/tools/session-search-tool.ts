import * as path from 'node:path';
import type { ExtensionAPI } from "@super-pi/coding-agent";
import { Type } from "../schema.js";
import { searchSessionAnchors } from '../store/session-anchor-search.js';
import type { SessionAnchorRange, SessionAnchorSearchResult } from '../store/session-anchor-search.js';
import { AGENT_ROOT } from '../paths.js';

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
  ranges?: SessionAnchorRange[];
}

const DEFAULT_SESSIONS_DIR = path.join(AGENT_ROOT, 'sessions');

export function registerSessionSearchTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'session_search',
    label: 'Session Search',
    description: `Search past Pi conversations directly in session JSONL files using a Markdown request. No session index is required.

Supported scalar fields are from, to, cwd, and limit. Supported list sections are all, any, and exclude: all terms must match, any requires at least one listed term, and exclude removes matching ranges. Returns compact source line ranges; use read with the returned path, offset=startLine and limit=endLine-startLine+1 to retrieve the conversation text. Output is plain text: count, optional message, then anchors as path:startLine-endLine with a short reason.

Example:
from: 2026-05-14
to: 2026-05-15
cwd: /path/to/project
limit: 20

all:
- alpha

any:
- beta
- gamma

exclude:
- delta`,
    parameters: Type.Object({
      markdown: Type.String({ description: 'Markdown request with optional from/to/cwd/limit fields and all/any/exclude lists.' }),
    }),
    execute: async (_id: string, args: { markdown: string }) => {
      const markdown = args.markdown;

      if (!markdown || markdown.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'markdown is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const searchResult = await searchSessionAnchors(markdown, { sessionsDir: DEFAULT_SESSIONS_DIR });
      if (!searchResult.success) {
        const result: SearchResult = { success: false, message: searchResult.message ?? 'Anchor session search failed.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const output = formatAnchorSearchOutput(searchResult);
      const result: SearchResult = {
        success: true,
        count: searchResult.ranges.length,
        message: searchResult.message,
        output,
        ranges: searchResult.ranges,
      };
      return { content: [{ type: 'text' as const, text: output }], details: result };
    },
  });
}

function formatAnchorSearchOutput(searchResult: SessionAnchorSearchResult): string {
  const lines = [`count: ${searchResult.ranges.length}`];
  if (searchResult.message) lines.push(`message: ${searchResult.message}`);
  if (searchResult.ranges.length > 0) {
    lines.push("anchors:");
    for (const range of searchResult.ranges) {
      const anchor = `${range.path}:${range.startLine}-${range.endLine}`;
      const reason = compactReason(range.reason);
      lines.push(reason ? `- ${anchor} — ${reason}` : `- ${anchor}`);
    }
  }
  return lines.join("\n");
}

function compactReason(reason: string | undefined): string {
  if (!reason) return "";
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length <= 180 ? oneLine : `${oneLine.slice(0, 177)}...`;
}
