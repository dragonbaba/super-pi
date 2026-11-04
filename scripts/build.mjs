import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
// Preserve the existing root build's package set; manifests own dependency order.
export const BUILD_PACKAGES = Object.freeze([
    "packages/tui", "packages/telemetry", "packages/ai", "packages/agent", "packages/codemode",
    "packages/session-backends/sqlite-node", "packages/protocol", "packages/client", "packages/server",
    "packages/coding-agent", "packages/memory", "packages/statusline",
]);

export function buildPlan(root = REPOSITORY, directories = BUILD_PACKAGES, offline = false) {
    const packages = new Map();
    for (const directory of directories) {
        const cwd = path.resolve(root, directory);
        const manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
        if (!manifest.name || packages.has(manifest.name)) throw new Error("Missing or duplicate build package: " + directory);
        const script = offline && manifest.scripts?.["build:offline"] ? "build:offline" : "build";
        if (!manifest.scripts?.[script]) throw new Error("Missing build script: " + manifest.name);
        packages.set(manifest.name, { name: manifest.name, cwd, script, manifest, dependencies: [] });
    }
    for (const item of packages.values()) {
        const dependencies = new Set();
        for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
            for (const name of Object.keys(item.manifest[field] ?? {})) if (packages.has(name)) dependencies.add(name);
        }
        item.dependencies = [...dependencies]; item.manifest = undefined;
    }
    const ordered = [], completed = new Set();
    while (ordered.length < packages.size) {
        const before = ordered.length;
        for (const item of packages.values()) {
            if (!completed.has(item.name) && item.dependencies.every(name => completed.has(name))) {
                ordered.push(item); completed.add(item.name);
            }
        }
        if (ordered.length === before) throw new Error("Cyclic workspace build dependencies");
    }
    return ordered;
}

export function parseBuildArguments(argv) {
    const options = { offline: false, jobs: Math.min(2, availableParallelism()), list: false, help: false };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === "--offline") options.offline = true;
        else if (argument === "--jobs") {
            const value = argv[++index]; options.jobs = Number(value);
            if (!value || !Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 32) throw new Error("--jobs must be an integer from 1 to 32");
        } else if (argument === "--list") options.list = true;
        else if (argument === "--help") options.help = true;
        else throw new Error("Unknown build option: " + argument);
    }
    return options;
}

/** One command lifecycle. Child output is inherited, never buffered or rewritten. */
export function runBuilds(plan, { jobs, offline = false, npmCli, signal, environment = process.env, spawnChild = spawn, output = console.log }) {
    if (!Number.isInteger(jobs) || jobs < 1 || jobs > 32) throw new Error("Invalid build concurrency");
    if (!npmCli || !path.isAbsolute(npmCli) || !fs.statSync(npmCli).isFile()) throw new Error("Run this entry through npm run build:offline or npm run build");
    const childEnvironment = offline ? { ...environment, npm_config_offline: "true" } : environment;
    const pending = new Set(plan), completed = new Set(), results = [];
    let active = 0, peakRunning = 0, exitCode = 0;
    return new Promise(resolve => {
        function finish() {
            signal?.removeEventListener("abort", abort);
            resolve({ exitCode, completed: completed.size, peakRunning, results });
        }
        function abort() {
            exitCode ||= Number.isInteger(signal.reason) && signal.reason > 0 ? signal.reason : 1;
            output("[build] Stopping new work; waiting for active builds to finish.");
            if (!active) finish();
        }
        function start(item) {
            pending.delete(item); active++; peakRunning = Math.max(peakRunning, active);
            const started = performance.now(); output("[build] START " + item.name);
            let child, launchError;
            function close(code, childSignal) {
                active--;
                const status = launchError ? 1 : code ?? 1;
                if (status === 0) completed.add(item.name); else exitCode ||= status > 0 ? status : 1;
                const elapsedMs = Math.round(performance.now() - started);
                results.push({ name: item.name, exitCode: status, signal: childSignal, elapsedMs });
                output("[build] END " + item.name + " ms=" + elapsedMs + " exit=" + status);
                if (launchError) output("[build] " + launchError.message);
                dispatch();
            }
            try {
                const args = [npmCli]; if (offline) args.push("--offline"); args.push("run", item.script);
                child = spawnChild(process.execPath, args, { cwd: item.cwd, env: childEnvironment, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
            } catch (error) { launchError = error; close(1, null); return; }
            child.once("error", error => { launchError = error; exitCode ||= 1; }); child.once("close", close);
        }
        function dispatch() {
            for (const item of pending) {
                if (exitCode || active >= jobs) break;
                if (item.dependencies.every(name => completed.has(name))) start(item);
            }
            if (!active && (exitCode || !pending.size)) finish();
        }
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort(); else dispatch();
    });
}

async function main() {
    const options = parseBuildArguments(process.argv.slice(2));
    if (options.help) {
        console.log("Usage: npm run build:offline -- [--jobs N] [--list]\n       npm run build -- [--jobs N] [--list]\nDefault concurrency: at most 2 packages. --jobs 1 runs serially.");
        return;
    }
    const plan = buildPlan(REPOSITORY, BUILD_PACKAGES, options.offline);
    if (options.list) {
        for (const item of plan) console.log(item.name + " (" + item.script + "): " + (item.dependencies.join(", ") || "no workspace dependencies"));
        return;
    }
    const controller = new AbortController();
    function interrupt() { controller.abort(130); }
    function terminate() { controller.abort(143); }
    process.once("SIGINT", interrupt); process.once("SIGTERM", terminate);
    const started = performance.now();
    try {
        const result = await runBuilds(plan, { ...options, npmCli: process.env.npm_execpath, signal: controller.signal });
        console.log("[build] Completed " + result.completed + "/" + plan.length + " packages in " + Math.round(performance.now() - started) + "ms; peak=" + result.peakRunning);
        process.exitCode = result.exitCode;
    } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error("[build] " + error.message); process.exitCode = 1; });
}
