import { existsSync, readdirSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_TEST_ROOT = resolve(REPOSITORY_ROOT, "tests");
const TEST_FILE_PATTERN = /\.test\.(?:[cm]?[jt]s)$/;
const HOT_TEST_PATTERN = /(?:^|\/)(?:source-invariants|hot-source-invariants|[^/]*hot-paths)\.test\./;

// These offline integration fixtures need an empty working directory as well as
// an isolated home. They used to run twice, once through the standalone probe.
const ISOLATED_CWD_TESTS = new Set([
	"alpha-stream-corpus.test.ts", "alpha-stream-endings.test.ts", "alpha-stream-markers.test.ts",
	"alpha-markdown-ownership.test.ts", "alpha-assistant-update.test.ts", "alpha-retained-active.test.ts",
	"alpha-cli.test.ts", "alpha-active-quit.test.ts", "alpha-compaction-quit.test.ts", "alpha-session-replacement.test.ts",
	"alpha-g2-raw.test.ts", "alpha-ansi.test.ts", "alpha-raw-session.test.ts", "alpha-raw-parallel.test.ts",
	"alpha-image.test.ts", "alpha-upstream-truncation.test.ts", "alpha-footer-scans.test.ts", "alpha-lifecycle.test.ts",
	"alpha-runtime-dispose.test.ts", "alpha-startup-quit.test.ts", "alpha-crash-cleanup.test.ts", "alpha-startup-faults.test.ts",
]);
const GC_TESTS = new Set([
	"alpha-assistant-update.test.ts", "alpha-markdown-ownership.test.ts",
	"alpha-raw-parallel.test.ts", "alpha-startup-quit.test.ts",
]);

function compareCodeUnits(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeTestPath(value) {
	return value.replaceAll("\\", "/");
}

export function classifyTestFile(file) {
	const normalized = normalizeTestPath(file);
	if (normalized.includes("/provider-contract/") || normalized.startsWith("provider-contract/") || normalized.includes(".contract.test.")) {
		return "contract";
	}
	if (HOT_TEST_PATTERN.test(normalized)) return "hot";
	return "unit";
}

export function discoverTestFiles(root = DEFAULT_TEST_ROOT) {
	const absoluteRoot = resolve(root);
	const discovered = [];
	const pending = [absoluteRoot];

	while (pending.length > 0) {
		const directory = pending.pop();
		const entries = readdirSync(directory, { withFileTypes: true });
		entries.sort((left, right) => compareCodeUnits(left.name, right.name));
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			const absolute = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				pending.push(absolute);
			} else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
				discovered.push(normalizeTestPath(relative(absoluteRoot, absolute)));
			}
		}
	}

	return discovered.sort(compareCodeUnits);
}

function parseArguments(argv) {
	const options = { suite: "all", root: DEFAULT_TEST_ROOT, skipMemory: false, list: false };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--suite") {
			options.suite = argv[++index];
		} else if (argument === "--root") {
			options.root = resolve(argv[++index]);
		} else if (argument === "--skip-memory") {
			options.skipMemory = true;
		} else if (argument === "--list") {
			options.list = true;
		} else {
			throw new Error(`Unknown test runner argument: ${argument}`);
		}
	}
	if (!new Set(["all", "unit", "hot", "contract"]).has(options.suite)) {
		throw new Error(`Unknown test suite: ${options.suite}`);
	}
	return options;
}

function runChild(label, command, args, cwd) {
	const root = mkdtempSync(resolve(tmpdir(), "super-pi-test-"));
	const started = performance.now();
	console.log(`[test] START ${label}`);
	let child;
	try {
		mkdirSync(resolve(root, "agent"));
		mkdirSync(resolve(root, "sessions"));
		child = spawnSync(command, args, {
			cwd: cwd ?? root, stdio: "inherit",
			env: { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
				SP_CODING_AGENT_DIR: resolve(root, "agent"), SP_CODING_AGENT_SESSION_DIR: resolve(root, "sessions"),
				SP_OFFLINE: "1", SP_TUI_WRITE_LOG: "" },
		});
	} finally {
		// Only remove this invocation's exact, directly-created temporary child.
		if (dirname(root) !== resolve(tmpdir())) throw new Error("temporary root escaped");
		rmSync(root, { recursive: true, force: true });
		console.log(`[test] END ${label} ms=${Math.round(performance.now() - started)} exit=${child?.status ?? "none"} signal=${child?.signal ?? "none"}`);
	}
	if (child.error) {
		console.error(`[test] ${label} failed to start: ${child.error.message}`);
		return 1;
	}
	if (child.status !== 0) {
		const exitCode = child.status ?? 1;
		console.error(`[test] ${label} failed with exit code ${exitCode}`);
		return exitCode;
	}
	return 0;
}

export function run(options) {
	const files = discoverTestFiles(options.root).filter(
		(file) => options.suite === "all" || classifyTestFile(file) === options.suite,
	);
	if (options.list) {
		for (const file of files) console.log(file);
		return 0;
	}

	for (const file of files) {
		const absoluteFile = resolve(options.root, file);
		const args = ["--experimental-strip-types", "--test", absoluteFile];
		if (GC_TESTS.has(file)) args.unshift("--expose-gc");
		const exitCode = runChild(file, process.execPath, args, ISOLATED_CWD_TESTS.has(file) ? undefined : REPOSITORY_ROOT);
		if (exitCode !== 0) return exitCode;
	}

	const includeMemory = !options.skipMemory && (options.suite === "all" || options.suite === "unit");
	if (includeMemory) {
		const bundledNpmCli = resolve(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
		const npmCli = process.env.npm_execpath || (existsSync(bundledNpmCli) ? bundledNpmCli : undefined);
		const npmCommand = npmCli ? process.execPath : "npm";
		const npmArguments = npmCli
			? [npmCli, "test", "--workspace", "@super-pi/memory"]
			: ["test", "--workspace", "@super-pi/memory"];
		const exitCode = runChild(
			"@super-pi/memory workspace",
			npmCommand,
			npmArguments,
			REPOSITORY_ROOT,
		);
		if (exitCode !== 0) return exitCode;
	}

	if (files.length === 0 && !includeMemory) console.log(`[test] no ${options.suite} tests discovered`);
	return 0;
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
	try {
		process.exitCode = run(parseArguments(process.argv.slice(2)));
	} catch (error) {
		console.error(`[test] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
