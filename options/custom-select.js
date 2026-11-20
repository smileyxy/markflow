/**
 * 毛玻璃自定义下拉选择组件
 *
 * 以渐进增强方式接管原生 <select data-custom-select> 元素：
 * 保留底层 <select> 的 DOM 值与 change 事件，提供与整体毛玻璃视觉一致的弹出菜单、
 * 向上/向下自适应定位、键盘导航与多语言文本同步能力。
 */

(function (global) {
  "use strict";

  const ctx = global.MarkFlowOptions;
  const instances = [];

  const CHECK_SVG = `<svg class="csel-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  const CHEVRON_SVG = `<svg class="csel-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

  function closeAll(exceptInstance = null) {
    instances.forEach(inst => {
      if (inst !== exceptInstance) inst.close();
    });
  }

  function enhanceSelect(selectEl) {
    if (!selectEl || selectEl._mfEnhanced) return;
    selectEl._mfEnhanced = true;

    const variant = selectEl.getAttribute("data-custom-select") || "form";
    const preferDir = selectEl.getAttribute("data-direction") || "auto";
    const isMono = selectEl.classList.contains("font-mono");

    const wrapper = document.createElement("div");
    wrapper.className = `csel-wrapper csel-${variant}` + (isMono ? " csel-mono" : "");

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "csel-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const labelSpan = document.createElement("span");
    labelSpan.className = "csel-label";

    trigger.appendChild(labelSpan);
    trigger.insertAdjacentHTML("beforeend", CHEVRON_SVG);

    const menu = document.createElement("div");
    menu.className = "csel-menu hidden";
    menu.setAttribute("role", "listbox");

    selectEl.parentNode.insertBefore(wrapper, selectEl);
    wrapper.appendChild(selectEl);
    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);
    selectEl.classList.add("native-select-hidden");

    let isOpen = false;
    let activeIdx = 0;

    function syncLabel() {
      const selectedOpt =
        selectEl.options[selectEl.selectedIndex] ||
        Array.from(selectEl.options).find(o => o.value === selectEl.value);
      labelSpan.textContent = selectedOpt ? selectedOpt.textContent : "";
    }

    function renderMenu() {
      menu.innerHTML = "";
      const opts = Array.from(selectEl.options);
      activeIdx = Math.max(0, selectEl.selectedIndex);

      opts.forEach((opt, idx) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className =
          "csel-option" +
          (opt.selected ? " is-selected" : "") +
          (idx === activeIdx ? " is-highlighted" : "");
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(opt.selected));
        item.innerHTML = `<span class="csel-opt-text">${MarkFlowEngine.escapeHtml(
          opt.textContent
        )}</span>${opt.selected ? CHECK_SVG : ""}`;

        item.addEventListener("mouseenter", () => {
          activeIdx = idx;
          updateHighlight();
        });

        item.addEventListener("click", () => {
          selectByIndex(idx);
          close();
          trigger.focus();
        });

        menu.appendChild(item);
      });
    }

    function updateHighlight() {
      const rows = menu.querySelectorAll(".csel-option");
      rows.forEach((row, i) => row.classList.toggle("is-highlighted", i === activeIdx));
      if (rows[activeIdx]) rows[activeIdx].scrollIntoView({ block: "nearest" });
    }

    function selectByIndex(idx) {
      if (idx < 0 || idx >= selectEl.options.length) return;
      const changed = selectEl.selectedIndex !== idx;
      selectEl.selectedIndex = idx;
      syncLabel();
      if (changed) {
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    function open() {
      if (selectEl.disabled) return;
      closeAll(instance);
      renderMenu();

      // 计算弹出方向：支持显式指定向上，或在视口底部空间不足时自动向上翻转
      const rect = trigger.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const openUp = preferDir === "up" || (preferDir === "auto" && spaceBelow < 240 && rect.top > spaceBelow);
      menu.classList.toggle("csel-up", openUp);

      menu.classList.remove("hidden");
      trigger.setAttribute("aria-expanded", "true");
      wrapper.classList.add("is-open");
      isOpen = true;

      const selectedRow = menu.querySelector(".csel-option.is-selected");
      if (selectedRow) selectedRow.scrollIntoView({ block: "nearest" });
    }

    function close() {
      if (!isOpen) return;
      menu.classList.add("hidden");
      trigger.setAttribute("aria-expanded", "false");
      wrapper.classList.remove("is-open");
      isOpen = false;
    }

    trigger.addEventListener("click", e => {
      e.stopPropagation();
      if (isOpen) close();
      else open();
    });

    trigger.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!isOpen) {
          open();
        } else {
          activeIdx = (activeIdx + 1) % Math.max(1, selectEl.options.length);
          updateHighlight();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen) {
          open();
        } else {
          activeIdx = (activeIdx - 1 + selectEl.options.length) % Math.max(1, selectEl.options.length);
          updateHighlight();
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!isOpen) open();
        else {
          selectByIndex(activeIdx);
          close();
        }
      } else if (e.key === "Escape") {
        if (isOpen) {
          e.preventDefault();
          close();
        }
      }
    });

    // 监听底层 select 的值变更与选项重建，自动同步触发器显示文案
    selectEl.addEventListener("change", syncLabel);
    const observer = new MutationObserver(() => syncLabel());
    observer.observe(selectEl, { childList: true, subtree: true, characterData: true });

    const instance = { selectEl, syncLabel, close };
    instances.push(instance);
    syncLabel();
  }

  function initCustomSelects() {
    document.querySelectorAll("select[data-custom-select]").forEach(enhanceSelect);

    if (!initCustomSelects._boundGlobal) {
      initCustomSelects._boundGlobal = true;
      document.addEventListener("click", e => {
        const hitWrapper = e.target.closest && e.target.closest(".csel-wrapper");
        if (!hitWrapper) closeAll();
      });
      document.addEventListener("keydown", e => {
        if (e.key === "Escape") closeAll();
      });
    }
  }

  function syncCustomSelects() {
    instances.forEach(inst => inst.syncLabel());
  }

  ctx.initCustomSelects = initCustomSelects;
  ctx.syncCustomSelects = syncCustomSelects;
})(window);
