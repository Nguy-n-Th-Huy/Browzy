## Context

See proposal.md — Why. The constraints that actually shape the approach:

- **The real onboarding is six manual steps and only its last one is in the product.** `docs/cai-dat.md:21-78` and the installer's own hand-off text (`host/agent/installer/core.js:182-212`) prescribe: install Node/Git/Chromium → `git clone` → `./install.sh` (registers `com.anthropic.browzy_in_chrome` at an absolute path) → `chrome://extensions` → Developer mode → Load unpacked → **restart the browser** → open the side panel → open Settings → enter Base URL + API key (or sign in with ChatGPT) → `Lưu` → `Kiểm tra kết nối`. Nothing in the extension can perform the first five (`docs/cai-dat.md:11`), and the extension cannot restart the browser (`install.sh` never does). So the product's honest job is to state *where in this sequence the user is* and what the next unperformed step is — not to re-describe the sequence in prose on two surfaces at once.
- **The three in-product preconditions already have a canonical order, and it is enforced.** `extension/settings/connection-gate.js:64-88` is the single predicate (`export function connectionGate(state)` at `:64`): testing is blocked by `testing` (`:65`), then `no_credential` / `signed_out` / `session_expired` on a `chatgpt` profile (`:69-77`), then `no_models` (`:82`), then `no_default_model` (`:85`), then allowed (`:88`). `settings-controller.js:1315-1334` mirrors the same first steps for `testConnection`/`discoverModels`. The walkthrough restates this order for the user; it does not invent, reorder, or re-implement it — it reads the same fields.
- **Two surfaces already derive "not ready", from two different state shapes.** The panel goes `ProfileCache` (`ocic_profile_cache_v1`) → `deriveReadinessState()` (`extension/sidepanel/profile-cache.js:90-158`) → `READINESS` (8 values, `profile-cache.js:15-27`) → `renderSetupBanner`'s switch (`sidepanel.js:376-434`). The settings page has no readiness concept at all: it reads `SettingsController` state (`isFirstRun`, `hasCredential`, `providerType`, `chatgptSessionState`, `models`, `defaultModelId`, `connectionStatus`, `loadError`) and re-expresses the same facts as a status card (`settings-app.js:469-513`) plus a first-run banner (`settings-app.js:362-371`). Any shared step derivation therefore has to take a *normalized* input rather than either shape.
- **`READINESS` deliberately does not include the companion.** It is derived from the stored profile only — from a cache mirror (`ocic_profile_cache_v1`) that `extension/background.js` refreshes on connect, so it can also be *stale* relative to a companion that is currently unregistered. The companion's own state lives elsewhere: the panel's connection pill classifies `chrome.runtime.lastError` into `HANDSHAKE_LABEL_VI` details (`sidepanel.js:325-329`, `protocol-client.js`, pinned by `test/companion-missing-notice.test.mjs:202`), and today the install instruction exists **only as that pill's `title` tooltip** (`sidepanel.js:338-340`, the file's only `install.sh` occurrence: "Máy này chưa đăng ký native messaging host. Chạy install.ps1…"). The settings page can only learn of it indirectly, as a failed `get_profile` (`settings-controller.js:376-380` sets `loaded`, `loadError` *and* an error `banner`). The two surfaces thus know different amounts, and the shared module must accept that difference rather than pretend to a common value.
- **The disclosure idiom is settled in this codebase, and it is not `<details>`.** `test/PinsPrimitives`-level evidence: `extension/ui/behaviors.js:141-142` (`<ui-tool-row>`), `extension/sidepanel/sidepanel.js:2721-2722` (timeline) and `2754-2758` (thinking) all use a real `<button aria-expanded aria-controls>` over a body that stays in the DOM with `hidden`, with `aria-expanded` as the source of truth (`sidepanel.js:2731` comment; `sidepanel.css:949-952` documents the vocabulary). Within `extension/**`, `<details>` appears only in `extension/recorder/options.js:320,543,580` and `extension/sidepanel/run-feedback.js:29` — raw-payload debug surfaces, not the product surface; `extension/settings/**` and `extension/sidepanel/sidepanel.html` contain none, and the two hits in `extension/content.js:295,812` are comments about `<details>` in page DOM. (`docs/imitation-learning-alignment.html:277` uses one, outside the extension's shipped surfaces.) `manifest.json` declares `minimum_chrome_version: 116`, below the range where `<details>`' internals are styleable without `::details-content`, so a `<details>` accordion could not be made to match `.section-heading` and the card surfaces.
- **`extension/ui/**` is the shared, approved design layer** (`extension/ui/tokens.css`, `components.css`, `base.css`, `behaviors.js`, `icons.js`, `prose.css`) and `openspec/ui-dna.md` fixes it: neutral surfaces, the existing accent/focus/border/radius tokens, `--font-sans` for UI, no new palette or layout system. Both settings pages already carry page-local `<style>` blocks and state that they never edit the shared layer. This change stays inside that rule.
- **The house test protocol is split by layer, not by convenience.** Pure logic is unit-tested from plain Node (`connection-gate.js` and `settings-validation.js` exist precisely so `settings-app.js` can be "thin and declarative" and stay DOM-untested, per `settings-app.js:1-8`); the DOM layer is verified by real captured screenshots. `sidepanel.js` is under the same rule ("DOM-only glue … verified by screenshots, not a DOM-diffing test" — `test/sidepanel-readiness-states.test.mjs:19-21`). New decisions therefore belong in pure modules, and the DOM work must be provable by a screenshot pass.
- **Structure is nearly unconstrained; behaviour is heavily pinned.** `test/PinsSettings`-level evidence: **no** test pins the DOM order of `<main class="panel-scroll">` children, the section headings, the nav chips, `data-section`, `aria-current` or `scroll-margin-top` (zero hits for all of them). What *is* pinned is small and enumerated under "Constraints from existing tests" below.

## Goals / Non-Goals

**Goals:**

- A first-time user, on both surfaces, can read the next unperformed setup step and its order without scrolling and without reading a paragraph.
- The settings page's scroll length is dominated by what the user came for; advanced, optional configuration is closed by default but one keystroke away.
- No setup failure can be hidden behind a collapsed section.
- Every existing deep link — the panel's `#btn-test-connection` and the gate hint's `#section-models` — still lands on a control the user can act on.
- Trimming copy never weakens a truthfulness obligation.
- The brand layer (`extension/ui/**`) and the design tokens are untouched.

**Non-Goals:**

- **No wizard, no second page, no route.** Onboarding stays on `settings.html`, which `manifest.json:38` already declares as `options_page` and which the panel already opens in a tab with an anchor. A wizard would hide sections from returning users, split the flow across two documents, and add state that has to survive validation and busy states in sections the user cannot see.
- **No new wire operation, no new companion field, no persistence change.** The walkthrough and the collapse state are both derivable in the extension from values that already cross the wire. `host/**` is not touched.
- **No change to the installer, `docs/cai-dat.md`, or the manual steps themselves.** This change improves what the product *says* about those steps; making the installer unnecessary is the separate `migrate-extension-core-to-rust` / packaging work.
- **No change to which controls exist, or to any validation, save, test, sign-in, discovery, usage, skills, permissions, memory or backup behaviour.** Sections move and collapse; their controls and handlers do not.
- **Teaching the settings page the result of a previous session's connection test.** `get_profile` does return `lastCapabilityTest` (`host/agent/settings/profile.js:180-189`) and the panel already uses it via `profile-cache.js`, but the settings controller never reads it, and deciding whether a stored result still applies to the *current* credential, endpoint and model means applying `capabilityTestKey` — a rule `profile-cache.js` owns. Making the settings page know it therefore means a new controller field plus a shared key rule: real, but a controller-state change, and not needed for the walkthrough to be truthful. The card labels that step `Chưa xác nhận` instead of claiming the test never ran (D5).
- **No animation choreography.** The reduced-motion token set (`tokens.css:324-328`) already zeroes `--motion-duration`; collapsed bodies use the existing `hidden` idiom, which has no transition to disable.

## Decisions

### D1. One shared, pure step derivation — `extension/setup-walkthrough.js`

New module at the extension root, imported by both `extension/settings/settings-app.js` and `extension/sidepanel/sidepanel.js`. Pure: no `document`, no `chrome.*`, no I/O. Tested from plain Node as `test/setup-walkthrough.test.mjs`, exactly like `connection-gate.js`.

```js
export const SETUP_STEP = Object.freeze({ COMPANION: "companion", PROVIDER: "provider", MODELS: "models", CONNECTION: "connection" });
export function deriveSetupSteps(input)
// input: { companion, providerType, hasCredential, chatgptSessionState,
//          models, defaultModelId, connectionStatus, busy }
// busy: { saving, signingOut, signingIn, switchingProviderType, discovering, testing }
// -> { steps: [{ key, title, detail, state }], currentKey, ready }
// state: "done" | "pending" | "todo"
```

- **Order** is fixed and matches the gate: `companion` (only when known to be not ok) → `provider` → `models` → `connection`. There is no path in which the list is emitted in another order.
- **`state` per step**, not a boolean, because two steps have a real in-flight state: `provider` is `pending` while `saving`, `signingOut`, `signingIn` or `switchingProviderType`; `models` is `pending` while `discovering`; `connection` is `pending` while `testing` or while `connectionStatus.status === "testing"`. Otherwise `done` when satisfied and `todo` when not. A step that is `pending` is neither claimed done nor labelled as something the user still has to do.
- **`companion`** is `null` when the caller cannot know, otherwise one of the handshake details the panel already enumerates (`HANDSHAKE_LABEL_VI`, `sidepanel.js:325-329`): `"companion_not_installed"`, `"native_host_unavailable"`, `"unsupported_version"`, or `"ok"`. A non-ok detail produces a leading companion step; `null` and `"ok"` produce none. The settings page always passes `null` — it cannot determine registration, and its own failure path is handled by the card (D5), not by an invented step.
- **`ready`** is false whenever a companion step exists and is not `done`. This is not cosmetic: `READINESS` is computed from a cache mirror that may predate a companion which is currently unregistered, so without this rule the panel could present a cached "ready" while nothing can run. The companion's own state is the only thing that can veto a cached profile.
- **`currentKey`** is the first step that is not `done`; `ready` is `currentKey === null`. The card and the panel mark `currentKey` — that mark is the "flow" the product was not stating.

*Why one module and not two copies:* the settings page and the panel are the same conversation at two moments. Two derivations would drift the first time either precondition changed, and the failure would be a user reading "next: models" on one surface and a different step on the other.

*Alternative rejected — reusing the panel's `READINESS` enum for both.* `READINESS` is derived from the stored profile cache and cannot express "the companion is not installed", which is the single most common first-run failure (`docs/cai-dat.md:123`). Bending it to cover the companion would change the panel's readiness contract and every test that pins it.

*Alternative rejected — putting the module in `extension/ui/**`.* That directory is the design layer (`openspec/ui-dna.md`) and a step-derivation function is not a design primitive; keeping it at the extension root also keeps both callers' imports symmetric.

### D2. Collapsible sections use the existing `aria-expanded` + `hidden` idiom

Each section becomes:

```html
<section class="settings-section" aria-labelledby="section-models">
  <h2 class="settings-section-head">
    <button type="button" class="settings-section-toggle" id="section-models"
            aria-expanded="true" aria-controls="section-models-body">
      <span class="settings-section-title">Mô hình</span>
      <span class="settings-section-state" id="section-models-state"></span>
      <span class="settings-section-chevron" id="ic-section-models"></span>
    </button>
  </h2>
  <div class="field-group" id="section-models-body"> …unchanged contents… </div>
</section>
```

- The section's existing `id="section-*"` moves onto the **toggle button**, so every existing anchor (`#section-models`, and the gate hint's `jump.href = "#section-models"`) resolves to a permanently visible element. Since the toggle is never hidden, a native anchor jump always lands in the right place even when the body is closed.
- The heading becomes a real `<h2>` containing the button (the accessible-disclosure pattern), and the button carries the section's state label so a closed section still says whether it needs the user.
- The state label is text (`Chưa xong` / `Đã xong` / `Chưa bật` / `Đã bật`), never a colour-only carrier — the rule `ui-dna.md` states and `redesign-settings-typed-only-skills` D7 already applied to the model radio group.
- The scroll offset rule moves with the id: today it is `.section-heading[id] { scroll-margin-top: 64px; }` (`settings.html:159`), and since the `<p class="section-heading">` elements are gone it is **replaced** by `.settings-section-toggle[id] { scroll-margin-top: 64px; }` — not added alongside, which would leave a rule matching nothing. `wireChipNav` (`settings-app.js:516-574`) resolves each chip with `getElementById(chip.dataset.section)`, so it now observes the toggle buttons instead of the `<p>` headings; those are the elements that define a section's position either way, and the observer's `rootMargin`/`threshold` are unchanged.
- `.field-group` declares no `display` (`components.css:188-196`), so the native `[hidden] { display: none }` rule is sufficient on the body; this is the one case the page's own `.btn[hidden]` note (`settings.html:189-197`) does not apply to.

