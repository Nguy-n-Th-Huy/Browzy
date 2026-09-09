// Maps the error taxonomy from host/agent/settings/errors.js (plus the
// secret-store's own SECURE_STORAGE_UNAVAILABLE code) to actionable,
// Vietnamese-first copy for the settings page.
//
// Hard rule, load-bearing for the "Secret isolation" requirement
// (specs/agent-settings/spec.md): none of these messages may ever include or
// derive from the raw API key. They only ever reference the error *code* and
// generic diagnostic text the companion already sanitized
// (host/agent/secrets/redact.js runs upstream of anything reaching here).

/**
 * @param {string} code one of host/agent/settings/errors.js's
 *   PROVIDER_ERROR_CODES, or "SECURE_STORAGE_UNAVAILABLE",
 *   "INVALID_BASE_URL", "INVALID_MODELS", or an unrecognized code.
 * @returns {{ title: string, message: string, action: string }}
 */
export function describeErrorCode(code) {
  switch (code) {
    case "STARTUP_ERROR":
      return {
        title: "Không khởi động được companion",
        message: "Runtime không sẵn sàng trong thời gian chờ khởi động.",
        action: "Thử lại sau ít phút. Nếu vẫn lỗi, khởi động lại trình duyệt/companion."
      };
    case "AUTH_ERROR":
      return {
        title: "Xác thực thất bại",
        message: "Điểm cuối từ chối API key (401/403).",
        action: "Kiểm tra lại API key và Base URL, sau đó thử lại. Khóa không được hiển thị vì lý do bảo mật."
      };
    case "MODEL_UNAVAILABLE_ERROR":
      return {
        title: "Không tìm thấy mô hình",
        message: "Điểm cuối không nhận model ID đã cấu hình.",
        action: "Kiểm tra lại model ID chính xác từ nhà cung cấp, hoặc dùng Tìm mô hình."
      };
    case "RATE_LIMIT_ERROR":
      return {
        title: "Bị giới hạn tốc độ",
        message: "Điểm cuối trả về lỗi rate limit (429).",
        action: "Đợi một chút rồi thử lại."
      };
    case "TIMEOUT_ERROR":
      return {
        title: "Hết thời gian chờ",
        message: "Không nhận được phản hồi hợp lệ trong thời gian cho phép.",
        action: "Kiểm tra kết nối mạng hoặc thử lại sau."
      };
    case "NETWORK_ERROR":
      return {
        title: "Lỗi mạng / TLS",
        message: "Không thể kết nối tới điểm cuối, hoặc điểm cuối trả lỗi máy chủ.",
        action: "Kiểm tra Base URL, chứng chỉ TLS và kết nối mạng."
      };
    case "PROTOCOL_ERROR":
      return {
        title: "Không tương thích giao thức",
        message: "Điểm cuối không nói giao thức Anthropic Messages API (ví dụ chỉ hỗ trợ OpenAI Chat Completions).",
        action: "Chọn một điểm cuối tương thích Anthropic Messages API."
      };
    case "TOOL_ERROR":
      return {
        title: "Không hỗ trợ gọi công cụ",
        message: "Mô hình hoàn tất lượt trả lời mà không gọi công cụ thử nghiệm.",
        action: "Chọn mô hình khác hỗ trợ tool-use có cấu trúc."
      };
    case "VISION_ERROR":
      return {
        title: "Không hỗ trợ nhận diện hình ảnh",
        message: "Mô hình từ chối hoặc không xử lý được ảnh thử nghiệm.",
        action: "Chọn mô hình khác hỗ trợ đầu vào hình ảnh, hoặc tiếp tục dùng ở chế độ chỉ văn bản."
      };
    case "REDIRECT_REJECTED":
      return {
        title: "Chặn chuyển hướng khác nguồn",
        message: "Điểm cuối yêu cầu chuyển hướng (redirect) sang một nguồn khác cho yêu cầu đã xác thực.",
        action: "Dùng trực tiếp Base URL cuối cùng, không qua chuyển hướng."
      };
    case "NO_CREDENTIAL":
      return {
        title: "Chưa có API key",
        message: "Chưa lưu thông tin xác thực cho hồ sơ này.",
        action: "Nhập và lưu API key trước khi kiểm tra kết nối hoặc trò chuyện."
      };
    case "INVALID_PROFILE":
      return {
        title: "Hồ sơ không hợp lệ",
        message: "Mô hình được chọn không còn trong danh sách của hồ sơ.",
        action: "Chọn lại một mô hình có trong danh sách."
      };
    case "SECURE_STORAGE_UNAVAILABLE":
      return {
        title: "Không có kho lưu trữ bảo mật của hệ điều hành",
        message: "Không tìm thấy Windows Credential Manager / macOS Keychain / Linux Secret Service khả dụng trên máy này.",
        action: "Bạn có thể chọn lưu API key chỉ trong bộ nhớ (mất khi companion khởi động lại), không bao giờ lưu dạng văn bản thuần."
      };
    case "INVALID_BASE_URL":
      return {
        title: "Base URL không hợp lệ",
        message: "Base URL chứa thông tin đăng nhập, query string, fragment, dùng scheme không hỗ trợ, hoặc không phải HTTPS.",
        action: "Sửa Base URL: dùng HTTPS (trừ điểm cuối loopback dev), không kèm user:pass@, ?query hay #fragment."
      };
    case "INVALID_MODELS":
      return {
        title: "Danh sách mô hình không hợp lệ",
        message: "Có ID trùng lặp, ID/nhãn rỗng, hoặc không có đúng một mô hình mặc định hợp lệ.",
        action: "Sửa danh sách mô hình: mỗi ID duy nhất, không rỗng, và chọn đúng một mô hình mặc định."
      };
    case "OFFLINE":
      return {
        title: "Không có mạng",
        message: "Không thể kết nối tới companion ngay bây giờ.",
        action: "Lưu cài đặt vẫn hoạt động khi ngoại tuyến; hãy thử Kiểm tra kết nối lại khi có mạng."
      };

    // Skills catalog codes (host/agent/skills/errors.js — task 7.3).
    case "INVALID_METADATA":
      return {
        title: "Metadata skill không hợp lệ",
        message: "Thư mục không có SKILL.md hợp lệ, hoặc thiếu tên/mô tả bắt buộc.",
        action: "Kiểm tra SKILL.md có khối frontmatter --- hợp lệ với name và description."
      };
    case "INVALID_NAME":
      return {
        title: "Tên skill không hợp lệ",
        message: "Tên chỉ được chứa chữ, số, \"_\" hoặc \"-\" (1-64 ký tự), không dùng dấu cách hay đường dẫn.",
        action: "Sửa lại trường Tên skill rồi thử tạo lại."
      };
    case "DUPLICATE_NAME":
      return {
        title: "Trùng tên skill",
        message: "Đã có một skill khác được nhập với cùng tên này.",
        action: "Gỡ bỏ skill hiện có trước, hoặc dùng Nạp lại để cập nhật từ thư mục nguồn hiện tại."
      };
    case "PATH_TRAVERSAL":
      return {
        title: "Đường dẫn không an toàn",
        message: "Một mục trong thư mục skill trỏ ra ngoài thư mục gốc.",
        action: "Sửa lại gói skill để mọi tệp nằm trong thư mục nguồn, không dùng \"..\" hay đường dẫn tuyệt đối."
      };
    case "SYMLINK_ESCAPE":
      return {
        title: "Liên kết thoát ra ngoài thư mục",
        message: "Thư mục skill chứa một symlink/junction trỏ ra ngoài thư mục nguồn.",
        action: "Gỡ bỏ liên kết đó hoặc thay bằng bản sao thực tế của tệp trong thư mục nguồn."
      };
    case "NOT_A_SKILL":
      return {
        title: "Không phải thư mục skill hợp lệ",
        message: "Đường dẫn đã chọn không phải là một thư mục, hoặc chứa loại tệp không hỗ trợ.",
        action: "Chọn đúng thư mục gốc của gói skill."
      };
    case "UNSUPPORTED_CAPABILITY":
      return {
        title: "Yêu cầu quyền chưa được hỗ trợ",
        message: "Skill này cần chạy script hệ thống hoặc ghi tệp — ứng dụng chưa hỗ trợ quyền này.",
        action: "Chỉ đọc tài nguyên và duyệt web được bật; skill yêu cầu shell/ghi tệp không thể bật."
      };
    case "NOT_FOUND":
      return {
        title: "Không tìm thấy skill",
        message: "Không tìm thấy thư mục nguồn, hoặc skill này chưa được nhập.",
        action: "Kiểm tra lại đường dẫn thư mục, hoặc nhập lại skill."
      };
    default:
      return {
        title: "Lỗi không xác định",
        message: `Đã xảy ra lỗi (${code || "không rõ mã lỗi"}).`,
        action: "Thử lại. Nếu vẫn lỗi, kiểm tra Base URL và API key."
      };
  }
}
