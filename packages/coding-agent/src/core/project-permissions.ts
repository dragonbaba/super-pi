import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Project-shared permission rules (R4): `<agentDir>/projects/<hash>/permissions.json`.
 * Every session in the same project folder reads one file. It lives under the user's
 * directory, so a cloned repository cannot bring its own grants.
 */
export type ProjectRuleDecision = "allow" | "ask" | "deny";
export interface ProjectPermissionRule { readonly tool: string; readonly decision: ProjectRuleDecision; readonly command?: string; }

/** Strength order: deny > ask > allow > none, so a segment's verdict is the maximum. */
export const RULE_NONE = 0, RULE_ALLOW = 1, RULE_ASK = 2, RULE_DENY = 3;
export const MAX_PROJECT_RULES = 256;
/** Claude Code saves at most five prefix rules for one compound command. */
export const MAX_REMEMBERED_RULES = 5;
const MAX_FILE_BYTES = 256 * 1024;
/** The longest `command` the file accepts; generated prefix rules stay within it. */
export const MAX_RULE_COMMAND = 4096;
const MAX_COMMAND = MAX_RULE_COMMAND;
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 3000;
const LOCK_RETRY_MS = 50;
const MAX_SAVE_ATTEMPTS = 4;
const STAR = 42;
const DECISIONS: Readonly<Record<string, number>> = Object.freeze({ allow: RULE_ALLOW, ask: RULE_ASK, deny: RULE_DENY });

/** Pattern words; a lone `*` word matches any number of words, `*` inside a word any characters. */
interface CompiledShellRule { readonly decision: number; readonly words: readonly string[]; }

function compileWords(command: string | undefined, folded: boolean): readonly string[] {
  if (command === undefined) return ["*"];
  const words = command.trim().split(/\s+/);
  if (folded) for (let index = 0; index < words.length; index++) words[index] = foldWord(words[index]!);
  return words;
}

/**
 * PowerShell case folding, one UTF-16 unit at a time on both the pattern and the command, so
 * they always agree. ASCII takes the arithmetic path; other letters fold through the engine.
 */
function foldCode(code: number): number {
  if (code < 128) return code >= 65 && code <= 90 ? code + 32 : code;
  const lower = String.fromCharCode(code).toLowerCase();
  return lower.length === 1 ? lower.charCodeAt(0) : code;
}

/** The folded word; the original string when nothing folds. */
function foldWord(word: string): string {
  let index = 0;
  while (index < word.length && foldCode(word.charCodeAt(index)) === word.charCodeAt(index)) index++;
  if (index === word.length) return word;
  let text = word.slice(0, index);
  for (; index < word.length; index++) text += String.fromCharCode(foldCode(word.charCodeAt(index)));
  return text;
}

/** `*` inside one word; two-pointer matching with one backtrack point, no allocation. */
function wordMatches(pattern: string, text: string, folded: boolean): boolean {
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern.charCodeAt(p) === STAR) { star = p++; mark = t; continue; }
    const code = text.charCodeAt(t);
    if (p < pattern.length && pattern.charCodeAt(p) === (folded ? foldCode(code) : code)) { p++; t++; continue; }
    if (star < 0) return false;
    p = star + 1; t = ++mark;
  }
  while (p < pattern.length && pattern.charCodeAt(p) === STAR) p++;
  return p === pattern.length;
}

/** The same algorithm over words: a lone `*` word may absorb zero or more argv words. */
function wordsMatch(words: readonly string[], argv: readonly string[], count: number, folded: boolean): boolean {
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < count) {
    if (p < words.length && words[p] === "*") { star = p++; mark = t; continue; }
    if (p < words.length && wordMatches(words[p]!, argv[t]!, folded)) { p++; t++; continue; }
    if (star < 0) return false;
    p = star + 1; t = ++mark;
  }
  while (p < words.length && words[p] === "*") p++;
  return p === words.length;
}

/** One dialect's rules, indexed by a literal first word; rules starting with a glob are scanned always. */
class ShellRuleIndex {
  readonly byName = new Map<string, CompiledShellRule[]>();
  readonly globbed: CompiledShellRule[] = [];
  readonly folded: boolean;
  /** The strongest decision any rule in this index carries. */
  strongest = RULE_NONE;
  constructor(folded: boolean) { this.folded = folded; }
  add(rule: CompiledShellRule): void {
    if (rule.decision > this.strongest) this.strongest = rule.decision;
    const first = rule.words[0]!;
    if (first.indexOf("*") >= 0) { this.globbed.push(rule); return; }
    const list = this.byName.get(first);
    if (list) list.push(rule); else this.byName.set(first, [rule]);
  }
  get size(): number { return this.byName.size + this.globbed.length; }
  /** The strongest decision among rules matching the first `count` argv words. */
  match(argv: readonly string[], count: number): number {
    if (count === 0) return RULE_NONE;
    let verdict = RULE_NONE;
    const name = argv[0]!, list = this.byName.get(this.folded ? foldWord(name) : name);
    if (list) for (let index = 0; index < list.length; index++) {
      const rule = list[index]!;
      if (rule.decision > verdict && wordsMatch(rule.words, argv, count, this.folded)) verdict = rule.decision;
    }
    for (let index = 0; index < this.globbed.length; index++) {
      const rule = this.globbed[index]!;
      if (rule.decision > verdict && wordsMatch(rule.words, argv, count, this.folded)) verdict = rule.decision;
    }
    return verdict;
  }
}

