import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateMetadata } from "../scripts/acceptance/windows-sandbox-clipboard-formats.mjs";

function report(formats = []) {
	return { protocol: "super-pi-wsb-clipboard-formats-v1", status: "complete", enumerationLimit: 64, acceptanceCountLimit: 5,
		sequenceBefore: 10, sequenceAfter: 10, ownerBefore: "123", ownerAfter: "123", sessionId: 1,
		count: formats.length, countClass: !formats.length ? "empty" : formats.length > 5 ? "over-acceptance-count" : "within-acceptance-count",
		enumerationComplete: true, namesComplete: true, metadataStable: true, opened: true, closed: true, error: null, cleanupError: null, formats };
}
function format(id, name) { return { id, registeredName: name ?? null, nameStatus: name ? "resolved" : "not-registered", nameError: 0 }; }
test("metadata diagnostic distinguishes empty, excess, unknown and incomplete enumeration without granting acceptance", () => {
	assert.equal(validateMetadata(report()).countClass, "empty");
	const six = report([format(13), format(16), format(1), format(7), format(0xC010, "DataObject"), format(0xC011, "Unknown")]);
	assert.equal(validateMetadata(six).count, 6); assert.equal(six.countClass, "over-acceptance-count"); assert.equal(six.formats[5].registeredName, "Unknown");
	const partial = { ...six, status: "enumeration-failed", enumerationComplete: false, namesComplete: false, count: null, countClass: "unknown", error: "EnumClipboardFormats:5" };
	assert.equal(validateMetadata(partial).count, null);
	assert.throws(() => validateMetadata({ ...partial, count: 6 }));
	assert.throws(() => validateMetadata({ ...partial, status: "complete" }));
	assert.throws(() => validateMetadata({ ...partial, namesComplete: true }));
	assert.throws(() => validateMetadata({ ...six, countClass: "within-acceptance-count" }));
	assert.throws(() => validateMetadata({ ...six, acceptanceCountLimit: 6 }));
	assert.throws(() => validateMetadata({ ...six, metadataStable: false }));
	assert.throws(() => validateMetadata({ ...six, sequenceAfter: 11 }));
	assert.throws(() => validateMetadata({ ...six, ownerAfter: "124" }));
	assert.throws(() => validateMetadata({ ...six, cleanupError: "CloseClipboard:5" }));
	const closeFailed = { ...six, status: "close-failed", closed: false, cleanupError: "CloseClipboard:5" };
	assert.equal(validateMetadata(closeFailed).count, 6); // Keep metadata but never claim diagnostic success after cleanup failure.
	const duplicate = report([format(13), format(13)]); assert.throws(() => validateMetadata(duplicate));
	const unavailable = report([{ id: 0xC010, registeredName: null, nameStatus: "failed", nameError: 5 }]);
	unavailable.status = "name-unavailable"; unavailable.namesComplete = false; assert.equal(validateMetadata(unavailable).count, 1);
	assert.throws(() => validateMetadata({ ...unavailable, namesComplete: true }));
	assert.throws(() => validateMetadata(report([format(13, "DataObject")])));
	assert.throws(() => validateMetadata(report([format(0xC010, "x".repeat(255))])));
	const capped = report(Array.from({ length: 64 }, (_, index) => format(0xC000 + index, "Format" + index)));
	assert.equal(validateMetadata(capped).count, 64); capped.formats.push(format(0xC100, "Overflow")); assert.throws(() => validateMetadata(capped));
});
test("metadata executable exposes only reviewed metadata APIs and preserves acceptance limits", () => {
	const source = fs.readFileSync(new URL("../scripts/acceptance/windows-sandbox-clipboard-formats.cs", import.meta.url), "utf8");
	const imports = [...source.matchAll(/static extern \w+ (\w+)\(/g)].map(match => match[1]).sort();
	assert.deepEqual(imports, ["OpenClipboard", "CloseClipboard", "EnumClipboardFormats", "GetClipboardFormatNameW", "GetClipboardSequenceNumber", "GetClipboardOwner",
		"GetProcessWindowStation", "GetThreadDesktop", "GetCurrentThreadId", "SetLastError", "OpenInputDesktop", "CloseDesktop", "GetUserObjectInformationW"].sort());
	assert.doesNotMatch(source, /GetClipboardData|EmptyClipboard|SetClipboardData|OleGetClipboard|GlobalLock|GlobalSize/);
	assert.match(source, /enumerationLimit = 64, acceptanceCountLimit = 5/);
});
