import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionExecutionPolicy } from "../packages/coding-agent/src/core/execution-policy.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import type { SessionPermissionMode } from "../packages/coding-agent/src/core/permission-mode.ts";
import { ProjectPermissionStore, ProjectRuleSet, projectPermissionsFile, RULE_ALLOW, RULE_ASK, RULE_DENY, RULE_NONE }
    from "../packages/coding-agent/src/core/project-permissions.ts";
import { classifyHostShellCommand, HOST_SHELL_OTHER, HOST_SHELL_RULE_ALLOWED, shellRuleVerdict, suggestShellRules }
    from "../packages/coding-agent/src/core/shell-policy/readonly-command.ts";
import { ShellAnalysisOwner } from "../packages/coding-agent/src/core/shell-policy/shell-analysis.ts";
import { windowsLexerCounters } from "../packages/coding-agent/src/core/shell-policy/syntax/windows.ts";

const REMEMBER = "允许，并在本项目不再询问";

async function temporary(t: TestContext, prefix: string): Promise<string> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

async function fixture(t: TestContext, environment: "sandbox" | "trusted-host", mode: SessionPermissionMode) {
    const root = await temporary(t, "sp-project-rules-"), agentDir = await temporary(t, "sp-project-agent-");
    const runtime = createExtensionRuntime(), manager = SessionManager.inMemory(root), store = new ProjectPermissionStore(agentDir, root);
    runtime.appendEntry = (customType, data) => { manager.appendCustomEntry(customType, data); };
    const notes: string[] = [];
    const ctx: any = { cwd: root, hasUI: false, signal: new AbortController().signal, sessionManager: manager,
        ui: { notify: (message: string) => { notes.push(message); } } };
    const owner = new SessionExecutionPolicy(runtime, environment, {}, mode, [], store);
    t.after(async () => { owner.dispose(); await runtime.executionBoundary.dispose(); });
    const file = projectPermissionsFile(agentDir, root);
    async function decide(name: string, input: object, definition: object = { name }): Promise<string> {
        if (environment === "sandbox") owner.registerDefinition(definition as any);
        try { (await owner.authorize({ type: "tool_call", toolName: name, input, toolCallId: "test-call" } as any, ctx, definition as any)).release(); return "allow"; }
        catch (error: any) { return /APPROVAL_REQUIRED/.test(error.message) ? "ask" : /Explicitly denied/.test(error.message) ? "deny" : error.message; }
    }
    async function writeRules(rules: object[]) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify({ version: 1, rules }));
    }
    return { root, store, ctx, notes, file, owner, decide, writeRules };
}

test("project rules match words with `*`, PowerShell without case, and rank deny over ask over allow", () => {
    const rules = new ProjectRuleSet([
        { tool: "bash", decision: "allow", command: "npm test *" }, { tool: "bash", decision: "allow", command: "git * main" },
        { tool: "bash", decision: "allow", command: "npm run test*" }, { tool: "bash", decision: "allow", command: "git *" },
        { tool: "bash", decision: "deny", command: "git push *" }, { tool: "bash", decision: "ask", command: "*.sh *" },
        { tool: "powershell", decision: "allow", command: "Get-Process *" }, { tool: "mcp__docs__search", decision: "allow" },
    ]);
    for (const [argv, expected] of [
        [["npm", "test"], RULE_ALLOW], [["npm", "test", "--", "x"], RULE_ALLOW], [["npm", "testing"], RULE_NONE], [["npx", "test"], RULE_NONE],
        [["npm", "run", "test:unit"], RULE_ALLOW], [["git", "status"], RULE_ALLOW], [["git", "push", "origin", "main"], RULE_DENY],
        [["deploy.sh", "prod"], RULE_ASK],
    ] as const) assert.equal(rules.matchShellWords(false, argv), expected, argv.join(" "));
    assert.equal(rules.matchShellWords(true, ["get-process", "-Name", "node"]), RULE_ALLOW);
    assert.equal(rules.matchShellWords(false, ["Get-Process"]), RULE_NONE);
    assert.equal(rules.toolDecision("mcp__docs__search"), RULE_ALLOW);
    assert.equal(rules.toolDecision("mcp__docs__write"), RULE_NONE);
});

