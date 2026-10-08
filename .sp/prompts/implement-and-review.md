---
description: Scoped implementation and review, with a fix only for actionable findings
---
Implement and review: $@

Give worker a scoped implementation task, then reviewer the resulting diff and verification evidence. Keep these dependent steps sequential; use readOnly: true for the reviewer. Inspect the review result before assigning any further worker task. If there are no actionable findings, stop. If findings exist, assign only the specific fixes and relevant verification; do not schedule an unconditional second worker.

Every subagent item requires task, scope, deliverable and stopCondition. Name owned files/subsystem and exclusions, supply existing evidence, require a concise verifiable result, and stop on completion or a blocker. Reuse successful prior work and checks.
