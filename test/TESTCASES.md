# Browzy in Chrome — Bộ test case thủ công

> Phạm vi: **browser tools thực tế**, **quản lý tab/group**, **overlay điều khiển từ xa**, **recorder (imitation learning)**, **audit**.
> Baseline đối chiếu: extension chính thức **Claude in Chrome**.
> Môi trường tham chiếu: Brave (Chromium 152) / Windows 11, Browzy 1.0.0, side panel (SDK path).

---

## 0. Quy ước

| Ký hiệu | Ý nghĩa |
|---|---|
| **P0** | Chặn phát hành — chức năng lõi hoặc an toàn người dùng |
| **P1** | Nghiêm trọng — sai lệch rõ so với Claude in Chrome |
| **P2** | Trung bình — trải nghiệm / hiệu năng |
| **P3** | Thấp — mỹ thuật, wording |
| **SP** | Side panel (đường SDK, không cần tài khoản Claude) |
| **MCP** | External MCP (Claude Code) |

**Điều kiện tiên quyết chung (PRE):**

1. Đã chạy `install.ps1` / `install.sh`, native host chạy được.
2. Extension nạp ở `brave://extensions`, bật Developer mode, ID = `ihljfjgoakmoemkdondoaadegpmibimh`.
3. Side panel đã cấu hình provider hợp lệ (Settings → provider + API key), trạng thái panel = sẵn sàng.
4. Có ít nhất 1 tab trang thường (https) để làm tab công tác.

**Probe đo overlay** (dán vào DevTools console của tab bị điều khiển, chạy TRƯỚC khi ra lệnh):

```js
(() => {
  const log = [], t0 = Date.now();
  const snap = () => {
    const h = document.querySelector('[data-browzy-overlay]');
    return h ? { present: true, vis: h.style.visibility } : { present: false };
  };
  let prev = JSON.stringify(snap());
  log.push({ t: 0, state: JSON.parse(prev) });
  setInterval(() => {
    const s = snap(), j = JSON.stringify(s);
    if (j !== prev) { prev = j; log.push({ t: Date.now() - t0, state: s }); }
  }, 100);
  window.__ovProbe = { log };
  return 'probe on';
})()
```

Sau khi chạy lệnh, đọc `window.__ovProbe.log`. Phân biệt 3 trạng thái, đây là điểm mấu chốt khi log bug:

| Kết quả probe | Nghĩa | Khâu hỏng |
|---|---|---|
| `present: false` suốt | overlay chưa từng được inject | `sendOverlayMessage()` / `executeScript` |
| `present: true`, `vis` luôn `hidden` | inject rồi nhưng không bật hiển thị | `computeRenderModel()` / heartbeat / action-event |
| `present: true`, `vis: visible` | overlay chạy đúng | — |

Thêm hook debug có sẵn: `window.__browzyOverlay.getState()` và `.getRenderModel()`.

---

## 1. Kết quả chạy thử & tình trạng lỗi

**Ngày chạy:** 2026-09-07 · **Cách chạy:** unit suite `test/*.test.mjs` (Node 22) + harness trích trực tiếp từ mã đã ship qua `test/_extract.mjs`.
**Lưu ý quan trọng:** `extension/background.js` và `extension/overlay/pointer-overlay.js` được sửa **trong lúc phiên test này đang chạy** (mtime 19:02 và 19:03). Các kết luận dưới đây bám theo **working tree tại thời điểm 19:05**, không phải bản đã commit.

### 1.1 Unit suite

| Hạng mục | Kết quả |
|---|---|
| Tổng | **46/47 PASS** |
| `tab-group-inheritance.test.mjs` | PASS — 60 check |
| `handlers.test.mjs` | PASS — 32 check |
| `overlay-background-bridge.test.mjs` | PASS — 79 check |
| `overlay-companion-sender.test.mjs` | PASS — 34 check |
| `action-events-emission.test.mjs` | PASS — 36 check |
| `overlay-pointer.test.mjs` | **FAIL — hồi quy mới, xem BUG-05** |
| `settings-ui-real-companion.test.mjs` | FAIL — cần credential provider thật (VM có mạng nhưng không có key hợp lệ). Không tính là lỗi sản phẩm |

---

### BUG-05 · `overlay-pointer.test.mjs` đỏ sau thay đổi overlay mới nhất · **P1 — chặn phát hành**

**Trạng thái:** MỞ, tái hiện 100%.