*Alternative rejected — `<details>`/`<summary>`.* See Context: not this codebase's idiom, and not styleable at `minimum_chrome_version: 116`.

### D3. Section open state is derived; a blocking state always wins

New pure module `extension/settings/settings-sections.js`, next to `connection-gate.js` and under the same "DOM-free on purpose" rule:

```js
export const SECTION_KEYS = ["provider", "models", "jevtools", "other", "backup"];
export function sectionDefaults(state)            // -> { provider: bool, … }
export function resolveSections(state, overrides) // precedence, below
export const SECTION_OF_CONTROL                   // control id -> section key
```

Precedence, in order:

1. **A section holding an error is open, always.** `provider` when `connectionStatus?.status === "fail"` or `fieldErrors.baseUrl`; `models` when `fieldErrors.models`; `jevtools` when `jevToolsTest?.status === "fail"` or a Jev test is in flight. A collapsed section is allowed to be *quiet*; it is never allowed to be *wrong*. Note what is deliberately **not** in this rule: a section whose step is merely unsatisfied stays under the user's control, because the walkthrough on the card — which is never collapsed — already names the next unmet step, so closing a section cannot hide the flow. Forcing every incomplete section open would make the disclosure useless during setup, which is exactly when the page is longest and the user most wants it.
2. **An explicit choice wins** over the default, for the session. A deep link's reveal and a manual toggle write the SAME slot — last write wins — because that is what the user expects: arriving at a section by deep link and then closing it must leave it closed. Only rule 1 is allowed to overrule this slot, and only for a section that holds an error.
3. **Otherwise, the derived default:** each section opens exactly when its own setup step is unmet — `provider` while no credential (or ChatGPT session) is stored, `models` once the provider step is done but the list is not, `jevtools` only while a Jev test is in flight or recorded, `other` and `backup` never. The connection test is not a section (it is a row inside the provider section), so a configured-but-untested profile opens nothing: the card carries that step and its own "Kiểm tra lại" control, and the step's action reveals the provider section when the user wants the row itself.

