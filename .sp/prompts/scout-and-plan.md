---
description: Resolve missing evidence and return a scoped implementation plan
---
Plan without implementing: $@

Reuse existing context. If evidence is missing, delegate only that question to scout with readOnly: true, then pass the relevant findings to planner. Otherwise call planner directly. Use a sequential chain only when the plan depends on new findings.

Every subagent item requires task, scope, deliverable and stopCondition. Give exact files/subsystem, a concrete question or plan requirement, concise evidence locations and an observable completion condition. Stop at the plan or report the missing decision; do not implement or request redundant scouting.