test("host-restricted classification lifts only literal segments, and suggestions name one prefix per other program", () => {
    const rules = new ProjectRuleSet([{ tool: "bash", decision: "allow", command: "npm test *" }, { tool: "bash", decision: "deny", command: "git push *" }]);
    for (const [command, expected] of [
        ["npm test && git status", HOST_SHELL_RULE_ALLOWED], ["npm test -- --grep x > log.txt", HOST_SHELL_RULE_ALLOWED],
        // A command the user allowed may change files too, so a later file command asks.
        ["npm test && rm a.txt", HOST_SHELL_OTHER], ["npm test $FILTER", HOST_SHELL_OTHER], ["npm run build", HOST_SHELL_OTHER],
        ["npm test &", HOST_SHELL_OTHER], ["npm test > out.txt && git status", HOST_SHELL_RULE_ALLOWED],
        // The redirect target was checked before the first command could replace a directory with a link.
        ["npm test && npm test > artifacts/result.txt", HOST_SHELL_OTHER],
    ] as const) assert.equal(classifyHostShellCommand("bash", command, undefined, rules), expected, command);
    assert.equal(shellRuleVerdict("bash", "ls && FOO=1 git push $REMOTE", rules), RULE_DENY);
    assert.equal(shellRuleVerdict("bash", "(git push origin)", rules), RULE_DENY);
    // Control-flow keywords open a segment without being its program.
    for (const command of ["if true; then git push origin main; fi", "for r in origin; do git push origin main; done", "! git push", "{ git push; }",
        "function publish { git push origin main; }; publish", "publish() { git push origin main; }; publish"])
        assert.equal(shellRuleVerdict("bash", command, rules), RULE_DENY, command);
    // Dispatch wrappers run the command after them; `command -v` only looks it up.
    for (const command of ["command git push origin main", "sudo -u ci env FOO=1 git push", "timeout 60 nohup git push", "sudo -n git push",
        "nice --adjustment 5 git push", "env --unset FOO git push", "time -p git push", "git branch | xargs -n 1 git push origin", "coproc git push", "sudo CI=1 git push origin main", "env - git push", "sudo -phello git push", "CI+=x git push", "xargs --replace git push origin {}", "env -- CI=1 git push origin main",
        "/usr/bin/git push origin main", "coproc publisher { git push origin main; }"])
        assert.equal(shellRuleVerdict("bash", command, rules), RULE_DENY, command);
    const lookup = new ProjectRuleSet([{ tool: "bash", decision: "deny", command: "git *" }]);
    // A rule naming a wrapper matches it at any level.
    const wrapper = new ProjectRuleSet([{ tool: "bash", decision: "deny", command: "sudo *" }]);
    for (const command of ["env sudo git push origin main", "command sudo git push"]) assert.equal(shellRuleVerdict("bash", command, wrapper), RULE_DENY, command);
    for (const command of ["command -v git", "command -p -v git", "command -pv git", "sudo -l git push"])
        assert.equal(shellRuleVerdict("bash", command, lookup), RULE_NONE, command);
    // `find -exec` runs its command; `case` arm patterns are not commands, their bodies are.
    const remove = new ProjectRuleSet([{ tool: "bash", decision: "deny", command: "rm *" }]);
    assert.equal(shellRuleVerdict("bash", 'find . -name "*.tmp" -exec rm -f {} +', remove), RULE_DENY);
    assert.equal(shellRuleVerdict("bash", 'case "$tool" in npm) echo npm;; git) echo git;; esac', lookup), RULE_NONE);
    assert.equal(shellRuleVerdict("bash", "case $x in\n  a|b) echo a ;;\n  *) git push ;;\nesac", lookup), RULE_DENY);
    const exact = new ProjectRuleSet([{ tool: "powershell", decision: "deny", command: "git push origin main" }]);
    // PowerShell keeps script blocks in one segment: each block's commands are matched on their own.
    for (const command of ["if ($true) { git push origin main }", "try { git push origin main } catch { Write-Output $_ }",
        "Try { npm test } catch [System.Exception] { Write-Error x } finally { git push origin main }", "1..2 | ForEach-Object { git push origin main }",
        "try {git push origin main} catch {}", "$null = git push origin main", "$out += git push origin main", "$r=git push origin main", "$null= git push origin main", "$null =git push origin main", "[string]$out = git push origin main", "git.exe push origin main",
        "return git push origin main", "function Publish { return git push origin main }; Publish", "process { Git push origin main }", "try { git push origin \"main\"} catch {}", "{\"git\" push origin main }", "try{ git push origin main }catch{}", "try{ npm test }finally{git push origin main}",
        "& \"C:\\Program Files\\Git\\cmd\\git.exe\" push origin main"])
        assert.equal(shellRuleVerdict("powershell", command, exact), RULE_DENY, command);
    assert.equal(shellRuleVerdict("powershell", "try { git status } catch { }", exact), RULE_NONE);
    // Hashtable keys are data; a hashtable value may still run a command.
    const npm = new ProjectRuleSet([{ tool: "powershell", decision: "deny", command: "npm *" }]);
    assert.equal(shellRuleVerdict("powershell", '$versions = @{ node = "22"; npm = "10" }', npm), RULE_NONE);
    assert.equal(shellRuleVerdict("powershell", "@{ out = npm test }", npm), RULE_DENY);
    assert.equal(shellRuleVerdict("powershell", "$result=@{ out = npm test }", npm), RULE_DENY);
    // A string in command position is a value; a call operator invokes it.
    for (const command of ["$label = 'npm'", "$label='npm'", "@{ label = 'npm' }"]) assert.equal(shellRuleVerdict("powershell", command, npm), RULE_NONE, command);
    assert.equal(shellRuleVerdict("powershell", "& 'npm' test", npm), RULE_DENY);
    for (const command of ["@{ result = (npm test) }", "@{ result = & npm test }"]) assert.equal(shellRuleVerdict("powershell", command, npm), RULE_DENY, command);
    // Switch labels are not commands; their action blocks are matched.
    assert.equal(shellRuleVerdict("powershell", "switch ($tool) { npm { Write-Output \"npm\" }; default { Write-Output other } }", npm), RULE_NONE);
    assert.equal(shellRuleVerdict("powershell", "switch ($tool) { a { Write-Output x } b { npm test } }", npm), RULE_DENY);
    // A quoted brace is text, not a block.
    assert.equal(shellRuleVerdict("powershell", 'rg --replace="{npm}" pattern file', npm), RULE_NONE);
    const blocks = new ProjectRuleSet([{ tool: "powershell", decision: "allow", command: "ForEach-Object *" }]);
    assert.equal(classifyHostShellCommand("powershell", "1..2 | ForEach-Object { npm test }", undefined, blocks), HOST_SHELL_OTHER);
    // An allow rule never lifts a segment that opens with control flow.
    assert.equal(classifyHostShellCommand("bash", "if true; then npm test; fi", undefined, rules), HOST_SHELL_OTHER);
    assert.equal(suggestShellRules("bash", "if true; then npm test; fi"), undefined);
    assert.equal(shellRuleVerdict("bash", "npm test", rules), RULE_NONE);
    assert.deepEqual(suggestShellRules("bash", "npm test -- --grep x && git status"), ["npm test *"]);
    assert.deepEqual(suggestShellRules("bash", "make"), ["make"]);
    assert.deepEqual(suggestShellRules("bash", "ls | node build.js --watch"), ["node build.js *"]);
    assert.deepEqual(suggestShellRules("powershell", "npm ci; Get-ChildItem"), ["npm ci *"]);
    assert.equal(suggestShellRules("bash", "npm test $FILTER"), undefined);
    assert.equal(suggestShellRules("bash", "npm run build && cp a.txt b.txt"), undefined);
    assert.equal(suggestShellRules("bash", "a1 x; a2 x; a3 x; a4 x; a5 x; a6 x"), undefined);
    assert.equal(suggestShellRules("bash", "make && npm test > out.txt"), undefined);
});

