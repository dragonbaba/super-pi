import type { ExtensionAPI } from "@super-pi/coding-agent";
import { Type } from "../schema.js";
import { StringEnum } from "../typebox-compat.js";
import { DatabaseManager } from '../store/db.js';
import { searchMemories, getMemoryStats } from '../store/sqlite-memory-store.js';
import type { MemoryCategory } from '../types.js';

const MAX_MEMORY_SEARCH_OUTPUT_BYTES = 50 * 1024;

interface SearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
}

export function registerMemorySearchTool(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: 'Search durable user, project, global, or failure memories by query and optional scope filters. Returns matching entries with project context and dates.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 1000, description: 'Search query. Use natural language or specific terms.' }),
      project: Type.Optional(Type.String({ maxLength: 500, description: 'Filter by project name. Pass null for global memories only.' })),
      target: Type.Optional(StringEnum(['memory', 'user', 'failure'] as const, { description: 'Filter by target type (memory, user, or failure).' })),
      category: Type.Optional(StringEnum(['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'] as const, { description: 'Filter by memory category.' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Maximum results to return (default: 10, max: 20).' })),
    }),
    execute: async (_id: string, args: { query: string; project?: string; target?: string; category?: string; limit?: number }) => {
      const query = args.query;
      const project = args.project;
      const target = args.target;
      const category = args.category as MemoryCategory | undefined;
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(Math.floor(args.limit!), 20)) : 10;

      if (!query || query.trim().length === 0) {
        const result: SearchResult = { success: false, message: 'query is required' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const stats = getMemoryStats(dbManager);
      if (stats.total === 0) {
        const result: SearchResult = { success: false, message: 'No memories in extended store yet. Use the memory tool with add action to store memories.' };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      const results = searchMemories(dbManager, query, { project, target, category, limit });

      if (results.length === 0) {
        const result: SearchResult = { success: true, count: 0, message: `No memories found matching "${query}". Try a different search term or broader query.` };
        return { content: [{ type: 'text' as const, text: result.message! }], details: result };
      }

      let output = `Found ${results.length} memories matching "${query}":\n\n`;

      for (const entry of results) {
        const projectLabel = entry.project ? `[${entry.project}]` : '[global]';
        const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠';
        const categoryLabel = entry.category ? ` [${entry.category}]` : '';
        output += `${targetLabel} ${projectLabel}${categoryLabel} ${entry.content}\n`;
        output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`;
      }

      const encoded = Buffer.from(output.trim(), 'utf8');
      let visible = output.trim();
      if (encoded.length > MAX_MEMORY_SEARCH_OUTPUT_BYTES) {
        visible = encoded.subarray(0, MAX_MEMORY_SEARCH_OUTPUT_BYTES - 96).toString('utf8').replace(/�$/u, '')
          + `\n\n[Memory search output truncated: ${encoded.length} bytes total]`;
      }
      const finalResult: SearchResult = { success: true, count: results.length };
      return { content: [{ type: 'text' as const, text: visible }], details: finalResult };
    },
  });
}
