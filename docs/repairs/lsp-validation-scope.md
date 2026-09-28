# LSP scope and the HTML incident

Read-only inspection of the effective configuration in both the incident workspace
and the candidate checkout found configured TypeScript, rust-analyzer and gopls
commands. All three commands resolved locally; none routed `.html`. This establishes
an absent HTML route, not a failed or unavailable server. No user configuration or
installed service was changed and no private configuration/environment dump is committed.

The tool now distinguishes zero submitted files from received diagnostics, reports
the submitted count and file limit, and states scope limitations. Default roots use
the session cwd instead of the host process cwd, including explicit relative and
trimmed-empty roots. Mixed routed/skipped requests retain matching skipped files
and return `partial` when those files have no active route. Unrelated missing default
servers do not make a targeted request incomplete. `/lsp` describes command availability
without asserting verified server coverage. Push silence, missing pull reports and
server errors cannot turn into an empty successful diagnostic list. Actual empty
reports remain supported. Existing authoritative project checks retain their role;
tool guidance does not guarantee every future model tool choice.

Review regressions retain uncertainty when a skipped route stops with unvisited scope,
including overlap with a live route. An exhaustive scan exactly at its file cap remains
complete; the collector reports the difference without an additional filesystem probe.
Live-route truncation sets `routedScopeLimited` and returns `partial`, even when no
default service was skipped. The tool reports the submitted count and omitted scope.
They also keep an initial empty push report
inside the configured grace window and verify that later diagnostics are returned.
No extra production scan is introduced to prove exhaustion beyond the cap.
Diagnostic routes share a single bounded traversal instead of rescanning for each
unavailable default service. Each adapter retains its own file cap, exclusions,
duplicate-file and visited-directory state. A real two-directory fixture with twenty
distinct missing-service policies performs two directory reads, down from forty-two;
separate regressions retain exclusion and explicitly requested-file semantics.
Directory traversal owns one reusable adapter scratch array per recursive directory
call, bounded by that call's adapter count and cleared in `finally`. It is not pooled
or retained after the call. A hot-suite AST invariant forbids per-entry array creation.
`node --expose-gc scripts/bench/lsp-route-collection.mjs` profiles 20 scans of 1,000
synthetic files with 21 policies: 220 actual directory reads, 1,000 submitted file
instances and zero retained result maps after controlled GC. The fixture changes
adapter scratch allocations from 20,200 per-entry arrays to 220 directory-owned arrays.
On local Windows / Node 26.4.0, sampling measured 157,347,408 bytes before and
157,077,752 after this change; post-release heap was 13,946,832 bytes in the latter run.
Those totals include filesystem/path processing and sampling noise; the deterministic
array ownership/count invariant, rather than a universal percentage, is the regression gate.
Nonblank roots retain their original whitespace. Strict publication checks apply to
diagnostic validation; source fixes may still use an empty code-action context after
the existing bounded grace wait, without claiming the file was validated.

`tests/lsp-validation-scope.test.ts` tests configuration/routing and status handling
with a private protocol process, including empty reports, silence, malformed reports,
errors, zero files and unavailable defaults. Those fixtures do not analyze languages.
Missing/null push payloads must not confirm validation; regressions failed before the
notification boundary required an actual diagnostic array and pass after that fix.
A separate real-service test uses the repository's already-installed Biome 2.5.7 in
a synthetic workspace. On the local Windows run, `const broken = ;` produced two
diagnostics as standalone JS and inside `<script>` in HTML: a syntax error and an
unused variable. This is evidence for those samples with that server/version/config,
not proof of all HTML/JS, asset consistency or browser behavior. The original incident
workspace did not have this Biome HTML route. CI exercises the same real-service test
without installing a new global server or altering runner configuration.
