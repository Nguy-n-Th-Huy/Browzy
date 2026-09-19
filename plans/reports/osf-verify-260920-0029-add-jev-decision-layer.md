# Báo cáo xác minh: add-jev-decision-layer

Ngày: 2026-09-20
Phạm vi: `host/agent/jev/{text-helper,questions,client,capability,runtime}.js`, `extension/content.js` (docNonce trong page_snapshot), và các bề mặt protocol/panel/tài liệu bị ảnh hưởng trực tiếp cùng test tương ứng.

## Kết luận tổng quan

Không phát hiện CRITICAL. Việc triển khai bám sát design.md và hai spec delta (`typesafe-jev-provider`, `jev-decision-layer`) ở mức chi tiết cao — kể cả các quy tắc tinh vi (round-robin candidate fitting, fail-closed docNonce, consume-once cho prepared content, precedence DONE trước ASK/REPLAN, các budget riêng biệt không reset lẫn nhau).

## Xác minh OpenSpec

- `openspec validate add-jev-decision-layer --strict` → **PASS** ("Change 'add-jev-decision-layer' is valid").
- Tất cả 8 mục trong `tasks.md` đã đối chiếu với code thực và test thực (không có mục nào chỉ đánh dấu `[x]` suông).

## Xác minh test (chạy trực tiếp, không lấy số liệu từ tasks.md làm bằng chứng)

`npm --prefix host test` (script thực tế trong `host/package.json` chỉ chạy `endpoint`, `parent-watch`, `ownership`) → **22/22 passed**, khớp đúng số tasks.md 3.3 nêu ("npm --prefix host test (22 passed)"). Đây là bằng chứng cho thấy claim của tasks.md phản ánh đúng script cấu hình, không phải con số bịa.