```
ReferenceError: isCaptureHideInForce is not defined
  at <extracted wiring block>:514
  test/overlay-pointer.test.mjs:519
```

Khối wiring trong `pointer-overlay.js` (dòng ~893) nay gọi `isCaptureHideInForce(now, capturedHiddenAt, CAPTURE_HIDE_MAX_AGE_MS)`, nhưng danh sách dependency mà `overlay-pointer.test.mjs:519` truyền vào `compile()` chưa có hàm này. Bản thân hàm tồn tại ở `pointer-overlay.js:130` và đã có test riêng ở dòng 106–120 — chỉ khối compile thứ hai bị bỏ sót.

Runtime thật **không** hỏng (cùng một IIFE nên hàm nhìn thấy được), nhưng theo quy ước của repo — test chạy trên **mã đã ship** — đây là test đỏ và phải xanh trước khi phát hành. Sửa: thêm `isCaptureHideInForce` (và các hằng liên quan) vào deps của lần `compile()` đó.

**Test case:** TC-OVL-17.

---

### BUG-01 · Overlay điều khiển không hiện — không ổn định · **P0**

**Trạng thái:** CHƯA KẾT LUẬN — cần probe trên máy thật.

**Hiện tượng.** Browzy đang thao tác (panel báo "Đang phản hồi", đã chạy N thao tác) nhưng trang **không** hiện con trỏ agent, khung điều khiển, badge và nút **Stop**. Cùng tác vụ, Claude in Chrome hiện đầy đủ con trỏ + pill *Stop Claude*. Lúc có lúc không.

**Bằng chứng.** Ảnh so sánh trên dauthau.info (2026-09-07): Claude in Chrome có con trỏ đỏ tại ô "Hải Phòng" + pill *Stop Claude*; Browzy chạy 7 thao tác, trang sạch trơn.

**Ảnh hưởng.** Mất khả năng quan sát và dừng khẩn — đúng cơ chế an toàn `design.md 5c` đặt ra. Người dùng không biết tab đang bị điều khiển và không có đường thoát ngoài mở panel.

**Đã loại trừ:**

- `overlay-background-bridge.test.mjs` (79 check) và `overlay-companion-sender.test.mjs` (34 check) xanh — cầu nối background ↔ overlay đúng ở mức đơn vị.
- `action-events-emission.test.mjs` (36 check) xanh — action-event có phát và `start` đi trước khi thực thi.
- Vấn đề `sendResponse` bị thiếu (từng làm mỗi event xử lý 2 lần) **đã được vá** trong working tree — xem BUG-04.

**Còn nghi (cần probe xác nhận):**

1. `emitActionStart()` lấy `tabId` **chỉ từ `args.tabId`**, và `forwardActionEventToOverlay()` `return` ngay khi `tabId` null ⇒ tool nào không mang `tabId` trong args thì bước đó không có overlay.
2. Race điều hướng: overlay inject vào document cũ, `pagehide` xoá timer, document mới chưa được inject lại cho tới action-event kế tiếp.
3. `chrome.scripting.executeScript` thất bại im lặng trên một số trang (không log, không fallback).

**Cách chốt:** chạy probe ở mục 0 rồi đọc `__ovProbe.log`. Ba trạng thái trong bảng ở mục 0 chỉ thẳng ra khâu hỏng. **Test case:** TC-OVL-01 → TC-OVL-03.

---

### BUG-02 · Ctrl+T khi agent đang chạy làm hỏng tab group · **P1**

**Trạng thái:** ĐÃ SỬA trong working tree — cần verify trên máy thật.

**Hiện tượng người dùng báo.** Đang chạy Browzy, bấm Ctrl+T mở tab riêng thì mất group. Claude in Chrome vẫn chạy bình thường khi mở tab khác làm việc khác.

**Mã hiện tại.** `guardInheritedTabGroup()` đã có nhánh `agentIsDriving && !(await looksLikeOperatorNewTab(tab))` — tab trắng do người dùng tạo bị `ungroup` kể cả khi agent đang chạy. `looksLikeOperatorNewTab()` còn đọc lại tab một lần nữa để phân biệt Ctrl+T với popup mà trang mở nhưng chưa commit URL. `adoptBorrowedTab()` cũng từ chối tab trắng bằng cùng `isBlankNewTab()`.