*Why one slot and not two:* an earlier draft of this decision kept reveals and toggles in separate precedence levels, on the theory that a deep link is a stronger statement of intent than a click. It is not — a reveal is a click the browser made for the user, and a user who closes a section they were just sent to means it. One slot also removes a class of bug where a stale reveal outlives its reason and keeps re-opening a section the user has since closed.

*Before the profile arrives* (`state.loaded === false`, `SettingsController` notifies once before its `getProfile` await and once after) **no section state is claimed and no walkthrough is shown**: the card renders a neutral loading line, and the sections take the "nothing known yet" default — `provider` open, the rest closed. The markup itself ships that same state (`aria-expanded="true"` and no `hidden` on the provider body; `aria-expanded="false"` and `hidden` on the other four), so the first paint is produced by the document rather than by a script that has not run yet, and a returning user sees one re-layout when the real profile arrives instead of an all-expanded page for the duration of the round-trip.

*Where the collapse state lives:* the derived defaults are pure and unit-tested; the overrides (reveals and user toggles) are a `Map` in `settings-app.js`, and `render()` reads it through `resolveSections(state, overrides)` on **every** pass — that is what makes a reveal survive the async `getProfile` render rather than being overwritten by it. Overrides are not persisted: a fresh page load is entitled to a different default. *Why not in `SettingsController`:* the controller is the wire + validation state machine, its state shape is pinned by `test/settings-ui-controller.test.mjs`, and disclosure is not state any other component needs. The decision logic that *is* worth testing — defaults, precedence, the control→section map — is in the pure module, so the DOM layer is left with an event handler and a `hidden` assignment.