test("the project rule file reloads on change, keeps the last good version and saves atomically", async t => {
    const root = await temporary(t, "sp-project-store-"), agentDir = await temporary(t, "sp-project-agent-");
    const store = new ProjectPermissionStore(agentDir, root), file = projectPermissionsFile(agentDir, root);
    assert.match(path.relative(agentDir, file), /^projects[\\/][0-9a-f]{32}[\\/]permissions\.json$/);
    assert.equal((await store.refresh()).empty, true);
    await store.remember([{ tool: "bash", decision: "allow", command: "npm test *" }]);
    await store.remember([{ tool: "bash", decision: "allow", command: "npm test *" }, { tool: "mcp__docs__search", decision: "allow" }]);
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(saved.project, root);
    assert.deepEqual(saved.rules, [{ tool: "bash", decision: "allow", command: "npm test *" }, { tool: "mcp__docs__search", decision: "allow" }]);
    assert.deepEqual(await fs.readdir(path.dirname(file)), ["permissions.json"]);
    // A broken edit keeps the previous rules in force and is reported once.
    await fs.writeFile(file, "{ not json");
    assert.equal((await store.refresh()).rules.length, 2);
    assert.match(store.takeWarning()!, /无法解析/);
    assert.equal(store.takeWarning(), undefined);
    await assert.rejects(store.remember([{ tool: "bash", decision: "allow", command: "make" }]), /未保存/);
    await fs.writeFile(file, JSON.stringify({ version: 1, rules: [{ tool: "read", decision: "deny", command: "x" }] }));
    assert.equal((await store.refresh()).rules.length, 2);
    assert.match(store.takeWarning()!, /只有 bash 和 powershell/);
    await fs.rm(file);
    assert.equal((await store.refresh()).empty, true);
});