**Kiểm chứng.** `tab-group-inheritance.test.mjs` có hẳn khối gắn nhãn `BUG-02`, 60/60 check xanh, gồm: *"Ctrl+T while a tool is dispatching is evicted"*, *"the new-tab button beside the group is evicted inside the grace window too"*, và *"a tab the operator deliberately drags in is kept, tool running or not"*.

**Còn lại phải verify bằng tay.** Phần group đã đúng, nhưng hiện tượng "mất group" mà người dùng thấy có thể đến từ chỗ khác: `sidepanel/page-context.js` đăng ký `chrome.tabs.onActivated` và gọi `_refreshFromActiveTab()` **vô điều kiện**, không phân biệt đang có run hay không — nên chuyển sang tab trắng giữa chừng sẽ đổi "trang đang bind" của panel. Cần TC-TAB-05 → TC-TAB-08 chạy tay để tách hai hiện tượng.

---

### BUG-03 · Tab agent mở bị đẩy xuống cuối group · **P2**

**Trạng thái:** ĐÃ SỬA trong working tree — cần verify trên máy thật.

**Mã hiện tại.** `tabs_create_mcp` dựng `createOpts` với `index = anchor.index + 1` và `openerTabId = anchor.id`, neo theo `lastAgentTabId` (tab mà tool_request gần nhất thực sự nhắm tới). Anchor chết, đã đóng, hoặc ở cửa sổ khác thì rơi về hành vi append cũ.

**Cần verify bằng tay** vì `lastAgentTabId` chỉ có giá trị trong run thật: nếu nó là `null` ở lệnh đầu tiên của một run thì tab đầu vẫn rơi xuống cuối. **Test case:** TC-TAB-01, TC-TAB-02.

---

### BUG-04 · Mỗi action-event bị gửi 2 lần kèm `executeScript` thừa · **P2**

**Trạng thái:** ĐÃ SỬA trong working tree.

Listener của `pointer-overlay.js` trước đây không bao giờ gọi `sendResponse` và trả `undefined`, nên `chrome.tabs.sendMessage` dạng promise **reject dù message đã được xử lý** — mọi event rơi vào nhánh `catch`, `executeScript` lại rồi gửi lại, tức mỗi action-event bị xử lý 2 lần kèm 1 lần inject thừa, suốt cả run (~1 nhịp/giây từ keepalive).

Bản hiện tại đã thêm `sendResponse({ ok: true })` ở cả 4 nhánh (`browzyOverlayEvent`, `browzyOverlayTeardown`, `browzyOverlayCapture`, `browzyOverlayApproval`). **Test case:** TC-OVL-11 để xác nhận trên trình duyệt thật.

---
## 2. Overlay điều khiển từ xa (TC-OVL)

Nguồn yêu cầu: `openspec/changes/redesign-remote-control-overlay`, `extension/overlay/pointer-overlay.js`, `design.md 5c / D1 / D5 / D6`.

