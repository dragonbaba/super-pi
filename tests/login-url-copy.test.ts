import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import ts from "typescript";
import { getKeybindings, setKeybindings, type TUI } from "@super-pi/tui";
import { KeybindingsManager, type KeybindingsConfig } from "../packages/coding-agent/src/core/keybindings.ts";
import { LoginDialogComponent } from "../packages/coding-agent/src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";

const device = { verificationUri: "https://example.invalid/device", userCode: "FIXTURE" };
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function dialog(t: TestContext, copy: (text: string) => Promise<void>, bindings: KeybindingsConfig = {}) {
	initTheme("dark", false);
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager(bindings));
	const value = new LoginDialogComponent({ requestRender() {} } as TUI, "fixture", () => {}, undefined, undefined, copy);
	t.after(() => { value.cancel(); setKeybindings(previous); });
	return value;
}
function rendered(value: LoginDialogComponent): string { return value.render(160).join("\n"); }

test("browser login copies its URL with the configured copy key without opening a real browser", async t => {
	const launched: string[] = [];
	const launcher = t.mock.method(childProcess, "spawn", ((_cmd: string, args: string[]) => {
		launched.push(args[args.length - 1]!);
		return Object.assign(new EventEmitter(), { unref() {} });
	}) as typeof childProcess.spawn);
	syncBuiltinESMExports();
	t.after(() => { launcher.mock.restore(); syncBuiltinESMExports(); });
	const copied: string[] = [];
	const value = dialog(t, async text => { copied.push(text); }, { "app.message.copy": "ctrl+y" });
	const url = "https://example.invalid/authorize?state=fixture";
	value.showAuth(url);
	assert.deepEqual(launched, [url]);
	assert.match(rendered(value), /copy login URL/);
	value.handleInput("\x18");
	assert.deepEqual(copied, []);
	value.handleInput("\x19");
	await settle();
	assert.deepEqual(copied, [url]);
	assert.match(rendered(value), /Login URL copied/);
});

test("device login keeps manual input intact while copying the verification URL", async t => {
	const copied: string[] = [];
	const value = dialog(t, async text => { copied.push(text); });
	value.showDeviceCode(device);
	const input = value.showManualInput("Code");
	value.handleInput("fixture-code");
	value.handleInput("\x18");
	await settle();
	value.handleInput("\r");
	assert.equal(await input, "fixture-code");
	assert.deepEqual(copied, [device.verificationUri]);
});

test("copy failure stays in the login dialog and a later attempt can succeed", async t => {
	let calls = 0;
	const value = dialog(t, async () => { if (++calls === 1) throw new Error("clipboard unavailable"); });
	value.showDeviceCode(device);
	value.handleInput("\x18");
	await settle();
	assert.match(rendered(value), /Could not copy login URL/);
	assert.equal(value.signal.aborted, false);
	value.handleInput("\x18");
	await settle();
	assert.match(rendered(value), /Login URL copied/);
	assert.equal(calls, 2);
});

test("copy repeats are coalesced and cancellation ignores late completion", async t => {
	let finish!: () => void;
	const pending = new Promise<void>(resolve => { finish = resolve; });
	let calls = 0;
	const value = dialog(t, () => { calls++; return pending; });
	value.showDeviceCode(device);
	value.handleInput("\x18");
	value.handleInput("\x18");
	assert.equal(calls, 1);
	value.cancel();
	finish();
	await settle();
	value.handleInput("\x18");
	assert.equal(calls, 1);
	assert.doesNotMatch(rendered(value), /Login URL copied/);
});

test("replaced authorization URLs do not receive feedback from an older copy", async t => {
	let finish!: () => void;
	const pending = new Promise<void>(resolve => { finish = resolve; });
	const copied: string[] = [];
	const value = dialog(t, text => { copied.push(text); return copied.length === 1 ? pending : Promise.resolve(); });
	value.showDeviceCode(device);
	value.handleInput("\x18");
	value.showDeviceCode({ ...device, verificationUri: "https://example.invalid/new-device" });
	finish();
	await settle();
	assert.doesNotMatch(rendered(value), /Login URL copied/);
	value.handleInput("\x18");
	await settle();
	assert.deepEqual(copied, [device.verificationUri, "https://example.invalid/new-device"]);
});

test("details replacement and login completion release the copy target", async t => {
	const copied: string[] = [];
	const value = dialog(t, async text => { copied.push(text); });
	value.handleInput("\x18");
	value.showDeviceCode(device);
	value.showDetails(["Choose a different method"]);
	value.handleInput("\x18");
	value.showDeviceCode(device);
	value.clearAuthUrl();
	value.handleInput("\x18");
	await settle();
	assert.deepEqual(copied, []);
});

test("ordinary login input stays synchronous and copy feedback owns one bounded hint", () => {
	const path = "packages/coding-agent/src/modes/interactive/components/login-dialog.ts";
	const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
	const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "LoginDialogComponent") as ts.ClassDeclaration;
	const input = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === "handleInput") as ts.MethodDeclaration;
	assert.ok(input);
	assert.equal(input.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false, false);
	const forbidden: string[] = [];
	function visit(node: ts.Node): void {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isNewExpression(node) || ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) forbidden.push(node.getText(source));
		ts.forEachChild(node, visit);
	}
	visit(input);
	assert.deepEqual(forbidden, []);
	const copy = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === "copyAuthUrl")!;
	assert.doesNotMatch(copy.getText(source), /addChild|new Text|setTimeout|setInterval/);
});
