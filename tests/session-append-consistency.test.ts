import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { removeOwnedFixture } from "./helpers/owned-fixture-cleanup.ts";

const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const failure = new Error("injected session write failure");
const uncertain = /write outcome is uncertain/i;

function withSession(run: (manager: SessionManager, file: string, root: string) => void, fresh = false): void {
	const root = fs.mkdtempSync(join(tmpdir(), "pi-append-consistency-"));
	try {
		const manager = SessionManager.create(root, join(root, "sessions"));
		if (!fresh) manager.appendMessage(user("acknowledged"));
		run(manager, manager.getSessionFile()!, root);
	} finally { removeOwnedFixture(root); }
}

function withFs(patch: Partial<typeof fs>, run: () => void): void {
	const original = Object.fromEntries(Object.keys(patch).map(key => [key, fs[key as keyof typeof fs]]));
	Object.assign(fs, patch);
	syncBuiltinESMExports();
	try { run(); } finally { Object.assign(fs, original); syncBuiltinESMExports(); }
}

function snapshot(manager: SessionManager) {
	return {
		entries: manager.getEntries(), count: manager.getEntryCount(), leaf: manager.getLeafId(),
		index: [...(manager as unknown as { byId: Map<string, unknown> }).byId],
		context: manager.buildSessionContext(),
	};
}

test("first flush failure before installation rolls back and releases its temporary file", () => withSession((manager, file, root) => {
	manager.appendModelChange("fixture", "fixture");
	const before = snapshot(manager);
	withFs({ linkSync: () => { throw failure; } }, () => {
		assert.throws(() => manager.appendMessage(user("failed first prompt")), error => error === failure);
	});
	assert.deepEqual(snapshot(manager), before);
	assert.equal(fs.existsSync(file), false);
	assert.deepEqual(fs.readdirSync(dirname(file)), []);
	manager.appendMessage(user("retry"));
	assert.deepEqual(SessionManager.open(file, root).getEntries(), manager.getEntries());
	assert.equal(fs.readFileSync(file, "utf8").includes("failed first prompt"), false);
}, true));

test("installed first flush with failed cleanup requires reload of the actual file", () => withSession((manager, file, root) => {
	const unlink = fs.unlinkSync;
	let injected = false;
	withFs({ unlinkSync: path => {
		if (!injected) { injected = true; throw failure; }
		unlink(path);
	} }, () => assert.throws(() => manager.appendMessage(user("installed")), error => error === failure));
	assert.equal(manager.getEntryCount(), 0);
	assert.equal(fs.readdirSync(dirname(file)).length, 1);
	assert.throws(() => manager.ensureOperationStorage(), uncertain);
	assert.throws(() => manager.appendMessage(user("blocked")), uncertain);
	manager.setSessionFile(file);
	assert.equal(manager.getEntryCount(), 1);
	const installed = manager.getLeafId();
	const next = manager.appendMessage(user("after reload"));
	assert.equal(manager.getEntry(next)?.parentId, installed);
}, true));

const appenders: Record<string, (manager: SessionManager, target: string) => string> = {
	message: manager => manager.appendMessage(user("failed")),
	model: manager => manager.appendModelChange("fixture", "new"),
	thinking: manager => manager.appendThinkingLevelChange("high"),
	compaction: (manager, target) => manager.appendCompaction("summary", target, 100),
	custom: manager => manager.appendCustomEntry("fixture", { value: 1 }),
	info: manager => manager.appendSessionInfo("failed name"),
	customMessage: manager => manager.appendCustomMessageEntry("fixture", "failed", true),
	label: (manager, target) => manager.appendLabelChange(target, "changed"),
	branchSummary: (manager, target) => manager.branchWithSummary(target, "failed branch"),
};
for (const [name, append] of Object.entries(appenders)) {
	test(`${name}: real open failure preserves the tree and permits a later explicit append`, () => withSession((manager, file) => {
		const target = manager.getLeafId()!;
		manager.appendLabelChange(target, "original");
		manager.appendMessage(user("current leaf differs from branch target"));
		const before = snapshot(manager), bytes = fs.readFileSync(file);
		// A directory itself can be opened on Windows. A missing parent forces
		// failure at open, before a descriptor or write exists, on both platforms.
		const directory = dirname(file), saved = `${directory}.saved`;
		fs.renameSync(directory, saved);
		try { assert.throws(() => append(manager, target)); }
		finally { fs.renameSync(saved, directory); }
		assert.deepEqual(snapshot(manager), before);
		assert.equal(manager.getLabel(target), "original");
		assert.deepEqual(fs.readFileSync(file), bytes);
		const id = append(manager, target);
		assert.equal(manager.getLeafId(), id);
		assert.deepEqual(SessionManager.open(file).getEntries(), JSON.parse(JSON.stringify(manager.getEntries())));
	}));
}

