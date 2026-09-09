/*
 * Vanilla-JS web components for the interactive primitives: menu/popover,
 * the slash picker, and the expandable tool-activity row. No shadow DOM
 * (they render into light DOM) so the shared tokens.css/components.css
 * cascade styles them like any other element -- these classes just add
 * keyboard/focus/positioning behavior on top of components.css.
 *
 * Depends on: components.css (for the .menu/.slash-picker/.tool-row
 * classes these elements apply to their own children).
 */

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * <ui-menu>
 *   <button slot="trigger" class="btn-icon" aria-haspopup="menu">...</button>
 *   <div slot="menu" class="menu" role="menu">
 *     <button class="menu-item" role="menuitem">...</button>
 *   </div>
 * </ui-menu>
 */
class UiMenu extends HTMLElement {
  connectedCallback() {
    this.trigger = this.querySelector('[slot="trigger"]');
    this.menu = this.querySelector('[slot="menu"]');
    if (!this.trigger || !this.menu) return;
    this.menu.hidden = true;
    this.trigger.setAttribute("aria-expanded", "false");

    this.trigger.addEventListener("click", () => this.toggle());
    this.trigger.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.open();
        this._focusItem(0);
      }
    });
    this.menu.addEventListener("keydown", (e) => this._onMenuKeydown(e));
    document.addEventListener("click", (e) => {
      if (!this.contains(e.target)) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen()) {
        this.close();
        this.trigger.focus();
      }
    });
  }

  isOpen() {
    return !this.menu.hidden;
  }

  open() {
    if (this.isOpen()) return;
    this._position();
    this.menu.hidden = false;
    this.trigger.setAttribute("aria-expanded", "true");
    this.dispatchEvent(new CustomEvent("ui-menu-open"));
  }

  close() {
    if (!this.isOpen()) return;
    this.menu.hidden = true;
    this.trigger.setAttribute("aria-expanded", "false");
    this.dispatchEvent(new CustomEvent("ui-menu-close"));
  }

  toggle() {
    this.isOpen() ? this.close() : this.open();
  }

  _items() {
    return Array.from(this.menu.querySelectorAll('[role="menuitem"]:not([disabled])'));
  }

  _focusItem(index) {
    const items = this._items();
    if (!items.length) return;
    const i = ((index % items.length) + items.length) % items.length;
    items[i].focus();
  }

  _onMenuKeydown(e) {
    const items = this._items();
    const current = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this._focusItem(current + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this._focusItem(current - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      this._focusItem(0);
    } else if (e.key === "End") {
      e.preventDefault();
      this._focusItem(items.length - 1);
    } else if (e.key === "Tab") {
      this.close();
    }
  }

  /** Keep the popover inside the panel/viewport bounds (design 5a/5c). */
  _position() {
    this.menu.style.top = "";
    this.menu.style.bottom = "";
    this.menu.style.left = "";
    this.menu.style.right = "";
    const rect = this.trigger.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const spaceBelow = viewportH - rect.bottom;
    const openUp = spaceBelow < 240 && rect.top > spaceBelow;
    this.menu.style.position = "fixed";
    this.menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 260))}px`;
    if (openUp) this.menu.style.bottom = `${viewportH - rect.top + 6}px`;
    else this.menu.style.top = `${rect.bottom + 6}px`;
  }
}
customElements.define("ui-menu", UiMenu);

/**
 * <ui-tool-row data-status="running|succeeded|failed|cancelled|unknown">
 *   <button class="tool-row-summary" aria-expanded="false">...</button>
 *   <div class="tool-row-detail" hidden>...</div>
 * </ui-tool-row>
 */
class UiToolRow extends HTMLElement {
  connectedCallback() {
    this.classList.add("tool-row");
    const status = this.dataset.status;
    if (status) this.classList.add(`is-${status}`);
    this.summary = this.querySelector(".tool-row-summary");
    this.detail = this.querySelector(".tool-row-detail");
    if (!this.summary || !this.detail) return;
    this.summary.addEventListener("click", () => this.toggle());
  }

  toggle(force) {
    const expand = force ?? this.detail.hidden;
    this.detail.hidden = !expand;
    this.summary.setAttribute("aria-expanded", String(expand));
    this.setAttribute("data-expanded", String(expand));
  }
}
customElements.define("ui-tool-row", UiToolRow);

/**
 * <ui-slash-picker>
 *   <div class="slash-picker" role="listbox"></div>
 * </ui-slash-picker>
 *
 * JS API: setItems([{name, description}]), filter(query), focus-linked
 * keyboard nav is wired via attachToInput(inputEl).
 */
class UiSlashPicker extends HTMLElement {
  connectedCallback() {
    this.list = this.querySelector(".slash-picker");
    this.items = [];
    this.highlighted = 0;
  }

  setItems(items) {
    this.items = items;
    this.highlighted = 0;
    this._render();
  }

  show() {
    if (this.list) this.list.hidden = false;
  }
  hide() {
    if (this.list) this.list.hidden = true;
  }
  isVisible() {
    return this.list && !this.list.hidden;
  }

  move(delta) {
    if (!this.items.length) return;
    this.highlighted = ((this.highlighted + delta) % this.items.length + this.items.length) % this.items.length;
    this._render();
  }

  current() {
    return this.items[this.highlighted];
  }

  _render() {
    if (!this.list) return;
    if (!this.items.length) {
      this.list.innerHTML = `<div class="slash-picker-empty">Không tìm thấy skill nào phù hợp.</div>`;
      return;
    }
    this.list.innerHTML = this.items
      .map(
        (item, i) => `
      <button type="button" class="slash-picker-item" role="option"
        id="slash-item-${i}"
        aria-selected="${i === this.highlighted}"
        data-highlighted="${i === this.highlighted}"
        data-index="${i}">
        <span class="slash-picker-item-name">/${item.name}</span>
        <span class="slash-picker-item-desc">${item.description || ""}</span>
      </button>`
      )
      .join("");
    this.list.querySelectorAll(".slash-picker-item").forEach((el) => {
      el.addEventListener("click", () => {
        this.highlighted = Number(el.dataset.index);
        this.dispatchEvent(new CustomEvent("ui-slash-select", { detail: this.current() }));
      });
    });
    const active = this.list.querySelector('[data-highlighted="true"]');
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  /** Wire ArrowUp/Down/Enter/Tab/Escape on a composer input element. */
  attachToInput(inputEl) {
    inputEl.addEventListener("keydown", (e) => {
      if (!this.isVisible()) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.move(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.move(-1);
      } else if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
        // Tab accepts the highlighted entry just like Enter, so users can keep
        // typing without reaching for Enter. Shift+Tab is left alone so it can
        // still move focus backwards out of the composer.
        if (!this.current()) return;
        e.preventDefault();
        this.dispatchEvent(new CustomEvent("ui-slash-select", { detail: this.current() }));
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.hide();
      }
    });
  }
}
customElements.define("ui-slash-picker", UiSlashPicker);

export { UiMenu, UiToolRow, UiSlashPicker };
