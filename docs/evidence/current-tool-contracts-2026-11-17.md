# Current tool contracts after session restore

## Problem and reproduction

A restored session can contain successful calls to tools removed by a later release. The current catalog already omitted the retired command frontend, but guidance treated missing historical names as discovery candidates without a stopping rule. Searching the old full name as a capability split it into words and activated unrelated command tools. A production session fixture reproduces the distinction by running a legacy contract, removing its registration on reload, then querying its name while retaining the original history.

Separately, project refresh scanned `.task-tmp`, so retired extension snapshots and compiled caches returned as project paths. Refreshing the real repository before the correction produced 18,547 entries including 48 retired extension paths. Existing terminal bridge errors also recommended a removed structured-argv interface.

## Change

`tool_search({query:name,exact:true})` matches only the exact registered name, preserving availability, selection and browser-approval boundaries. Capability/category searches retain their existing default. A missing result guides the model to current tools and ends repeated lookup until the catalog changes; it does not claim that policy-excluded or direct-only tools do not exist. No script/shell parsing, preflight, alias, automatic replay or new execution quota is introduced.

The fixed CodeMode entry, missing-member diagnostics, documentation lookup and current usage guide now agree that catalogs/schemas determine current contracts and history is evidence. Independent work uses `batch` descriptors. A missing `tools.NAME` throws during array construction, before `Promise.all` or `Promise.allSettled` runs; an uncaught script error ends execution and cancels pending children. Completed effects remain completed.

Project scanning excludes `.task-tmp` without deleting scratch files. Refresh through the existing owner produced 4,109 entries, zero scratch paths and zero retired extension paths in the generated profile/index. Current usage documentation no longer advertises the retired name; retained probe JSON is explicitly historical. Terminal bridge recovery points to the existing script-file mechanism.

The release changes the fixed entry text once. Tool activation, catalog replacement, reload and MCP refresh still do not rewrite that prefix. Original session history and private configuration are not rewritten.

## Verification

The relevant nine-file suite passes **239 tests / 0 failures**, including restored-session history, exact lookup and catalog replacement, unavailable/policy controls, browser pause, independent reads, runtime/session lifecycle, source invariants and all-provider prefix tests. The provider matrix covers 10 APIs, 14 configurations and 140 serialized offline requests; this does not claim live cache hit rates or provider/MCP execution.

Type checking and offline build **12/12** pass. Changes are static guidance, explicit discovery and project-refresh boundaries; they do not touch normal delta/progress/rendering hot paths. Existing discovery AST/allocation-counter and six catalog-release controls pass with zero retained catalog objects. No speedup is claimed.

```powershell
npm run check
npm run build:offline
node --experimental-strip-types --test tests/tool-search-category.test.ts tests/tool-search-ranking.test.ts tests/tool-search-hot-paths.test.ts tests/project-context-retirement.test.ts tests/codemode-runtime.test.ts tests/codemode-session.test.ts tests/source-invariants.test.ts tests/tool-prefix-stability.test.ts tests/tool-prefix-providers.test.ts
```