Chạy trực tiếp từng file test liên quan đến Jev (không qua wrapper script vì `host/package.json`'s `test` không include chúng):

| File | Kết quả | Khớp claim tasks.md |
|---|---|---|
| `host/test/jev-runtime.test.mjs` | 119/119 | Khớp "runtime suite 119/119" |
| `host/test/jev-decision-runtime.test.mjs` | 31/31 | Khớp "focused decision runtime 31/31" |
| `host/test/jev-decision-protocol.test.mjs` | 13/13 | Khớp "protocol 13/13" |
| `host/test/jev-questions.test.mjs` | 32/32 | — |
| `host/test/jev-client.test.mjs` | 24/24 | — |
| `host/test/jev-capability.test.mjs` | 20/20 | — |
| `host/test/jev-text-helper.test.mjs` | 96/96 | Khớp "helper suite 96/96" (task 1.1) |
| `host/test/jev-source-fetch.test.mjs` | 12/12 | — |
| `host/test/dispatch-checks.test.mjs` | 12/12 | — |
| `host/test/agent-typesafe-run.test.mjs` | 9/9 | Khớp "companion integration 9/9" |
| `host/test/settings-typesafe.test.mjs` | 20/20 | Khớp "settings compatibility 20/20" |
| `host/test/settings-capability-test.test.mjs` | 14/14 | — |
| `host/test/settings-all.test.mjs` | 4/4 | — |
| `host/test/agent-protocol.test.mjs` | 11/11 | — |
| `host/test/agent-companion-core.test.mjs` | 20/20 | — |
| `test/page-snapshot-content.test.mjs` (extension, root) | ALL PASSED (bao gồm 4 test docNonce mới) | — |
| `test/sidepanel-conversation-model.test.mjs` | ALL PASSED (bao gồm "attributes the decision to Jev", "action probabilities are not labelled target confidence", "independent monitors remain advisory") | — |
| `test/sidepanel-streaming-render.test.mjs` | ALL PASSED | — |

Không có test nào skip/todo/fail trong toàn bộ danh sách trên. Không có phép đo tốc độ/độ chính xác model thật nào được thực hiện hay tuyên bố (đúng ràng buộc của nhiệm vụ).

Không tìm thấy `package.json` ở gốc repo (không có root test command khác ngoài `host/package.json`'s script đã kiểm tra).

## Đối chiếu spec ↔ code (từng requirement quan trọng)

**Ba đầu Choice độc lập (action/goal_done/stuck):** `host/agent/jev/questions.js:703-714` (`validateDecision`) buộc đúng 3 tên head, đúng 3 khóa answers, mỗi head validate độc lập qua `validateChoiceAnswer` (khóa được offer, xác suất phủ đúng tập offered, tổng ≈1, khóa chọn phải là max). `buildDecisionRequest` (dòng 726-788) build đúng 3 câu hỏi `action`, `goal_done`, `stuck` trên cùng state — khớp design.md mục 2 và spec "Single-request decision protocol".

**docNonce fail-closed, không thay bằng URL equality:** `extension/content.js:1550` expose `docNonce` trong `page_snapshot`; `host/agent/jev/questions.js:735` chỉ đưa prepared TYPE_TEXT vào candidate khi `snapshot.docNonce` là string không rỗng VÀ khớp chính xác `record.docNonce`; `host/agent/jev/runtime.js:825` ném lỗi `INVALID_RESPONSE` nếu chuẩn bị text mà không có `snapshot?.docNonce`. Test `test/page-snapshot-content.test.mjs` xác nhận nonce bền vững qua SPA navigation và đổi khi tài liệu bị thay thế ở cùng URL.

**Consume-once cho prepared content, không tái sử dụng qua field khác:** `runtime.js:701-703` đánh dấu `record.consumed = true` ngay trước khi vượt qua bridge (comment: "Consume before crossing the bridge: an unknown result cannot be retried"); `questions.js:735` loại bỏ record đã `consumed` hoặc không khớp đúng `ref/role/label` của field quan sát hiện tại — không cross-bind theo ngữ nghĩa.

**Reobserve + validate trước dispatch, stale bị skip chứ không remap:** `runtime.js:665-688` quan sát lại sau `canUseTool`, so khớp toàn bộ identity fields, `docNonce`, `url`, và tính hợp lệ của `preparedId`; nếu bất kỳ điều kiện nào sai → trả `{ ok:false, stale:true }` (bị skip, tính vào no-progress) thay vì remap sang key khác — khớp scenario "State changes during decision" của spec `jev-decision-layer`.

**Hoàn thành yêu cầu xác minh LLM trước khi thành công, reject có giới hạn, fail → blocked completion-unverified:** `runtime.js:1025-1122` — DONE hoặc `goalDone` dương đều đi qua `requestCompletionCheck`; `check.achieved === true` mới được `finish({outcome:"done", doneVerified:true})`; check null/lỗi → `blocked/completion_unverified`; reject tăng `verificationRejections`, cập nhật memory (xoá `prepared` cũ), đạt `maxVerificationRejections` → `blocked/completion_unverified`. Khớp chính xác toàn bộ các scenario liên quan trong spec.

**ASK/REPLAN không reset budget toàn cục, WAIT tính vào bound:** `runtime.js:1124-1138` (ASK/REPLAN dùng `emitStep` + `finish`/`continue`, không đụng tới `executed`/`decisionsMade`); `runtime.js:1208-1210` WAIT dispatch qua `computer`/`wait` — đi qua cùng pipeline dispatch tính vào `maxActions`. Các bound riêng (`maxActions`, `maxDecisions`, `maxMemoryUpdates`, `maxVerificationRejections`, `maxReplansWithoutProgress`) độc lập, mỗi bound có lý do kết thúc named riêng (dòng 339-344, 858, 902, 1119, 1144).

**Capability test 3 giai đoạn dùng đúng validator runtime, không giữ probe hợp cũ:** `host/agent/jev/capability.js:82-84` gọi thẳng `buildDecisionRequest`/`validateDecision` — cùng hàm runtime dùng cho quyết định thật — không phải một probe đơn-head cũ. Test `settings-typesafe.test.mjs` ("the capability test records three stages and a failed image stage never strands the profile") và `settings-capability-test.test.mjs` xác nhận stage ảnh fail không chặn runnable.

**Gán nhãn quy kết trung thực (Jev vs mô hình):** `extension/sidepanel/tool-labels.js:405,431,458` và `conversation-model.js:1183` dùng `step.decisionSource === "jev"` để chọn nhãn "Jev" so với "mô hình", và record cũ (không có field này) vẫn hiển thị đúng nhãn "mô hình" — khớp yêu cầu "Prior records ... still render faithfully" và "Decision attribution is observable".

**Không còn fallback âm thầm về kiến trúc NEXT_STEP mỗi bước:** `runtime.js` không import `requestStepDecision` từ `text-helper.js` (chỉ import `requestActionPlan`, `requestCompletionCheck`, `requestFinalReport`); hàm `requestStepDecision` legacy vẫn tồn tại trong `text-helper.js` (dùng cho test riêng của nó) nhưng không được runtime gọi ở đường đi chính — không có "silent fallback".

## Các phát hiện

Không có phát hiện CRITICAL.

**WARNING:** Không tìm thấy.

**SUGGESTION (không chặn archive):**
1. Một số comment trong `extension/sidepanel/tool-labels.js` và `extension/sidepanel/conversation-model.js` tham chiếu "design.md §7/§8/§10" mà không luôn kèm tên change — các tham chiếu này thực chất trỏ về design.md của các change TRƯỚC (`add-typesafe-jev-provider`, `add-jev-run-context`), không phải design.md của `add-jev-decision-layer` (design.md của change này không dùng đánh số §, dùng "### 1..4"). Đây là comment lịch sử hợp lệ giải thích tiến hoá code qua nhiều change, không phải lỗi của change này, nhưng dễ gây nhầm lẫn cho người đọc sau này nếu không có tên change đi kèm mỗi lần. Không cần sửa ngay.
2. `requestStepDecision` trong `host/agent/jev/text-helper.js:1542` không còn được runtime gọi (dead từ góc nhìn production path) nhưng vẫn export và có test riêng (`jev-text-helper.test.mjs`). Không sai theo spec (spec không yêu cầu xoá), nhưng nếu không còn mục đích sử dụng nào khác, có thể cân nhắc dọn dẹp ở một change sau.

## Ghi chú phạm vi

Git status của nhánh cho thấy rất nhiều file khác (extension/background.js, settings/*, host/agent/companion.js, v.v.) đang bị chỉnh sửa đồng thời bởi phiên làm việc khác trên cùng nhánh — các thay đổi đó KHÔNG thuộc phạm vi `add-jev-decision-layer` (proposal.md liệt kê rõ impact: `questions.js`, `client.js`, `text-helper.js`, `runtime.js` + protocol/capability/panel/docs trực tiếp liên quan). Các file đó không được đánh giá CRITICAL/WARNING ở đây — chúng thuộc quyền sở hữu của phiên khác, đúng theo ranh giới phạm vi được giao.

## Trạng thái

Status: DONE
Summary: Triển khai add-jev-decision-layer khớp đầy đủ với proposal/design/2 spec delta; tất cả 8 tasks đều có code thật + test thật hậu thuẫn; toàn bộ test suite liên quan (jev-*, dispatch-checks, agent-typesafe-run, settings-typesafe, settings-capability-test, page-snapshot-content, sidepanel-conversation-model/streaming-render) chạy trực tiếp đều pass đúng số lượng tasks.md công bố; `openspec validate --strict` pass. Không có CRITICAL/WARNING, chỉ 2 SUGGESTION không chặn archive.
Concerns/Blockers: Không có blocker. Hai suggestion (chú thích §-reference dễ nhầm nguồn, và `requestStepDecision` dead trên production path) chỉ mang tính dọn dẹp, không ảnh hưởng chức năng hay an toàn.