### D4. Jev browser tools becomes its own top-level section, after the provider connection row

Today it is a `.field-group-item` inside the provider group, positioned *between* the fields the user must fill and the row holding `Lưu` / `Kiểm tra kết nối` (`settings.html:367-442` for the Jev block, `443-449` for the connection row that ends with `#btn-test-connection` and `#btn-save`). It moves to its own `.settings-section` with its own heading, placed **after** the provider section, and starts collapsed.

- This is what `agent-settings` already requires: "a dedicated, opt-in Settings section that is **separate from the profile's primary provider configuration**" (`openspec/specs/agent-settings/spec.md:185`).
- Consequence for the first-run path: `Lưu` and `Kiểm tra kết nối` become reachable without passing optional, advanced configuration.
- Its controls, ids, handlers, save path and test path are all unchanged; only their container and document position change. `settings-app.js` resolves every one of them by id, so the move is position-independent.
- The chip nav gains a `Jev` chip — five chips total (`Nhà cung cấp`, `Mô hình`, `Jev`, `Skills`, `Sao lưu`) — so its new position does not cost discoverability. No chip sizing, padding or behaviour is introduced: `.settings-navbar` is already `position: sticky` + `overflow-x: auto` with `flex: none` chips and a `:focus-visible` focus ring (`settings.html:118-166`), so five chips scroll horizontally at 320 px exactly as four do, and the page body still never scrolls horizontally.

### D5. The setup card replaces the two surfaces that restate the flow

`renderStatusCard(state, gate)` becomes `renderSetupCard(state, gate)` (same call site, same gate argument, still before `renderProvider` — the seam `test/settings-connection-gate.test.mjs:211-212` pins is preserved and the assertion updated to the new name). The card renders, in this order of definition:

