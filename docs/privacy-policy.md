# Chính sách quyền riêng tư — Browzy

*Cập nhật lần cuối: 07/09/2026*

## Tóm tắt

Browzy không có máy chủ. Chúng tôi không nhận, không lưu và không thấy dữ liệu của bạn.

Tiện ích chạy hoàn toàn trên máy bạn cùng một chương trình đồng hành (companion) mà bạn tự cài. Nội dung trang và câu hỏi của bạn đi thẳng từ máy bạn tới **điểm cuối AI do chính bạn cấu hình** — không đi qua bất kỳ hạ tầng nào của chúng tôi. Chúng tôi không có cách nào đọc được chúng, kể cả khi muốn.

## Dữ liệu nào rời khỏi máy bạn

Chỉ đi tới điểm cuối AI mà bạn tự nhập Base URL và API key:

| Dữ liệu | Khi nào |
|---|---|
| Nội dung trang (văn bản, cấu trúc, ảnh chụp màn hình) | khi bạn yêu cầu trợ lý làm việc với một trang |
| URL và tiêu đề của tab đang gắn | đi kèm ngữ cảnh của yêu cầu đó |
| Nội dung bạn gõ vào khung chat, và tệp bạn đính kèm | khi bạn gửi |

Không có gì được gửi đi khi bạn không yêu cầu. Tiện ích không chạy nền để thu thập dữ liệu, không theo dõi các tab khác, và không gửi gì tới chúng tôi.

**Bạn chọn ai nhận dữ liệu này.** Điểm cuối AI là do bạn cấu hình. Chính sách quyền riêng tư của nhà cung cấp đó áp dụng cho dữ liệu bạn gửi tới họ — hãy đọc chính sách của họ.

## Dữ liệu lưu trên máy bạn

Nằm trong thư mục cá nhân của bạn, không đồng bộ đi đâu:

- **Lịch sử hội thoại** — `~/.config/browzy-in-chrome/agent/conversations/`
- **Bản ghi phiên** (nếu bạn bật tính năng ghi) — `~/.config/browzy-in-chrome/agent/recordings/`
- **Ảnh chụp màn hình** trợ lý chụp trong lúc làm việc
- **Cấu hình không nhạy cảm** trong bộ nhớ tiện ích: model đã chọn, trạng thái giao diện, một mã cài đặt ngẫu nhiên dùng để tiện ích và companion nhận ra nhau

Xoá bằng cách xoá thư mục trên và gỡ tiện ích.

## API key của bạn

**Không** lưu trong bộ nhớ tiện ích. Nó nằm trong kho khoá của hệ điều hành — Credential Manager trên Windows, Keychain trên macOS, Secret Service trên Linux — và chỉ được companion đọc ra để đặt vào header xác thực khi gọi điểm cuối bạn cấu hình.

Đây là lựa chọn có chủ đích: nếu bộ nhớ tiện ích bị lộ, API key của bạn không nằm trong đó.

## Quyền `debugger` — vì sao cần và dùng làm gì

Chrome hiện cảnh báo *"Browzy started debugging this browser"* suốt thời gian tiện ích hoạt động. Bạn nên biết nó dùng để làm gì.

Trợ lý cần tạo được cú nhấp và phím gõ **thật** — thứ mà trang web chấp nhận. Sự kiện do JavaScript tạo mang cờ `isTrusted=false` và bị phần lớn trang web bỏ qua, đúng ở những chỗ quan trọng nhất như biểu mẫu đăng nhập hay trình soạn thảo. Chỉ giao thức DevTools mới tạo được input ở tầng trình duyệt, và `debugger` là đường duy nhất để tiện ích chạm tới nó.

Nó chỉ dùng cho hai việc: gửi thao tác chuột/bàn phím, và chụp màn hình — trên đúng những tab bạn đã cho phép trong phiên đang chạy. Không gắn vào tab bạn không chỉ định. Không đọc lưu lượng mạng của bạn.

## Chúng tôi không làm gì

- Không bán hoặc chuyển dữ liệu của bạn cho bên thứ ba
- Không dùng dữ liệu của bạn cho mục đích nào ngoài việc thực hiện yêu cầu bạn đưa ra
- Không dùng dữ liệu để đánh giá tín dụng hay cho vay
- Không đặt máy chủ phân tích, không gắn mã theo dõi, không quảng cáo
- Không huấn luyện bất kỳ mô hình nào bằng dữ liệu của bạn

## Trẻ em

Browzy không hướng tới trẻ em dưới 13 tuổi và không cố ý thu thập dữ liệu từ trẻ em.

## Thay đổi

Nếu chính sách này thay đổi, ngày cập nhật ở đầu trang sẽ đổi theo. Thay đổi có ảnh hưởng thực chất sẽ được nêu trong ghi chú phát hành của phiên bản tương ứng.

## Liên hệ

[ĐIỀN EMAIL LIÊN HỆ CỦA BẠN]
