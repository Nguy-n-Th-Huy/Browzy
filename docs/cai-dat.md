# Hướng dẫn cài đặt Browzy

*Dành cho người cài lần đầu trên một máy mới.*

Browzy gồm **hai nửa** phải khớp nhau:

| Nửa | Là gì | Chạy ở đâu |
|---|---|---|
| **Extension** | giao diện và phần điều khiển trình duyệt | trong Chrome/Edge/Brave |
| **Companion** (native host) | bộ não agent, chạy Claude Agent SDK | tiến trình Node trên máy bạn |

Extension **không tự chạy được**. Nó nói chuyện với companion qua cơ chế native messaging của Chrome, và Chrome đòi companion phải được **đăng ký sẵn trên đĩa** trước khi kết nối. Đó là lý do luôn có một bước cài ngoài trình duyệt — không thể chỉ "Load unpacked" là xong.

---

## Chuẩn bị

- **[Node.js](https://nodejs.org)** bản LTS — companion chạy trên Node, không có Node thì không cài được.
- **Git** — để lấy mã nguồn.
- Một trình duyệt nhân Chromium: **Chrome**, **Edge** hoặc **Brave**.
- **Một trong hai thứ**, cho panel chat:
  - **API key** của một nhà cung cấp tương thích Anthropic, **hoặc**
  - **một gói ChatGPT trả phí** (Plus/Pro/Team — cùng gói mà Codex CLI đăng nhập). Xem [Đăng nhập bằng gói ChatGPT](#đăng-nhập-bằng-gói-chatgpt).

  Browzy không kèm sẵn key nào và không có máy chủ trung gian.

---

## Cài đặt

### 1. Lấy mã nguồn

```bash
git clone https://github.com/Nguy-n-Th-Huy/Browzy.git
cd Browzy
```

### 2. Cài companion

Chọn **một** dòng theo hệ điều hành:

```bash
./install.sh          # macOS, Linux, hoặc Windows qua Git Bash
```
```powershell
.\install.ps1         # Windows PowerShell
```

> **Windows báo `cannot be loaded because running scripts is disabled`?**
> Đây không phải lỗi của Browzy. PowerShell mặc định chặn **mọi** file `.ps1` chưa ký, kể cả file nằm sẵn trên máy bạn. Chạy dòng này thay thế — nó chỉ áp dụng cho đúng lần chạy đó, không đổi gì trên máy:
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\install.ps1
> ```
> Hoặc mở Git Bash và chạy `./install.sh`. Muốn khỏi vướng về sau thì đặt một lần cho tài khoản của bạn (không cần quyền admin): `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`.

Lệnh này tự làm ba việc: cài dependency, suy ra extension ID từ khoá công khai trong manifest, rồi ghi đăng ký native host cho từng trình duyệt tìm thấy.

Chạy lại bao nhiêu lần cũng vô hại. Không có gì thay đổi thì nó in `Already up to date` và không ghi gì; có thay đổi thì nó **sao lưu bản cũ** trước khi ghi đè.

Muốn đăng ký cho một số trình duyệt thôi:
```bash
./install.sh --only=chrome,edge
```

### 3. Nạp extension

1. Mở `chrome://extensions` (hoặc `edge://extensions`, `brave://extensions`)
2. Bật **Developer mode** ở góc trên bên phải
3. Bấm **Load unpacked**, chọn thư mục **`extension/`** bên trong repo vừa clone

Không phải copy ID nào cả. Manifest mang sẵn một khoá công khai cố định, nên extension nhận **cùng một ID** trên mọi máy và mọi lần nạp lại — đó chính là ID mà bước 2 vừa đăng ký.

### 4. Chọn nhà cung cấp

Mở panel Browzy → **Settings**. Mục **Loại nhà cung cấp** có hai lựa chọn:

- **API tương thích Anthropic** (mặc định) — dán Base URL + API key. Key nằm lại trên máy bạn.
- **Tài khoản ChatGPT** — dùng gói ChatGPT trả phí của bạn, không cần key nào. Xem [Đăng nhập bằng gói ChatGPT](#đăng-nhập-bằng-gói-chatgpt).

Sau khi chọn, bấm **Kiểm tra kết nối**. Panel sẽ không chạy cho tới khi phép thử này đạt với đúng cấu hình hiện tại.

---

## Đăng nhập bằng gói ChatGPT

Nếu bạn đã trả phí cho ChatGPT (Plus/Pro/Team — cùng gói mà Codex CLI đăng nhập) và không muốn mua thêm API credit, một profile có thể dùng thẳng gói đó. Đây là lựa chọn bạn phải bật, không bao giờ tự xảy ra: profile vẫn là loại Anthropic cho tới khi bạn đổi.

1. **Settings** → chọn **Tài khoản ChatGPT** → **Lưu**. Hai ô Base URL và API key biến mất; không phải nhập gì ở đó.
2. Bấm **Đăng nhập với ChatGPT**. Một tab trình duyệt mới mở ra trang đăng nhập của OpenAI; xác nhận ở đó rồi tab sẽ báo là đóng được. Settings khi ấy hiện email và gói của tài khoản đã đăng nhập, còn danh sách mô hình được nạp các ID mô hình Codex của gói đó — chỉ khi danh sách đang trống, nên những gì bạn tự sửa không bao giờ bị ghi đè, và vẫn sửa được tiếp.
3. **Đăng nhập bằng mã, nếu cách trên không chạy được.** Đăng nhập qua trình duyệt cần cổng `1455` để nhận kết quả; nếu cổng đã bị chiếm (phổ biến nhất là một phiên Codex CLI đang đăng nhập), Settings sẽ báo và đưa cho bạn nút **Dùng mã thay thế**. Nút này hiện một mã dùng một lần, đường dẫn tới `https://auth.openai.com/codex/device`, và đồng hồ đếm ngược; nhập mã ở trang đó thì panel tự đăng nhập. Cả hai cách đều hủy được, và nếu không hoàn tất thì tự hết hạn (5 phút cho cách trình duyệt, 15 phút cho cách mã) mà không lưu gì.
4. Bấm **Kiểm tra kết nối**. Cũng là một yêu cầu nhỏ thật, như đường API key, chỉ khác ở chỗ: ở đây nó **tính vào giới hạn sử dụng ChatGPT của bạn**.
5. **Đăng xuất** nằm ngay chỗ đó. Có hiệu lực lập tức: credential đã lưu bị xoá, phiên đang chạy bằng nó bị hủy, và các request đang bay qua nó không được phục vụ nữa.

**Giới hạn sử dụng.** Gói ChatGPT có định mức, và nhà cung cấp này không tìm cách lách. Khi tài khoản chạm ngưỡng, yêu cầu thất bại và panel báo rõ ngưỡng đó cùng thời điểm reset — không có lần thử lại nào ẩn phía sau, vì cũng không có credential thứ hai nào để thử.

**Bản chất của cách này — đọc trước khi phụ thuộc vào nó.** Browzy tới ChatGPT qua **một backend không chính thức, không có tài liệu** (đúng backend Codex CLI dùng), không phải một sản phẩm OpenAI mở cho bên thứ ba. OpenAI có thể thay đổi hoặc đóng nó bất cứ lúc nào, và một nhà cung cấp hôm qua còn chạy tốt có thể ngừng chạy mà chẳng cần bản phát hành nào phía Browzy. **Điều khoản dịch vụ của OpenAI áp dụng cho tài khoản của bạn**, và việc dùng gói theo cách này là quyết định của bạn. Browzy không liên kết hay được OpenAI bảo trợ, và không có hành vi nào ở đây giả danh khách khác — backend được báo rõ đây là `browzy`. Nếu điều khoản đó không ổn với tài khoản của bạn, hãy dùng nhà cung cấp API key.

**Không hỗ trợ, có chủ đích:**

- **Gộp / xoay vòng / dự phòng nhiều tài khoản.** Mỗi profile đúng một tài khoản đã đăng nhập, luôn là tài khoản đó.
- **Khách khác dùng cổng cục bộ này.** Endpoint dịch thuật chỉ phục vụ chính các phiên chạy và phép thử kết nối của companion này. Nó chỉ buộc tại `127.0.0.1` trên một cổng do hệ điều hành chọn, mọi request đều phải có token cấp lúc bắt đầu phiên và thu hồi khi phiên kết thúc — nên đây không phải một proxy để bạn trỏ Codex CLI, IDE hay script vào.
- **Khám phá mô hình.** Không có endpoint liệt kê mô hình Codex; danh sách lấy theo các ID của gói và do bạn tự sửa.

Credential để refresh nằm trong kho bảo mật của hệ điều hành, cùng quy tắc cách ly như API key (`browzy-in-chrome/chatgpt/<profile>`); access token ngắn hạn chỉ giữ trong bộ nhớ — không ra đĩa, không vào storage của extension, không vào log. Cũng như API key, đăng nhập tính theo từng máy: thêm máy thứ hai là phải đăng nhập lại ở máy đó. Việc chạy cùng một profile ChatGPT trên hai tiến trình companion cùng lúc (hai trình duyệt chẳng hạn) không được phối hợp: một trong hai sẽ thấy phiên hết hạn và được yêu cầu đăng nhập lại.

Đường external MCP không liên quan — vẫn dùng model và auth mà phiên Claude Code của bạn tự cung cấp.

---

## Kiểm tra khi có trục trặc

```bash
node host/bin/browzy.js doctor
```

Lệnh này **chỉ đọc, không sửa gì**. Nó cho biết:
- đăng ký đang trỏ cho extension ID nào,
- ở những trình duyệt nào,
- và file companion mà nó trỏ tới **có còn tồn tại không**.

### Panel hiện "Chưa cài companion"

Extension không tìm thấy native host. Chạy lại `./install.sh` (hoặc `.\install.ps1`), rồi **tải lại extension** ở `chrome://extensions`.

### Panel đứng ở "Đang kết nối"

Companion đã đăng ký nhưng không khởi động được. Chạy `browzy doctor` — nguyên nhân hay gặp nhất là đăng ký trỏ vào một đường dẫn không còn tồn tại, do thư mục repo bị di chuyển hoặc đổi tên sau khi cài. Chạy lại installer là xong.

### Đã di chuyển thư mục repo

Đăng ký ghi **đường dẫn tuyệt đối**. Di chuyển hay đổi tên thư mục là đăng ký hỏng. Chạy lại installer ở vị trí mới.

---

## Gỡ cài đặt

```bash
node host/bin/browzy.js uninstall
```

Lệnh này gỡ đăng ký native host. Extension thì gỡ ở `chrome://extensions` như mọi extension khác.

---

## Câu hỏi hay gặp

### Đã có gói npm rồi, sao vẫn phải clone?

Gói `@huydepzai2810/browzy-host` trên npm **chỉ chứa companion**, không chứa extension. Mà `Load unpacked` thì cần thư mục `extension/` có thật trên đĩa. Nên hôm nay, nếu đằng nào cũng phải clone để lấy extension, thì `./install.sh` đã cài luôn companion và `npm i -g` là bước thừa.

Gói npm chỉ thật sự cần khi extension đến từ nơi khác — cụ thể là khi Browzy đã lên Chrome Web Store. Lúc đó luồng cài sẽ là:

```bash
npm i -g @huydepzai2810/browzy-host
browzy install --extension-id <ID do Web Store cấp>
```

và không phải clone gì cả.

### Vì sao bản Web Store cần `--extension-id`?

`package-extension.sh` **xoá trường `key`** khỏi manifest khi đóng gói, vì Chrome Web Store tự cấp ID riêng cho mỗi item. Nghĩa là bản cài từ Web Store có ID **khác** bản unpacked.

Companion chỉ chấp nhận kết nối từ đúng một ID ghi trong `allowed_origins`. Nếu cài extension từ Web Store mà đăng ký companion theo ID của bản unpacked, hai bên sẽ không bao giờ bắt tay được — và triệu chứng là panel treo ở "Đang kết nối" mà không báo lỗi gì.

Nên với bản Web Store, phải truyền đúng ID mà store cấp:
```bash
browzy install --extension-id <ID do Web Store cấp>
```

### Chia sẻ file zip cho người khác được không?

Không nên. Chrome không cài extension từ zip — người nhận vẫn phải giải nén rồi Load unpacked. Và nếu đó là zip từ `package-extension.sh` (đã xoá `key`), extension sẽ nhận ID khác trên máy họ, nên companion không khớp.

Muốn người khác dùng thử thì đưa họ đường dẫn repo và trang này. `git clone` gọn hơn và đúng hơn.

### Dữ liệu của tôi đi đâu?

Không đi qua máy chủ nào của dự án — dự án không có máy chủ. Chi tiết ở [Chính sách quyền riêng tư](./privacy-policy.md).
