# Proposal: Completion Report Bound

## Why

Seen live: the run "Phân tích nội dung trang này giúp mình." ended `done` with the completion check **confirmed** — and no report, because the model's report was **1,571 characters against the 1,400-character bound**, so the validator discarded it and the panel read "kiểm tra hoàn thành đã xác nhận, nhưng không tạo được báo cáo". The analysis existed; a digit stopped it. The bound was sized in the run-context change for a short result blurb, not for the analysis goals the loop now serves.

## What Changes

- **The report bound moves 1,400 → 4,000 characters** (`MAX_REPORT_CHARS`), so a real analysis fits while the bound stays a bound.
- **The completion check gets its own output budget**: `max_tokens: 4096` for that one request (a 4,000-character Vietnamese report cannot be emitted inside the shared 1,024-token budget; a truncated JSON would be worse). Every other configured-model call keeps `1,024`.
- **The completion-check instruction targets the bound** — wording changes from "a concise report" to a focused report kept within the stated bound; the no-invention and "Bước tiếp theo" rules are unchanged.
- **Unchanged**: parse/verdict semantics (a report beyond the bound is still recorded as an unusable-report failure with the verdict standing), every other call, the panel copy (which already names the case correctly).

## Capabilities

### New Capabilities
- (none)

### Modified Capabilities
- (none — the report bound and the request's token budget are implementation-level values; no requirement text changes. The change is marked `skip_specs: true`, and the existing "The result report cannot be produced" scenario continues to describe the beyond-bound behavior.)

## Impact

- **Host**: `host/agent/jev/text-helper.js` (`MAX_REPORT_CHARS`, a per-call `maxTokens` seam on the shared builder, the completion-check instruction wording) and `host/test/jev-text-helper.test.mjs`.
- **Docs/specs**: none (README already describes the report without a number).
