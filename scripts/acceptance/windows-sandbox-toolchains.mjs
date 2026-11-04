// VM-startup discovery only. No shell execution, host environment inheritance or tool installation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const win = path.win32;
const INVALID = /[\x00-\x1f;%<>"|?*]/;
const LOCAL = /^[A-Za-z]:\\/;
const ENV_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const TRAILING_SEPARATOR = /\\$/;
const SYSTEM_PATH = "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\OpenSSH";
const ROOT_ENV = ["JAVA_HOME", "JDK_HOME", "GOROOT", "DOTNET_ROOT", "RUSTUP_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "GRADLE_HOME", "CUDA_PATH"];
const RESERVED_GUEST_ROOTS = ["C:\\Windows", "C:\\SuperPiTools", "C:\\SuperPiToolchains", "C:\\SuperPiInput", "C:\\SuperPiWorkspace", "C:\\SuperPiExchange", "C:\\SuperPiCommand", "C:\\SuperPiVolume"];
function need(value, reason) { if (!value) throw new Error("[SANDBOX_TOOLCHAIN] " + reason); }
function within(value, root) { return value.toLowerCase() === root.toLowerCase() || value.toLowerCase().startsWith(root.toLowerCase() + "\\"); }
function canonical(value) {
    need(typeof value === "string" && value.length > 0 && value.length <= 1024 && !INVALID.test(value), "Invalid tool directory");
    const normalized = win.normalize(value);
    need(LOCAL.test(normalized) && !normalized.startsWith("\\\\"), "Tool directories must be absolute local paths");
    return normalized.length > 3 ? normalized.replace(TRAILING_SEPARATOR, "") : normalized;
}
function xml(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function environmentValue(environment, name) {
    for (const key of Object.keys(environment)) if (key.toUpperCase() === name) return environment[key];
    return undefined;
}

/** Host-created, read-only mounts. Retained only for one VM generation. */
export class SandboxToolchains {
    #mounts = [];
    #paths = [];
    #supplementalPaths = [];
    #environment = new Map();
    #inferredRoots = [];
    #seen = new Set();
    #excluded;
    #workspace;
    #home;
    #cargo;
    #cargoRoots = new Set();
    #windows;
    #io;
    #shell;
    #hostShell;
    #checked = false;
    #entries = 0;
    #directories = 0;
    diagnostics = [];
    constructor({ cwd, settings = {}, powershellPath, environment = process.env, executable = process.execPath,
        home = os.homedir(), io = fs } = {}) {
        need(settings && typeof settings === "object" && !Array.isArray(settings), "Expected toolchain settings");
        for (const key of Object.keys(settings)) need(key === "include" || key === "exclude", "Unknown toolchain setting: " + key);
        for (const key of ["include", "exclude"]) need(settings[key] === undefined || Array.isArray(settings[key]) && settings[key].length <= 64, "Invalid " + key + " list");
        this.#io = io;
        this.#workspace = canonical(io.realpathSync(canonical(cwd)));
        this.#home = canonical(io.realpathSync(canonical(home)));
        this.#cargo = this.#protectCargoHome(win.join(this.#home, ".cargo"));
        const cargoHome = environmentValue(environment, "CARGO_HOME");
        if (cargoHome) this.#cargo = this.#protectCargoHome(cargoHome);
        this.#windows = canonical(environmentValue(environment, "SYSTEMROOT") || "C:\\Windows");
        this.#excluded = [];
        for (const item of settings.exclude ?? []) this.#excluded.push(canonical(item));
        const entries = [];
        for (const item of (environmentValue(environment, "PATH") || "").split(";")) {
            const value = item.trim(); if (value) entries.push(value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value);
        }
        need(entries.length <= 512, "PATH entry limit exceeded");
        let shell = powershellPath;
        if (!shell) for (const entry of entries) {
            let directory; try { directory = canonical(entry); } catch { continue; }
            const candidate = win.join(directory, "pwsh.exe");
            if (this.#file(candidate)) { shell = candidate; break; }
        }
        if (!shell) {
            const standard = win.join(environmentValue(environment, "PROGRAMFILES") || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
            if (this.#file(standard)) shell = standard;
        }
        need(shell && win.basename(shell).toLowerCase() === "pwsh.exe", "PowerShell 7 (pwsh.exe) is required; no Windows PowerShell fallback");
        shell = canonical(io.realpathSync(canonical(shell)));
        this.#hostShell = shell;
        const shellRoot = win.dirname(shell);
        need(this.#file(win.join(shellRoot, "pwsh.dll")) && this.#file(win.join(shellRoot, "pwsh.runtimeconfig.json")), "Complete PowerShell 7 installation required");
        this.#add(shellRoot, shellRoot, true);
        this.#shell = this.#translate(shell);
        this.#environment.set("PSModulePath", this.#translate(win.join(shellRoot, "Modules")));
        // The application runtime has priority over stale Node versions later on PATH.
        this.#discover(win.dirname(canonical(executable)), true);
        for (const entry of entries) this.#discover(entry, false);
        for (const entry of settings.include ?? []) this.#discover(entry, true);
        for (const entry of this.#supplementalPaths) this.#appendPath(entry);
        this.#supplementalPaths.length = 0;
        for (const name of ROOT_ENV) {
            const value = environmentValue(environment, name);
            if (!value) continue;
            try { const root = canonical(value); this.#add(root, undefined, false); const guest = this.#translate(root); if (guest) this.#environment.set(name, guest); }
            catch { this.diagnostics.push({ path: value, reason: "unavailable dependency root: " + name }); }
        }
        // rustup proxies need toolchains/settings, never the credential-bearing .cargo root.
        if (!this.#environment.has("RUSTUP_HOME") && this.#translate(win.join(this.#cargo, "bin"))
            && this.#file(win.join(this.#cargo, "bin", "rustup.exe"))) {
            const rustup = win.join(this.#home, ".rustup");
            this.#add(rustup, undefined, false);
            const guest = this.#translate(rustup); if (guest) this.#environment.set("RUSTUP_HOME", guest);
        }
        this.#finishEnvironment();
    }
    #finishEnvironment() {
        // First surviving PATH installation wins; explicit host root variables keep priority.
        for (const entry of this.#paths) for (const [name, host, executableDirectory] of this.#inferredRoots) {
            if (this.#environment.has(name)) continue;
            if (this.#translate(executableDirectory)?.toLowerCase() !== entry.toLowerCase()) continue;
            const guest = this.#translate(host); if (guest) this.#environment.set(name, guest);
        }
        this.#environment.set("PATH", this.#paths.join(";") + ";" + SYSTEM_PATH);
        const drives = new Set();
        for (const mount of this.#mounts) if (mount.host[0].toUpperCase() !== "C") drives.add(mount.host[0].toUpperCase());
        this.#environment.set("SUPERPI_TOOLCHAIN_DRIVES", [...drives].join(";"));
        need(this.encodedEnvironment.length <= 24000, "Translated toolchain environment exceeds command capacity");
    }
    #file(file) { try { return this.#io.statSync(file).isFile(); } catch { return false; } }
    #protectCargoHome(value) {
        const root = canonical(value); this.#cargoRoots.add(root);
        try { const real = canonical(this.#io.realpathSync(root)); this.#cargoRoots.add(real); return real; }
        catch (error) { need(error?.code === "ENOENT", "Cannot resolve Cargo home identity"); return root; }
    }
    #safe(root) {
        if (root.length <= 3 || within(this.#workspace, root) || within(root, this.#workspace) || within(this.#home, root)
            || within(root, this.#windows)) return false;
        for (const cargo of this.#cargoRoots) if (within(cargo, root) || within(root, cargo) && !within(root, win.join(cargo, "bin"))) return false;
        for (const reserved of RESERVED_GUEST_ROOTS) if (within(root, reserved) || within(reserved, root)) return false;
        for (const excluded of this.#excluded) if (within(root, excluded) || within(excluded, root)) return false;
        return true;
    }
    #add(root, entry, required) {
        try {
            root = canonical(root);
            need(this.#safe(root), "Unsafe or excluded tool root: " + root);
            const stat = this.#io.lstatSync(root, { bigint: true });
            need(stat.isDirectory() && !stat.isSymbolicLink() && canonical(this.#io.realpathSync(root)).toLowerCase() === root.toLowerCase(), "Redirected tool root: " + root);
            let mounted = false;
            for (const mount of this.#mounts) if (within(root, mount.host)) { mounted = true; mount.required ||= required; break; }
            if (!mounted) {
                need(this.#mounts.length < 128, "Tool mount limit exceeded");
                for (let i = this.#mounts.length - 1; i >= 0; i--) if (within(this.#mounts[i].host, root)) { required ||= this.#mounts[i].required; this.#mounts.splice(i, 1); }
                this.#mounts.push({ host: root, guest: root[0].toUpperCase() === "C" ? root : "C:\\SuperPiToolchains\\" + root[0].toUpperCase() + root.slice(2), dev: stat.dev, ino: stat.ino, required });
            }
            if (entry) this.#appendPath(entry);
            return true;
        } catch (error) {
            if (required) throw error;
            this.diagnostics.push({ path: root, reason: "unavailable or excluded tool directory" }); return false;
        }
    }
    #appendPath(entry) {
        const guest = this.#translate(entry); if (!guest) return;
        const key = guest.toLowerCase(); if (!this.#seen.has(key)) { this.#seen.add(key); this.#paths.push(guest); }
    }
    #discover(value, required) {
        let entry;
        try {
            entry = canonical(value);
            if (within(entry, this.#windows)) { need(!required, "Unsafe system tool root: " + entry); return; }
            // OS app aliases and agent-owned transient wrappers are not portable installations.
            const lower = entry.toLowerCase();
            if (lower.endsWith("\\microsoft\\windowsapps") || lower.includes("\\.codex\\tmp\\")) return;
            entry = canonical(this.#io.realpathSync(entry));
            const stat = this.#io.statSync(entry); need(stat.isDirectory(), "PATH entry is not a directory");
            let root = entry;
            const leaf = win.basename(entry).toLowerCase(), parent = win.dirname(entry);
            if ((leaf === "bin" || leaf === "cmd" || leaf === "scripts") && this.#safe(parent)) root = parent;
            // A Links directory contains aliases, not their installation dependencies.
            if (leaf === "links") {
                for (const child of this.#io.readdirSync(entry, { withFileTypes: true })) {
                    if (!child.isSymbolicLink()) continue;
                    const alias = win.join(entry, child.name);
                    try {
                        const target = canonical(this.#io.realpathSync(alias));
                        if (win.basename(target).toLowerCase() === child.name.toLowerCase()) this.#discover(win.dirname(target), false);
                    } catch { this.diagnostics.push({ path: alias, reason: "invalid or missing tool alias" }); }
                }
                return;
            }
            if (!this.#add(root, entry, required)) return;
            // Additional executable directories inside complete installations are discovered structurally.
            if (root === entry) for (const child of ["bin", "Scripts"]) {
                const nested = win.join(root, child);
                try { if (this.#io.statSync(nested).isDirectory()) this.#supplementalPaths.push(nested); } catch { /* optional layout */ }
            }
            if (this.#file(win.join(root, "bin", "go.exe"))) this.#inferredRoots.push(["GOROOT", root, win.join(root, "bin")]);
            if (this.#file(win.join(root, "bin", "javac.exe"))) this.#inferredRoots.push(["JAVA_HOME", root, win.join(root, "bin")]);
            if (this.#file(win.join(root, "dotnet.exe"))) this.#inferredRoots.push(["DOTNET_ROOT", root, root]);
        } catch (error) {
            if (required) throw error;
            this.diagnostics.push({ path: value, reason: "invalid or missing PATH entry" });
        }
    }
    #translate(host) {
        for (const mount of this.#mounts) if (within(host, mount.host)) return mount.guest + host.slice(mount.host.length);
        return undefined;
    }
    get shell() { return this.#shell; }
    get hostShell() { return this.#hostShell; }
    get statistics() { return { mounts: this.#mounts.length, paths: this.#paths.length, scannedEntries: this.#entries, scannedDirectories: this.#directories, checked: this.#checked }; }
    async validateTrees(signal) {
        need(!this.#checked, "Tool trees already checked");
        const io = this.#io.promises;
        for (let i = 0; i < this.#mounts.length; i++) {
            const mount = this.#mounts[i], stack = [mount.host]; let entries = 0;
            try {
                while (stack.length) {
                    signal?.throwIfAborted(); const directory = stack.pop(); this.#directories++;
                    const children = io ? await io.readdir(directory, { withFileTypes: true }) : this.#io.readdirSync(directory, { withFileTypes: true });
                    for (const child of children) {
                        need(entries < 250000 && this.#entries < 2000000, "Tool tree inspection capacity exceeded");
                        entries++; this.#entries++;
                        const file = win.join(directory, child.name);
                        if (child.isSymbolicLink()) {
                            const target = canonical(io ? await io.realpath(file) : this.#io.realpathSync(file));
                            need(within(target, mount.host), "Tool link leaves installation root: " + win.relative(mount.host, file));
                        } else if (child.isDirectory()) stack.push(file);
                    }
                }
            } catch (error) {
                signal?.throwIfAborted(); if (mount.required) throw error;
                this.diagnostics.push({ path: mount.host, reason: error instanceof Error ? error.message.slice(0, 512) : "Tool tree inspection failed" });
                this.#mounts.splice(i--, 1);
                for (let p = this.#paths.length - 1; p >= 0; p--) if (within(this.#paths[p], mount.guest)) this.#paths.splice(p, 1);
                for (const [name, value] of this.#environment) if (name !== "PATH" && within(value, mount.guest)) this.#environment.delete(name);
            }
        }
        this.assertCurrent(); this.#finishEnvironment(); this.#inferredRoots.length = 0; this.#checked = true;
    }
    get encodedEnvironment() {
        let text = this.#shell;
        for (const [name, value] of this.#environment) { need(ENV_NAME.test(name) && !value.includes("\n") && !value.includes("\r"), "Invalid guest environment"); text += "\n" + name + "=" + value; }
        return Buffer.from(text, "utf8").toString("base64");
    }
    assertCurrent() {
        for (const mount of this.#mounts) {
            const stat = this.#io.lstatSync(mount.host, { bigint: true });
            need(stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === mount.dev && stat.ino === mount.ino
                && canonical(this.#io.realpathSync(mount.host)).toLowerCase() === mount.host.toLowerCase(), "Tool directory identity changed: " + mount.host);
        }
    }
    appendConfig(config) {
        need(this.#checked, "Tool trees must be checked before mapping");
        this.assertCurrent();
        let mappings = "";
        for (const mount of this.#mounts) mappings += "<MappedFolder><HostFolder>" + xml(mount.host) + "</HostFolder><SandboxFolder>" + xml(mount.guest) + "</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>";
        need(config.indexOf("</MappedFolders>") === config.lastIndexOf("</MappedFolders>") && config.includes("</MappedFolders>"), "Expected one mapping section");
        return config.replace("</MappedFolders>", mappings + "</MappedFolders>");
    }
}