1. **Not loaded** (`state.loaded === false`): a single neutral line, no headline claim and no step list — the page does not yet know anything about the profile. It never renders the not-configured state in this window, which is what would otherwise flash a false "nothing is set up" on every open for a configured user.
2. **Load failed** (`state.loadError`): the error headline derived from the existing error code path, and **no step list**. The step list is a set of instructions the page cannot make actionable while it cannot reach the profile, so showing it next to an error would be two messages contradicting each other. `renderBanner` already renders the matching error banner from the same failure (`settings-app.js:376-380`); the card states the headline and stays out of the way.
3. **Not ready**: the **headline** already computed today (icon, title, sub) for the not-configured / untested / testing / pass / fail cases (`settings-app.js:469-513`, default sub-text at `:478`), with the one wrong line fixed — the not-configured sub no longer says models live in `Nhà cung cấp` — plus **the walkthrough** from D1: one row per step carrying its `state` (`done` / `pending` / `todo`), with `currentKey` marked as the next one, and for the provider and model steps an action that reveals the section that step lives in. Every row's state is carried by a shared `.status-pill` plus its label text, never by colour alone.
   - One label is stated with the settings page's own knowledge rather than an assumption: the connection step's `todo` label is `Chưa xác nhận`, not `Cần làm`. `SettingsController.connectionStatus` is only written by a test run in *this page* — `_applyProfile` never reads the profile's `lastCapabilityTest` (which `loadProfile()` does return, `host/agent/settings/profile.js:180-189`) — so the page cannot know whether a previous session's test passed, and `Cần làm` would claim the test has never been run. The panel *can* know, so its walkthrough keeps `Cần làm`. Making the settings page learn the prior result would mean reading `lastCapabilityTest` under the same key rule `profile-cache.js` owns, which is a controller-state change outside this change's scope (see Non-Goals) — the honest label costs nothing and claims nothing.
4. **Ready**: no step list at all — the card says the profile is ready, as today.

The existing `#btn-status-retest` control is unchanged and still driven by the same `gate`.

**The first-run banner's `isFirstRun` branch is removed** (`settings-app.js:362-371`): the card says the same thing with a visible order, and keeping both is what produced the duplication. The `agent-settings` obligation that first-run explains cost/billing (`openspec/specs/agent-settings/spec.md:131`) moves into the card's not-configured sub-line — shortened, not dropped. `renderBanner` keeps every other branch (error, success, info, memory-only offer) exactly as it is.

### D6. Deep links reveal their target; anchor activation is not hijacked

