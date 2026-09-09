# BLOCKER — `settingSources: ['project']` rò rỉ skill từ mọi thư mục tổ tiên

Change: `repair-slash-dispatch-and-builtin-commands`
Ngày: 2026-09-09
Trạng thái: **STOP-SHIP tại task 5.4**. Nhóm 5.6, 5.7, 5.3, 4.1, 4.2, 5.8 chưa thực hiện.

## Kết luận

Design decision 7 chọn thêm `'project'` vào `settingSources` để SDK phát hiện được
snapshot skill trong session workspace. Decision 7 tự nêu điều nó chưa biết:
`'project'` có bị giới hạn ở `cwd/.claude` hay đi ngược lên cây thư mục. Task 5.4
được viết ra để trả lời bằng test thật. Kết quả: **đi ngược lên, không giới hạn**.

## Bằng chứng

Real `query()` (CLI thật, không mock), `cwd` = session workspace tạm, hai sentinel
với tên sinh ngẫu nhiên. Mảng `skills` trong message `system`/`init`, 18 mục:

```
zz-sentinel-workspace-ddaa22abd49b   <- mong đợi có
zz-sentinel-parent-61d4a74cfc8a      <- KHÔNG được có, nhưng có
deep-research design-sync dataviz update-config verify debug code-review
simplify batch fewer-permission-prompts doctor loop claude-api
workflow-authoring run run-skill-generator
```

Hai biến thể chẩn đoán:

| Biến thể | Thiết lập | Kết quả |
|---|---|---|
| A | Thư mục cha có `.claude/skills/<sentinel>` nhưng **không** có `.git` | Sentinel cha **vẫn rò rỉ** |
| B | Không có `.claude/skills/` ở bất kỳ cấp cha nào | Sạch — chỉ workspace sentinel + 16 skill CLI |

Biến thể A quan trọng: rò rỉ **rộng hơn** điều decision 7 lo ngại. Không hề có
gating theo repo-root. Bất kỳ thư mục tổ tiên nào chứa `.claude/skills/` đều bị
phát hiện.

## Hệ quả trên máy thật (đã xác minh độc lập)

- Session workspace thật: `C:\Users\Admin\.config\browzy-in-chrome\agent\conversations\<id>\`
  (`host/agent/settings/paths.js:27`, `OCIC_AGENT_HOME` không đặt)
- Tổ tiên `C:\Users\Admin\` chứa `.claude\skills\` với **189 skill** của operator

Nên mọi conversation thật trên máy này sẽ phát hiện và cấp quyền truy cập toàn bộ
bộ skill toàn cục của operator. Đây chính xác là rò rỉ mà decision 7 tưởng đã ngăn
được bằng cách không bật `'user'` — nó vào bằng cửa khác.

## Trạng thái cây làm việc (chưa commit)

```
 M host/agent/tools/query-options.js                      settingSources [] -> ["project"] + comment
 M host/test/agent-skills-wiring.test.mjs                 assertion posture
 M host/test/agent-tool-permission-preapproval.test.mjs   assertion posture
 M test/sidepanel-slash-picker-dispatch.test.mjs          assertion posture
 ?? host/test/skills-scope-verification.test.mjs          test cổng (đang RED, đúng)
```

Comment inline mới thêm gần dòng `settingSources` khẳng định "does not leak
anything from outside that workspace" — khẳng định này **đã bị bằng chứng bác bỏ**.
Chưa sửa, để trạng thái blocked hiển thị nguyên vẹn cho review.

Nhóm task 1–3 (đã commit) vẫn đúng, nhưng tự nó chỉ biến `Unknown command: /x`
thành `Unknown skill: x`.

## Câu hỏi chưa giải quyết

1. Có cơ chế nào bound được walk-up của `'project'` ở phía SDK không (marker file,
   option khác), hay phải bỏ hẳn `settingSources` làm đường phát hiện skill?
2. Nếu bỏ: đường thay thế để SDK thấy snapshot workspace là gì — `skills` option
   nhận đường dẫn tuyệt đối? một `agents`/plugin surface khác? Cần đọc `sdk.d.ts`.
3. Có nên đặt session workspace ở nơi không có tổ tiên nào chứa `.claude/` như một
   biện pháp giảm nhẹ tạm thời? (Mong manh — phụ thuộc bố cục máy operator.)
4. Giữ hay revert 5.1/5.2/5.5? Hiện giữ làm bằng chứng cho vòng thiết kế lại.