| ID | Ưu tiên | Tiền đề | Các bước | Kết quả kỳ vọng |
|---|:--:|---|---|---|
| TC-OVL-01 | P0 | PRE + probe đã cắm trên tab `https://example.com` | 1. Panel bind vào tab.<br>2. Gõ: *"cuộn trang xuống rồi click link Learn more"*.<br>3. Quan sát trang trong lúc chạy.<br>4. Đọc `__ovProbe.log` | Trong lúc agent thao tác: có khung viền điều khiển, badge trạng thái + nút **Stop**, con trỏ agent di chuyển tới đúng toạ độ click. Probe: `present: true`, `vis: visible` xuất hiện **trước** thao tác đầu tiên |
| TC-OVL-02 | P0 | như trên | Lặp lại TC-OVL-01 **5 lần liên tiếp**, mỗi lần reload trang trước khi chạy | 5/5 lần overlay hiện. Bất kỳ lần nào `present:false` ⇒ FAIL, ghi lại URL + readyState lúc chạy |
| TC-OVL-03 | P0 | như trên, nhưng chạy trên trang **nặng** (dauthau.info hoặc trang có nhiều iframe/SPA) | như TC-OVL-01 | Overlay hiện giống hệt trang nhẹ. Đây là ca tái hiện BUG-01 |
| TC-OVL-04 | P1 | Agent đang chạy, overlay đang hiện | Bấm nút **Stop** trên overlay | Run dừng ngay; overlay biến mất; panel phản ánh trạng thái đã dừng; **không** cần mở panel mới dừng được |
| TC-OVL-05 | P1 | Agent vừa kết thúc trả lời | Đợi 5 giây, không thao tác gì | Overlay tự biến mất trong vòng **≤3 giây** kể từ tín hiệu cuối (heartbeat 2.7s + chu kỳ kiểm 250ms) |
| TC-OVL-06 | P1 | Agent đang chạy | Ngắt native host / kill companion process giữa chừng | Overlay biến mất trong ≤3s. Không được để lại badge "đang điều khiển" treo vĩnh viễn |
| TC-OVL-07 | P1 | Agent đang chạy nhiều bước, có điều hướng | Gõ: *"vào example.com, sau đó vào example.org, mỗi trang báo lại tiêu đề"* | Sau **mỗi lần** điều hướng, overlay được inject lại vào document mới và hiện lại trong thao tác kế tiếp. Không có khoảng trang bị điều khiển mà không có dấu hiệu |
| TC-OVL-08 | P1 | Agent tạo tab mới | Gõ: *"mở tab mới vào https://example.org rồi đọc tiêu đề"* | Trên **tab mới**, overlay hiện khi agent bắt đầu đọc/thao tác. Ghi nhận: overlay có hiện được trên tab vừa `about:blank` chuyển sang https không |
| TC-OVL-09 | P1 | Cấu hình có approval gate | Ra lệnh cần phê duyệt (điền form / submit) | Overlay chuyển sang trạng thái **chờ phê duyệt**: có nút **Mở panel**, **không** có nút Allow/Deny trên trang (theo design D6 — chốt quyền không được nằm trong tầm với của chính agent) |
| TC-OVL-10 | P2 | Overlay đang hiện | Agent thực hiện `computer.screenshot` | Overlay tự ẩn trong lúc chụp (`browzyOverlayCapture` phase hide) rồi hiện lại — ảnh chụp không dính overlay |
| TC-OVL-11 | P2 | DevTools mở ở tab bị điều khiển | Đặt breakpoint/log tại listener `browzyOverlayEvent`, chạy 1 thao tác | Mỗi action-event được xử lý **đúng 1 lần**. Nếu thấy 2 lần ⇒ FAIL (BUG-04) |
| TC-OVL-12 | P2 | — | Chạy agent trên trang **hạn chế**: `brave://settings`, Chrome Web Store, PDF viewer | Không crash, không lỗi im lặng: tool trả về thông báo *Restricted page* rõ ràng; không giả vờ đang điều khiển |
| TC-OVL-13 | P3 | Overlay đang hiện | Rê chuột / click vào vùng trang bên dưới overlay | Trang nhận click bình thường (`pointer-events:none`); chỉ nút **Stop** và **Mở panel** bắt sự kiện |
| TC-OVL-14 | P3 | Overlay đang hiện | Đọc nhãn hành động trên badge và cạnh con trỏ | Nhãn khớp hành động thật: *Đang mở trang / Đang đọc trang / Đang nhấp / Đang nhập nội dung / Đang cuộn trang…*; hành động không di chuột (read, script, capture) thì nhãn cạnh con trỏ về *đang nghĩ* |
| TC-OVL-15 | P2 | Agent đang chạy trên tab A | Đóng tab A giữa chừng | Không lỗi console; bookkeeping `overlayRunTabs` được dọn; run báo *stale context* thay vì nhảy sang tab khác |
| TC-OVL-16 | P2 | Service worker đã ngủ (đợi >30s không thao tác) | Ra lệnh mới | Overlay vẫn hiện đúng sau khi service worker thức dậy — không phụ thuộc state đã mất |
| TC-OVL-17 | P1 | Working tree hiện tại | Chạy `node test/overlay-pointer.test.mjs` | Thoát code 0. Hiện đang `ReferenceError: isCaptureHideInForce is not defined` tại `test/overlay-pointer.test.mjs:519` (BUG-05) |

---

## 3. Quản lý tab & tab group (TC-TAB)

