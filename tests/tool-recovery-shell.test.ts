import assert from "node:assert/strict";
import test from "node:test";
import { inspectBashResourceLifecycle } from "../packages/extensions/resource-lifecycle-guard/core.ts";
import { inspectBashPermissionScope } from "../packages/extensions/resource-lifecycle-guard/permission-bash.ts";

// Inspection only: these strings must never be passed to a shell or browser.
export const chromeCommands = [String.raw`CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
for p in 0 0.4 0.8 1.2; do
  node pelican-on-bicycle.gen.js --out=_dbg_$p.html --phase=$p >/dev/null
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1240,880 \
    --virtual-time-budget=1200 --screenshot=_dbg_$p.png "file:///fixture/_dbg_$p.html" >/dev/null 2>&1
done
ls -la _dbg_*.png`, String.raw`CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"; "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1240,880 --virtual-time-budget=1200 --screenshot=_dbg_0.png "file:///fixture/_dbg_0.html" 2>&1 | tail -3; ls -la _dbg_0.png`];

for (const [index, command] of chromeCommands.entries()) test(`Chrome structure ${index}: executable expansion stays opaque for authorization`, () => {
 assert.equal(inspectBashResourceLifecycle({ command }), undefined);
 assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
});
test("literal spaced executable and dynamic data keep the original allow decision", () => {
 for (const command of [String.raw`"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless`, 'printf "%s" "$CHROME"', 'echo "$CHROME"; node fixture.js --phase=$p']) {
  assert.equal(inspectBashResourceLifecycle({ command }), undefined, command);
 }
});
test("specific refusal classes retain conservative decisions without unrelated heredoc advice", () => {
 for (const [command, code] of [['bash script.sh', 'SHELL_WRAPPER'], ['bash -c "$SCRIPT"', 'SHELL_WRAPPER'], ['echo "$(time echo x)"', 'SHELL_SUBSTITUTION']]) {
  const failure = inspectBashResourceLifecycle({ command })!;
  assert.ok(failure.startsWith(`[${code}]`), failure);
  if (code !== 'SHELL_HEREDOC') assert.doesNotMatch(failure, /heredoc/i);
 }
 for (const command of ['cat <<EOF\ntext\nEOF', 'echo $((1 << 2)']) {
  assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
 }
});
