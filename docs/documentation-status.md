# Documentation status

Current behavior is defined by [execution environments](execution-environments.md),
the root READMEs, the launcher and production source. Current verification
commands live in [testing](testing.md); MXC uses PowerShell 7 and directly
accesses authorized workspaces in two sandbox modes. Three other modes use host tools.

| Material | Status |
| --- | --- |
| Execution environments, building, testing, package API references | Current; check against source when changing behavior |
| MXC migration and route evidence | Delivered history; evidence for the recorded revision |
| Windows Sandbox VM plans and evidence | Retired history; see the archived acceptance suite below |
| CodeMode R1–R5, OpenCode OC, upstream V/F and PF external acceptance | Mixed plans and evidence; verify individual items before marking complete |

## Windows Sandbox VM retirement

The former VM launchers, acceptance tests, fixtures and test-runner routing
have been removed from the current tree. The last revision containing the
[acceptance source](https://github.com/dragonbaba/super-pi/tree/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/scripts/acceptance)
and [test fixtures](https://github.com/dragonbaba/super-pi/tree/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/tests)
is `b9843f859`. Evidence and old design documents retain their historical
paths, commands and section anchors. For current commands see [testing](testing.md).