/** A parsed, immutable rule file. Built once per file version; matching does not allocate. */
export class ProjectRuleSet {
  readonly rules: readonly ProjectPermissionRule[];
  private readonly bash = new ShellRuleIndex(false);
  private readonly powerShell = new ShellRuleIndex(true);
  private readonly tools = new Map<string, number>();
  constructor(rules: readonly ProjectPermissionRule[]) {
    this.rules = rules;
    for (const rule of rules) {
      const decision = DECISIONS[rule.decision]!;
      const shell = rule.tool === "bash" || rule.tool === "powershell";
      if (shell) {
        const powerShell = rule.tool === "powershell";
        (powerShell ? this.powerShell : this.bash).add(Object.freeze({ decision, words: Object.freeze(compileWords(rule.command, powerShell)) }));
      }
      // A rule without `command` covers the whole tool, whatever its input parses into.
      if ((!shell || rule.command === undefined) && decision > (this.tools.get(rule.tool) ?? RULE_NONE)) this.tools.set(rule.tool, decision);
    }
  }
  get empty(): boolean { return this.rules.length === 0; }
  hasShellRules(powerShell: boolean): boolean { return (powerShell ? this.powerShell : this.bash).size > 0; }
  /** Whether a command-pattern rule for this shell can deny or ask. */
  hasRestrictiveShellRules(powerShell: boolean): boolean { return (powerShell ? this.powerShell : this.bash).strongest >= RULE_ASK; }
  /** Rules for a whole tool by exact name: MCP and file tools, or a shell rule without `command`. */
  toolDecision(tool: string): number { return this.tools.get(tool) ?? RULE_NONE; }
  /** Strongest decision for one simple command's words (PowerShell compares without case). */
  matchShellWords(powerShell: boolean, argv: readonly string[], count = argv.length): number {
    return (powerShell ? this.powerShell : this.bash).match(argv, count);
  }
}

export const EMPTY_PROJECT_RULES = new ProjectRuleSet(Object.freeze([]));

export function projectPermissionsFile(agentDir: string, canonicalProject: string): string {
  const key = process.platform === "win32" ? canonicalProject.toLowerCase() : canonicalProject;
  return join(agentDir, "projects", createHash("sha256").update(key).digest("hex").slice(0, 32), "permissions.json");
}

function parseRules(text: string): ProjectPermissionRule[] {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || value.version !== 1 || !Array.isArray(value.rules)) throw new Error("需要 {\"version\": 1, \"rules\": [...]}");
  if (value.rules.length > MAX_PROJECT_RULES) throw new Error(`规则最多 ${MAX_PROJECT_RULES} 条`);
  const rules: ProjectPermissionRule[] = [];
  for (let index = 0; index < value.rules.length; index++) {
    const rule = value.rules[index];
    const where = `第 ${index + 1} 条规则`;
    if (!rule || typeof rule !== "object" || typeof rule.tool !== "string" || !rule.tool.length || rule.tool.length > 128) throw new Error(where + "：tool 无效");
    if (typeof rule.decision !== "string" || !Object.hasOwn(DECISIONS, rule.decision)) throw new Error(where + "：decision 只能是 allow、ask 或 deny");
    if (rule.command !== undefined) {
      if (rule.tool !== "bash" && rule.tool !== "powershell") throw new Error(where + "：只有 bash 和 powershell 规则可以写 command");
      if (typeof rule.command !== "string" || !rule.command.trim() || rule.command.length > MAX_COMMAND) throw new Error(where + "：command 无效");
    }
    rules.push(Object.freeze(rule.command === undefined ? { tool: rule.tool, decision: rule.decision } : { tool: rule.tool, decision: rule.decision, command: rule.command.trim() }));
  }
  return rules;
}

/**
 * Loads and saves one project's rule file. Each authorization calls `refresh`, which only
 * re-reads when the file's mtime or size changed. A file that fails to parse keeps the
 * previous version in force (never wider) and reports the error once per file version.
 */
export class ProjectPermissionStore {
  private file?: string;
  private project?: string;
  private mtime = -1;
  private size = -1;
  private current: ProjectRuleSet = EMPTY_PROJECT_RULES;
  private failure?: string;
  private reported = true;
  /** The reload in progress; overlapping authorizations wait for it instead of reading stale rules. */
  private loading?: Promise<ProjectRuleSet>;
  private readonly agentDir: string;
  private readonly cwd: string;
  constructor(agentDir: string, cwd: string) { this.agentDir = agentDir; this.cwd = cwd; }

