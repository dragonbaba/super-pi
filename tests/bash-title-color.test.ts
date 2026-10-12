import assert from "node:assert/strict";
import test from "node:test";
import { RELEASE_COMPONENT_RENDER_CACHE, type TUI } from "@super-pi/tui";
import { BashExecutionComponent } from "../packages/coding-agent/src/modes/interactive/components/bash-execution.ts";
import { initTheme, theme } from "../packages/coding-agent/src/modes/interactive/theme/theme.ts";

for (const excluded of [false, true]) {
	test(`${excluded ? "excluded" : "ordinary"} shell title keeps its color through updates and release`, () => {
		for (const outcome of ["success", "error", "cancel"] as const) {
			initTheme("dark", false);
			const component = new BashExecutionComponent("fixture", { requestRender() {} } as TUI, excluded);
			try {
				const check = () => {
					const expected = theme.fg(excluded ? "dim" : "bashMode", theme.bold("$ fixture"));
					assert.ok(component.render(80).some(line => line.includes(expected)), `${outcome}: expected title color`);
				};
				check();
				component.appendOutput("fixture output\n");
				check();
				component.setComplete(outcome === "error" ? 1 : 0, outcome === "cancel");
				check();
				component.setExpanded(true);
				component.setOutputPad(0);
				check();
				initTheme("light", false);
				component.invalidate();
				check();
				component[RELEASE_COMPONENT_RENDER_CACHE]();
				check();
				assert.equal(component.getOutput(), "fixture output\n");
			} finally {
				component[RELEASE_COMPONENT_RENDER_CACHE]();
				initTheme("dark", false);
			}
		}
	});
}
