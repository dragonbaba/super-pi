// Only metadata is created; no shell or model task is executed by this fixture.
import { SubagentTasks } from "../../packages/extensions/subagent/tasks.ts";
import { dirname } from "node:path";
const file = process.argv[2];
const tasks = new SubagentTasks(8);
tasks.configureHistory({ file, id: "fixture-session", cwd: dirname(file) }, "subagent");
const ids = {};
for (const state of ["completed", "failed", "cancelled", "running", "queued"]) {
	const task = tasks.create("scout", dirname(file), "branch-a");
	ids[state] = task.id;
	if (state !== "queued") tasks.start(task);
	if (state === "cancelled") tasks.cancel(task.id);
	if (!["running", "queued"].includes(state)) tasks.finish(task, `terminal ${state}`, state === "failed");
}
process.stdout.write(JSON.stringify(ids));
// Deliberately skip disposal. The next process must recover only observations.
process.exitCode = 0;
