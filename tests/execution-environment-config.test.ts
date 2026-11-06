import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { parseArgs } from "../packages/coding-agent/src/cli/args.ts";
import { defaultPermissionMode } from "../packages/coding-agent/src/core/permission-mode.ts";

test("interactive permission preferences cannot restore host access and overrides never persist", () => {
    for (const legacy of [undefined, "full-access", "never-ask", "host-write", "host-restricted"]) assert.equal(defaultPermissionMode(legacy), "sandbox-write");
    assert.equal(defaultPermissionMode("read-only"), "read-only");
    const settings = SettingsManager.inMemory({ permissionMode: "read-only" });
    for (const mode of ["sandbox-write", "host-write", "host-restricted", "read-only"] as const) {
        settings.setPermissionModeForSession(mode);
        assert.equal(settings.getPermissionMode(), mode);
        assert.equal(settings.getExecutionEnvironment(), mode.startsWith("host-") ? "trusted-host" : "sandbox");
        assert.equal(settings.getGlobalSettings().permissionMode, "read-only");
    }
    assert.throws(() => settings.setPermissionModeForSession("full-access" as any));
});

test("execution profile is explicit, validated, global-only, and CLI selection is not persisted", () => {
    const settings = SettingsManager.inMemory({ executionEnvironment: "sandbox" });
    assert.equal(settings.getExecutionEnvironment(), "sandbox");
    settings.setExecutionEnvironmentForSession("trusted-host");
    assert.equal(settings.getExecutionEnvironment(), "trusted-host");
    assert.equal(settings.getGlobalSettings().executionEnvironment, "sandbox");
    assert.throws(() => SettingsManager.inMemory({ executionEnvironment: "full-access" as any }).getExecutionEnvironment(), /Invalid global/);
    assert.equal(parseArgs(["--execution-environment", "sandbox"]).executionEnvironment, "sandbox");
    assert.equal(parseArgs(["--execution-environment", "trusted-host"]).executionEnvironment, "trusted-host");
    assert.ok(parseArgs(["--execution-environment", "full-access"]).diagnostics.some(item => item.type === "error"));
    assert.equal(parseArgs(["--", "--execution-environment", "trusted-host"]).executionEnvironment, undefined);
});
test("new Windows installations default to sandbox while existing settings never gain host authority", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sp-execution-config-"));
    t.after(async () => { await fs.rm(root, { recursive: true }); });
    const fresh = SettingsManager.create(root, path.join(root, "fresh"));
    assert.equal(fresh.getExecutionEnvironment(), process.platform === "win32" ? "sandbox" : undefined);
    await fs.mkdir(path.join(root, "existing", "config"), { recursive: true });
    await fs.writeFile(path.join(root, "existing", "config", "settings.json"), JSON.stringify({ approvalPolicy: "never-ask", permissionMode: "full-access" }));
    await fs.mkdir(path.join(root, ".sp", "config"), { recursive: true });
    await fs.writeFile(path.join(root, ".sp", "config", "settings.json"), JSON.stringify({ executionEnvironment: "trusted-host" }));
    const old = SettingsManager.create(root, path.join(root, "existing"));
    assert.equal(old.getExecutionEnvironment(), undefined);
    assert.equal(old.getProjectSettings().executionEnvironment, "trusted-host");
});
