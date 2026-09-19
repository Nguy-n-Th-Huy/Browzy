# Apply report — the Jev answer gets a brain and material

Date: 2026-09-19
Changes applied: `jev-reports-can-analyse` (A), `jev-runs-consult-sources-beyond-the-page` (B)
Status: DONE — all affected suites green; 2 tasks remain OPEN pending a live run.

## What the operator complained about

The Jev branch drove the browser correctly but answered badly. The KTD assessment
came back as a list of identifiers and view counts; the same goal on the
Claude/ChatGPT branch came back with a conclusion first, supported by a second
source. Four causes, all mechanical, none of them "the model is stupid":

1. the answer instruction banned inference, so the run could restate a page but
   never conclude from it;
2. the answer saw only the LAST page, so a run that browsed ten pages reported
   from one;
3. the report was capped at 4000 characters, below the length of the assessment
   being asked for;
4. the run could not read anything the driven page did not itself contain.

A fixes 1–3. B fixes 4.

## A — the answer may reason

- `host/agent/jev/text-helper.js`: FINAL_REPORT and COMPLETION_CHECK rewritten
  around a fact/reasoning split — a FACT must come from provided material,
  REASONING over those facts is expected, a conclusion names the facts it rests
  on, and the run never presents its own conclusion as something a source said.
  Shape rules added: a goal that asked for an ACTION gets a short answer; a goal
  that asked for ANALYSIS gets its conclusion FIRST.
- `MAX_REPORT_CHARS` 4000 → 12000, and `COMPLETION_CHECK_MAX_TOKENS` 4096 →
  16384 with it. Raising the character cap alone would have been a bug: a
  Vietnamese assessment runs ~2 chars/token, so a 12k answer needs ~6k output
  tokens and would have been truncated into a strict-parse refusal.
- Observations: the run now accumulates every distinct page it saw
  (deduped by url+text, bounded per record and in total, oldest dropped first)
  and the answer is written against all of them instead of the last one.

## B — the answer may read beyond the page

- `host/agent/jev/source-fetch.js` (new): read-only GET with resolved-address
  checks (loopback, RFC1918, link-local, CGNAT, multicast, v6 forms and
  `::ffff:` unwrapping), every redirect hop re-checked, a size cap enforced
  while reading the stream, a time cap, a text-content-type allowlist, and no
  cookies or credentials.
- The research step runs ONCE, at the analysis phase, never inside the cycle.
  The completion check that would report the goal complete may instead NAME up
  to 3 URLs; the host fetches those and asks for the answer once with them in
  hand. A URL found inside a fetched document is not fetchable on that basis —
  one hop per named source, never a chain.
- Fetched text is untrusted data on the same terms page text is: it states
  facts, it cannot authorize, reconfigure, change the outcome, or steer the
  loop. Covered by an instruction-shaped fixture document.
- Attribution: the answer names each source by URL, and a source that could not
  be read is named as unread rather than silently dropped.
- Toggle: a non-secret profile field, on by default, absent-loads-enabled (the
  screenshot toggle's rule), with a settings disclosure that states the actual
  capability — at most 3 URLs, read-only GET, no credentials, nothing rendered
  or executed, the servers at those URLs see the request — and explicitly says
  this is not web browsing.

### Provider-side search (section 4)

Implemented, and gated on proof rather than on the source's name:

- A fourth capability stage runs a real search against the decision-model
  source and reads the result blocks. A declared tool the endpoint accepted and
  then ignored is a FAIL, because a pass tells the operator the answer call can
  search. A server tool that ran and failed arrives inside a 200 body, not as a
  raised error, so the stage reads blocks rather than trusting the status.
- The current tool type is tried first and the earlier one exactly once, only
  when the endpoint rejected the type itself. No model→tool-type table is
  hardcoded; that table rots.
- The stage never decides overall `status`. A profile without search stays
  fully runnable and consults the URLs the decision model can name.
- The proof reaches a run as the snapshot's `searchSources`, read from the
  capability result stored under this exact (endpoint, model, credential) key —
  so changing any of the three drops the claim with it, and an untested profile
  claims nothing.
- The tool rides the ANSWER call only. It cannot ride a decision-class call:
  the step decision, run plan, memory revisions, stall recovery and completion
  check have no parameter that could carry it, and a test asserts the step
  decision stays tool-free. The pinned requirement that decision calls are
  tool-free is therefore untouched — the final report was never in that list.
- Search follows the consultation toggle: an operator who turned off reading
  beyond the driven page turned off searching beyond it too.

Search-engine scraping was deliberately NOT implemented (task 4.3).

## Verification

| Suite | Result |
|---|---|
| `host/test/jev-runtime.test.mjs` | 101/101 |
| `host/test/jev-source-fetch.test.mjs` | 12/12 |
| `host/test/jev-capability.test.mjs` | 20/20 |
| `host/test/jev-text-helper.test.mjs` | 60/60 |
| `host/test/settings-typesafe.test.mjs` | 20/20 |
| `host/test/agent-typesafe-run.test.mjs` | 8/8 |
| `host/test/settings-capability-test.test.mjs` | 14/14 |
| `host/test/agent-settings-relay.test.mjs` | 31/31 |
| `test/settings-ui-controller.test.mjs` | PASS |
| `test/settings-ui-client.test.mjs` | PASS |
| `test/settings-connection-gate.test.mjs` | PASS |
| `test/overlay-pointer.test.mjs` | PASS |
| `test/sidepanel-conversation-model.test.mjs` | PASS |

`npx openspec validate` passes for both changes.

Two existing assertions changed, both because the new stage is reported: a
capability test on a Chat Completions decision wire now records
`search: "fail"` / `SEARCH_UNAVAILABLE`. That is the honest outcome — that wire
has no server tools — and it gates nothing. No assertion was weakened.

## Known-broken, NOT caused by these changes

`test/overlay-background-bridge.test.mjs` fails at HEAD, on committed source,
before either change: the extracted `teardownOverlayForRun` and
`handleAgentMessage` are compiled against dependency objects that no longer
list every collaborator those functions call. I added the missing stubs
(`requestAnnotationClear`, `activeAgentRuns`, `invalidateDownloadDecisionsForRun`,
`clearUploadGrantsForRun`, `releaseRunLocks`, `pushManagedPolicySnapshot`),
which moved the failure past four blocks, and stopped at the remaining one: the
side-panel block extracts the `browzyOverlayOpenPanel` listener body by regex
and the shipped listener no longer matches what the block expects, so
`chrome.sidePanel.open()` is never reached. Repairing that needs a reading of
the current listener and belongs to its own change, not to these two.

## Still OPEN

- A, task 4.2 and B, task 6.2 — both need a live run, not a fixture. The bar
  for B is not "a fetch happened"; it is whether a second source changed a
  conclusion. Re-run the KTD assessment goal with consultation on and record
  which sources were consulted and what the answer used them for.
- Earlier changes still carry live-run tasks: `improve-jev-step-reasoning` 2.2
  (capture OpenRouter's live decision response shape) and 9.2 (calibrate the
  selection confidence floor and probability margin),
  `jev-runs-answer-the-operator` 6.2, `fix-hover-survives-the-input-shield`
  5 and 6 (the second hover defect: `pageChanged` reads true on every hover, so
  no stall guard ever fires).
- Parked: `decision-model-names-the-element`. The evidence is real — in
  `conv_d3bb74afe4104b5ae9`, steps 9 and 13 resolved the wrong element at 0.47
  and 0.86 confidence — but it is not the defect the operator is currently
  reporting, and the operations are now correct in practice.
