// ==UserScript==
// @name         Debug 元素定位工具
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  点击页面元素后，向上搜索所有带有 data-name 属性的元素，生成 CSS 路径用于调试
// @author       Conglinyizhi
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @require      https://cdn.jsdelivr.net/npm/jquery@4.0/dist/jquery.slim.min.js
// ==/UserScript==

(() => {
  // ========== 注入全局样式 ==========
  $("<style>", { id: "el-locator-styles" }).text(`
.el-toast {
  position: fixed; top: 20px; right: 20px;
  padding: 12px 20px; padding-bottom: 8px;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  z-index: 9999999;
  font-size: 14px;
  max-width: 400px;
  word-wrap: break-word;
  transition: top 0.3s ease;
  background: #333; color: #fff;
}
.el-toast--dark { background: #2d2d2d; color: #e0e0e0; }
.el-toast--bottom { top: auto; bottom: 20px; }

.el-progress {
  position: absolute; bottom: 0; left: 0;
  height: 3px;
  border-radius: 0 0 4px 4px;
}
.el-progress--run { animation: el-pb 3s linear forwards; }
@keyframes el-pb { from { width: 100%; } to { width: 0%; } }

.el-hover {
  position: fixed;
  pointer-events: none;
  z-index: 9999998;
  display: none;
  transition: all 0.1s ease;
}

.el-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.5);
  z-index: 999999;
  display: flex;
  justify-content: center;
  align-items: center;
}
.el-box {
  background: #fff; color: #333;
  border-radius: 8px; padding: 20px;
  max-width: 600px; max-height: 80vh;
  overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.el-box--dark { background: #2d2d2d; color: #e0e0e0; }
.el-box h3 { margin: 0 0 15px; }
.el-code {
  white-space: pre-wrap; word-wrap: break-word;
  font-family: 'Courier New', monospace;
  font-size: 14px; line-height: 1.6;
}
.el-row { margin-top: 15px; display: flex; align-items: center; gap: 8px; }
.el-bar {
  margin-top: 10px; padding: 8px;
  border-radius: 4px; font-size: 12px; display: none;
  background: #f5f5f5; color: #666;
}
.el-bar--dark { background: #1a1a1a; color: #aaa; }
.el-btn {
  padding: 8px 16px; color: #fff;
  border: none; border-radius: 4px;
  cursor: pointer; font-size: 14px; flex: 1;
}
.el-btn--primary { background: #2196F3; }
.el-btn--primary.el-btn--dark { background: #4a90a4; }
.el-btn--close { background: #4CAF50; }
.el-btn--close.el-btn--dark { background: #5c5c5c; }
.el-flex { display: flex; gap: 10px; margin-top: 15px; }

.el-slide-in { animation: el-si 0.3s ease-out; }
@keyframes el-si {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
.el-slide-out { animation: el-so 0.3s ease-in; }
@keyframes el-so {
  from { transform: translateX(0); opacity: 1; }
  to { transform: translateX(100%); opacity: 0; }
}
  `).appendTo(document.head);

  // ========== 工具函数 ==========

  function isDarkMode() {
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false;
  }

  function showElementBorder(element, duration = 1000) {
    if (!element) return;
    const $el = $(element);
    const orig = { outline: $el.css("outline"), outlineOffset: $el.css("outlineOffset") };
    $el.css({ outline: "3px solid #2196F3", outlineOffset: "2px" });
    setTimeout(() => $el.css(orig), duration);
  }

  function createToast(message, themeColor = "#2196F3") {
    const dark = isDarkMode();
    const $t = $("<div>").addClass("el-toast").toggleClass("el-toast--dark", dark).text(message);
    $t.css("border-left", `4px solid ${dark && themeColor === "#2196F3" ? "#4a90a4" : themeColor}`);
    const $p = $("<div>").addClass("el-progress el-progress--run")
      .css("background", dark && themeColor === "#2196F3" ? "#4a90a4" : themeColor);
    $t.append($p);
    return $t[0];
  }

  function createHoverIndicator(color = "#2196F3") {
    const dark = isDarkMode();
    const c = dark && color === "#2196F3" ? "#4a90a4" : color;
    return $("<div>").addClass("el-hover").css({ border: `2px solid ${c}`, background: `${c}1a` })[0];
  }

  // 全局模式管理
  let activeMode = null, activeCleanup = null;
  function registerMode(name, fn) {
    if (activeMode && activeCleanup) { console.log(`[切换] ${activeMode} -> ${name}`); activeCleanup(); }
    activeMode = name; activeCleanup = fn;
  }
  function unregisterMode(name) { if (activeMode === name) { activeMode = null; activeCleanup = null; } }

  function fadeOut($el, dur = 300) {
    $el.css({ transition: `opacity ${dur}ms`, opacity: "0" });
    setTimeout(() => $el.hide(), dur);
  }

  function isToolElement(el) {
    for (let c = el; c && c !== document.body; c = c.parentElement)
      if (c.getAttribute?.("data-el-locator")) return true;
    return false;
  }

  function mark(el) { el.setAttribute("data-el-locator", "true"); return el; }

  function updateHover(indicator, target, visible = true) {
    const $i = $(indicator);
    if (!visible || !target) { $i.hide(); return; }
    const r = target.getBoundingClientRect();
    $i.css({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, display: "block" });
  }

  function adjustToastPos(toast, mx, my) {
    const $t = $(toast);
    const h = $t.height(), w = $t.width();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    $t.toggleClass("el-toast--bottom", my < h + rem && mx > window.innerWidth - w - rem);
  }

  function clickOnToast(toast, mx, my) {
    const r = toast.getBoundingClientRect();
    return mx >= r.left && mx <= r.right && my >= r.top && my <= r.bottom;
  }

  function resetPb(pb, dur = 3000) {
    const $p = $(pb);
    $p.css("animation", "none"); pb.offsetHeight; $p.css("animation", `el-pb ${dur}ms linear forwards`);
  }

  function collectPath(el) {
    const items = [];
    for (let c = el; c && c !== document; c = c.parentElement) {
      const dn = c.hasAttribute("data-name");
      const cls = String(c.className || "").trim();
      if (dn || cls) items.push({ tag: c.tagName.toLowerCase(), dataName: dn ? c.getAttribute("data-name") : null, className: cls });
    }
    return items;
  }

  function genPath(items) {
    if (!items.length) return null;
    return items.toReversed().map(e => {
      let s = e.tag;
      if (e.dataName) s += `[data-name="${e.dataName}"]`;
      else if (e.className) s += `.${e.className.replace(/\s+/g, ".")}`;
      return s;
    }).join(" > ");
  }

  function commonPrefix(paths) {
    if (!paths.length) return "";
    const parts = paths.map(p => p.split(" > "));
    let common = parts[0];
    for (let i = 1; i < parts.length; i++) {
      const cur = [];
      for (let j = 0; j < Math.min(common.length, parts[i].length); j++) {
        if (common[j] === parts[i][j]) cur.push(common[j]); else break;
      }
      common = cur;
      if (!common.length) break;
    }
    return common.join(" > ");
  }

  function fmtPaths(paths) {
    if (paths.length <= 1) return paths[0] || "";
    const pre = commonPrefix(paths);
    if (!pre) return paths.join("\n");
    return `/* 公共父级 */\n${pre}\n\n/* 子元素 */\n${
      paths.map(p => {
        const d = p.slice(pre.length).trim();
        return d ? `& > ${d.startsWith("> ") ? d.slice(2) : d}` : "& /* 自身 */";
      }).join("\n")
    }`;
  }

  async function copy(text) {
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return { ok: true, api: "Clipboard API" }; }
    } catch {}
    try {
      const ta = $("<textarea>").css({ position: "fixed", left: "-9999px", top: "-9999px" }).val(text).appendTo(document.body);
      ta[0].focus(); ta[0].select();
      const ok = document.execCommand("copy");
      ta.remove();
      return { ok, api: 'execCommand("copy")' };
    } catch { return { ok: false, api: "none" }; }
  }

  function showModal(content, onClose) {
    const dark = isDarkMode();
    const close = () => { $ov.remove(); onClose?.(); };
    const $ov = $("<div>").addClass("el-overlay").on("click", e => { if (e.target === $ov[0]) close(); });
    mark($ov[0]);

    const autoClose = localStorage.getItem("el_autoClose") === "true";
    const $cb = $("<input>", { type: "checkbox", id: "el-ac", checked: autoClose }).css({ cursor: "pointer", width: 16, height: 16 })
      .on("change", () => localStorage.setItem("el_autoClose", $cb[0].checked));

    $("<div>").addClass("el-box").toggleClass("el-box--dark", dark).append(
      $("<h3>").text("元素定位路径"),
      $("<div>").addClass("el-code").text(content),
      $("<div>").addClass("el-row").append($cb, $("<label>", { htmlFor: "el-ac" }).text("复制成功后三秒关闭")),
      $("<div>").addClass("el-bar").toggleClass("el-bar--dark", dark),
      $("<div>").addClass("el-flex").append(
        $("<button>").addClass("el-btn el-btn--primary").toggleClass("el-btn--dark", dark).text("复制")
          .on("click", async function () {
            const r = await copy(content);
            if (r.ok) {
              $(this).text("已复制！").css("background", "#4CAF50");
              $ov.find(".el-bar").text(`API: ${r.api}`).show();
              if ($cb[0].checked) setTimeout(close, 3000);
              else setTimeout(() => { $(this).text("复制").css("background", ""); $ov.find(".el-bar").hide(); }, 2000);
            } else {
              $(this).text("复制失败").css("background", "#f44336");
              setTimeout(() => $(this).text("复制").css("background", ""), 2000);
            }
          }),
        $("<button>").addClass("el-btn el-btn--close").toggleClass("el-btn--dark", dark).text("关闭").on("click", close),
      ),
    ).appendTo($ov).appendTo(document.body);
  }

  // ========== 模式一：单次定位 ==========
  function startDetector() {
    const toast = mark(createToast("🎯 请点击页面上的任意元素...", "#00ff00"));
    const $t = $(toast).appendTo(document.body);
    const $pb = $t.find(".el-progress");
    const show = () => { $t.show().css("opacity", "1"); resetPb($pb[0]); };
    const hideTimer = setTimeout(() => fadeOut($t), 3000);
    let lastClick = 0, active = true;

    const mm = (e) => adjustToastPos(toast, e.clientX, e.clientY);
    document.addEventListener("mousemove", mm);

    const cleanup = () => {
      if (!active) return; active = false;
      clearTimeout(hideTimer);
      document.removeEventListener("click", handler, true);
      document.removeEventListener("mousemove", mm);
      $t.remove(); unregisterMode("detector");
    };
    registerMode("detector", cleanup);

    const handler = (e) => {
      if (!active || Date.now() - lastClick < 500 || isToolElement(e.target) || clickOnToast(toast, e.clientX, e.clientY)) return;
      lastClick = Date.now();
      e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
      showElementBorder(e.target);

      const items = collectPath(e.target);
      if (!items.length) {
        show(); $t.text("❌ 未找到带 data-name 或 class 的元素").css("border-left-color", "#f44336");
        setTimeout(cleanup, 3000);
      } else {
        show(); $t.text("✅ 已找到元素路径，请查看对话框").css("border-left-color", "#4CAF50");
        showModal(genPath(items), cleanup);
      }
      document.removeEventListener("click", handler, true);
      document.removeEventListener("mousemove", mm);
    };
    document.addEventListener("click", handler, true);
  }

  // ========== 模式二：自动挡 ==========
  function startAuto() {
    const toast = mark(createToast("🎯 请点击页面上的任意元素...", "#00ff00"));
    const $t = $(toast).appendTo(document.body);
    const $pb = $t.find(".el-progress");
    const hi = $(createHoverIndicator()).appendTo(document.body);
    let lastEl = null, lastClick = 0, active = true;

    const show = () => { $t.show().css("opacity", "1"); resetPb($pb[0]); };
    const hideTimer = setTimeout(() => fadeOut($t), 3000);

    const cleanup = () => {
      if (!active) return; active = false;
      clearTimeout(hideTimer);
      document.removeEventListener("click", handler, true);
      document.removeEventListener("mousemove", mm);
      $t.remove(); hi.remove(); lastEl?.css({ outline: "", outlineOffset: "" });
      unregisterMode("auto");
    };
    registerMode("auto", cleanup);

    const mm = (e) => {
      if (!active) return;
      if (Date.now() - lastClick < 500) { hi.hide(); lastEl?.css({ outline: "", outlineOffset: "" }); lastEl = null; }
      else {
        const t = e.target;
        if (t && t !== toast && t !== hi[0]) {
          updateHover(hi[0], t, true);
          if (lastEl && lastEl[0] !== t) lastEl.css({ outline: "", outlineOffset: "" });
          lastEl = $(t);
        }
      }
      adjustToastPos(toast, e.clientX, e.clientY);
    };
    document.addEventListener("mousemove", mm);

    const handler = async (e) => {
      if (!active || Date.now() - lastClick < 500 || isToolElement(e.target) || clickOnToast(toast, e.clientX, e.clientY)) return;
      lastClick = Date.now();
      e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
      showElementBorder(e.target);

      const items = collectPath(e.target);
      if (!items.length) {
        show(); $t.text("❌ 未找到带 data-name 或 class 的元素").css("border-left-color", "#f44336");
        setTimeout(cleanup, 3000);
      } else {
        const path = genPath(items);
        const r = await copy(path);
        show();
        $t.text(r.ok ? `✅ 已复制！\nAPI: ${r.api}` : "❌ 复制失败")
          .css("border-left-color", r.ok ? "#4CAF50" : "#f44336");
        setTimeout(cleanup, 3000);
      }
      document.removeEventListener("click", handler, true);
      document.removeEventListener("mousemove", mm);
    };
    document.addEventListener("click", handler, true);
  }

  // ========== 模式三：批量记录 ==========
  function startBatch(optimized = true) {
    const modeName = optimized ? "批量记录模式" : "传统批量记录模式";
    const theme = optimized ? "#ff9800" : "#9c27b0";
    const paths = [];
    let recording = true, hideTimer = null;

    const toast = mark(createToast(`📝 ${modeName} (已记录: 0)\n按 "c" 停止并复制`, theme));
    const $t = $(toast).appendTo(document.body);
    const $pb = $t.find(".el-progress");
    const hi = $(createHoverIndicator(theme)).appendTo(document.body);
    let lastEl = null, lastClick = 0;

    const cleanup = () => {
      if (!recording) return; recording = false;
      if (hideTimer) clearTimeout(hideTimer);
      document.removeEventListener("click", handler, true);
      document.removeEventListener("mousemove", mm);
      document.removeEventListener("keydown", key);
      $t.remove(); hi.remove(); lastEl?.css({ outline: "", outlineOffset: "" });
      unregisterMode("batch");
    };
    registerMode("batch", cleanup);

    const show = () => {
      $t.show().css("opacity", "1"); resetPb($pb[0]);
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (recording) fadeOut($t); }, 3000);
    };
    show();

    const mm = (e) => {
      if (!recording) return;
      if (Date.now() - lastClick < 500) { hi.hide(); lastEl?.css({ outline: "", outlineOffset: "" }); lastEl = null; }
      else {
        const t = e.target;
        if (t && t !== toast && t !== hi[0]) {
          updateHover(hi[0], t, true);
          if (lastEl && lastEl[0] !== t) lastEl.css({ outline: "", outlineOffset: "" });
          lastEl = $(t);
        }
      }
      adjustToastPos(toast, e.clientX, e.clientY);
    };
    document.addEventListener("mousemove", mm);

    async function stop() {
      if (!recording) return; recording = false;
      if (hideTimer) clearTimeout(hideTimer);
      hi.remove();
      document.removeEventListener("click", handler, true);
      document.removeEventListener("mousemove", mm);
      document.removeEventListener("keydown", key);
      lastEl?.css({ outline: "", outlineOffset: "" });
      unregisterMode("batch");

      if (!paths.length) {
        $t.show().css("opacity", "1").text("❌ 未记录任何元素").css("border-left-color", "#f44336");
        return setTimeout(() => $t.remove(), 2000);
      }
      const text = optimized ? fmtPaths(paths) : paths.join("\n");
      const r = await copy(text);
      $t.show().css("opacity", "1")
        .text(r.ok ? `✅ 已复制 ${paths.length} 个路径！\nAPI: ${r.api}` : "❌ 复制失败")
        .css("border-left-color", r.ok ? "#4CAF50" : "#f44336");
      setTimeout(() => $t.remove(), 3000);
    }

    const key = (e) => { if (e.key.toLowerCase() === "c") { e.preventDefault(); e.stopPropagation(); stop(); } };
    document.addEventListener("keydown", key);

    const handler = (e) => {
      if (!recording || Date.now() - lastClick < 500 || isToolElement(e.target) || clickOnToast(toast, e.clientX, e.clientY)) return;
      lastClick = Date.now();
      e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
      showElementBorder(e.target);

      const items = collectPath(e.target);
      if (!items.length) {
        show(); $t.text(`❌ 未找到\n已记录: ${paths.length}\n按 "c" 停止`).css("border-left-color", "#f44336");
        setTimeout(() => { if (recording) $t.text(`📝 ${modeName} (${paths.length})\n按 "c" 停止`).css("border-left-color", theme); }, 1500);
        return;
      }
      paths.push(genPath(items));
      show(); $t.text(`✅ 已记录 (${paths.length})\n按 "c" 停止`).css("border-left-color", "#4CAF50");
      setTimeout(() => { if (recording) $t.text(`📝 ${modeName} (${paths.length})\n按 "c" 停止`).css("border-left-color", theme); }, 800);
    };
    document.addEventListener("click", handler, true);
  }

  // ========== 菜单注册 ==========
  GM_registerMenuCommand("🔍 启动元素定位工具", startDetector);
  GM_registerMenuCommand("📝 批量记录模式", () => startBatch(true));
  GM_registerMenuCommand("📝 批量记录模式 (传统)", () => startBatch(false));
  GM_registerMenuCommand("⚡ 自动挡", startAuto);
})();
