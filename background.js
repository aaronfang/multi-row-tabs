const FALLBACK_ICON =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect width='16' height='16' rx='3' fill='%239aa0a6'/></svg>";

// ===== favicon 转换：background 抓取 -> data URL，避免页面 Mixed Content 警告 =====
const favCache = new Map();

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => resolve("");
    fr.readAsDataURL(blob);
  });
}

async function faviconToDataUrl(url) {
  if (!url) return "";
  if (url.startsWith("data:")) return url;
  if (favCache.has(url)) return favCache.get(url);
  let data = "";
  try {
    const resp = await fetch(url, { cache: "force-cache" });
    if (resp.ok) {
      const blob = await resp.blob();
      if (blob.size > 0 && blob.size < 256 * 1024) data = await blobToDataUrl(blob);
    }
  } catch (e) {
    // 抓取失败时使用兜底图标
  }
  if (favCache.size >= 500) favCache.clear();
  favCache.set(url, data);
  return data;
}

// ===== 一键切换 / 还原（并行处理，减少卡顿） =====
async function toggleForWindow(windowId) {
  const r = await chrome.storage.local.get("enabled");
  const next = !r.enabled;
  await chrome.storage.local.set({ enabled: next });

  const tabs = await chrome.tabs.query({ windowId });
  await Promise.allSettled(
    tabs.map(async (t) => {
      // 优先直接通知已注入的 content script
      try {
        await chrome.tabs.sendMessage(t.id, { type: "mrt-set-enabled", enabled: next });
        return;
      } catch (e) {
        // 尚未注入
      }
      if (!next) return;
      try {
        await Promise.all([
          chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content.js"] }),
          chrome.scripting.insertCSS({ target: { tabId: t.id }, files: ["content.css"] }),
        ]);
        await chrome.tabs.sendMessage(t.id, { type: "mrt-set-enabled", enabled: next });
      } catch (e) {
        // chrome:// 等受限页面，忽略
      }
    })
  );
}

// ===== 广播刷新（150ms 防抖，避免高频重绘） =====
const broadcastTimers = new Map();
function broadcast(windowId) {
  clearTimeout(broadcastTimers.get(windowId));
  broadcastTimers.set(
    windowId,
    setTimeout(() => {
      broadcastTimers.delete(windowId);
      chrome.tabs.query({ windowId }, (tabs) => {
        for (const t of tabs) {
          chrome.tabs.sendMessage(t.id, { type: "mrt-refresh" }).catch(() => {});
        }
      });
    }, 150)
  );
}

chrome.tabs.onCreated.addListener((t) => broadcast(t.windowId));
chrome.tabs.onRemoved.addListener((id, info) => broadcast(info.windowId));
chrome.tabs.onActivated.addListener((info) => broadcast(info.windowId));
chrome.tabs.onMoved.addListener((id, info) => broadcast(info.windowId));
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.title || info.favIconUrl || info.url || info.status === "complete") {
    broadcast(tab.windowId);
  }
  // 后台预热 favicon 缓存，渲染时不用现抓
  if (info.favIconUrl) faviconToDataUrl(info.favIconUrl);
});

// ===== 响应 content script 请求 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "mrt-toggle") {
    const windowId = sender.tab ? sender.tab.windowId : undefined;
    chrome.windows.getCurrent((w) => {
      toggleForWindow(windowId || w.id).then(() => sendResponse({ ok: true }));
    });
    return true; // 异步响应
  }

  if (msg.type === "mrt-get-tabs") {
    const windowId = sender.tab ? sender.tab.windowId : undefined;
    chrome.storage.local.get("showUrl", async (cfg) => {
      const tabs = await chrome.tabs.query(windowId ? { windowId } : { currentWindow: true });
      const list = await Promise.all(
        tabs.map(async (t) => ({
          id: t.id,
          title: t.title,
          url: t.url,
          active: t.active,
          fav: (await faviconToDataUrl(t.favIconUrl)) || FALLBACK_ICON,
        }))
      );
      sendResponse({ showUrl: !!cfg.showUrl, tabs: list });
    });
    return true; // 异步响应
  }

  if (msg.type === "mrt-activate") {
    chrome.tabs.update(msg.tabId, { active: true }).catch(() => {});
  }

  if (msg.type === "mrt-close") {
    chrome.tabs.remove(msg.tabId).catch(() => {});
  }
});