test("host-restricted offers 不再询问 for other commands and MCP tools, then runs them without asking", async t => {
    const f = await fixture(t, "trusted-host", "host-restricted"), outside = await temporary(t, "sp-project-outside-");
    await fs.writeFile(path.join(f.root, "a.txt"), "a");
    let offered: string[] = [], details = "";
    f.ctx.hasUI = true;
    f.ctx.ui.select = async (_title: string, choices: string[], options: any) => {
        offered = choices; details = options.details;
        return choices.includes(REMEMBER) ? REMEMBER : choices[0];
    };
    assert.equal(await f.decide("bash", { command: "npm test -- --grep x && git status" }), "allow");
    assert.match(details, /bash: npm test \*/);
    assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")).rules, [{ tool: "bash", decision: "allow", command: "npm test *" }]);
    f.ctx.ui.select = async () => { throw new Error("asked again"); };
    assert.equal(await f.decide("bash", { command: "npm test" }), "allow");
    // Outside paths are asked every time; no rule is offered for them.
    f.ctx.ui.select = async (_title: string, choices: string[]) => { offered = choices; return choices[0]; };
    assert.equal(await f.decide("bash", { command: `npm test > ${outside.replaceAll("\\", "/")}/log.txt` }), "allow");
    assert.equal(offered.includes(REMEMBER), false);
    // A write into an existing directory asks even with a saved rule, so none is offered.
    await fs.mkdir(path.join(f.root, "dist"));
    assert.equal(await f.decide("bash", { command: "cp a.txt dist/ && make" }), "allow");
    assert.equal(offered.includes(REMEMBER), false);
    const mcp ={ name: "mcp__docs__search", mcpServer: "docs", mcpToolPrefix: "mcp__docs__" };
    f.ctx.ui.select = async (_title: string, choices: string[]) => { offered = choices; return REMEMBER; };
    assert.equal(await f.decide("mcp__docs__search", {}, mcp), "allow");
    f.ctx.ui.select = async () => { throw new Error("asked again"); };
    assert.equal(await f.decide("mcp__docs__search", {}, mcp), "allow");
    // Classification, mutation analysis and the rule check read one token table.
    await f.writeRules([{ tool: "powershell", decision: "allow", command: "npm test *" }]);
    const lexes = windowsLexerCounters.lexes;
    assert.equal(await f.decide("powershell", { command: "npm test; Get-ChildItem" }), "allow");
    assert.equal(windowsLexerCounters.lexes - lexes, 1);
});