| ID | Ưu tiên | Tiền đề | Các bước | Kết quả kỳ vọng |
|---|:--:|---|---|---|
| TC-TAB-01 | P2 | Group agent có ≥3 tab, tab công tác nằm ở **giữa** group | Gõ: *"mở tab mới vào https://example.org"* | Tab mới nằm **ngay bên phải tab công tác**, không bị đẩy xuống cuối group (BUG-03) |
| TC-TAB-02 | P2 | như trên | Kiểm tra `openerTabId` của tab mới qua `chrome.tabs.get` | `openerTabId` = id tab công tác |
| TC-TAB-03 | P1 | Người dùng đang xem tab X **ngoài** group agent | Agent tạo tab mới | Tab mới **không** được select, cửa sổ **không** nhảy lên trước; người dùng vẫn ở tab X |
| TC-TAB-04 | P2 | Chưa có group agent | Ra lệnh đầu tiên cần tab | Group được tạo từ chính tab đang mở panel (không đẻ thêm tab `about:blank` thừa); group có nhãn và màu đúng |
| TC-TAB-05 | **P0** | Agent **đang chạy**, tab công tác nằm trong group agent | Người dùng bấm **Ctrl+T** | Tab mới **nằm ngoài** group agent, group agent giữ nguyên số tab và nhãn; agent tiếp tục chạy không gián đoạn (BUG-02) |
| TC-TAB-06 | P1 | như TC-TAB-05 | Người dùng bấm nút **+** trên thanh tab, ngay cạnh group | Giống TC-TAB-05 |
| TC-TAB-07 | P1 | Agent **đang chạy** | Người dùng Ctrl+T rồi tự điều hướng tab đó sang trang khác và làm việc | Agent không đụng vào tab đó; tab đó không xuất hiện trong `tabs_context`; không bị đóng khi run kết thúc |
| TC-TAB-08 | P1 | Agent **vừa dừng** (trong cửa sổ grace) | Người dùng Ctrl+T | Vẫn phải nằm ngoài group agent |
| TC-TAB-09 | P1 | Người dùng **chủ động kéo** một tab của mình vào group agent | Quan sát | Tab được giữ trong group (thao tác có chủ đích thì tôn trọng) — phân biệt được với ca thừa kế tự động ở TC-TAB-05 |
| TC-TAB-10 | **P0** | Group agent có 1 tab do agent tạo + 1 tab mượn của người dùng | Gõ: *"đóng các tab không cần nữa"* | Chỉ tab agent tự tạo bị đóng. Tab mượn **không bao giờ** bị đóng, không bị đổi group |
| TC-TAB-11 | P1 | Tab mượn của người dùng đã được adopt | Kết thúc run / bỏ bind | `releaseBorrowedTab` trả tab về đúng group cũ (hoặc về trạng thái ungrouped nếu trước đó không thuộc group nào). Tab không bị đóng |
| TC-TAB-12 | P2 | — | Gọi `set_tab_focus` không kèm `focus_window` | Tab được select trong cửa sổ của nó nhưng cửa sổ **không** được raise |
| TC-TAB-13 | P2 | — | Gọi `set_tab_focus` với `focus_window: true` | Cửa sổ được đưa lên trước |
| TC-TAB-14 | P2 | Nhiều cửa sổ Brave đang mở | Agent tạo tab | Tab mới vào **đúng cửa sổ của group agent**, không rơi vào cửa sổ đang focus của người dùng |
| TC-TAB-15 | P1 | Đóng tab cuối cùng của group | Ra lệnh mới | Group được dựng lại sạch sẽ, không lỗi, không tham chiếu group đã chết |

---

## 4. Browser tools thực tế (TC-TOOL)

Registry lõi 30 tool (`host/tool-definitions.js`: 25 preserved + 5 post-baseline, 1 removal). Bảng dưới là các ca bắt buộc; mỗi tool nên có thêm 1 ca âm (đối số sai) trước khi phát hành.

