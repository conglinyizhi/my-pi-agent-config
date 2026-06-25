// ==UserScript==
// @name         Debug 元素定位工具
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  点击页面元素后，向上搜索所有带有 data-name 属性的元素，生成 CSS 路径用于调试
// @author       Conglinyizhi
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @require      https://cdn.jsdelivr.net/npm/jquery@4.0/dist/jquery.slim.min.js
// ==/UserScript==

(function () {
  "use strict";

  // ========== CSS 样式常量 ==========
  const CSS_STYLES = {
    COLORS: {
      primary: "#2196F3",
      success: "#4CAF50",
      warning: "#ff9800",
      error: "#f44336",
      purple: "#9c27b0",
      darkMode: {
        primary: "#4a90a4",
        purple: "#7b1fa2",
      },
    },

    toast: (darkMode) => `
            position: fixed;
            top: 20px;
            right: 20px;
            background-color: ${darkMode ? "#2d2d2d" : "#333"};
            color: ${darkMode ? "#e0e0e0" : "white"};
            padding: 12px 20px;
            padding-bottom: 8px;
            border-radius: 4px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
            z-index: 9999999;
            font-size: 14px;
            max-width: 400px;
            word-wrap: break-word;
            transition: top 0.3s ease, right 0.3s ease;
        `,

    progressBar: (color) => `
            position: absolute;
            bottom: 0;
            left: 0;
            height: 3px;
            background-color: ${color};
            border-radius: 0 0 4px 4px;
            animation: progress 3s linear forwards;
        `,

    hoverIndicator: (color) => `
            position: fixed;
            pointer-events: none;
            border: 2px solid ${color};
            background-color: ${color}1a;
            z-index: 9999998;
            display: none;
            transition: all 0.1s ease;
        `,

    borderLeft: (color) => `border-left: 4px solid ${color};`,

    progressAnimation: `
            @keyframes progress {
                from { width: 100%; }
                to { width: 0%; }
            }
        `,

    slideInAnimation: `
            @keyframes slideIn {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
        `,

    slideOutAnimation: `
            @keyframes slideOut {
                from {
                    transform: translateX(0);
                    opacity: 1;
                }
                to {
                    transform: translateX(100%);
                    opacity: 0;
                }
            }
        `,
  };

  // ========== 工具函数 ==========

  function isDarkMode() {
    return (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }

  function showElementBorder(element, duration = 1000) {
    if (!element) return;
    const $el = $(element);
    const originalOutline = $el.css("outline");
    const originalOutlineOffset = $el.css("outlineOffset");

    $el.css({ outline: "3px solid #2196F3", outlineOffset: "2px" });

    setTimeout(() => {
      $el.css({
        outline: originalOutline,
        outlineOffset: originalOutlineOffset,
      });
    }, duration);
  }

  // 创建 Toast 元素（使用 cssText 设批量样式）
  function createToastWithProgress(message, themeColor = CSS_STYLES.COLORS.primary) {
    const darkMode = isDarkMode();
    const actualColor =
      darkMode && themeColor === CSS_STYLES.COLORS.primary
        ? CSS_STYLES.COLORS.darkMode.primary
        : themeColor;

    const $toast = $("<div>")
      .attr("style", CSS_STYLES.toast(darkMode) + CSS_STYLES.borderLeft(themeColor))
      .text(message);

    const $progress = $("<div>").attr("style", CSS_STYLES.progressBar(actualColor));
    $toast.append($progress);

    return $toast[0];
  }

  function createHoverIndicator(color = CSS_STYLES.COLORS.primary) {
    const darkMode = isDarkMode();
    const actualColor =
      darkMode && color === CSS_STYLES.COLORS.primary
        ? CSS_STYLES.COLORS.darkMode.primary
        : color;

    return $("<div>").attr("style", CSS_STYLES.hoverIndicator(actualColor))[0];
  }

  // 初始化动画样式
  let animationsInitialized = false;
  function initAnimations() {
    if (animationsInitialized) return;
    animationsInitialized = true;

    $("<style>", { id: "element-locator-animations" })
      .text(
        CSS_STYLES.progressAnimation +
        CSS_STYLES.slideInAnimation +
        CSS_STYLES.slideOutAnimation
      )
      .appendTo(document.head);
  }

  // 全局状态管理
  let activeMode = null;
  let activeCleanup = null;

  function registerMode(modeName, cleanupFn) {
    if (activeMode && activeCleanup) {
      console.log(`[元素定位工具] 切换模式: ${activeMode} -> ${modeName}`);
      activeCleanup();
    }
    activeMode = modeName;
    activeCleanup = cleanupFn;
  }

  function unregisterMode(modeName) {
    if (activeMode === modeName) {
      activeMode = null;
      activeCleanup = null;
    }
  }

  // 淡化隐藏（jQuery slim 无 fadeOut，用 CSS 过渡替代）
  function fadeOut($el, duration = 300) {
    $el.css({ transition: `opacity ${duration}ms`, opacity: "0" });
    setTimeout(() => $el.hide(), duration);
  }

  // 检查是否工具自身创建的元素
  function isToolElement(element) {
    let current = element;
    while (current && current !== document.body) {
      if (current.getAttribute && current.getAttribute("data-el-locator")) return true;
      current = current.parentElement;
    }
    return false;
  }

  // 标记工具创建的元素
  function markAsToolElement(el) {
    el.setAttribute("data-el-locator", "true");
    return el;
  }

  // 更新 hover 指示器位置
  function updateHoverIndicator(indicator, target, visible = true) {
    const $ind = $(indicator);
    if (!visible || !target) {
      $ind.hide();
      return;
    }
    const rect = target.getBoundingClientRect();
    $ind.css({
      left: rect.left + "px",
      top: rect.top + "px",
      width: rect.width + "px",
      height: rect.height + "px",
      display: "block",
    });
  }

  // 自动调整 Toast 位置（避开鼠标位置）
  function autoAdjustToastPosition(toast, mouseX, mouseY) {
    const $toast = $(toast);
    const toastHeight = $toast.height();
    const toastWidth = $toast.width();
    const oneRem =
      parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

    const isNearTopRight =
      mouseY < toastHeight + oneRem &&
      mouseX > window.innerWidth - toastWidth - oneRem;

    $toast.css(
      isNearTopRight
        ? { top: "auto", bottom: "20px" }
        : { top: "20px", bottom: "auto" },
    );
  }

  // 检查点击是否在 toast 外部（外部点需要拦截）
  function shouldInterceptClick(toast, mouseX, mouseY) {
    const rect = toast.getBoundingClientRect();
    const isInsideToast =
      mouseX >= rect.left &&
      mouseX <= rect.right &&
      mouseY >= rect.top &&
      mouseY <= rect.bottom;
    return !isInsideToast;
  }

  // 重置进度条动画
  function resetProgressBarAnimation(progressBar, duration = 3000) {
    const $pb = $(progressBar);
    $pb.css("animation", "none");
    progressBar.offsetHeight; // 强制重绘
    $pb.css("animation", `progress ${duration}ms linear forwards`);
  }

  // 收集元素的 data-name 路径信息
  function collectElementPathInfo(element) {
    const elementsWithDataName = [];
    let currentElement = element;

    while (currentElement && currentElement !== document) {
      const hasDataName = currentElement.hasAttribute("data-name");
      const classNameStr = String(currentElement.className || "");
      const hasClass = classNameStr.trim();

      if (hasDataName || hasClass) {
        elementsWithDataName.push({
          tag: currentElement.tagName.toLowerCase(),
          dataName: hasDataName
            ? currentElement.getAttribute("data-name")
            : null,
          className: hasClass ? classNameStr : "",
        });
      }
      currentElement = currentElement.parentElement;
    }

    return elementsWithDataName;
  }

  // 生成 CSS 路径（只使用 data-name 和 tag，class 作为备选）
  function generateCssPath(elementsWithDataName) {
    if (elementsWithDataName.length === 0) return null;

    const pathParts = [];
    for (let i = elementsWithDataName.length - 1; i >= 0; i--) {
      const el = elementsWithDataName[i];
      let selector = el.tag;

      if (el.dataName) {
        selector += `[data-name="${el.dataName}"]`;
      } else if (el.className) {
        // 没有 data-name 时才用 class 作为回退
        selector += `.${el.className.trim().replace(/\s+/g, ".")}`;
      }

      pathParts.push(selector);
    }

    return pathParts.join(" > ");
  }

  // 查找多个路径的公共前缀
  function findCommonPrefix(paths) {
    if (paths.length === 0) return "";
    const parts = paths.map((path) => path.split(" > "));
    let commonParts = parts[0];

    for (let i = 1; i < parts.length; i++) {
      let newCommonParts = [];
      for (let j = 0; j < Math.min(commonParts.length, parts[i].length); j++) {
        if (commonParts[j] === parts[i][j]) {
          newCommonParts.push(commonParts[j]);
        } else {
          break;
        }
      }
      commonParts = newCommonParts;
      if (commonParts.length === 0) break;
    }

    return commonParts.join(" > ");
  }

  // 格式化批量路径（公共父级 + 差异部分）
  function formatPathsOptimized(paths) {
    if (paths.length === 0) return "";
    if (paths.length === 1) return paths[0];

    const commonPrefix = findCommonPrefix(paths);

    if (!commonPrefix) {
      return paths.join("\n");
    }

    const diffParts = paths.map((path) => {
      if (path.startsWith(commonPrefix)) {
        const diff = path.slice(commonPrefix.length).trim();
        if (!diff) return "& /* 自身 */";
        return diff.startsWith("> ") ? `&${diff}` : `& > ${diff}`;
      }
      return `& > ${path}`;
    });

    return `/* 公共父级 */\n${commonPrefix}\n\n/* 子元素 */\n${diffParts.join("\n")}`;
  }

  // 复制到剪贴板
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return { success: true, api: "navigator.clipboard.writeText" };
      }
    } catch (err) {
      console.warn("Clipboard API 失败，尝试回退:", err);
    }

    try {
      const $textarea = $("<textarea>").css({
        position: "fixed",
        left: "-999999px",
        top: "-999999px",
      });
      $textarea.val(text).appendTo(document.body);
      $textarea[0].focus();
      $textarea[0].select();

      const successful = document.execCommand("copy");
      $textarea.remove();
      return { success: successful, api: 'document.execCommand("copy")' };
    } catch (err) {
      console.error("复制失败:", err);
      return { success: false, api: "none" };
    }
  }

  // 显示模态对话框
  function showModal(content, onCloseCallback) {
    const darkMode = isDarkMode();
    const bgColor = darkMode ? "#2d2d2d" : "white";
    const textColor = darkMode ? "#e0e0e0" : "#333";
    const btnBg = darkMode ? "#4a90a4" : "#2196F3";

    let $overlay;
    const closeDialog = () => {
      if ($overlay) $overlay.remove();
      if (onCloseCallback) onCloseCallback();
    };

    $overlay = $("<div>").css({
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      backgroundColor: "rgba(0, 0, 0, 0.5)",
      zIndex: "999999",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
    });
    markAsToolElement($overlay[0]);

    const $modal = $("<div>").css({
      backgroundColor: bgColor,
      borderRadius: "8px",
      padding: "20px",
      maxWidth: "600px",
      maxHeight: "80vh",
      overflowY: "auto",
      boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
    });

    const $title = $("<h3>")
      .css({ marginTop: "0", marginBottom: "15px", color: textColor })
      .text("元素定位路径");

    const $content = $("<div>").css({
      whiteSpace: "pre-wrap",
      wordWrap: "break-word",
      fontFamily: "'Courier New', monospace",
      fontSize: "14px",
      lineHeight: "1.6",
      color: textColor,
    }).text(content);

    // 自动关闭复选框
    const savedAutoClose =
      localStorage.getItem("elementLocator_autoClose") === "true";
    const $checkbox = $("<input>", {
      type: "checkbox",
      id: "autoCloseCheckbox",
      checked: savedAutoClose,
    }).css({ cursor: "pointer", width: "16px", height: "16px" });

    $checkbox.on("change", () => {
      localStorage.setItem("elementLocator_autoClose", $checkbox[0].checked);
    });

    const $checkboxLabel = $("<label>", { htmlFor: "autoCloseCheckbox" })
      .css({ cursor: "pointer", fontSize: "14px", color: textColor })
      .text("复制成功后三秒关闭");

    const $checkboxContainer = $("<div>").css({
      marginTop: "15px", display: "flex", alignItems: "center", gap: "8px",
    }).append($checkbox).append($checkboxLabel);

    const $apiInfo = $("<div>").css({
      marginTop: "10px", padding: "8px",
      backgroundColor: darkMode ? "#1a1a1a" : "#f5f5f5",
      borderRadius: "4px", fontSize: "12px",
      color: darkMode ? "#aaa" : "#666",
      display: "none",
    });

    const $copyBtn = $("<button>").css({
      padding: "8px 16px", backgroundColor: btnBg, color: "white",
      border: "none", borderRadius: "4px", cursor: "pointer",
      fontSize: "14px", flex: "1",
    }).text("复制");

    const $closeBtn = $("<button>").css({
      padding: "8px 16px",
      backgroundColor: darkMode ? "#5c5c5c" : "#4CAF50",
      color: "white", border: "none", borderRadius: "4px",
      cursor: "pointer", fontSize: "14px", flex: "1",
    }).text("关闭").on("click", closeDialog);

    const $btnContainer = $("<div>").css({
      display: "flex", gap: "10px", marginTop: "15px",
    }).append($copyBtn).append($closeBtn);

    // 复制按钮事件
    $copyBtn.on("click", async () => {
      const result = await copyToClipboard(content);
      if (result.success) {
        $copyBtn.text("已复制！").css("backgroundColor", "#4CAF50");
        $apiInfo.text(`使用的 API: ${result.api}`).show();

        if ($checkbox[0].checked) {
          setTimeout(closeDialog, 3000);
        } else {
          setTimeout(() => {
            $copyBtn.text("复制").css("backgroundColor", btnBg);
            $apiInfo.hide();
          }, 2000);
        }
      } else {
        $copyBtn.text("复制失败").css("backgroundColor", "#f44336");
        setTimeout(() => $copyBtn.text("复制").css("backgroundColor", btnBg), 2000);
      }
    });

    // 组装
    $modal
      .append($title)
      .append($content)
      .append($checkboxContainer)
      .append($apiInfo)
      .append($btnContainer);

    $overlay.append($modal).appendTo(document.body);

    // 点击遮罩层关闭
    $overlay.on("click", (e) => {
      if (e.target === $overlay[0]) closeDialog();
    });
  }

  // ========== 模式一：单次定位 ==========
  function startDataNameDetector() {
    initAnimations();

    const toastEl = markAsToolElement(
      createToastWithProgress("🎯 请点击页面上的任意元素...", "#00ff00"),
    );
    const $indicator = $(toastEl);
    const $progressBar = $indicator.find("div").first();
    $indicator.appendTo(document.body);

    const showToastWithAutoHide = () => {
      $indicator.show().css("opacity", "1");
      resetProgressBarAnimation($progressBar[0], 3000);
    };

    const hideToastTimeout = setTimeout(() => fadeOut($indicator, 300), 3000);

    const mouseMoveHandler = (e) => {
      autoAdjustToastPosition($indicator[0], e.clientX, e.clientY);
    };
    document.addEventListener("mousemove", mouseMoveHandler);

    let lastClickTime = 0;
    let isActive = true;

    const cleanup = () => {
      if (!isActive) return;
      isActive = false;
      clearTimeout(hideToastTimeout);
      document.removeEventListener("click", clickHandler, true);
      document.removeEventListener("mousemove", mouseMoveHandler);
      $indicator.remove();
      unregisterMode("detector");
    };

    registerMode("detector", cleanup);

    const clickHandler = (e) => {
      if (!isActive) return;
      const now = Date.now();
      if (now - lastClickTime < 500) return;
      if (isToolElement(e.target)) return;
      if (!shouldInterceptClick($indicator[0], e.clientX, e.clientY)) return;

      lastClickTime = now;
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();

      showElementBorder(e.target, 1000);

      const elementsWithDataName = collectElementPathInfo(e.target);

      if (elementsWithDataName.length === 0) {
        showToastWithAutoHide();
        $indicator
          .text("❌ 未找到带有 data-name 或 class 的元素")
          .css("borderLeft", "4px solid #f44336");
        setTimeout(cleanup, 3000);
      } else {
        const cssPath = generateCssPath(elementsWithDataName);
        showToastWithAutoHide();
        $indicator
          .text("✅ 已找到元素路径，请查看对话框")
          .css("borderLeft", "4px solid #4CAF50");
        showModal(cssPath, cleanup);
      }

      document.removeEventListener("click", clickHandler, true);
      document.removeEventListener("mousemove", mouseMoveHandler);
    };

    document.addEventListener("click", clickHandler, true);
    console.log("Debug 元素定位工具已启动，请点击页面上的任意元素...");
  }

  // ========== 模式二：自动挡（hover 预览 + 一键复制）==========
  function startAutoMode() {
    initAnimations();

    const toastEl = markAsToolElement(
      createToastWithProgress("🎯 请点击页面上的任意元素...", "#00ff00"),
    );
    const $indicator = $(toastEl);
    const $progressBar = $indicator.find("div").first();
    $indicator.appendTo(document.body);

    const $hoverIndicator = $(createHoverIndicator(CSS_STYLES.COLORS.primary));
    $hoverIndicator.appendTo(document.body);

    let $lastHoverElement = null;
    let lastClickTime = 0;
    let isActive = true;

    const showToastWithAutoHide = () => {
      $indicator.show().css("opacity", "1");
      resetProgressBarAnimation($progressBar[0], 3000);
    };

    const hideToastTimeout = setTimeout(() => fadeOut($indicator, 300), 3000);

    const cleanup = () => {
      if (!isActive) return;
      isActive = false;
      clearTimeout(hideToastTimeout);
      document.removeEventListener("click", clickHandler, true);
      document.removeEventListener("mousemove", mouseMoveHandler);
      $indicator.remove();
      $hoverIndicator.remove();
      if ($lastHoverElement) {
        $lastHoverElement.css({ outline: "", outlineOffset: "" });
      }
      unregisterMode("auto");
    };

    registerMode("auto", cleanup);

    const mouseMoveHandler = (e) => {
      if (!isActive) return;
      const now = Date.now();

      if (now - lastClickTime < 500) {
        $hoverIndicator.hide();
        if ($lastHoverElement) {
          $lastHoverElement.css({ outline: "", outlineOffset: "" });
          $lastHoverElement = null;
        }
      } else {
        const target = e.target;
        if (
          target &&
          target !== $indicator[0] &&
          target !== $hoverIndicator[0]
        ) {
          updateHoverIndicator($hoverIndicator[0], target, true);
          if ($lastHoverElement && $lastHoverElement[0] !== target) {
            $lastHoverElement.css({ outline: "", outlineOffset: "" });
          }
          $lastHoverElement = $(target);
        }
      }

      autoAdjustToastPosition($indicator[0], e.clientX, e.clientY);
    };

    document.addEventListener("mousemove", mouseMoveHandler);

    const clickHandler = async (e) => {
      if (!isActive) return;
      const now = Date.now();
      if (now - lastClickTime < 500) return;
      if (isToolElement(e.target)) return;
      if (!shouldInterceptClick($indicator[0], e.clientX, e.clientY)) return;

      lastClickTime = now;
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();

      showElementBorder(e.target, 1000);

      const elementsWithDataName = collectElementPathInfo(e.target);

      if (elementsWithDataName.length === 0) {
        showToastWithAutoHide();
        $indicator
          .text("❌ 未找到带有 data-name 或 class 的元素")
          .css("borderLeft", "4px solid #f44336");
        setTimeout(cleanup, 3000);
      } else {
        const cssPath = generateCssPath(elementsWithDataName);
        const result = await copyToClipboard(cssPath);
        showToastWithAutoHide();
        $indicator
          .text(
            result.success
              ? `✅ 已复制！\n使用的 API: ${result.api}`
              : "❌ 复制失败",
          )
          .css(
            "borderLeft",
            result.success ? "4px solid #4CAF50" : "4px solid #f44336",
          );
        setTimeout(cleanup, 3000);
      }

      document.removeEventListener("click", clickHandler, true);
      document.removeEventListener("mousemove", mouseMoveHandler);
    };

    document.addEventListener("click", clickHandler, true);
    console.log("自动挡模式已启动，请点击页面上的任意元素...");
  }

  // ========== 模式三：批量记录 ==========
  function startBatchMode(useOptimizedFormat = true) {
    initAnimations();

    const isTraditional = !useOptimizedFormat;
    const themeColor = isTraditional
      ? CSS_STYLES.COLORS.purple
      : CSS_STYLES.COLORS.warning;
    const modeName = isTraditional ? "传统批量记录模式" : "批量记录模式";
    const hoverColor = isTraditional
      ? CSS_STYLES.COLORS.purple
      : CSS_STYLES.COLORS.primary;

    const recordedPaths = [];
    let isRecording = true;
    let hideToastTimeout = null;

    const toastEl = markAsToolElement(
      createToastWithProgress(
        `📝 ${modeName} (已记录: 0)\n按 "c" 键停止并复制`,
        themeColor,
      ),
    );
    const $indicator = $(toastEl);
    const $progressBar = $indicator.find("div").first();
    $indicator.appendTo(document.body);

    const $hoverIndicator = $(createHoverIndicator(hoverColor));
    $hoverIndicator.appendTo(document.body);

    let $lastHoverElement = null;
    let lastClickTime = 0;

    const cleanup = () => {
      if (!isRecording) return;
      isRecording = false;
      if (hideToastTimeout) {
        clearTimeout(hideToastTimeout);
        hideToastTimeout = null;
      }
      document.removeEventListener("click", clickHandler, true);
      document.removeEventListener("mousemove", mouseMoveHandler);
      document.removeEventListener("keydown", keyHandler);
      $indicator.remove();
      $hoverIndicator.remove();
      if ($lastHoverElement) {
        $lastHoverElement.css({ outline: "", outlineOffset: "" });
      }
      unregisterMode("batch");
    };

    registerMode("batch", cleanup);

    const showToastWithAutoHide = () => {
      $indicator.show().css("opacity", "1");
      resetProgressBarAnimation($progressBar[0], 3000);

      if (hideToastTimeout) clearTimeout(hideToastTimeout);
      hideToastTimeout = setTimeout(() => {
        if (isRecording) fadeOut($indicator, 300);
      }, 3000);
    };

    showToastWithAutoHide();

    const mouseMoveHandler = (e) => {
      if (!isRecording) return;
      const now = Date.now();

      if (now - lastClickTime < 500) {
        $hoverIndicator.hide();
        if ($lastHoverElement) {
          $lastHoverElement.css({ outline: "", outlineOffset: "" });
          $lastHoverElement = null;
        }
      } else {
        const target = e.target;
        if (
          target &&
          target !== $indicator[0] &&
          target !== $hoverIndicator[0]
        ) {
          updateHoverIndicator($hoverIndicator[0], target, true);
          if ($lastHoverElement && $lastHoverElement[0] !== target) {
            $lastHoverElement.css({ outline: "", outlineOffset: "" });
          }
          $lastHoverElement = $(target);
        }
      }

      autoAdjustToastPosition($indicator[0], e.clientX, e.clientY);
    };

    document.addEventListener("mousemove", mouseMoveHandler);

    async function stopRecording() {
      if (!isRecording) return;
      isRecording = false;

      if (hideToastTimeout) {
        clearTimeout(hideToastTimeout);
        hideToastTimeout = null;
      }

      $hoverIndicator.remove();
      document.removeEventListener("click", clickHandler, true);
      document.removeEventListener("mousemove", mouseMoveHandler);
      document.removeEventListener("keydown", keyHandler);

      if ($lastHoverElement) {
        $lastHoverElement.css({ outline: "", outlineOffset: "" });
      }

      unregisterMode("batch");

      if (recordedPaths.length === 0) {
        $indicator
          .show()
          .css("opacity", "1")
          .text("❌ 未记录任何元素")
          .css("borderLeft", "4px solid #f44336");
        setTimeout(() => $indicator.remove(), 2000);
        return;
      }

      const allPaths = useOptimizedFormat
        ? formatPathsOptimized(recordedPaths)
        : recordedPaths.join("\n");

      const result = await copyToClipboard(allPaths);
      $indicator
        .show()
        .css("opacity", "1")
        .text(
          result.success
            ? `✅ 已复制 ${recordedPaths.length} 个元素路径！\n使用的 API: ${result.api}`
            : "❌ 复制失败",
        )
        .css(
          "borderLeft",
          result.success ? "4px solid #4CAF50" : "4px solid #f44336",
        );

      setTimeout(() => $indicator.remove(), 3000);
    }

    const keyHandler = (e) => {
      if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        e.stopPropagation();
        stopRecording();
      }
    };

    document.addEventListener("keydown", keyHandler);

    const clickHandler = (e) => {
      if (!isRecording) return;
      const now = Date.now();
      if (now - lastClickTime < 500) return;
      if (isToolElement(e.target)) return;
      if (!shouldInterceptClick($indicator[0], e.clientX, e.clientY)) return;

      lastClickTime = now;
      e.stopPropagation();
      e.stopImmediatePropagation();
      e.preventDefault();

      showElementBorder(e.target, 1000);

      const elementsWithDataName = collectElementPathInfo(e.target);

      if (elementsWithDataName.length === 0) {
        showToastWithAutoHide();
        $indicator
          .text(
            `❌ 未找到带有 data-name 或 class 的元素\n已记录: ${recordedPaths.length}\n按 "c" 键停止并复制`,
          )
          .css("borderLeft", "4px solid #f44336");
        setTimeout(() => {
          if (isRecording) {
            $indicator
              .text(
                `📝 ${modeName} (已记录: ${recordedPaths.length})\n按 "c" 键停止并复制`,
              )
              .css("borderLeft", `4px solid ${themeColor}`);
          }
        }, 1500);
        return;
      }

      recordedPaths.push(generateCssPath(elementsWithDataName));

      showToastWithAutoHide();
      $indicator
        .text(
          `✅ 已记录 (已记录: ${recordedPaths.length})\n按 "c" 键停止并复制`,
        )
        .css("borderLeft", "4px solid #4CAF50");

      setTimeout(() => {
        if (isRecording) {
          $indicator
            .text(
              `📝 ${modeName} (已记录: ${recordedPaths.length})\n按 "c" 键停止并复制`,
            )
            .css("borderLeft", `4px solid ${themeColor}`);
        }
      }, 800);
    };

    document.addEventListener("click", clickHandler, true);
    console.log(`${modeName}已启动，点击元素记录路径，按 "c" 键停止并复制...`);
  }

  // ========== 右键菜单注册 ==========
  GM_registerMenuCommand("🔍 启动元素定位工具", function () {
    startDataNameDetector();
  });

  GM_registerMenuCommand("📝 批量记录模式", function () {
    startBatchMode(true);
  });

  GM_registerMenuCommand("📝 批量记录模式 (传统)", function () {
    startBatchMode(false);
  });

  GM_registerMenuCommand("⚡ 自动挡", function () {
    startAutoMode();
  });

  console.log(
    'Debug 元素定位工具已加载，请在暴力猴菜单中点击"启动元素定位工具"或"自动挡"或"批量记录模式"',
  );
})();
