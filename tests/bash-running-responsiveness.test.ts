import test from "node:test";
import { runBashResponsiveness } from "./helpers/bash-responsiveness-fixture.ts";

for (const scenario of ["short", "long", "output-then-quiet", "off-tail"] as const) {
	test(`offline SDK Bash remains scrollable during ${scenario}`, { timeout: 20_000 }, async t => {
		const result = await runBashResponsiveness(scenario);
		t.diagnostic(JSON.stringify(result));
	});
}

for (const termination of ["failure", "abort"] as const) {
	test(`offline SDK shell ${termination} stops timers and releases rendering owners`, { timeout: 20_000 }, async t => {
		t.diagnostic(JSON.stringify(await runBashResponsiveness("short", undefined, termination)));
	});
}