| ID | Ưu tiên | Tool | Các bước | Kết quả kỳ vọng |
|---|:--:|---|---|---|
| TC-TOOL-01 | P0 | `navigate` | Điều hướng tới https, tới `back`, tới `forward` | Điều hướng đúng; trả về tab context kèm URL mới |
| TC-TOOL-02 | P1 | `navigate` | Điều hướng tới scheme lạ: `javascript:`, `data:`, `file:`, `chrome://` | Bị chặn kèm thông báo rõ, không crash (đối chiếu `test/navigate-url-scheme.test.mjs`) |
| TC-TOOL-03 | P0 | `computer.left_click` | Click theo `ref` và theo `coordinate` trên nút nhỏ (~8×8px) | Click trúng tâm phần tử; trang phản hồi đúng |
| TC-TOOL-04 | P0 | `computer.type` | Gõ chuỗi có dấu tiếng Việt + emoji vào ô input | Nội dung ghép lại **giống hệt** từng byte; không mất dấu, không đảo ký tự |
| TC-TOOL-05 | P1 | `computer.scroll` | Cuộn xuống N nấc rồi lên N nấc | Tổng delta đúng bằng lượng yêu cầu; về đúng vị trí ban đầu |
| TC-TOOL-06 | P1 | `computer.key` | Gửi `ctrl+a`, `Backspace`, phím giữ lâu | Đúng chuỗi `keydown → insertText → keyup`; giữ phím lâu render đúng auto-repeat |
| TC-TOOL-07 | P0 | `computer.screenshot` | Chụp full và `zoom` một vùng | Ảnh đúng vùng; overlay không dính vào ảnh (xem TC-OVL-10) |
| TC-TOOL-08 | P0 | `read_page` | Đọc cây a11y trang phức tạp | Mỗi phần tử tương tác có `ref_N`; `ref` dùng lại được cho click/form_input |
| TC-TOOL-09 | P1 | `read_page` | Đọc trang > 50.000 ký tự | Bị cắt kèm ghi chú kích thước thật, không im lặng nuốt dữ liệu |
| TC-TOOL-10 | P1 | `get_page_text` | Trang bài báo, trang SPA rỗng | Trang báo: lấy đúng nội dung chính. Trang rỗng: báo trung thực là không có nội dung, **không bịa** (đối chiếu `test/extraction-honesty.test.mjs`) |
| TC-TOOL-11 | P1 | `find` | Tìm bằng ngôn ngữ tự nhiên: "ô tìm kiếm", "nút đăng nhập" | Trả ≤20 phần tử kèm ref; >20 thì báo thu hẹp truy vấn |
| TC-TOOL-12 | P1 | `form_input` | Set giá trị `<select>`, checkbox, radio, input text | Giá trị được set và **event `change`/`input` được bắn** để framework nhận |
| TC-TOOL-13 | P1 | `javascript_tool` | Chạy biểu thức cuối, `await fetch(...)` | Trả JSON đúng kết quả biểu thức cuối; lỗi ném ra được báo nguyên văn |
| TC-TOOL-14 | **P0** | `javascript_tool` | Chạy trên **tab mượn** của người dùng khi chưa được cấp quyền | Bị chặn bởi cổng phê duyệt, không tự chạy (đối chiếu `test/borrowed-tab-javascript-tool.test.mjs`) |
| TC-TOOL-15 | P2 | `read_console_messages` | Đọc có `pattern`, có `onlyErrors` | Lọc đúng; chỉ trả log của domain hiện tại |
| TC-TOOL-16 | P2 | `read_network_requests` | Sau khi tải trang có XHR | Liệt kê được request; không rò header nhạy cảm |
| TC-TOOL-17 | P2 | `resize_window` | Đổi kích thước cửa sổ | Viewport đổi đúng; `innerWidth/innerHeight` khớp |
| TC-TOOL-18 | P1 | `file_upload` | Đính file vào input theo `ref` | File được gắn; `input.files.length > 0` |
| TC-TOOL-19 | P1 | `upload_image` | Đính ảnh chụp theo `ref` vào file input; drop ảnh tại `coordinate` vào rich-text editor không có file input (vd. Google Docs) | Theo ref: gắn file như cũ. Theo coordinate: editor nhận đúng ảnh tại đúng vị trí; ref trỏ non-file-input thì báo mismatch và chỉ đường coordinate, không đoán vị trí |
| TC-TOOL-26 | P1 | `gif_creator` | start → click vài control → stop → export | Trả GIF animated xem được, marker cam ở đúng vị trí click; export kèm `download:true` lưu file xuống đĩa và báo đúng path |
| TC-TOOL-27 | P1 | `gif_creator` | export khi tab đóng giữa chừng; export GIF quá giới hạn | Tab đóng: trả frame đã có + câu nói rõ dừng sớm. Quá giới hạn: báo lỗi nêu limit + size đạt được, không trả ảnh dở |
| TC-TOOL-28 | P1 | `shortcuts_list` / `shortcuts_execute` | List rồi execute một workflow có sẵn | List liệt kê đúng; execute chạy các step và báo kết quả từng step; id lạ báo not-found phân biệt với chạy-lỗi |
| TC-TOOL-29 | P1 | `list_connected_browsers` / `select_browser` | Mở 2 browser (vd. Brave + Edge) đều gắn extension, list rồi select qua lại | List đủ 2, đúng 1 driver. Select chuyển thật (tab mới mở bên browser đích); select browser lạ không rớt kết nối hiện tại |
| TC-TOOL-21 | P1 | `set_config` / `get_config` | Đặt config toàn cục và theo tab | `get_config` phản ánh đúng lớp ưu tiên per-tab > global; catalog mô tả đầy đủ |
| TC-TOOL-22 | P1 | `update_plan` | Yêu cầu kế hoạch trước khi làm | Panel hiện thẻ kế hoạch chờ duyệt; không thao tác gì trước khi được duyệt |
| TC-TOOL-23 | P2 | `debug` / `debug_timings` | Sau một run nhiều bước | Trả lại được chi tiết mà kết quả tool đã lược bỏ; timing theo từng call |
| TC-TOOL-24 | P1 | Humanized input | Bật humanize, click + gõ | Con trỏ đi theo quỹ đạo người, nhưng **điểm click cuối luôn trúng tâm target**; thời gian giữ phím dưới ngưỡng auto-repeat của OS |
| TC-TOOL-25 | **P0** | Approval gate | Ra lệnh mutate trên tab mượn | Có yêu cầu phê duyệt trước khi thực thi; từ chối thì không có thay đổi nào xảy ra |

