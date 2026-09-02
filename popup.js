const toggleBtn = document.getElementById("toggleBtn");
const showUrlBox = document.getElementById("showUrl");
const showLauncherBox = document.getElementById("showLauncher");
const barBgColorInput = document.getElementById("barBgColor");
const barBgAlphaInput = document.getElementById("barBgAlpha");
const barBgAlphaVal = document.getElementById("barBgAlphaVal");
const hotkeyInput = document.getElementById("hotkeyInput");
const hotkeyClear = document.getElementById("hotkeyClear");

function refreshState() {
  chrome.storage.local.get(["enabled", "showUrl", "showLauncher", "barBgColor", "barBgAlpha", "hotkey"], (r) => {
    toggleBtn.textContent = r.enabled ? "隐藏多行标签栏" : "显示多行标签栏";
    showUrlBox.checked = !!r.showUrl;
    showLauncherBox.checked = r.showLauncher !== false;
    barBgColorInput.value = r.barBgColor || "#f1f3f4";
    barBgAlphaInput.value = Math.round((r.barBgAlpha === undefined ? 0 : r.barBgAlpha) * 100);
    barBgAlphaVal.textContent = barBgAlphaInput.value + "%";
    // 从未设置时显示默认快捷键 Alt+Z；用户清除后显示为空
    hotkeyInput.value = r.hotkey === undefined ? "Alt+Z" : r.hotkey || "";
  });
}

// 一键切换 / 还原
toggleBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "mrt-toggle" }, () => refreshState());
});

// 显示链接配置
showUrlBox.addEventListener("change", () => {
  chrome.storage.local.set({ showUrl: showUrlBox.checked });
});

// 浮动按钮显示 / 隐藏
showLauncherBox.addEventListener("change", () => {
  chrome.storage.local.set({ showLauncher: showLauncherBox.checked });
});

// 标签栏背景颜色 / 透明度
barBgColorInput.addEventListener("input", () => {
  chrome.storage.local.set({ barBgColor: barBgColorInput.value });
});
barBgAlphaInput.addEventListener("input", () => {
  barBgAlphaVal.textContent = barBgAlphaInput.value + "%";
  chrome.storage.local.set({ barBgAlpha: barBgAlphaInput.value / 100 });
});

// ===== 快捷键录制 =====
function formatHotkey(ev) {
  const parts = [];
  if (ev.ctrlKey) parts.push("Ctrl");
  if (ev.altKey) parts.push("Alt");
  if (ev.shiftKey) parts.push("Shift");
  if (ev.metaKey) parts.push("Meta");
  let key = ev.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null; // 仅修饰键，无效
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

hotkeyInput.addEventListener("focus", () => {
  hotkeyInput.placeholder = "请按下组合键…";
});
hotkeyInput.addEventListener("blur", () => {
  hotkeyInput.placeholder = "点击后按下组合键";
});
hotkeyInput.addEventListener("keydown", (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  const combo = formatHotkey(ev);
  if (!combo) return; // 仅按下修饰键，继续等待
  hotkeyInput.value = combo;
  chrome.storage.local.set({ hotkey: combo });
  hotkeyInput.blur();
});

// 清除快捷键（存空字符串，避免刷新后恢复默认值）
hotkeyClear.addEventListener("click", () => {
  hotkeyInput.value = "";
  chrome.storage.local.set({ hotkey: "" });
});

refreshState();
