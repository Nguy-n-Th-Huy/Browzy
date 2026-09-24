// DOM-agnostic state machine for Settings > Bộ nhớ cách làm việc
// (openspec/changes/add-task-memory tasks.md 7.3-7.4). Same convention as
// permissions-controller.js: no `document`/`chrome`, so it is testable from
// plain Node against a fake client; memory-app.js is the thin DOM layer.
//
// It never invents a field the host result does not carry, and it never
// claims a forget succeeded unless the host answered ok.

function emptyState() {
  return {
    loaded: false,
    enabled: true,
    settingEnabled: false,
    sites: [], // [{ host, memories: [...] }] in host order
    invalid: 0,
    banner: null, // { kind: "error"|"info"|"success", title, message }
    forgettingHost: null,
    forgettingAll: false
  };
}

function errorBanner(title, err) {
  if (err && err.code === "NETWORK_ERROR") {
    return { kind: "error", title, message: "Không kết nối được tới companion. Kiểm tra companion đang chạy rồi thử lại." };
  }
  return { kind: "error", title, message: (err && err.message) || "Có lỗi không xác định." };
}

/** "hôm nay" / "hôm qua" / "N ngày trước" / a date — relative to `now`. */
export function lastConfirmedLabel(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return "Chưa rõ";
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return "Xác nhận hôm nay";
  if (days === 1) return "Xác nhận hôm qua";
  if (days < 30) return `Xác nhận ${days} ngày trước`;
  return `Xác nhận ngày ${new Date(ms).toLocaleDateString("vi-VN")}`;
}

export class MemoryController {
  /**
   * @param {ReturnType<import("./memory-client.js").createMemoryClient>} client
   * @param {{ onChange?: (state: object) => void, now?: () => number }} [opts]
   */
  constructor(client, { onChange = () => {}, now = Date.now } = {}) {
    this.client = client;
    this.onChange = onChange;
    this.now = now;
    this.state = emptyState();
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  async load() {
    try {
      const [settings, listing] = await Promise.all([this.client.getSettings(), this.client.list()]);
      this._set({
        loaded: true,
        enabled: settings && settings.enabled !== false,
        sites: Array.isArray(listing && listing.sites) ? listing.sites : [],
        invalid: Number.isInteger(listing && listing.invalid) ? listing.invalid : 0,
        banner: null
      });
    } catch (err) {
      this._set({ loaded: true, banner: errorBanner("Không tải được bộ nhớ", err) });
    }
  }

  async setEnabled(enabled) {
    if (this.state.settingEnabled) return;
    this._set({ settingEnabled: true });
    try {
      const result = await this.client.setEnabled(enabled === true);
      this._set({ settingEnabled: false, enabled: result && result.enabled === true, banner: null });
    } catch (err) {
      this._set({ settingEnabled: false, banner: errorBanner("Không lưu được lựa chọn", err) });
    }
  }

  async forgetHost(host) {
    if (this.state.forgettingHost || this.state.forgettingAll) return;
    this._set({ forgettingHost: host });
    try {
      const result = await this.client.forgetHost(host);
      this._set({
        forgettingHost: null,
        sites: this.state.sites.filter((site) => site.host !== host),
        banner: { kind: "success", title: `Đã quên ${host}`, message: `${result && Number.isInteger(result.forgotten) ? result.forgotten : 0} cách làm đã bị xóa.` }
      });
    } catch (err) {
      this._set({ forgettingHost: null, banner: errorBanner(`Không quên được ${host}`, err) });
    }
  }

  async forgetAll() {
    if (this.state.forgettingHost || this.state.forgettingAll) return;
    this._set({ forgettingAll: true });
    try {
      await this.client.forgetAll();
      this._set({ forgettingAll: false, sites: [], invalid: 0, banner: { kind: "success", title: "Đã quên tất cả", message: "Không còn cách làm nào được ghi nhớ." } });
    } catch (err) {
      this._set({ forgettingAll: false, banner: errorBanner("Không quên được", err) });
    }
  }

  isEmpty() {
    return this.state.loaded && this.state.sites.length === 0;
  }

  /** View rows: one per site, each memory with display labels. */
  siteRows() {
    return this.state.sites.map((site) => ({
      host: site.host,
      memories: (site.memories || []).map((memory) => ({
        id: memory.id,
        intentLabel: typeof memory.intent === "string" && memory.intent ? memory.intent : "(nội dung yêu cầu không được lưu)",
        stepsLabel: `${memory.stepCount} bước`,
        confirmedLabel: lastConfirmedLabel(memory.lastConfirmedAt, this.now()),
        stateLabel: memory.state === "stale" ? "Đã cũ — sẽ không được gợi ý" : "Đang dùng",
        stale: memory.state === "stale",
        usedLabel: memory.useCount > 0 ? `Đã dùng lại ${memory.useCount} lần` : null
      }))
    }));
  }
}