test("project deny and ask rules apply in every tier; allow rules do not lift outside asks", async t => {
    const host = await fixture(t, "trusted-host", "host-write");
    await host.writeRules([{ tool: "bash", decision: "deny", command: "git push *" }, { tool: "bash", decision: "ask", command: "npm publish *" },
        { tool: "read", decision: "ask" }]);
    assert.equal(await host.decide("bash", { command: "git status && git push origin main" }), "deny");
    assert.equal(await host.decide("bash", { command: "npm publish" }), "ask");
    assert.equal(await host.decide("bash", { command: "npm test" }), "allow");
    await fs.writeFile(path.join(host.root, "a.txt"), "a");
    assert.equal(await host.decide("read", { path: "a.txt" }), "ask");
    // Change observation (`/changes` verification) answers to project read rules too.
    await assert.rejects(host.owner.authorizeFileObservation(host.ctx, ["a.txt"]), /existing read grant/);
    await host.writeRules([{ tool: "bash", decision: "deny", command: "git push *" }]);
    await host.owner.authorizeFileObservation(host.ctx, ["a.txt"]);
    const sandbox = await fixture(t, "sandbox", "sandbox-write");
    await sandbox.writeRules([{ tool: "bash", decision: "deny", command: "git push *" }]);
    assert.equal(await sandbox.decide("bash", { command: "git push" }), "deny");
    const restricted = await fixture(t, "trusted-host", "host-restricted"), outside = await temporary(t, "sp-project-outside-");
    await restricted.writeRules([{ tool: "bash", decision: "allow" }]);
    assert.equal(await restricted.decide("bash", { command: "npm test" }), "allow");
    assert.equal(await restricted.decide("bash", { command: `npm test > ${outside.replaceAll("\\", "/")}/log.txt` }), "ask");
});

