## Why

OpenAI now ships a Decisions API (`POST /v1/decisions`, model `gpt-6-luna`) that answers typed choice questions over text **and inline images**. Today a `browser_subgoal` cycle that wants visual evidence must send the screenshot to the profile's primary LLM, which turns it into text (`visualNotes`) before Jev decides from text only. With an image-capable decision model, the decision step can look at the page directly, and the primary LLM can be limited to generating text.

## What Changes

- Add a fifth Jev transport source, `openai` ("OpenAI Decisions"), to the decision client: `POST {base}/v1/decisions`, Bearer auth, default base `https://api.openai.com`, default model `gpt-6-luna`.
- Translate each Jev head (including yes/no heads) into one OpenAI `choice` question and map the `answers` array back into the existing validated Jev decision shape. Missing probabilities or confidence fail as `INVALID_RESPONSE`; nothing is invented.
- When the source is `openai` and the screenshot toggle is on, send the page capture to the decision request as an `input_image` data URL. The primary LLM's planning and completion steps then receive no screenshot and produce no image-derived `visualNotes`; they only generate text.
- Other sources keep their current behavior.
- The capability test for `openai` runs a text decision probe and an image decision probe.
- Settings: add the source option, its transport key field, and its default base URL/model. The key is stored only in the profile's settings storage.
- Update the README "Jev browser tools" section.

## Capabilities

### New Capabilities
- `openai-decisions-jev-source`: The OpenAI Decisions wire: request translation, response mapping, validation, image input, and capability probing.

### Modified Capabilities
- `agent-settings`: Add `openai` as a selectable Jev transport source with its own key, default base URL, and default model.
- `jev-browser-subgoal`: For the `openai` source, screenshots go to the decision model instead of the primary LLM, and the LLM only generates text.

## Impact

- Code: `host/agent/jev/client.js`, `host/agent/jev/runtime.js`, `host/agent/jev/text-helper.js`, `host/agent/jev/capability.js`, `host/agent/settings/profile.js`, `host/agent/companion.js` (source plumbing), `extension/settings/settings.html`, `extension/settings/settings-controller.js`.
- Tests: new `host/test/jev-openai-decisions.test.mjs`, plus updates to the capability, settings, and subgoal tests.
- Docs: README.
- External: OpenAI billing ($0.10 per 1M input tokens). No new npm dependencies.
- Security: no API key appears in the repo. Tests use fake keys and an injected `fetch`.
