// Whole shipped content-script fixture, real workflow runner and computer /
// form_input handlers. Only browser dispatch/transport boundaries are spies.
import fs from "node:fs";
import { extractMethod, compile, BACKGROUND } from "./_extract.mjs";
import { createTargetWorld } from "./_workflow-target-fixture.mjs";

let passed = 0;
let failed = 0;
const ok = (condition, message) => {
  console.log(`  ${condition ? "PASS" : "FAIL"} ${message}`);
  if (condition) passed++; else failed++;
};
const bg = fs.readFileSync(BACKGROUND, "utf8");
function fullFunction(name) {
  const found = new RegExp(`(?:async )?function ${name}\\([^]*?\\)\\s*\\{`).exec(bg);
  if (!found) throw new Error(`Missing function ${name}`);
  let depth = 1;
  for (let i = found.index + found[0].length; i < bg.length; i++) {
    if (bg[i] === "{") depth++;
    if (bg[i] === "}" && --depth === 0) return bg.slice(found.index, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}
function executor(world, { allowed = true, queryReply } = {}) {
  const messages = [];
  const clicks = [];
  const moves = [];
  const writes = [];
  const code = [
    "queryWorkflowReplayTargetState", "resolveTargetToCoordinates", "resolveRefToCoordinates",
    "runShortcutToolSteps", "shortcutDriftReason", "shortcutResultMarkerLine",
    "shortcutStepProducesContent", "batchItemResultFailed", "describeTargetText", "parseModifierString"
  ].map(fullFunction).join("\n");
  const methods = compile(`${code}\nconst toolHandlers = {${extractMethod("computer")}, ${extractMethod("form_input")}};`, {
    SHORTCUT_TAB_SCOPED_TOOLS: new Set(["computer", "form_input"]),
    isInGroup: async () => allowed,
    sendContentMessage: async (tabId, message) => {
      messages.push({ tabId, ...message });
      if (message.type === "getWorkflowReplayTargetState" && queryReply !== undefined) return queryReply;
      if (message.type === "setFormValue") { writes.push(message); return { result: { set: true } }; }
      return world.send(message);
    },
    currentAction: null, currentActionExtras: null,
    screenshotToCssCoordinate: (_tab, point) => point,
    mouseClick: async (...args) => { clicks.push(args); },
    dispatchMouse: async (...args) => { moves.push(args); },
    humanizeOn: async () => false, isBrave: async () => false, cursorByTab: new Map(),
    probeHit: async () => null, hitLandedNote_: () => "", formatHit: () => "", dbg() {},
    probeNotes_: () => ({ note: "", warning: "" }),
    makePointerStepHandler: () => null, openListNote_: async () => ""
  }, "{ runShortcutToolSteps, queryWorkflowReplayTargetState, ...toolHandlers }");
  return {
    ...methods, messages, clicks, moves, writes,
    run(target, extra = {}, tool = "computer") {
      return methods.runShortcutToolSteps({ id: "fixture", steps: [{ kind: "tool", ref: tool, args: { action: "left_click", target, ...extra } }] }, 7, { prove: true });
    }
  };
}

console.log("== supported expanded and collapsed widget states ==");
for (const expanded of [true, false]) {
  const world = createTargetWorld();
  const { target, control } = world.widget({ expanded });
  const run = executor(world);
  const result = await run.run(target);
  ok(result.ok && run.clicks.length === (expanded ? 0 : 1), `${expanded ? "expanded" : "collapsed"} widget: real proof executor dispatches ${expanded ? 0 : 1} clicks`);
  if (expanded) {
    ok(result.outcomes[0].state === "already_satisfied" && /no click dispatched/.test(result.outcomes[0].note), "skipped expansion records an explicit state and truthful note");
    ok(JSON.parse(result.marker.slice("OCIC_WORKFLOW_RESULT ".length)).steps[0].state === "already_satisfied", "the durable workflow result marker preserves already_satisfied");
    ok(world.mutations.length === 0 && run.messages.length === 1, "state query never scrolls, assigns a clicked ref, or modifies the document");
  } else {
    const clicked = run.clicks[0];
    const rect = control.getBoundingClientRect();
    ok(clicked?.[0] === 7 && clicked[1] === rect.left + rect.width / 2 && clicked[2] === rect.top + rect.height / 2, "collapsed widget uses exact live control coordinates in the real computer handler");
    ok(!result.outcomes[0].state, "an actual click is not recorded as already satisfied");
  }
}

console.log("== no-click checks require complete unambiguous widget evidence ==");
const rejected = [
  ["missing paired attribute", (w, v) => { delete v.control.attrs["data-search-simple"]; }],
  ["empty opposite label", (w, v) => { v.control.attrs["data-search-simple"] = ""; }],
  ["equal mode labels", (w, v) => { v.control.attrs["data-search-simple"] = v.target.name; }],
  ["changed live label", (w, v) => { v.control._text = "An unrelated action"; }],
  ["inconsistent accessible label", (w, v) => { v.control.attrs["aria-label"] = "Different action"; }],
  ["wrong role", (w, v) => { v.control.attrs.role = "button"; }],
  ["missing form", (w, v) => { w.doc.body.appendChild(v.control); }],
  ["panel in different form", (w, v) => { w.doc.body.appendChild(w.element("form")).appendChild(v.panel); }],
  ["duplicate target widget", (w) => { w.widget(); }],
  ["duplicate panel", (w, v) => { v.form.appendChild(w.element("div", { attrs: { class: "panel-body advance-search" } })); }],
  ["second widget in form", (w, v) => { const another = w.widget({ expand: "Open another search" }); v.form.appendChild(another.control); }],
  ["hidden heading", (w, v) => { v.control.attrs.hidden = ""; }],
  ["hidden panel", (w, v) => { v.panel.style.display = "none"; }],
  ["invisible ancestor", (w, v) => { v.form.style.visibility = "hidden"; }],
  ["transparent ancestor", (w, v) => { v.form.style.opacity = "0"; }],
  ["disabled heading", (w, v) => { v.control.attrs["aria-disabled"] = "true"; }],
  ["disabled form ancestor", (w, v) => { v.form.attrs.disabled = ""; }],
  ["inert form ancestor", (w, v) => { v.form.attrs.inert = ""; }],
  ["assistant overlay", (w, v) => { v.form.attrs["data-browzy-overlay"] = ""; }],
  ["zero size panel", (w, v) => { v.panel.rect.height = 0; }],
  ["clipped zero-height ancestor", (w, v) => {
    const collapsed = v.form.appendChild(w.element("div", { style: { overflow: "hidden" }, rect: { height: 0 } }));
    collapsed.appendChild(v.panel);
  }],
  ["covered heading", (w, v) => { w.doc.body.appendChild(w.element("div", { rect: { ...v.control.rect } })); }]
];
for (const [label, mutate] of rejected) {
  const world = createTargetWorld();
  const widget = world.widget();
  mutate(world, widget);
  const run = executor(world);
  const result = await run.run(widget.target);
  ok(!result.ok && result.drift?.reason === "target_no_longer_resolves" && run.clicks.length === 0 && !result.outcomes[0].state, `${label}: no fabricated success or opposite-state click`);
}

console.log("== state is independent of viewport scroll and panel popup overlays ==");
for (const position of [-2000, 2000]) {
  const world = createTargetWorld();
  const widget = world.widget();
  widget.control.rect.y = position;
  widget.panel.rect.y = position + 70;
  const run = executor(world);
  const result = await run.run(widget.target);
  ok(result.ok && run.clicks.length === 0 && world.mutations.length === 0, `rendered expanded panel at y=${position} needs neither a click nor inspection scrolling`);
}
{
  const world = createTargetWorld();
  const widget = world.widget();
  world.doc.body.appendChild(world.element("div", { attrs: { role: "listbox" }, rect: { x: 20, y: 663, width: 705, height: 500 } }));
  const run = executor(world);
  const result = await run.run(widget.target);
  ok(result.ok && run.clicks.length === 0, "an open combo popup covering the panel does not falsely collapse it");
}
{
  const world = createTargetWorld();
  const widget = world.widget({ expand: "Afficher les filtres", simple: "Masquer les filtres" });
  const result = await executor(world).run(widget.target);
  ok(result.ok, "labels come from the widget attributes, without Vietnamese text or a hostname rule");
  ok(world.state({ ...widget.target, name: "Afficher" }) === null, "a partial expansion label cannot establish desired state");
  ok(world.state({ ...widget.target, name: "Masquer les filtres" }) === null, "an explicit collapse request is never mistaken for expansion");
  ok(world.state({ ...widget.target, role: "button" }) === null, "the state query requires the recorded role to agree");
}
{
  const world = createTargetWorld();
  const widget = world.widget();
  const actual = world.doc.body.appendChild(world.element("a", { text: widget.target.name, rect: { x: 100, y: 100 } }));
  const run = executor(world);
  const result = await run.run(widget.target);
  ok(result.ok && run.clicks.length === 1 && !result.outcomes[0].state && run.clicks[0][1] === actual.rect.x + 90, "a live exact label elsewhere keeps its real click instead of borrowing another widget's state");
}

console.log("== ordinary computer, modifiers, ref/coordinate aim, hover and form input are unaffected ==");
for (const extra of [ { modifiers: "ctrl" }, { ref: "original_ref" }, { coordinate: [50, 60] }, { start_coordinate: [50, 60] }, { action: "hover" } ]) {
  const world = createTargetWorld();
  const widget = world.widget({ expanded: false });
  const run = executor(world);
  const result = await run.run(widget.target, extra);
  ok(result.ok && !run.messages.some((m) => m.type === "getWorkflowReplayTargetState") && run.clicks.length + run.moves.length === 1, `${JSON.stringify(extra)} dispatches normally without state precheck`);
  if (extra.modifiers) ok(run.clicks[0][3].modifiers === 2, "the actual computer handler preserves ctrl modifier dispatch");
}
{
  const world = createTargetWorld();
  const widget = world.widget();
  const run = executor(world);
  const result = await run.computer({ tabId: 7, action: "left_click", target: widget.target });
  ok(/Could not resolve/.test(result.content[0].text) && run.clicks.length === 0 && !run.messages.some((m) => m.type === "getWorkflowReplayTargetState"), "ordinary computer still reports the exact missing identity even for an expanded widget");
  const form = await run.run({ role: "textbox", name: "Keyword" }, { value: "current value" }, "form_input");
  ok(form.ok && run.writes.length === 1 && run.writes[0].value === "current value" && !run.messages.some((m) => m.type === "getWorkflowReplayTargetState"), "form_input resolves the live field and writes the caller's value without a replay-state shortcut");
}
for (const queryReply of [ {}, { result: { alreadySatisfied: true } }, { result: { alreadySatisfied: true, state: "expanded", evidence: "guessed" } } ]) {
  const world = createTargetWorld();
  const widget = world.widget();
  const run = executor(world, { queryReply });
  const result = await run.run(widget.target);
  ok(!result.ok && result.drift?.reason === "target_no_longer_resolves", "missing/malformed state reply retains exact resolution failure");
}
{
  const world = createTargetWorld();
  const widget = world.widget();
  const run = executor(world, { allowed: false });
  ok(await run.queryWorkflowReplayTargetState(99, widget.target) === null && run.messages.length === 0, "tab scope is checked before sending any state query");
}

console.log(`\n${passed} passed; ${failed} failed`);
process.exitCode = failed ? 1 : 0;
