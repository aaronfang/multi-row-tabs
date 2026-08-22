(function () {
  // 防止重复注入（manifest 自动注入 + 手动 executeScript 可能叠加）
  if (window.__mrtInjected) return;
  window.__mrtInjected = true;

  const FALLBACK_ICON =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect width='16' height='16' rx='3' fill='%239aa0a6'/></svg>";

  let bar = null;
  let launcher = null;
  let enabled = false;
  let lastSig = "";
  let floatOpen = false;
  let hotkey = "Alt+Z"; // 用户自定义快捷键，默认 Alt+Z
  let sortMode = "default"; // 排序方式：default 与浏览器一致 / title 按名称 / host 按域名
  // 悬浮按钮位置：百分比存储，窗口尺寸变化后仍能保持相对位置
  let launcherPos = null;
  let drag = null;

  function setFloatOpen(open) {
    floatOpen = open;
    if (bar) bar.classList.toggle("mrt-open", open);
    if (launcher) launcher.style.display = open ? "none" : "";
    if (open) {
      // 展开时默认聚焦当前活动标签，可用方向键导航、回车切换
      const els = tabEls();
      const activeIdx = els.findIndex((el) => el.classList.contains("mrt-active"));
      setKbFocus(activeIdx >= 0 ? activeIdx : 0);
    } else {
      clearKbFocus();
    }
  }

  // ===== 键盘方向键导航 =====
  let kbIndex = -1; // 当前键盘焦点标签下标

  function tabEls() {
    return bar ? Array.from(bar.querySelectorAll(".mrt-tab")) : [];
  }

  function setKbFocus(i) {
    const els = tabEls();
    if (!els.length) return;
    kbIndex = Math.max(0, Math.min(els.length - 1, i));
    els.forEach((el, idx) => el.classList.toggle("mrt-kbfocus", idx === kbIndex));
    els[kbIndex].scrollIntoView({ block: "nearest" });
  }

  function clearKbFocus() {
    kbIndex = -1;
    tabEls().forEach((el) => el.classList.remove("mrt-kbfocus"));
  }

  // 上 / 下移动一行：在相邻行中找水平中心最接近的标签
  function moveRow(dir) {
    const els = tabEls();
    if (!els.length || kbIndex < 0) return;
    const cur = els[kbIndex];
    const cx = cur.offsetLeft + cur.offsetWidth / 2;
    const curTop = cur.offsetTop;
    let best = -1;
    let bestDist = Infinity;
    els.forEach((el, idx) => {
      if (dir < 0 ? el.offsetTop >= curTop : el.offsetTop <= curTop) return;
      // 优先选择最近的行，同行内选水平中心最接近的
      const d = Math.abs(el.offsetTop - curTop) * 10000 + Math.abs(el.offsetLeft + el.offsetWidth / 2 - cx);
      if (d < bestDist) {
        bestDist = d;
        best = idx;
      }
    });
    if (best >= 0) setKbFocus(best);
  }

  function ensureBar() {
    if (bar && document.body.contains(bar)) return bar;
    bar = document.createElement("div");
    bar.id = "mrt-bar";
    // 鼠标离开标签栏后自动收起，避免长时间遮挡页面
    bar.addEventListener("mouseleave", () => {
      if (!floatOpen) return;
      setTimeout(() => {
        if (bar && !bar.matches(":hover")) setFloatOpen(false);
      }, 250);
    });
    document.body.appendChild(bar);
    return bar;
  }

  // ===== 右上角悬浮按钮：可拖拽到页面任意位置 =====
  function applyLauncherPos() {
    if (!launcher) return;
    if (launcherPos) {
      launcher.style.left = launcherPos.x + "%";
      launcher.style.top = launcherPos.y + "%";
      launcher.style.right = "auto";
    }
  }

  function ensureLauncher() {
    if (launcher && document.body.contains(launcher)) return launcher;
    launcher = document.createElement("div");
    launcher.id = "mrt-launcher";
    launcher.textContent = "≡";
    launcher.title = "展开多行标签栏（可拖拽移动）";

    launcher.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      drag = {
        sx: ev.clientX,
        sy: ev.clientY,
        lx: launcher.offsetLeft,
        ly: launcher.offsetTop,
        moved: false,
      };
      launcher.setPointerCapture(ev.pointerId);
    });
    launcher.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.sx;
      const dy = ev.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) > 5) {
        drag.moved = true;
        launcher.classList.add("mrt-dragging");
      }
      if (!drag.moved) return;
      const w = launcher.offsetWidth;
      const h = launcher.offsetHeight;
      const x = Math.min(Math.max(0, drag.lx + dx), window.innerWidth - w);
      const y = Math.min(Math.max(0, drag.ly + dy), window.innerHeight - h);
      launcher.style.left = x + "px";
      launcher.style.top = y + "px";
      launcher.style.right = "auto";
    });
    launcher.addEventListener("pointerup", () => {
      if (!drag) return;
      const wasDrag = drag.moved;
      drag = null;
      launcher.classList.remove("mrt-dragging");
      if (wasDrag) {
        // 以百分比保存，窗口尺寸变化后自动适配
        launcherPos = {
          x: +((launcher.offsetLeft / window.innerWidth) * 100).toFixed(2),
          y: +((launcher.offsetTop / window.innerHeight) * 100).toFixed(2),
        };
        chrome.storage.local.set({ launcherPos });
        applyLauncherPos();
      } else {
        setFloatOpen(!floatOpen); // 视为点击：展开 / 收起
      }
    });

    document.body.appendChild(launcher);
    applyLauncherPos();
    return launcher;
  }

  // 标签数据签名：无变化时跳过重绘，减少卡顿
  function signature(tabs, showUrl) {
    return (
      (showUrl ? 1 : 0) +
      "|" +
      sortMode +
      "\n" +
      tabs
        .map((t) => [t.id, t.active ? 1 : 0, t.title || "", t.url || "", (t.fav || "").length].join("|"))
        .join("\n")
    );
  }

  // ===== 排序 =====
  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return "";
    }
  }

  // 常见二级后缀（国家/地区 + 用途组合），命中时一级域名取后三段
  const SECOND_LEVEL_TLDS = new Set([
    "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn",
    "co.uk", "org.uk", "ac.uk", "gov.uk",
    "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
    "com.hk", "org.hk", "edu.hk", "gov.hk",
    "com.tw", "org.tw", "edu.tw", "gov.tw",
    "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "co.kr", "or.kr", "go.kr",
    "com.sg", "com.my", "com.br", "com.mx", "com.ar", "com.tr",
    "com.vn", "com.ph", "com.co", "com.pe", "com.eg", "com.sa",
    "co.in", "co.nz", "co.za", "co.id", "co.th", "co.il",
  ]);

  // 提取一级域名：www.example.com → example.com；a.b.com.cn → b.com.cn
  function rootDomain(host) {
    if (!host) return "";
    const labels = host.toLowerCase().split(".");
    if (labels.length <= 2) return host.toLowerCase();
    if (/^\d+$/.test(labels[labels.length - 1]) || /^\[/.test(host)) return host.toLowerCase(); // IP 地址
    const lastTwo = labels.slice(-2).join(".");
    const keep = SECOND_LEVEL_TLDS.has(lastTwo) ? 3 : 2;
    return labels.slice(-Math.min(keep, labels.length)).join(".");
  }

  function cmpText(a, b) {
    // localeCompare 支持中文拼音排序；相等时按标签 id 稳定排序
    return a.localeCompare(b, "zh-Hans-CN") || 0;
  }

  function sortTabs(tabs) {
    if (sortMode === "title") {
      return [...tabs].sort(
        (a, b) => cmpText(a.title || "", b.title || "") || a.id - b.id
      );
    }
    if (sortMode === "host") {
      // 优先按一级域名排序，同一级域名内再按完整主机名、标题排序
      return [...tabs].sort((a, b) => {
        const ha = hostOf(a.url);
        const hb = hostOf(b.url);
        return (
          cmpText(rootDomain(ha), rootDomain(hb)) ||
          cmpText(ha, hb) ||
          cmpText(a.title || "", b.title || "") ||
          a.id - b.id
        );
      });
    }
    return tabs; // default：保持浏览器标签原始顺序
  }

  async function render() {
    if (!enabled) {
      if (bar) {
        bar.remove();
        bar = null;
      }
      if (launcher) {
        launcher.remove();
        launcher = null;
      }
      floatOpen = false;
      lastSig = "";
      return;
    }

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "mrt-get-tabs" });
    } catch (e) {
      return;
    }
    if (!resp || !resp.tabs) return;
    const tabs = sortTabs(resp.tabs);
    const showUrl = !!resp.showUrl;

    const sig = signature(tabs, showUrl);
    if (sig === lastSig && bar && document.body.contains(bar)) return; // 无变化，跳过重绘
    lastSig = sig;

    const b = ensureBar();
    b.textContent = "";
    ensureLauncher();
    b.classList.toggle("mrt-open", floatOpen);
    if (launcher) launcher.style.display = floatOpen ? "none" : "";

    // 排序控件：位于标签栏开头，切换后立即重绘
    const sortSel = document.createElement("select");
    sortSel.className = "mrt-sort";
    sortSel.title = "标签排序方式";
    for (const [value, label] of [
      ["default", "默认"],
      ["title", "按名称"],
      ["host", "按域名"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      sortSel.appendChild(opt);
    }
    sortSel.value = sortMode;
    sortSel.addEventListener("click", (ev) => ev.stopPropagation());
    sortSel.addEventListener("change", () => {
      sortMode = sortSel.value;
      chrome.storage.local.set({ sortMode });
      lastSig = ""; // 强制重绘
      render();
    });
    b.appendChild(sortSel);

    // 标签数量统计
    const countEl = document.createElement("span");
    countEl.className = "mrt-count";
    countEl.textContent = tabs.length;
    countEl.title = "当前打开的标签页数";
    b.appendChild(countEl);

    for (const t of tabs) {
      const item = document.createElement("div");
      item.className = "mrt-tab" + (t.active ? " mrt-active" : "");
      item.title = (t.title || "") + "\n" + (t.url || "");
      item.setAttribute("data-tab-id", t.id); // 键盘导航回车切换时读取

      // 第一行：图标 + 标题 + 关闭按钮
      const main = document.createElement("div");
      main.className = "mrt-main";

      const fav = document.createElement("img");
      fav.className = "mrt-fav";
      fav.src = t.fav || FALLBACK_ICON;
      fav.onerror = () => {
        fav.onerror = null;
        fav.src = FALLBACK_ICON;
      };
      main.appendChild(fav);

      const title = document.createElement("span");
      title.className = "mrt-title";
      title.textContent = t.title || t.url || "(无标题)";
      main.appendChild(title);

      const close = document.createElement("span");
      close.className = "mrt-close";
      close.textContent = "×";
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        chrome.runtime.sendMessage({ type: "mrt-close", tabId: t.id });
        // 立即从展开的标签栏中移除该标签，无需等待 background 刷新
        item.remove();
      });
      main.appendChild(close);

      item.appendChild(main);

      // 第二行：链接（配置开启时显示）
      if (showUrl) {
        const urlEl = document.createElement("div");
        urlEl.className = "mrt-url";
        urlEl.textContent = t.url || "";
        item.appendChild(urlEl);
      }

      // 左键：切换到该标签
      item.addEventListener("click", () => {
        if (!t.active) {
          chrome.runtime.sendMessage({ type: "mrt-activate", tabId: t.id });
        }
      });

      // 中键：关闭该标签（与原生标签栏行为一致）
      // 自动滚动由 mousedown 默认行为触发，必须在此阶段阻止，auxclick 时已太晚
      item.addEventListener("mousedown", (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          ev.stopPropagation();
        }
      });
      item.addEventListener("auxclick", (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          ev.stopPropagation();
          chrome.runtime.sendMessage({ type: "mrt-close", tabId: t.id });
          item.remove();
        }
      });

      b.appendChild(item);
    }

    // 展开期间数据刷新重绘后，恢复键盘焦点高亮
    if (floatOpen && kbIndex >= 0) setKbFocus(kbIndex);
  }

  // 窗口尺寸变化时，按百分比重新定位悬浮按钮
  window.addEventListener("resize", applyLauncherPos);

  // ===== 自定义快捷键：展开 / 收起标签栏 =====
  function comboFromEvent(ev) {
    const parts = [];
    if (ev.ctrlKey) parts.push("Ctrl");
    if (ev.altKey) parts.push("Alt");
    if (ev.shiftKey) parts.push("Shift");
    if (ev.metaKey) parts.push("Meta");
    let key = ev.key;
    if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;
    if (key === " ") key = "Space";
    else if (key.length === 1) key = key.toUpperCase();
    parts.push(key);
    return parts.join("+");
  }

  window.addEventListener("keydown", (ev) => {
    if (!enabled) return;

    // 快捷键：收起时展开、展开时收起（开 / 关切换），优先于导航逻辑
    if (hotkey && comboFromEvent(ev) === hotkey) {
      ev.preventDefault();
      ev.stopPropagation();
      setFloatOpen(!floatOpen);
      return;
    }

    // 标签栏展开时：方向键导航、回车切换、Esc 收起
    if (floatOpen && bar) {
      const els = tabEls();
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        setFloatOpen(false);
        return;
      }
      if (!els.length) return;
      if (kbIndex < 0) setKbFocus(0);
      switch (ev.key) {
        case "ArrowRight":
          ev.preventDefault();
          ev.stopPropagation();
          setKbFocus(kbIndex + 1);
          return;
        case "ArrowLeft":
          ev.preventDefault();
          ev.stopPropagation();
          setKbFocus(kbIndex - 1);
          return;
        case "ArrowDown":
          ev.preventDefault();
          ev.stopPropagation();
          moveRow(1);
          return;
        case "ArrowUp":
          ev.preventDefault();
          ev.stopPropagation();
          moveRow(-1);
          return;
        case "Enter":
          ev.preventDefault();
          ev.stopPropagation();
          if (kbIndex >= 0 && els[kbIndex]) {
            const tabId = parseInt(els[kbIndex].getAttribute("data-tab-id"), 10);
            if (!Number.isNaN(tabId)) {
              chrome.runtime.sendMessage({ type: "mrt-activate", tabId });
            }
          }
          return;
        case "Delete":
          ev.preventDefault();
          ev.stopPropagation();
          if (kbIndex >= 0 && els[kbIndex]) {
            const tabId = parseInt(els[kbIndex].getAttribute("data-tab-id"), 10);
            if (!Number.isNaN(tabId)) {
              chrome.runtime.sendMessage({ type: "mrt-close", tabId });
              els[kbIndex].remove();
            }
          }
          return;
      }
      return; // 展开状态下其余按键不拦截，交给页面
    }
  }, true); // 捕获阶段，优先于页面自身快捷键

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "mrt-set-enabled") {
      enabled = !!msg.enabled;
      render();
    } else if (msg.type === "mrt-refresh") {
      if (enabled) render();
    }
  });

  // 配置变化（showUrl / 按钮位置 / 快捷键 / 排序方式）时处理
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.showUrl && enabled) render();
    if (changes.launcherPos) {
      launcherPos = changes.launcherPos.newValue || null;
      applyLauncherPos();
    }
    if (changes.hotkey) {
      hotkey = changes.hotkey.newValue || "";
    }
    if (changes.sortMode) {
      const next = changes.sortMode.newValue || "default";
      if (next !== sortMode) {
        sortMode = next;
        if (enabled) render();
      }
    }
  });

  // 初始化：读取开关状态、按钮位置、快捷键与排序方式
  // hotkey 为 undefined 表示从未设置 → 使用默认 Alt+Z；为空字符串表示用户已清除 → 无快捷键
  chrome.storage.local.get(["enabled", "launcherPos", "hotkey", "sortMode"], (r) => {
    enabled = !!r.enabled;
    launcherPos = r.launcherPos || null;
    hotkey = r.hotkey === undefined ? "Alt+Z" : r.hotkey || "";
    sortMode = r.sortMode || "default";
    render();
  });
})();