---

## 5. Recorder — Imitation Learning (TC-REC)

| ID | Ưu tiên | Tiền đề | Các bước | Kết quả kỳ vọng |
|---|:--:|---|---|---|
| TC-REC-01 | P1 | Chưa nhập OpenAI key | Mở Options, thử bật ghi | Báo thiếu credential rõ ràng, hướng dẫn nhập; không ghi im lặng thiếu tiếng |
| TC-REC-02 | P0 | Đã nhập OpenAI key, đã cấp quyền mic | Bấm icon toolbar (hoặc panel → History → **Bắt đầu ghi**) | Badge đi đúng dây chuyền `…` (~2.5s, click bị bỏ qua) → `REC` |
| TC-REC-03 | P0 | Đang `REC` | Điều hướng, click vài chỗ, nói 2–3 câu, bấm dừng | Badge `…` trong lúc transcribe → hiện **📋**, reference đã nằm trên clipboard |
| TC-REC-04 | P0 | Sau TC-REC-03 | Mở Options → Recorded sessions | Phiên ghi có `events > 0`, `utterances > 0`, player audio chạy được, có frame count, có phần **Narration** đúng lời nói |
| TC-REC-05 | P0 | Sau TC-REC-03 | Kiểm tra đĩa: `~/.config/browzy-in-chrome/recordings/<id>/` | Có `trace.json` và thư mục `images/` |
| TC-REC-06 | P1 | Đang `REC` | Giữ **Alt** rồi click một nút nguy hiểm | Hành động được **ghi lại nhưng không thực thi** (override/mask mode) |
| TC-REC-07 | P1 | Đang `REC` | Mở tab mới giữa phiên và thao tác ở đó | Sự kiện tab mới cũng được ghi (`recorder_hello` bắt kịp), trace liền mạch đa tab |
| TC-REC-08 | P1 | Đang `REC` | Gõ mật khẩu vào ô `type=password` | Trong chế độ audit/mask, nội dung nhập bị che. Ghi rõ hành vi thực tế nếu khác |
| TC-REC-09 | P2 | Transcription thất bại | Gọi `retranscribe_recording` | Chạy lại được, cập nhật lại narration |
| TC-REC-10 | P1 | Native host không chạy | Bấm ghi rồi dừng | Báo lỗi rõ (không có 📋 ⇒ phải có thông báo), không treo badge `…` vĩnh viễn |
| TC-REC-11 | P2 | Có session Claude Code nối channel | Dừng ghi | Xuất hiện message `recording_complete`, Claude ack, `recording_ack` khớp id |
| TC-REC-12 | P2 | Ghi phiên dài (>10 phút) | Dừng và mở viewer | Không tràn IndexedDB gây treo Options; nếu có chính sách giữ N phiên gần nhất thì áp dụng đúng |

---

## 6. Audit (TC-AUD)

