// Claude-in-Chrome-faithful tool definitions for the Messages API harness.
// `computer` follows Anthropic's computer-use beta schema (2025-01-24) — the
// same shape the official extension drives. `navigate` mirrors Browzy's
// background navigate() (url | "back" | "forward").
// Browzy's computer() implements a subset; anything outside it is translated
// by extension/agent/bridge.js or refused with retry guidance (never dropped
// silently). Schemas here stay faithful so the captured system prompt's tool
// descriptions keep matching what the model can emit.

export const CIC_BETAS = ["computer-use-2025-01-24"];

export const COMPUTER_TOOL = {
  type: "computer_20250124",
  name: "computer",
  display_width_px: 1280,
  display_height_px: 800,
  display_number: 1,
};

export const NAVIGATE_TOOL = {
  name: "navigate",
  description:
    "Navigate the active agent tab. Give a full URL (scheme defaults to https), or \"back\" / \"forward\" for history. Waits briefly for the load to settle.",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Destination URL, or \"back\" / \"forward\".",
      },
    },
    required: ["url"],
  },
};

// Static description of the computer tool's action space, appended to the
// system prompt so models without built-in computer-use knowledge still emit
// well-formed actions. Mirrors the beta action set.
export const COMPUTER_ACTION_GUIDE = [
  "Browser actions available through the `computer` tool (tabId required on every call):",
  "- screenshot: capture the current viewport (returns an image you can see). Always screenshot before acting on a new page.",
  "- left_click / right_click / double_click / triple_click + coordinate [x, y]: click at a point read off the last screenshot (origin top-left). Prefer ref over coordinate whenever you have one.",
  "- left_click_drag + start_coordinate + coordinate: drag from start to end.",
  "- hover + coordinate/ref: move over an element without clicking. Reveals tooltips, dropdown menus, hover states.",
  "- scroll_to + ref: scroll an element into view by reference ID. No pixel guessing.",
  "- zoom + region [x0, y0, x1, y1]: close-up screenshot of a rectangular region for small controls.",
  "- scroll + coordinate + scroll_direction (up/down/left/right) + scroll_amount (wheel ticks, default 3).",
  "- type + text: type into the focused control. Click the field first.",
  "- key + text: press a key or chord (e.g. Enter, Escape, Tab, ctrl+l, ctrl+c). repeat 1-100, default 1.",
  "- modifiers on clicks: ctrl, shift, alt, cmd (meta), win — combinable with + (e.g. ctrl+shift).",
  "- mouse_move + coordinate: move without clicking. cursor_position: report the cursor. wait + duration in seconds (max 30).",
  "Coordinates are in screenshot pixels. If an action fails, screenshot again — the page moved under you.",
].join("\n");

export function cicTools(displayWidthPx = 1280, displayHeightPx = 800) {
  return [
    { ...COMPUTER_TOOL, display_width_px: displayWidthPx, display_height_px: displayHeightPx },
    NAVIGATE_TOOL,
  ];
}

export const READ_PAGE_TOOL = {
  name: "read_page",
  description:
    "Read the page structure ONCE as an accessibility tree with element refs. Prefer this over screenshots for understanding layout. Returns refs you can act on.",
  input_schema: {
    type: "object",
    properties: {
      max_chars: { type: "number", description: "Max characters of the tree. Omit unless the page is huge." },
    },
  },
};

export const BROWSER_BATCH_TOOL = {
  name: "browser_batch",
  description:
    "Run several actions in ONE call, in order: [{name, input}]. Names allowed inside: computer, navigate, read_page, find. Stops after the first failure or page change. USE THIS for every multi-step sequence instead of one tool call per action.",
  input_schema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        description: "Ordered list of {name, input} steps. Keep it to what the current page state supports.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: ["computer", "navigate", "read_page", "find"] },
            input: { type: "object", description: "Args for that tool (tabId is filled automatically, omit it)." },
          },
          required: ["name", "input"],
        },
      },
    },
    required: ["actions"],
  },
};

// The curated set the harness model actually sees: 7 tools.
// computer (act) + navigate (move) + tabs (locate/create) + read_page (observe) + find (locate) + browser_batch (bundle).
export const FIND_TOOL = {
  name: "find",
  description:
    "Locate a control by description ('login button', 'search field'). Returns [ref] role, name and EXACT screenshot coordinates. NEVER eyeball pixels from a screenshot when you can find first — act on the returned coordinates.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, as the user would name it." },
    },
    required: ["query"],
  },
};

export const TABS_CONTEXT_TOOL = {
  name: "tabs_context",
  description:
    "List all tabs in the current group with their tab IDs. Call this FIRST before navigate or any tab action — every tab tool needs a valid tabId.",
  input_schema: { type: "object", properties: {} },
};

export const TABS_CREATE_TOOL = {
  name: "tabs_create",
  description: "Create a new empty tab in the current group. Returns its tab ID.",
  input_schema: { type: "object", properties: {} },
};

export function cicHarnessTools(displayWidthPx = 1280, displayHeightPx = 800) {
  const [computer] = cicTools(displayWidthPx, displayHeightPx);
  return [computer, NAVIGATE_TOOL, TABS_CONTEXT_TOOL, TABS_CREATE_TOOL, READ_PAGE_TOOL, FIND_TOOL, BROWSER_BATCH_TOOL];
}
