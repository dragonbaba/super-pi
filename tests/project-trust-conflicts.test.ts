import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { CONFIG_DIR_NAME, getConfigDir } from "../packages/coding-agent/src/config.ts";
import { resolveProjectTrusted, type ResolveProjectTrustedOptions } from "../packages/coding-agent/src/core/project-trust.ts";
import { ProjectTrustConflictError, ProjectTrustStore } from "../packages/coding-agent/src/core/trust-manager.ts";
import { InteractiveMode } from "../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

function fixture(t: TestContext, resources: boolean) {
	const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "sp-trust-conflict-")));
	t.diagnostic(`ownedFixture=${root}`);
	t.after(() => removeOwnedFixture(root));
	const cwd = join(root, "Project"), agentDir = join(root, "Agent");
	fs.mkdirSync(cwd);
	if (resources) fs.mkdirSync(join(cwd, CONFIG_DIR_NAME, "extensions"), { recursive: true });
	const store = new ProjectTrustStore(agentDir);
	const options: ResolveProjectTrustedOptions = {
		cwd, trustStore: store, defaultProjectTrust: "always",
		projectTrustContext: { cwd, mode: "rpc", hasUI: false,
			ui: { select: async () => { assert.fail("unexpected UI"); }, confirm: async () => false, input: async () => undefined, notify: () => {} } },
	};
	return { root, cwd, agentDir, store, options };
}

for (const resources of [false, true]) {
	test(`trust conflicts deny without UI even with default always; resources=${resources}`, async t => {
		const f = fixture(t, resources);
		t.mock.method(f.store, "get", () => { throw new ProjectTrustConflictError(f.cwd); });
		assert.equal(await resolveProjectTrusted(f.options), false);
	});
	for (const selected of ["Trust", "Do not trust", undefined]) {
		test(`trust conflict UI permits explicit ${selected ?? "cancel"}; resources=${resources}`, async t => {
			const f = fixture(t, resources);
			t.mock.method(f.store, "get", () => { throw new ProjectTrustConflictError(f.cwd); });
			let prompts = 0;
			f.options.projectTrustContext.hasUI = true;
			f.options.projectTrustContext.ui.select = async (title, choices) => {
				prompts++; assert.match(title, /Conflicting trust decisions/); assert.ok(title.includes(f.cwd));
				assert.ok(choices.includes("Trust") && choices.includes("Do not trust")); return selected;
			};
			assert.equal(await resolveProjectTrusted(f.options), selected === "Trust");
			assert.equal(prompts, 1);
			assert.equal(f.store.getEntry(f.cwd)?.decision ?? null, selected === undefined ? null : selected === "Trust");
		});
	}
}

test("the actual /trust entry opens a conflict selector and saves an explicit decision", t => {
	const f = fixture(t, true); initTheme("dark");
	const originalGet = ProjectTrustStore.prototype.getEntry;
	t.mock.method(ProjectTrustStore.prototype, "getEntry", () => { throw new ProjectTrustConflictError(f.cwd); });
	let opened = 0, closed = 0, status = "";
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { services: { agentDir: f.agentDir }, session: { sessionManager: { getCwd: () => f.cwd }, settingsManager: { isProjectTrusted: () => false } } },
		showSelector: (build: (done: () => void) => { component: { render: (width: number) => string[]; handleInput: (key: string) => void } }) => {
			opened++; const { component } = build(() => { closed++; });
			assert.match(component.render(160).join("\n"), /Conflicting trust decisions/);
			component.handleInput("\n");
		},
		showStatus: (message: string) => { status = message; },
	});
	mode.showTrustSelector();
	assert.equal(opened, 1); assert.equal(closed, 1); assert.match(status, /Saved trust decision: trusted/);
	assert.equal(originalGet.call(f.store, f.cwd)?.decision, true);
});

test("a real Windows alias conflict is repaired through the startup choice", { skip: process.platform !== "win32" }, async t => {
	const f = fixture(t, true), trustPath = join(getConfigDir(f.agentDir), "trust.json");
	fs.mkdirSync(getConfigDir(f.agentDir), { recursive: true });
	fs.writeFileSync(trustPath, JSON.stringify({ [f.cwd.toUpperCase()]: true, [f.cwd.toLowerCase()]: false }));
	f.options.projectTrustContext.hasUI = true;
	f.options.projectTrustContext.ui.select = async () => "Do not trust";
	assert.equal(await resolveProjectTrusted(f.options), false);
	assert.deepEqual(JSON.parse(fs.readFileSync(trustPath, "utf8")), { [f.cwd]: false });
	assert.equal(f.store.get(f.cwd), false);
});