test("serialization failure does not even write the missing separator", () => withSession((manager, file) => {
	fs.writeFileSync(file, fs.readFileSync(file, "utf8").trimEnd());
	manager.setSessionFile(file);
	const before = snapshot(manager), bytes = fs.readFileSync(file);
	assert.throws(() => manager.appendCustomEntry("invalid", 1n), /BigInt/);
	assert.deepEqual(snapshot(manager), before);
	assert.deepEqual(fs.readFileSync(file), bytes);
	manager.appendMessage(user("valid"));
	assert.equal(fs.readFileSync(file, "utf8").startsWith(`${bytes.toString()}\n{`), true);
	assert.equal(SessionManager.open(file).getEntryCount(), 2);
}));

for (const closeFailure of [false, true]) {
	test(`partial write releases fd and blocks all writes (close also fails: ${closeFailure})`, () => withSession((manager, file) => {
		const before = snapshot(manager), bytes = fs.readFileSync(file, "utf8");
		const write = fs.writeFileSync, close = fs.closeSync;
		let fd: number | undefined, closes = 0;
		withFs({
			writeFileSync: (target, data, options) => {
				if (typeof target === "number") fd = target;
				write(target, String(data).slice(0, 24), options);
				throw failure;
			},
			closeSync: target => { closes++; close(target); if (closeFailure) throw new Error("secondary close failure"); },
		}, () => assert.throws(() => manager.appendMessage(user("partial")), error => error === failure));
		assert.equal(closes, 1);
		assert.throws(() => fs.fstatSync(fd!), { code: "EBADF" });
		assert.deepEqual(snapshot(manager), before);
		const partial = fs.readFileSync(file, "utf8");
		assert.equal(partial.startsWith(bytes), true);
		assert.equal(partial.length, bytes.length + 24);
		assert.throws(() => manager.appendMessage(user("blocked")), uncertain);
		assert.throws(() => manager.ensureOperationStorage(), uncertain);
		assert.throws(() => manager.createBranchedSession(before.leaf!), uncertain);
		assert.deepEqual(snapshot(manager), before);
		assert.equal(fs.readFileSync(file, "utf8"), partial);
		manager.setSessionFile(file);
		assert.equal(manager.getEntryCount(), before.count);
		const id = manager.appendMessage(user("after reload"));
		assert.equal(manager.getEntry(id)?.parentId, before.leaf);
		assert.equal(fs.readFileSync(file, "utf8").startsWith(`${partial}\n{`), true);
		assert.deepEqual(SessionManager.open(file).getEntries(), manager.getEntries());
	}));
}

test("close failure after full write recovers the committed record on explicit reload", () => withSession((manager, file) => {
	const before = snapshot(manager), close = fs.closeSync;
	let closes = 0;
	withFs({ closeSync: fd => { closes++; close(fd); throw failure; } }, () => {
		assert.throws(() => manager.appendMessage(user("written")), error => error === failure);
	});
	assert.equal(closes, 1);
	assert.deepEqual(snapshot(manager), before);
	assert.throws(() => manager.appendMessage(user("blocked")), uncertain);
	manager.setSessionFile(file);
	assert.equal(manager.getEntryCount(), before.count + 1);
	const recovered = manager.getLeafId();
	const next = manager.appendMessage(user("next"));
	assert.equal(manager.getEntry(next)?.parentId, recovered);
}));

test("failed reload retains the write barrier; a new session explicitly retires it", () => withSession((manager, file, root) => {
	withFs({ writeFileSync: () => { throw failure; } }, () => {
		assert.throws(() => manager.appendMessage(user("uncertain")), error => error === failure);
	});
	const invalid = join(root, "invalid.jsonl");
	fs.writeFileSync(invalid, "not a session");
	assert.throws(() => manager.setSessionFile(invalid), /not a valid/);
	assert.throws(() => manager.appendMessage(user("blocked")), uncertain);
	manager.newSession();
	assert.notEqual(manager.getSessionFile(), file);
	manager.appendMessage(user("new owner"));
	assert.equal(manager.getEntryCount(), 1);
}));
