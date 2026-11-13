/**
 * Pi Hermes Memory Extension
 *
 * Brings Hermes-style persistent memory and a learning loop to any Pi user.
 * After `pi install`, users get:
 *
 * 1. Persistent Memory — MEMORY.md + USER.md that survive across sessions
 * 2. Explicit Memory Review — current model extracts/merges only after /memory > 整理记忆
 * 3. Explicit Artifact Cleanup — /memory > 清理恢复产物 runs bounded recovery governance
 * 4. Fast Lifecycle — no startup sweep/backfill or shutdown model/index work
 * 5. Procedural Skills — SKILL.md files for reusable procedures
 * 6. /memory > 管理技能 — manages procedural skills
 * 7. Context Fencing — <memory-context> tags prevent injection through stored memory
 * 8. Memory Aging — entry timestamps guide reviewed consolidation
 *
 * See docs/ROADMAP.md for full roadmap and Hermes competitive analysis.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@super-pi/coding-agent";
import { MemoryStore } from "./store/memory-store.js";
import { SkillStore } from "./store/skill-store.js";
import { DatabaseManager } from "./store/db.js";
import { AtomicLockCoordinator } from "./store/atomic-lock-coordinator.js";
import { registerMemoryTool } from "./tools/memory-tool.js";
import { registerSkillTool } from "./tools/skill-tool.js";
import { registerSessionSearchTool } from "./tools/session-search-tool.js";
import { registerMemorySearchTool } from "./tools/memory-search-tool.js";
import { createMemoryReviewHandler } from "./handlers/memory-review.js";
import { createMemoryCleanupHandler } from "./handlers/memory-cleanup.js";
import { registerMemoryCommand } from "./handlers/memory-command.js";
import { createLazySkillsHandler } from "./handlers/skills-command-registration.js";
import { createLazyBulkMemoryHandler } from "./handlers/memory-bulk-command-registration.js";
import { createSyncMarkdownMemoriesHandler } from "./handlers/sync-markdown-memories.js";
import { loadConfig } from "./config.js";
import { detectProject, detectProjectSkills } from "./project.js";
import { buildPromptContext, buildSessionMemoryDigest, StablePromptAppender } from "./prompt-context.js";
import { contextHasMemoryDigest, MEMORY_DIGEST_CUSTOM_TYPE } from "./memory-digest.js";
import { AGENT_ROOT, resolveProjectsRoot } from "./paths.js";

export function resolveProjectSkillDiscovery(
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
  cwd?: string,
): { skillPaths: string[] } {
  const detected = detectProjectSkills(projectsMemoryDir, cwd);
  skillStore.setProjectContext(detected.name, detected.skillsDir);

  // Pi auto-discovers its own `~/.sp/agent/skills/`, but this extension keeps
  // its generated skills in a directory of its own so users can audit, wipe, or
  // ignore them without touching skills they installed themselves (#126). Both
  // of ours must therefore be contributed here.
  const skillPaths = [skillStore.getGlobalSkillsDir()];
  if (detected.skillsDir) skillPaths.push(detected.skillsDir);
  return { skillPaths };
}

export function registerProjectSkillDiscoveryHandler(
  pi: Pick<ExtensionAPI, "on">,
  skillStore: SkillStore,
  projectsMemoryDir: string | undefined,
): void {
  pi.on("resources_discover", (event, _ctx) =>
    resolveProjectSkillDiscovery(skillStore, projectsMemoryDir, (event as { cwd?: string }).cwd));
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();

  const agentRoot = AGENT_ROOT;
  const legacyGlobalDir = path.join(agentRoot, "memory");
  const defaultGlobalDir = path.join(agentRoot, "@super-pi/memory");

  const configuredMemoryDir = config.memoryDir?.trim();
  const pointsToLegacyMemoryDir = configuredMemoryDir
    ? path.resolve(configuredMemoryDir) === path.resolve(legacyGlobalDir)
    : false;

  const globalDir = !configuredMemoryDir || pointsToLegacyMemoryDir
    ? defaultGlobalDir
    : configuredMemoryDir;

  const store = new MemoryStore({ ...config, memoryDir: globalDir });
  const project = detectProject(config.projectsMemoryDir);
  const projectName = project.name ?? "";
  const skillStore = new SkillStore({
    globalSkillsDir: path.join(globalDir, "skills"),
    piGlobalSkillsDir: path.join(agentRoot, "skills"),
    projectSkillsDir: project.memoryDir ? path.join(project.memoryDir, "skills") : null,
    projectName: project.name,
  });
  const dbManager = new DatabaseManager(globalDir);
  const projectsRoot = resolveProjectsRoot(config.projectsMemoryDir);
  const promptAppender = new StablePromptAppender();
  // Digest mode: one hidden message per session context. The text is frozen at
  // session start. Whether the current context holds it is rechecked on session
  // start, compaction and tree navigation, and once on the prompt after a send
  // (a failed prompt admission never persists the message) — never per turn.
  let sessionDigest = "";
  let sessionDigestInContext = false;
  let sessionDigestUnconfirmed = false;
  const refreshDigestPresence = (ctx: { sessionManager?: { buildContextEntries?: () => readonly unknown[] } }) => {
    let entries: readonly unknown[] | undefined;
    try { entries = ctx.sessionManager?.buildContextEntries?.(); } catch { entries = undefined; }
    sessionDigestInContext = contextHasMemoryDigest(entries as Parameters<typeof contextHasMemoryDigest>[0]);
    sessionDigestUnconfirmed = false;
  };

  const refreshSkillProjectContext = (cwd?: string) => {
    const resource = resolveProjectSkillDiscovery(skillStore, config.projectsMemoryDir, cwd);
    return {
      name: skillStore.getProjectName(),
      skillsDir: skillStore.getProjectSkillsDir(),
      resource,
    };
  };

  // Extension load performs no legacy migration or agent-root directory scan.
  // Detect project from cwd using shared helper
  // Project-scoped store: ~/.sp/agent/<projectsMemoryDir>/<project_name>/
  const projectConfig = project.memoryDir
    ? { ...config, memoryCharLimit: config.projectCharLimit, memoryDir: project.memoryDir }
    : { ...config, memoryDir: undefined };
  const projectStore = project.memoryDir ? new MemoryStore(projectConfig) : null;

  // ── 1. Load only the active canonical memory files on session start. ──
  // Full Markdown reconciliation, session indexing, recovery cleanup, and model
  // review are explicit menu actions. Startup never runs legacy migrations.
  pi.on("session_start", async (_event, ctx) => {
    refreshSkillProjectContext(ctx.cwd);
    await skillStore.ensureDiscoveredRoots();
    await store.loadFromDisk();
    if (projectStore) await projectStore.loadFromDisk();
    promptAppender.setContext(buildPromptContext(config, store, projectStore, projectName));
    sessionDigest = buildSessionMemoryDigest(config, store, projectStore, projectName);
    refreshDigestPresence(ctx);
  });

  // Compaction or tree navigation can drop the digest from the live context.
  pi.on("session_compact", (_event, ctx) => { refreshDigestPresence(ctx); });
  pi.on("session_tree", (_event, ctx) => { refreshDigestPresence(ctx); });

  registerProjectSkillDiscoveryHandler(pi, skillStore, config.projectsMemoryDir);

  // ── 2. Inject one session-frozen memory policy/snapshot. The combined string
  // is reused on ordinary turns and rebuilt only if Pi changes its base prompt.
  pi.on("before_agent_start", (event, ctx) => {
    const systemPrompt = promptAppender.append(event.systemPrompt);
    if (sessionDigestUnconfirmed) refreshDigestPresence(ctx);
    if (sessionDigest && !sessionDigestInContext) {
      sessionDigestInContext = true;
      sessionDigestUnconfirmed = true;
      return {
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        message: { customType: MEMORY_DIGEST_CUSTOM_TYPE, content: sessionDigest, display: false },
      };
    }
    return systemPrompt === undefined ? undefined : { systemPrompt };
  });

  // ── 3. Register the memory tool (with project store + SQLite sync) ──
  registerMemoryTool(pi, store, projectStore, dbManager, projectName);

  // ── 4. Register the skill tool ──
  registerSkillTool(pi, skillStore);

  // ── 5. Register explicit memory maintenance commands. ──
  // No background model call, session flush, live/backfill index scan, recovery
  // sweep, correction extraction, or capacity consolidation is registered.
  const review = createMemoryReviewHandler(store, config, config.consolidationTimeoutMs, {
    projectStore,
    projectName: projectName || null,
  });
  const cleanup = createMemoryCleanupHandler({ store, globalDir, projectsRoot });
  const skills = createLazySkillsHandler(pi, skillStore);
  const sync = createSyncMarkdownMemoriesHandler(dbManager, globalDir, config.projectsMemoryDir, agentRoot);
  const bulk = createLazyBulkMemoryHandler({ store, projectStore, project, globalDir, projectsRoot, config, dbManager });
  registerMemoryCommand(pi, { store, projectStore, project, globalDir, review, cleanup, sync, skills, bulk });
  // ── 6. Explicit search: JSONL history and the derived memory index. ──
  registerSessionSearchTool(pi);
  registerMemorySearchTool(pi, dbManager, project.name);

  // ── 7. Constant-time owner shutdown. ──
  // There are no background review/index/sweep tasks to abort or join and no
  // session file to parse. Close only resources this extension may have opened.
  pi.on("session_shutdown", () => {
    try { dbManager.close(); } catch { /* best effort — never block shutdown */ }
    store.close();
    projectStore?.close();
    AtomicLockCoordinator.closeSharedUnder(globalDir);
    if (project.memoryDir) AtomicLockCoordinator.closeSharedUnder(project.memoryDir);
  });
}