test("whole-tool shell rules, batch operations and non-ASCII PowerShell spellings cannot slip past project rules", async t => {
    const host = await fixture(t, "trusted-host", "host-write");
    await host.writeRules([{ tool: "bash", decision: "deny" }, { tool: "write", decision: "deny" }]);
    // An assignment-only segment has no command words; the whole-tool rule still applies.
    assert.equal(await host.decide("bash", { command: "FOO=$(git push origin main)" }), "deny");
    assert.equal(await host.decide("file_batch", { operations: [{ operation: "write", path: "a.txt", content: "x" }] }), "deny");
    const rules = new ProjectRuleSet([{ tool: "powershell", decision: "deny", command: "npm run DÉPLOY *" }]);
    for (const word of ["DÉPLOY", "déploy"]) assert.equal(rules.matchShellWords(true, ["npm", "run", word, "prod"]), RULE_DENY, word);
    // A quote inside a literal heredoc body does not swallow the command after the terminator.
    const sandbox = await fixture(t, "sandbox", "sandbox-write");
    await sandbox.writeRules([{ tool: "bash", decision: "deny", command: "git push *" }]);
    assert.equal(await sandbox.decide("bash", { command: "cat <<'EOF'\n'\nEOF\ngit push origin main" }), "deny");
    assert.equal(await sandbox.decide("bash", { command: "cat <<'EOF'\n'\ngit push" }), "ask");
    assert.equal(await sandbox.decide("bash", { command: "cat <<'EOF'\ngit push\nEOF" }), "allow");
    // The host owner rewrites an interpreter heredoc for its own analysis; rules see the words as written.
    await host.writeRules([{ tool: "bash", decision: "deny", command: "node" }]);
    assert.equal(await host.decide("bash", { command: "node <<'EOF'\nconsole.log(1)\nEOF" }), "deny");
    // Allow rules and 不再询问 leave heredoc commands to the ask.
    const allow = new ProjectRuleSet([{ tool: "bash", decision: "allow", command: "cat *" }]);
    assert.equal(classifyHostShellCommand("bash", "cat <<'EOF'\n'\nEOF\nmake", undefined, allow), HOST_SHELL_OTHER);
    assert.equal(suggestShellRules("bash", "make <<EOF\nx\nEOF"), undefined);
    // A quoted `<<` is argument data, not a heredoc.
    const npm = new ProjectRuleSet([{ tool: "bash", decision: "allow", command: "npm test *" }]);
    assert.equal(classifyHostShellCommand("bash", "npm test -- --grep '<<'", undefined, npm), HOST_SHELL_RULE_ALLOWED);
    assert.deepEqual(suggestShellRules("bash", "npm test -- --grep '<<'"), ["npm test *"]);
});

test("saves from concurrent sessions are merged, and a rule the reader would reject is never written", async t => {
    const root = await temporary(t, "sp-project-store-"), agentDir = await temporary(t, "sp-project-agent-");
    const first = new ProjectPermissionStore(agentDir, root), second = new ProjectPermissionStore(agentDir, root);
    const file = projectPermissionsFile(agentDir, root);
    await Promise.all([first.remember([{ tool: "bash", decision: "allow", command: "npm test *" }]),
        second.remember([{ tool: "bash", decision: "allow", command: "make" }])]);
    const commands = JSON.parse(await fs.readFile(file, "utf8")).rules.map((rule: any) => rule.command).sort();
    assert.deepEqual(commands, ["make", "npm test *"]);
    assert.deepEqual(await fs.readdir(path.dirname(file)), ["permissions.json"]);
    // A long literal argument falls back to the program's prefix; an oversized rule is refused.
    assert.deepEqual(suggestShellRules("bash", "curl " + "x".repeat(5000)), ["curl *"]);
    const before = await fs.readFile(file, "utf8");
    await assert.rejects(first.remember([{ tool: "bash", decision: "allow", command: "curl " + "x".repeat(5000) }]), /未保存/);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.equal((await first.refresh()).rules.length, 2);
    // Overlapping authorizations share one reload; neither sees the old rules once the file changed.
    await fs.writeFile(file, JSON.stringify({ version: 1, rules: [{ tool: "bash", decision: "deny", command: "git push *" }] }));
    const [a, b] = await Promise.all([second.refresh(), second.refresh()]);
    assert.equal(a, b);
    assert.equal(a.matchShellWords(false, ["git", "push"]), RULE_DENY);
});

test("a shell analysis owner shared with the rule check is released", async t => {
    const root = await temporary(t, "sp-project-owner-");
    const owner = new ShellAnalysisOwner("npm test", root, 0, "bash");
    const rules = new ProjectRuleSet([{ tool: "bash", decision: "deny", command: "npm *" }]);
    assert.equal(shellRuleVerdict("bash", "npm test", rules, owner), RULE_DENY);
    assert.equal(classifyHostShellCommand("bash", "npm test", owner, rules), HOST_SHELL_OTHER);
    owner.release();
    assert.equal(owner.size, 0);
});