  private async location(): Promise<string> {
    if (this.file) return this.file;
    this.project = await realpath(this.cwd);
    return this.file = projectPermissionsFile(resolve(this.agentDir), this.project);
  }

  async refresh(): Promise<ProjectRuleSet> {
    if (this.loading) return this.loading;
    const loading = this.load();
    this.loading = loading;
    try { return await loading; } finally { if (this.loading === loading) this.loading = undefined; }
  }

  private async load(): Promise<ProjectRuleSet> {
    const file = await this.location();
    let stat;
    try { stat = await lstat(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Deleting the file is the user's way to clear every rule.
      this.mtime = this.size = -1; this.current = EMPTY_PROJECT_RULES; this.failure = undefined;
      return this.current;
    }
    if (stat.mtimeMs === this.mtime && stat.size === this.size) return this.current;
    // The version is published together with its parsed rules, after loading finishes.
    try {
      if (!stat.isFile()) throw new Error("不是普通文件");
      if (stat.size > MAX_FILE_BYTES) throw new Error("文件超过 256 KB");
      this.current = new ProjectRuleSet(Object.freeze(parseRules(await readFile(file, "utf8"))));
      this.failure = undefined;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error);
      this.reported = false;
    }
    this.mtime = stat.mtimeMs; this.size = stat.size;
    return this.current;
  }

  /** The parse error of the current file version, returned once so it is shown once. */
  takeWarning(): string | undefined {
    if (this.reported || this.failure === undefined) return undefined;
    this.reported = true;
    return `项目权限规则无法解析，继续使用上一版：${this.file}\n${this.failure}`;
  }

  async describe(): Promise<{ file: string; project: string; rules: readonly ProjectPermissionRule[]; error?: string }> {
    const rules = await this.refresh();
    return { file: this.file!, project: this.project!, rules: rules.rules, error: this.failure };
  }

  /**
   * Appends rules not already present; refuses while the file on disk does not parse.
   * Sessions of one project serialize saves with a lock file. A manual edit that lands
   * between reading and replacing the file is detected by its mtime/size and merged again.
   */
  async remember(additions: readonly ProjectPermissionRule[]): Promise<void> {
    const file = await this.location(), parent = dirname(file);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const lock = await acquireLock(join(parent, "permissions.lock"));
    try {
      for (let attempt = 1; ; attempt++) {
        this.mtime = -1;
        const current = await this.refresh();
        if (this.failure !== undefined) throw new Error(`项目权限规则无法解析，未保存：${file}\n${this.failure}`);
        const readMtime = this.mtime, readSize = this.size, rules = [...current.rules];
        for (const rule of additions) {
          let present = false;
          for (const existing of rules) if (existing.tool === rule.tool && existing.decision === rule.decision && existing.command === rule.command) { present = true; break; }
          if (!present) rules.push(Object.freeze({ ...rule }));
        }
        const text = JSON.stringify({ version: 1, project: this.project, rules }, null, 2) + "\n";
        // The reader's limits apply to what is written, so a save never leaves a file that will not load.
        if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error(`规则文件将超过 256 KB，未保存：${file}`);
        try { parseRules(text); } catch (error) { throw new Error(`规则无效，未保存：${error instanceof Error ? error.message : String(error)}`); }
        const temporary = join(parent, randomBytes(16).toString("hex") + ".tmp");
        await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
        let changed: boolean;
        try { const stat = await lstat(file); changed = stat.mtimeMs !== readMtime || stat.size !== readSize; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { await unlink(temporary); throw error; } changed = readMtime !== -1; }
        if (changed) {
          await unlink(temporary);
          if (attempt === MAX_SAVE_ATTEMPTS) throw new Error(`规则文件正在被修改，未保存：${file}`);
          continue;
        }
        try { await rename(temporary, file); }
        catch (error) { await unlink(temporary).catch(ignoreError); throw error; }
        break;
      }
    } finally { await unlink(lock).catch(ignoreError); }
    this.mtime = -1;
    await this.refresh();
    if (this.failure !== undefined) throw new Error(`保存后的规则文件无法解析：${file}\n${this.failure}`);
  }
}

function ignoreError(): void {}

/** An exclusive lock file; one left by a crashed session expires after ten seconds. */
async function acquireLock(lock: string): Promise<string> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 }); return lock; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    try {
      if (Date.now() - (await lstat(lock)).mtimeMs > LOCK_STALE_MS) { await unlink(lock).catch(ignoreError); continue; }
    } catch { continue; }
    if (Date.now() > deadline) throw new Error("另一个会话正在保存本项目的权限规则，未保存");
    await delay(LOCK_RETRY_MS);
  }
}
