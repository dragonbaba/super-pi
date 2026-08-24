/**
 * Pi Hermes Memory Extension
 *
 * Brings Hermes-style persistent memory and a learning loop to any Pi user.
 * After `pi install`, users get:
 *
 * 1. Persistent Memory — MEMORY.md + USER.md that survive across sessions
 * 2. Explicit Memory Review — current model extracts/merges only after /memory-review
 * 3. Explicit Artifact Cleanup — /memory-cleanup runs bounded recovery governance
 * 4. Fast Lifecycle — no startup sweep/backfill or shutdown model/index work
 * 5. Procedural Skills — SKILL.md files for reusable procedures
 * 6. /memory-skills — manages procedural skills
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
import { registerMemoryReviewCommand } from "./handlers/memory-review.js";
import { registerMemoryCleanupCommand } from "./handlers/memory-cleanup.js";
import { registerLazySkillsCommand } from "./handlers/skills-command-registration.js";
import { migrateThenSyncMarkdownMemories, registerSyncMarkdownMemoriesCommand } from "./handlers/sync-markdown-memories.js";
import { loadConfig } from "./config.js";
import { detectProject, detectProjectSkills } from "./project.js";
import { buildPromptContext, StablePromptAppender } from "./prompt-context.js";
import { AGENT_ROOT, resolveProjectsRoot } from "./paths.js";
import { isDatabaseMigrationPending } from "./extension-root-migration.js";

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

  const shouldMigrateExtensionRoot = !configuredMemoryDir || pointsToLegacyMemoryDir;

  const store = new MemoryStore({ ...config, memoryDir: globalDir });
  const project = detectProject(config.projectsMemoryDir);
  const projectName = project.name ?? "";
  const skillStore = new SkillStore({
    globalSkillsDir: path.join(globalDir, "skills"),
    piGlobalSkillsDir: path.join(agentRoot, "skills"),
    projectSkillsDir: project.memoryDir ? path.join(project.memoryDir, "skills") : null,
    projectName: project.name,
    legacySkillsDir: path.join(legacyGlobalDir, "skills"),
    migrationSentinelPath: path.join(globalDir, ".skills-migrated-to-extension-storage"),
  });
  const dbManager = new DatabaseManager(globalDir);
  let databaseMigrationPending = shouldMigrateExtensionRoot
    && isDatabaseMigrationPending(legacyGlobalDir, globalDir);
  let requiredStartupMigrationComplete = !databaseMigrationPending;
  if (databaseMigrationPending) {
    dbManager.setOpenGuard(() => {
      if (databaseMigrationPending) {
        throw new Error("Legacy sessions.db migration is pending");
      }
    });
  }
  const projectsRoot = resolveProjectsRoot(config.projectsMemoryDir);
  const promptAppender = new StablePromptAppender();

  const refreshSkillProjectContext = (cwd?: string) => {
    const resource = resolveProjectSkillDiscovery(skillStore, config.projectsMemoryDir, cwd);
    return {
      name: skillStore.getProjectName(),
      skillsDir: skillStore.getProjectSkillsDir(),
      resource,
    };
  };

  // Legacy project-memory migration is explicit through /memory-sync-markdown;
  // extension load performs no agent-root directory scan.
  // Detect project from cwd using shared helper
  // Project-scoped store: ~/.sp/agent/<projectsMemoryDir>/<project_name>/
  const projectConfig = project.memoryDir
    ? { ...config, memoryCharLimit: config.projectCharLimit, memoryDir: project.memoryDir }
    : { ...config, memoryDir: undefined };
  const projectStore = project.memoryDir ? new MemoryStore(projectConfig) : null;

  // ── 1. Load only the active canonical memory files on session start. ──
  // Full Markdown reconciliation, session indexing, recovery cleanup, and model
  // review are explicit commands. The sole startup exception is a previously
  // detected legacy SQLite migration, which must complete before that DB opens.
  pi.on("session_start", async (_event, ctx) => {
    if (!requiredStartupMigrationComplete) {
      try {
        await migrateThenSyncMarkdownMemories(
          dbManager,
          legacyGlobalDir,
          globalDir,
          config.projectsMemoryDir,
          agentRoot,
          {
            onMigrationSucceeded: () => {
              databaseMigrationPending = false;
              dbManager.setOpenGuard(null);
            },
          },
        );
        requiredStartupMigrationComplete = true;
      } catch {
        // Keep the DB fail-closed and retry the required one-time migration on
        // the next startup; ordinary memory loading remains available.
      }
    }

    refreshSkillProjectContext(ctx.cwd);
    await skillStore.migrateLegacySkills();
    await skillStore.ensureDiscoveredRoots();
    await store.loadFromDisk();
    if (projectStore) await projectStore.loadFromDisk();
    promptAppender.setContext(buildPromptContext(config, store, projectStore, projectName));
  });

  registerProjectSkillDiscoveryHandler(pi, skillStore, config.projectsMemoryDir);

  // ── 2. Inject one session-frozen memory policy/snapshot. The combined string
  // is reused on ordinary turns and rebuilt only if Pi changes its base prompt.
  pi.on("before_agent_start", (event, _ctx) => {
    const systemPrompt = promptAppender.append(event.systemPrompt);
    return systemPrompt === undefined ? undefined : { systemPrompt };
  });

  // ── 3. Register the memory tool (with project store + SQLite sync) ──
  registerMemoryTool(pi, store, projectStore, dbManager, projectName);

  // ── 4. Register the skill tool ──
  registerSkillTool(pi, skillStore);

  // ── 5. Register explicit memory maintenance commands. ──
  // No background model call, session flush, live/backfill index scan, recovery
  // sweep, correction extraction, or capacity consolidation is registered.
  registerMemoryReviewCommand(pi, store, config, config.consolidationTimeoutMs, {
    projectStore,
    projectName: projectName || null,
  });
  registerMemoryCleanupCommand(pi, { store, globalDir, projectsRoot });
  registerLazySkillsCommand(pi, skillStore);
  registerSyncMarkdownMemoriesCommand(pi, dbManager, globalDir, config.projectsMemoryDir, agentRoot, {
    legacyGlobalDir: shouldMigrateExtensionRoot ? legacyGlobalDir : null,
    onMigrationSucceeded: () => {
      databaseMigrationPending = false;
      requiredStartupMigrationComplete = true;
      dbManager.setOpenGuard(null);
    },
  });
  // ── 6. SQLite search tools. Historical indexing is not exposed as a
  // standing slash command; search remains available only when explicitly requested.
  registerSessionSearchTool(pi, dbManager, config.sessionSearch ?? { variant: "legacy" });
  registerMemorySearchTool(pi, dbManager);

  // ── 7. Constant-time owner shutdown. ──
  // There are no background review/index/sweep tasks to abort or join and no
  // session file to parse. Close only resources this extension may have opened.
  pi.on("session_shutdown", () => {
    try { dbManager.close(); } catch { /* best effort — never block shutdown */ }
    AtomicLockCoordinator.closeSharedUnder(globalDir);
    if (project.memoryDir) AtomicLockCoordinator.closeSharedUnder(project.memoryDir);
    if (shouldMigrateExtensionRoot) AtomicLockCoordinator.closeSharedUnder(legacyGlobalDir);
  });
}