`settings.html#btn-test-connection` is a documented destination (the panel's `testConnectionButton()`, `sidepanel.js:362-368`) and `#section-models` is the gate hint's target. A hash that points **inside** a collapsed body cannot be scrolled to at all — `display: none` elements have no box — so the reveal has to happen before the jump, not after it.

- `settings-app.js` resolves `location.hash` **synchronously in module scope**, expands the owning section through the D3 override mechanism (so the later async `getProfile` render cannot close it again), then `scrollIntoView()`s the target.
- A `hashchange` listener does the same for in-page navigation.
- The chip nav keeps its current behaviour: the chips are still real anchors and are **not** `preventDefault()`ed, so keyboard focus order and native activation are untouched (the property `redesign-settings-typed-only-skills` D6 established). Because a chip's target is the section's own toggle button — which is never hidden — the native jump already lands correctly and the reveal only has to open the body.
- `SECTION_OF_CONTROL` (D3) is the table that makes this testable without a DOM: it maps `btn-test-connection`, `section-models`, `section-provider`, `model-add-id` and the other named entry points to their owning section.

### D7. The panel's pre-setup surface states the flow instead of claiming readiness

In `extension/sidepanel/sidepanel.js`:

- `emptyStateHtml(readiness, steps)` gains the inputs it needs. When the profile is **not** ready, it renders the walkthrough (D1 steps, with the current step marked) and a link to Settings for the section that resolves it — and does **not** render the `Sẵn sàng trên trang này` eyebrow, the `Chào bạn, tôi có thể giúp gì?` greeting, or the three `data-suggest` cards. Those three prompts insert text that the send path will refuse while the profile is incomplete, so offering them is the defect: the panel is the first surface a new user sees, and its largest text asserted a readiness that had not been reached.
- When the profile **is** ready, the empty state is byte-for-byte what ships today.
- The step input is assembled from the panel's own two sources: `panel.readinessState()` for the profile half (`extension/sidepanel/panel-controller.js:832-834`) and `panel.protocol.handshakeDetail()` for the companion half. `CHATGPT_SIGN_IN_REQUIRED` / `CHATGPT_SESSION_EXPIRED` are *not* separate steps — they are the provider step's detail (`deriveSetupSteps` reads `providerType` and `chatgptSessionState` directly), so a `chatgpt` profile with an unregistered companion renders **companion, then provider (sign in)** and never two competing steps. The order is the one in D1, and nothing in the panel may reorder it.
- Because the companion half is the only thing that can veto a cached profile (D1), the panel derives `ready` from `deriveSetupSteps(...).ready`, not from `readinessState().state === READINESS.READY` alone, for the purpose of deciding which empty state to show. The banner's own `READINESS` switch is untouched, so no readiness assertion changes meaning.
- `wireEmptyStateSuggestions()` is unchanged — it selects `[data-suggest]`, of which there are simply none in the not-ready state. A separate `wireSetupStepLinks()` binds the walkthrough's rows, so the suggestion handler keeps the contract `test/sidepanel-chip-fills-composer.test.mjs:55-74` pins (fills the composer, focuses it, never sends).
- `renderSetupBanner`'s switch is **unchanged**; only its guard changes: it clears the slot and returns when there is no transcript, because in that case the empty state is already carrying the same statement and a second copy above the composer is the duplication this change exists to remove. With a transcript present, readiness can regress mid-conversation and the strip stays exactly as it is — which is why the switch is kept whole rather than deleted.
- The companion step's instruction (`Chạy ./install.sh … rồi tải lại extension`) moves out of the pill's `title` tooltip and into that step's detail, where it is visible without a hover. The pill and `HANDSHAKE_LABEL_VI` are untouched (`test/companion-missing-notice.test.mjs:202` pins them).

### D8. Copy rules — what is trimmed, what must survive

Trimmed (with the reason):

- The first-run banner's paragraph (duplicates the card).
- The status card's "…ở mục Nhà cung cấp bên dưới" instruction (wrong section, superseded by the steps).
- `#jevtools-beta-notice` (4 sentences, `settings.html:369`): reduced to the one sentence that says what the section is and that it costs the primary provider's quota; the rest moves to the two group hints inside the now-collapsed section, where a reader who opted in is already looking. Note this is the *Jev browser-tools* notice — `agent-settings` forbids a **standalone Jev/TypeSafe provider** beta notice or `beta-badge` (`test/settings-connection-gate.test.mjs:290`), which stays forbidden.
- `#key-input`'s hint (2 sentences, `settings.html:268`) becomes the one-sentence form already used verbatim by the Jev key field (`settings.html:391`), so the same claim is stated once, the same way, on both credential fields.

Must survive, verbatim or stronger — each is a spec obligation:

- The cost/usage disclosure on both test controls (`#test-disclosure-anthropic`, `#test-disclosure-chatgpt`, `#jevtools-test-disclosure`) — `agent-settings` "Explicit compatibility and connection testing".
- The ChatGPT unofficial-backend + OpenAI-terms disclosure (`#chatgpt-disclosure`) — `agent-settings` "Editable provider profile".
- Where the secret is stored and that it is never shown again — `agent-settings` "Secret isolation".
- That usage and billing depend on the configured provider/ChatGPT plan, with no promise of free inference or universal gateway compatibility — `agent-settings` "No Claude product account required". This one is a first-run obligation, so it is the *destination* of the trimmed first-run copy, not a casualty of it.
- The export hint's "Tệp xuất KHÔNG chứa API key" — `agent-settings` "Secret isolation" export/diagnostics scenario.
- The gate hints (`CONNECTION_GATE_HINT_NO_MODELS` / `…_NO_DEFAULT`) — single copy in `connection-gate.js`, pinned by `test/settings-connection-gate.test.mjs:48-49`.

Rules applied to everything else: one idea per sentence; a hint states the constraint or the consequence, not the design rationale; no new product nouns (the vocabulary stays `Browzy`, `companion`, `Base URL`, `API key`, `mô hình mặc định`, `Jev browser tools`); and no sentence that describes what the interface visibly does not do.

### D9. Test strategy

Added:

- `test/setup-walkthrough.test.mjs` — the step list, each step's `state`, and `currentKey` for every branch: companion missing / host unavailable / wrong version / unknown / ok; chatgpt signed-out, signed-in, session-expired; empty model list; models without a default; pass, fail, testing, and `null` connection status; each `busy` flag producing `pending` on the step it belongs to and on no other; that a non-ok companion makes `ready === false` even when every profile condition is satisfied (the cached-profile veto); and that the produced order matches the gate's own precedence for the same input (the two must not be able to disagree about what comes first).
- `test/settings-sections.test.mjs` — the derived defaults per state, including the `loaded === false` window; that an error condition beats both an explicit reveal and an explicit user toggle of `false`, while an unsatisfied step does not; that a reveal beats a user toggle and a user toggle beats the default; and that `SECTION_OF_CONTROL` covers every deep-linked control the page exposes (`btn-test-connection`, `section-models`, `section-provider`, `model-add-id`) with each mapped id present in `settings.html`.
- `test/sidepanel-setup-walkthrough.test.mjs` — the panel's pre-setup empty state, executed rather than pattern-matched: `test/_extract.mjs` pulls the shipped `emptyStateHtml` and `deriveSetupInput` (and the four label/anchor tables) out of `sidepanel.js` by brace-matching and runs them with their dependencies injected, so the assertions are about the real function and the real `deriveSetupSteps`. It covers the not-ready branch (steps present, greeting/eyebrow/`data-suggest` absent, the companion step carrying the install command and no settings link, the cached-profile veto) and the ready branch (the greeting and all three example prompts, byte-identical).

Migrated:

- `test/settings-connection-gate.test.mjs:212` — `renderStatusCard(state, gate);` → `renderSetupCard(state, gate);`. The seam's *intent* is untouched and its other assertions stay as they are: exactly one `connectionGate(` call, computed before the provider renderer, one `disabled` assignment per test button, the `#test-gate-hint` container, the `#section-models` jump target.

Not re-pinned, not deleted: nothing. Every other assertion in the settings and panel suites is left to hold on its own; if one of them breaks, the change is wrong, not the test.

Verified from rendered pixels, because these are the layers the house protocol excludes from unit tests: the settings page in a real Chromium through a committed harness, at a 400 px-wide panel and at 320 px, light and dark, across seven profile states, plus keyboard reachability and both deep links. The 13 captures, their harness and their own self-check live in `design-review/`, and `reports/01-settings-ui-evidence.md` records the method, the before/after measurements and the limits — including the one thing this does not cover: the side panel, whose pre-setup state is executed in Node through `test/_extract.mjs` instead, because `sidepanel.js` needs the whole `chrome.*` surface to boot and this repository has no stand-alone panel harness.

## Constraints from existing tests

Enumerated from the shipped suites, not assumed. The first table is what must keep holding in `extension/settings/**`; the second in `extension/sidepanel/**`.

**`extension/settings/settings.html`**

| Test | Pinned | Consequence for this change |
|---|---|---|
| `settings-connection-gate.test.mjs:226-227` | `/id="test-gate-hint" hidden><\/p>/`, exactly one occurrence | The hint container keeps its exact empty-hidden markup and stays unique |
| `settings-connection-gate.test.mjs:228` | `/id="section-models"/` | The id stays in the page — now on the models toggle button |
| `settings-connection-gate.test.mjs:287-290` | no `id="provider-type-typesafe"`, no `id="typesafe-fields"`, no `id="test-disclosure-typesafe"`, no `beta-badge` | Do not reintroduce any of these while rewriting copy |
| `settings-connection-gate.test.mjs:291` | exactly 2 `<input type="radio" name="provider-type"` | Provider radio count unchanged |
| `settings-connection-gate.test.mjs:296-299` | `id="provider-baseurl-item"` present, `anthropic-baseurl-item` absent, exactly one `id="base-url"`, `base-url-label` + `base-url-hint` present | The endpoint field's ids survive the re-wrap |
| `settings-connection-gate.test.mjs:312` | no `typesafe-source-select`/`decision-source-select` | — |
| `settings-connection-gate.test.mjs:322,326-328` | `<option value="openrouter">OpenRouter (alpha)</option>`; exactly 3 `<option value="…">` in the Jev transport select | The Jev select's options are untouched by the move |
| `settings-chatgpt-signout.test.mjs:35-45` | `id="btn-chatgpt-signout"` within 80 chars of `>Đăng xuất</button>`; the 800-char window after `id="chatgpt-session-expired-actions"` contains `btn-chatgpt-signout-expired` + `>Đăng xuất</button>` + `btn-chatgpt-signin-again`, and no `onclick=` | Re-wrapping the ChatGPT block must preserve those ids, labels and relative order inside the window |
| `settings-memory-controller.test.mjs:141` | `/id="nav-memory"/` | The Skills & tiện ích rows keep their ids |
| `extension-csp-no-inline-scripts.test.mjs:51-73` | zero inline `<script>`, zero `on*=` attributes in every `extension/**/*.html` | All new behaviour stays in `*-app.js`; no inline handlers on the toggles |

**`extension/settings/settings-app.js`**

| Test | Pinned | Consequence |
|---|---|---|
| `settings-connection-gate.test.mjs:209` | exactly one `\bconnectionGate(` call | The card must receive the gate as a parameter; it must not call `connectionGate` itself |
| `settings-connection-gate.test.mjs:211-212` | `function render(state) {` exists; `const gate = connectionGate(state);` before `renderStatusCard(state, gate);` before `renderProvider(state, gate);` | → `renderSetupCard(state, gate);` in the same position; the `render()` signature and the gate's placement are unchanged |
| `settings-connection-gate.test.mjs:219-220` | exactly one `retestBtn.disabled = !gate.canTest;` and one `$("btn-test-connection").disabled = !gate.canTest;` | Keep the local name `retestBtn` and both single assignments |
| `settings-connection-gate.test.mjs:222-223` | `!state.defaultModelId` and `state.testing \|\| !state.hasCredential` are absent | Do not introduce a second copy of the predicate — in particular the walkthrough must not re-derive testability from those fields |
| `settings-connection-gate.test.mjs:230-233` | `aria-describedby", "test-gate-hint"`, `connectionBlockedTitle(gate.reason)`, `hintEl.innerHTML = ""`, `jump.href = "#section-models"` | `renderTestGateFeedback` is untouched |
| `settings-connection-gate.test.mjs:245-252,260-273` | `renderProvider` never touches `#jevtools-transport-key-input`; `jevToolsTransportKeyInput.value` ×2; `jevToolsTransportKeyInputMain.value` ×2; the clear precedes `controller.save(` | The slice `[indexOf("function renderProvider(state, gate) {") … indexOf("function renderModels")]` must stay non-empty, keep that order, and the Jev key input must stay uncontrolled |
| `settings-chatgpt-signout.test.mjs:52-72` | the shared `confirmThenSignOut` handler, both `addEventListener` calls, `for (const id of ["btn-chatgpt-signout", "btn-chatgpt-signout-expired"])`, the shared busy label | `renderChatgptFields` keeps its shape |

**`extension/sidepanel/sidepanel.js`**

| Test | Pinned | Consequence |
|---|---|---|
| `sidepanel-readiness-states.test.mjs:324` | `src.includes('openSettings("btn-test-connection")')` | The literal survives in `testConnectionButton`'s body, which is kept |
| `sidepanel-readiness-states.test.mjs:325-335` | per-`READINESS`-case `testConnectionButton(`/`settingsButton(` within 300–600 chars, and the two negative assertions for the ChatGPT cases | `renderSetupBanner`'s switch keeps its `case` labels and factories exactly; only the guard above the switch changes |
| `companion-missing-notice.test.mjs:202` | `/companion_not_installed:\s*"Chưa cài companion"/` | `HANDSHAKE_LABEL_VI` and the pill are untouched |
| `sidepanel-chip-fills-composer.test.mjs:41-74` | `wireEmptyStateSuggestions` exists; its body reads `data-suggest` into the composer, focuses it, calls `updateSendEnabled()` and `autoGrow()`, and never sends | The function is left intact; the not-ready empty state simply contains no `[data-suggest]` |
| `sidepanel-context-binding.test.mjs:73` | the literal `"Tóm tắt bài viết trên trang này giúp mình."` as a `referencesCurrentPage()` fixture | That string is also a suggestion prompt; keep it |

Verified absent: no test pins `"Sẵn sàng trên trang này"`, `"Chào bạn, tôi có thể giúp gì?"`, the three suggestion titles as DOM output, `emptyStateHtml`'s signature or unconditionality, the `.setup-banner`/`#setup-banner-slot` DOM shape, the per-`READINESS` banner copy, `#empty-state-slot`/`.empty-state`/`.suggestion-item` shape, section order, nav chips, `data-section`, `aria-current`, `scroll-margin-top`, or that `extension/ui/**` is unmodified. The section restructure and the panel's empty state therefore have no structural pins to satisfy — only the behavioural ones above.

## Risks / Trade-offs

- **Collapsing content is, on its face, the thing the previous redesign refused to do** (`redesign-settings-typed-only-skills` D6 rejected panes because "panes hide content and add state that must survive validation errors in sections the user cannot see"). → The distinction is load-bearing and is enforced, not asserted: a collapsed section keeps its heading, its state label and its expander permanently visible, the content is one keystroke away rather than in another tab, and D3's precedence makes a section that holds an error or an unmet step open *regardless of what the user did to it*. What D6 rejected — content made unfindable, and state hidden from the user — is not what this ships.
- **A collapsed section could hide the very control a user is looking for.** → Four mitigations: the state label on every heading, the chip nav gaining a Jev chip, the setup card linking directly into the section each step lives in, and `SECTION_OF_CONTROL` making every deep-link target revealed on arrival. Both deep links that exist today are covered by an explicit test case.
- **The walkthrough could drift from the gate that decides whether testing is possible.** → No duplication is introduced: the walkthrough reads `state`, the gate reads `state`, and neither re-implements the other. `test/setup-walkthrough.test.mjs` includes a case that feeds the same input to both and asserts the step order agrees with `connectionGate()`'s precedence, so a future divergence fails a test rather than shipping.
- **Removing the first-run banner could drop a spec obligation with it.** → The obligation is named in D8 with the requirement it comes from, and the replacement text lives in the setup card's not-configured state, which is the first-run surface.
- **The panel's empty state becoming readiness-dependent touches the one surface with no unit coverage.** → It is covered the way the house protocol covers `sidepanel.js`: structurally for the pieces other tests already pin (the suggestion handler's contract, the banner switch), by the new pure module for the step derivation, and by a real-browser pass for the rendering. The risk is visual, and the mitigation is the verification pass, not a new DOM-diffing test the project deliberately does not have.
- **A hash pointing at a control inside a collapsed section needs the reveal to run before the browser scrolls.** → The reveal is synchronous in module scope, and the override it writes is what keeps the later async render from closing the section again. If the timing were wrong the failure is visible (the page stays at the top) rather than silent, and it is exercised in the manual pass for both existing deep links.
- **Trimming copy can quietly weaken a disclosure.** → D8 lists every disclosure that must survive with the requirement it satisfies; the trimmed strings are exactly those that duplicate another surface or restate the interface.

## Migration Plan

No data migration, no stored-field change, no wire-protocol change, no host change. All state the new surfaces read already exists in `SettingsController` and `ProfileCache`. Rollback is reverting the change: the collapsed sections and the removed first-run banner are markup and render-code edits, and the two new modules are pure additions with no other consumer.
