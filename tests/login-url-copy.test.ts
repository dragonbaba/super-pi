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
import { openBrowser } from "../packages/coding-agent/src/utils/open-browser.ts";

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

function mockLauncher(t: TestContext): string[] {
	const launched: string[] = [];
	const launcher = t.mock.method(childProcess, "spawn", ((_cmd: string, args: string[]) => {
		launched.push(args[args.length - 1]!);
		return Object.assign(new EventEmitter(), { unref() {} });
	}) as typeof childProcess.spawn);
	syncBuiltinESMExports();
	t.after(() => { launcher.mock.restore(); syncBuiltinESMExports(); });
	return launched;
}

test("browser login copies its URL with the configured copy key without opening a real browser", async t => {
	const launched = mockLauncher(t);
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

for (const [input, normalized] of [
	["HTTPS://Example.INVALID:443/authorize?state=a%2Bb&redirect_uri=http%3A%2F%2Flocalhost", "https://example.invalid/authorize?state=a%2Bb&redirect_uri=http%3A%2F%2Flocalhost"],
	["http://127.0.0.1:8080/login?state=%1B%07", "http://127.0.0.1:8080/login?state=%1B%07"],
] as const) test(`login URL is parsed once per event and reused for render/copy/open: ${input}`, async t => {
	const launched = mockLauncher(t);
	const parse = t.mock.method(URL, "parse");
	const copied: string[] = [];
	const value = dialog(t, async text => { copied.push(text); });
	value.showAuth(input);
	assert.deepEqual(launched, [normalized]);
	assert.ok(rendered(value).includes(normalized));
	for (let index = 0; index < 5; index++) value.render(120 + index);
	value.handleInput("x");
	value.handleInput("\x18");
	await settle();
	assert.deepEqual(copied, [normalized]);
	assert.equal(parse.mock.callCount(), 1);
	value.showDeviceCode({ ...device, verificationUri: input });
	value.handleInput("\x18");
	await settle();
	assert.deepEqual(copied, [normalized, normalized]);
	value.showInfo("Provider information", [{ label: "Account", url: input }]);
	assert.ok(rendered(value).includes(`Account: ${normalized}`));
	assert.equal(parse.mock.callCount(), 3);
	assert.deepEqual(launched, [normalized]);
});

const invalidUrls = [
	"file:///tmp/login.html", "javascript:alert(1)", "data:text/html,login", "ms-settings:privacy",
	"/login", "//example.invalid/login", "https://", "not a URL",
	...[0, 7, 9, 10, 13, 27, 31, 127, 128, 133, 155, 156, 157, 159]
		.map(code => `https://example.invalid/${String.fromCharCode(code)}login`),
];
for (const kind of ["auth", "device", "info"] as const) test(`${kind} rejects unsafe login URLs before display, copy or launch`, async t => {
	const launched = mockLauncher(t);
	const parse = t.mock.method(URL, "parse");
	const copied: string[] = [];
	const value = dialog(t, async text => { copied.push(text); });
	for (const url of invalidUrls) {
		assert.throws(() => {
			if (kind === "auth") value.showAuth(url);
			else if (kind === "device") value.showDeviceCode({ ...device, verificationUri: url });
			else value.showInfo("Provider information", [{ url }]);
		}, error => error instanceof Error && /^Login URL /.test(error.message) && !error.message.includes(url));
		assert.ok(!rendered(value).includes(url));
		value.handleInput("\x18");
	}
	await settle();
	assert.deepEqual(copied, []);
	assert.deepEqual(launched, []);
	assert.equal(parse.mock.callCount(), 8, "14 control-bearing inputs must be rejected before URL parsing");
});

const injectedText = "first\r\nsecond\x1b]52;c;ZmFrZQ==\x07\x1b[2J\x00\x08\x0b\x0c\x1b\x7f\x85\x9d";
function assertSafeText(value: LoginDialogComponent): void {
	const output = rendered(value)
		.replace(/\x1b\[[\d;]*m/g, "")
		.replace(/\x1b\]8;;[^\x00-\x1f\x7f-\x9f]*\x07/g, "")
		.replace(/\x1b_pi:\/?fc\x07/g, "");
	assert.doesNotMatch(output, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
	assert.match(output, /first[^\n]*\n[^\n]*second/);
}

test("login titles, instructions, device codes and info text cannot inject terminal controls", t => {
	mockLauncher(t);
	const value = dialog(t, async () => {});
	const title = new LoginDialogComponent({ requestRender() {} } as TUI, "fixture", () => {}, injectedText);
	t.after(() => title.cancel());
	assertSafeText(title);
	value.showAuth(device.verificationUri, injectedText);
	assertSafeText(value);
	value.showDeviceCode({ ...device, userCode: injectedText });
	assertSafeText(value);
	value.showInfo(injectedText, [{ url: device.verificationUri, label: injectedText }]);
	value.showWaiting(injectedText);
	value.showProgress(injectedText);
	assertSafeText(value);
});

test("manual and provider prompts sanitize display text without changing submitted values", async t => {
	const value = dialog(t, async () => {});
	const manual = value.showManualInput(injectedText);
	void manual.catch(() => {});
	assertSafeText(value);
	value.handleInput("manual-code");
	value.handleInput("\r");
	assert.equal(await manual, "manual-code");
	const prompt = value.showPrompt(injectedText, injectedText);
	void prompt.catch(() => {});
	assertSafeText(value);
	value.handleInput("provider-code");
	value.handleInput("\r");
	assert.equal(await prompt, "provider-code");
});

test("trusted details retain application styling and general launcher retains file support", t => {
	const launched = mockLauncher(t);
	const value = dialog(t, async () => {});
	value.showDetails(["\x1b[31mApplication-owned text\x1b[0m"]);
	assert.match(rendered(value), /\x1b\[31mApplication-owned text/);
	const file = process.platform === "win32" ? "C:\\fixture\\login.html" : "/tmp/fixture/login.html";
	openBrowser(file);
	assert.deepEqual(launched, [file]);
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
	const urlBoundaries: string[] = [];
	for (const member of owner.members) {
		if (!ts.isMethodDeclaration(member)) continue;
		function findUrlParse(node: ts.Node): void {
			if (ts.isCallExpression(node) && node.expression.getText(source) === "parseLoginUrl") {
				urlBoundaries.push(member.name!.getText(source));
			}
			ts.forEachChild(node, findUrlParse);
		}
		findUrlParse(member);
	}
	assert.deepEqual(urlBoundaries, ["showAuth", "showDeviceCode", "showInfo"]);
	assert.doesNotMatch(input.getText(source) + copy.getText(source), /parseLoginUrl|sanitizeLoginText/);
});
