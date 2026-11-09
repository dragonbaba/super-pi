// §64: read-only routing acceptance. Never imports or executes a preserved test.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { classifyTestFile, discoverTestFiles, run, testFileArguments } from "../scripts/test.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const preserved = [
    ["windows-sandbox-captured-host-write.test.mjs", "AB3C290371E1B450E1A4F216116C7C11D456276FFB6D29377A7F6487355FC15C"],
    ["windows-sandbox-explicit-write-snapshot.test.mjs", "A98372F9004603176FD77548B2EB002E33E555EF59762172DAFD3827BEC952D0"],
    ["windows-sandbox-input-capture.test.mjs", "4D88C5FD13ADF11A83A74B1835A0FF338ED2B2EEC3BD3830BC0EDD081DE4DC08"],
    ["windows-sandbox-input-read-preparation.test.mjs", "AC81C76B5A8E069A953F9987B5CB563D3E0409EAEBCE3E9F437FDFDEA3DACF39"],
    ["windows-sandbox-input-revision-lease.test.mjs", "210BFFAAD80E4BCC3A5C16288A3AF950D324D7BA780D2921517BB2D148516E98"],
    ["windows-sandbox-input-session-source.test.mjs", "A33097217FFBB7EBD8EE18DE69E49AA48A0186E3975C8C644D5B8FDACF47D3F2"],
    ["windows-sandbox-input-workspace-grant.test.mjs", "6912352D3955DD2FCA4551EA183319E008A771E470DF2CBB741FB7EF6D430DEA"],
    ["windows-sandbox-issued-workspace-source.test.mjs", "6547A7E94069F93DECF9143589C745E74D93C0887785EC286E0670A1543A10E4"],
    ["windows-sandbox-source-reader.test.mjs", "6E1A994911CF8513D33B528D5C3E8356FD44C6084039E078CF7E5633CDA4F15C"],
    ["windows-sandbox-volume-candidate-cmd.test.mjs", "9AE3C1B4A0B99B1BD59208681123A6B59BCACFC67576178247AE9F760770B064"],
    ["windows-sandbox-volume-candidate-identity.test.mjs", "BE98F48C38FBE263D783F86D210983A527AD07CD5C4101DBFEB93FAD2779A2CE"],
    ["windows-sandbox-workspace-grant-identity.test.mjs", "AA7B6AA18F14A70F72BAF62E8606A598DFC29A287B60F3092831283D5CB981DD"],
    ["windows-sandbox-workspace-input-capture.test.mjs", "60FD22AAA972DD5105632C20DE73157E922A7132E483A687D2B557DB40C95490"],
    ["windows-sandbox-workspace-source-reader.test.mjs", "3D7D2AB33BE0335693B9784EF056AADF326927F01A50BAEC4242DBC48AB411C9"],
];
test("ordinary suites retain model regressions and never replay frozen manual acceptance", { timeout: 30000 }, async () => {
    const discovered = discoverTestFiles(root), names = preserved.map(([name]) => name);
    assert.deepEqual(discovered.filter(name => classifyTestFile(name) === "manual"), names);
    let readBytes = 0;
    for (const [name, expected] of preserved) {
        const file = resolve(root, name), stat = lstatSync(file);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536);
        readBytes += stat.size; assert.ok(readBytes <= 1048576);
        assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase(), expected);
        assert.equal(classifyTestFile("nested/" + name), "unit", "no basename-wide exclusion");
    }
    assert.equal(classifyTestFile("windows-sandbox-new-model.test.mjs"), "unit");
    assert.equal(classifyTestFile("windows-sandbox-candidate-write-batch.test.mjs"), "unit");
    const selected = {}, originalLog = console.log;
    for (const suite of ["all", "unit", "hot", "contract", "manual"]) {
        const lines = [];
        console.log = line => { assert.equal(typeof line, "string"); assert.ok(lines.length < 4096); lines.push(line); };
        try { assert.equal(await run({ root, suite, list: true, skipMemory: true, jobs: 1, shard: { index: 1, count: 1 } }), 0); }
        finally { console.log = originalLog; }
        const expected = discovered.filter(name => {
            const group = classifyTestFile(name);
            return group !== "manual" && (suite === "all" || group === suite);
        });
        assert.deepEqual(lines, expected);
        assert.ok(names.every(name => !lines.includes(name)));
        selected[suite] = lines;
    }
    assert.deepEqual([...selected.unit, ...selected.hot, ...selected.contract].sort(), selected.all);
    const sandbox = discovered.filter(name => name.startsWith("windows-sandbox-"));
    const automaticSandbox = sandbox.filter(name => !names.includes(name));
    assert.ok(automaticSandbox.length >= 40);
    assert.ok(automaticSandbox.every(name => selected.all.includes(name)));
    const gcNames = ["alpha-assistant-update.test.ts", "alpha-markdown-ownership.test.ts",
        "alpha-raw-parallel.test.ts", "alpha-startup-quit.test.ts", "tui-transcript-selection-reset.test.ts",
        "windows-sandbox-candidate-write-batch.test.mjs"];
    for (const name of gcNames) assert.deepEqual(testFileArguments(name, root),
        ["--expose-gc", "--experimental-strip-types", "--test", resolve(root, name)]);
    assert.deepEqual(testFileArguments("windows-sandbox-input-snapshot.test.mjs", root),
        ["--experimental-strip-types", "--test", resolve(root, "windows-sandbox-input-snapshot.test.mjs")]);
    const line = JSON.stringify({ preserved: names.length, readBytes, lists: Object.keys(selected).length,
        discovered: discovered.length, automatic: selected.all.length,
        automaticSandbox: automaticSandbox.length, manualSelected: selected.manual.length, gcArguments: gcNames.length });
    assert.ok(Buffer.byteLength(line) < 1024); console.log(line);
});
