# Browzy panel design DNA

Grounded in `extension/ui/tokens.css`, `extension/ui/prose.css`, and the existing sidepanel timeline/thinking disclosures.

- Preserve the existing neutral surfaces, accent/focus colors, spacing, borders and radius tokens. No new palette or layout system.
- Use `--font-sans` for Vietnamese answer prose and UI, `--font-serif` for existing headings, and `--font-mono` only for code.
- Keep requested results primary. Optional diagnostics use a keyboard-operable disclosure; incomplete outcomes remain visible.
- Tables scroll within their container. Long names and URLs wrap without widening the panel.
- Timeline summaries disclose actual browser operations separately from planning/checking activity. Unknown historical facts stay unknown.
- Evidence uses bounded recorded text and historical image artifacts. Disabled, missing and failed images have explicit text states; opening evidence never captures a new image.
- Preserve the existing accessible focus ring, semantic buttons, status regions, and terminal/permission priority.