| ID | Ưu tiên | Tiền đề | Các bước | Kết quả kỳ vọng |
|---|:--:|---|---|---|
| TC-AUD-01 | P1 | Mặc định | Chạy vài thao tác, mở Options → Audits | Mặc định **tắt** — không có audit nào được ghi |
| TC-AUD-02 | P0 | `set_config({key:"audit_mode", value:"audit"})` | Chạy một tác vụ nhiều bước, nhiều tab | Có đúng **1 timeline cho mỗi session**; bấm play chạy từ đầu đến cuối và **tự chuyển tab** |
| TC-AUD-03 | P1 | audit bật, 2 session Claude Code cùng chạy | Chạy song song trên 2 tab | Ra **2 audit độc lập**, không trộn lẫn (phân theo prefix `h{clientId}_`) |
| TC-AUD-04 | P1 | audit bật | Quay lại một tab đã rời đi trước đó | Mở **segment mới trên cùng stream**; replay liền mạch, không lỗi node id |
| TC-AUD-05 | P1 | audit bật, trang rất nặng | Chạy tới khi vượt ngưỡng 40MB | Stream được đánh dấu **`truncated`**, không dừng im lặng |
| TC-AUD-06 | P2 | audit bật | Để idle >30 phút | Idle reaper dọn stream; audit trước đó vẫn xem lại được |
| TC-AUD-07 | P1 | audit bật, chế độ `audit` | Gõ nội dung vào form | Nội dung người dùng nhập **bị che** trong replay (khác với chế độ `teach`) |
| TC-AUD-08 | P2 | audit bật | Replay trang có canvas/WebGL, video, CSS cross-origin | Chấp nhận giới hạn đã biết (không capture canvas, không capture nội dung video, CSS cross-origin không inline) — nhưng replay **không được vỡ** |

---

## 7. Đối chiếu Claude in Chrome (TC-CMP)

Chạy **cùng một prompt** trên cùng một trang, lần lượt bằng Claude in Chrome rồi Browzy, chụp màn hình cả hai.

| ID | Ưu tiên | Hạng mục | Chuẩn tham chiếu (Claude in Chrome) | Kết quả kỳ vọng ở Browzy |
|---|:--:|---|---|---|
| TC-CMP-01 | P0 | Dấu hiệu điều khiển trên trang | Con trỏ agent + pill **Stop Claude** hiện suốt run | Có tương đương: con trỏ + badge + **Stop**, hiện suốt run, 5/5 lần |
| TC-CMP-02 | P0 | Người dùng mở tab mới khi agent đang chạy | Agent chạy tiếp bình thường, tab người dùng độc lập | Giống hệt (BUG-02) |
| TC-CMP-03 | P2 | Vị trí tab agent mở | Cạnh tab đang làm việc | Cạnh tab đang làm việc (BUG-03) |
| TC-CMP-04 | P1 | Không cướp focus | Tab mới không được select, cửa sổ không nhảy lên | Giống hệt |
| TC-CMP-05 | P1 | Nhóm tab | Nhóm nhãn rõ ràng, gồm đúng tab agent đang dùng | Nhóm không phình ra vì tab người dùng |
| TC-CMP-06 | P2 | Thuật lại thao tác trên panel | Liệt kê từng bước (Captured page / Scrolled / Clicked / Typed…) | Có mức chi tiết tương đương, không chỉ "N thao tác" |
| TC-CMP-07 | P2 | Dừng khẩn | Dừng được từ trang, không cần mở panel | Nút Stop trên overlay dừng được run |

---

## 8. Hồi quy nhanh trước mỗi lần phát hành

Chạy theo thứ tự, ~15 phút:

1. `for t in test/*.test.mjs; do node "$t" || break; done` — toàn bộ unit test phải xanh.
2. TC-OVL-01, TC-OVL-02 (5 lần), TC-OVL-05 — overlay hiện và tự tắt.
3. TC-TAB-05, TC-TAB-10 — Ctrl+T không phá group; không đóng nhầm tab mượn.
4. TC-TOOL-03, TC-TOOL-04, TC-TOOL-08 — click, gõ tiếng Việt, đọc a11y.
5. TC-REC-02 → TC-REC-05 — ghi một phiên ngắn, kiểm tra file trên đĩa.
6. TC-CMP-01 — so ảnh với Claude in Chrome trên cùng một trang.

---

## 9. Mẫu ghi lỗi

```
[BUG-xx] <mô tả một dòng>
Mức độ: P0/P1/P2/P3
Môi trường: Brave <version> / Windows <ver> / Browzy <version> / SP hoặc MCP
Trang: <URL>
Các bước: 1... 2... 3...
Thực tế: <quan sát được>
Kỳ vọng: <đúng ra phải>
Bằng chứng: ảnh chụp / __ovProbe.log / console log / trace.json
Tần suất: x/y lần
```
