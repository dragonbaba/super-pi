import assert from "node:assert/strict";
import test from "node:test";
import { inspectBashResourceLifecycle, isBlockingLifecycleReason } from "../packages/extensions/resource-lifecycle-guard/core.ts";
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
test("uninspectable shell forms remain opaque without a lifecycle block", () => {
 for (const command of ['bash script.sh', 'bash -c "$SCRIPT"', 'echo "$(time echo x)"']) {
  const reason = inspectBashResourceLifecycle({ command });
  assert.ok(reason); assert.equal(isBlockingLifecycleReason(reason), false);
  assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
 }
 for (const command of ['cat <<EOF\ntext\nEOF', 'echo $((1 << 2)']) {
  assert.equal(inspectBashPermissionScope({ command }, process.cwd())?.kind, "opaque-script");
 }
});
