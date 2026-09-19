# Proposal: Snapshot Text Visibility and Jev Scroll-Loop Guards

## Why

Diagnosed live on a real tender page (`dauthau.asia`, run "phân tích gói thầu này"): the run made 21 consecutive scroll steps, never read the tender, and ended `blocked / no_progress`. The cause is concrete and measured: `page_snapshot`'s text extract is built from a **clone's `textContent`**, so every hidden menu and collapsed navigation block counts as text — 111,724 characters of cleaned text on that page, with the first tender field ("Chủ đầu tư") at index **7,075** — past the 6,000-character snapshot bound. The model received six thousand characters of hidden chrome, could see nothing else with any operation, and the loop's scroll guards (which watch the element table, not scroll count) let it scroll 21 times before stopping. The requirement already says "visible page text"; the implementation does not deliver it.

## What Changes

- **The extract becomes rendered-text-aware.** Elements that are not rendered (`display: none`, `visibility: hidden`, the `hidden` attribute) contribute nothing to the page text, so hidden navigation, collapsed menus, and invisible chrome can never crowd out the content. The existing exclusions (scripts/styles, overlay/annotation hosts), the masked-control masking, the container-selection and coverage logic, and the disclosure of truncation all stay; the same extraction serves `page_snapshot` and `get_page_text`.
- **The text bound is sized for content.** The page-text bound moves from 6,000 to 10,000 characters, consistently across the three places that pin it (the extension's snapshot builder, the decision request's `page.text` projection, and the text-helper field context). Truncation is still disclosed; the request fitter still enforces provider ceilings.
- **A scroll-only stall guard.** Consecutive executed steps whose every action is a scroll — either direction, regardless of whether the element table changed — are treated as a stall once the configured count (8) is reached: the existing bounded recovery consultation runs; a refusal, an unavailable consultation, or a spent recovery bound ends the run blocked `no_progress` immediately, and after a recovery one further executed scroll ends it the same way.
- **The step-decision instruction gains plan adherence and honest ends.** It must not repeat an action the run's own notes call ineffective, must choose the control its notes name for the next step, must choose `BLOCKED` (naming the access/login/gating limit) when what the goal needs cannot be obtained from the page, and must choose `DONE` once gathered material suffices for an information/analysis goal.
- **The completion check understands analysis goals.** For a goal asking for information or analysis rather than a page action, a confirming verdict means the gathered material supports the requested analysis (naming anything unobtainable), not that a discrete page state is visible.
- **Unchanged**: the element table and its bounds; reference semantics; dispatch/approval discipline; screenshots; the other guards.

## Capabilities

### New Capabilities
- (none — the change extends existing capabilities)

### Modified Capabilities
- `agent-browser-runtime`: the "Page snapshot operation" requirement's text extract is pinned to rendered (visible) text and a bound that reaches content, so invisible chrome cannot crowd it out.
- `typesafe-jev-provider`: "Bounded run and honest outcomes" gains the scroll-only stall guard and the analysis-goal completion-check semantics; "Step decisions from the configured model" gains the plan-adherence and honest-end rules.

## Impact

- **Extension**: `extension/content.js` (the shared page-text extractor + snapshot text bound) and its tests (`page-snapshot-content`, `get_page_text`-facing suites), with the stand-in DOM harness taught to model hidden elements.
- **Host**: `host/agent/jev/runtime.js` (the scroll-only streak guard + post-recovery repeat rule), `host/agent/jev/questions.js` (the text bound constant), `host/agent/jev/text-helper.js` (the NEXT_STEP/COMPLETION_CHECK instruction text), and their suites.
- **Docs/specs**: README (the changed text bound and the new guard where the Jev loop is described), the two capability deltas above.
