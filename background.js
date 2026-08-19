const FALLBACK_ICON =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect width='16' height='16' rx='3' fill='%239aa0a6'/></svg>";

// ===== favicon 转换：background 抓取 -> data URL，避免页面 Mixed Content 警告 =====
// 缓存结构：url -> { data, ts }；失败结果只短暂缓存，到期后允许重试，避免一次偶发失败导致图标永久变兜底
const favCache = new Map();
const FAIL_TTL = 4000; // 失败冷却时长（ms）

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => resolve("");
    fr.readAsDataURL(blob);
  });
}

// chrome://、about: 等内部协议图标无法在扩展环境抓取，直接使用兜底图标，不进入抓取/重试流程
function isFetchableFavUrl(url) {
  return /^https?:/i.test(url);
}

async function faviconToDataUrl(url, force = false) {
  if (!url) return "";
  if (url.startsWith("data:")) return url;
  if (!isFetchableFavUrl(url)) return "";
  const hit = favCache.get(url);
  if (hit) {
    if (hit.data) return hit.data; // 成功结果永久缓存
    if (!force && Date.now() - hit.ts < FAIL_TTL) return ""; // 失败冷却中，稍后重试
    favCache.delete(url);
  }
  let data = "";
  try {
    const resp = await fetch(url, { cache: "force-cache" });
    if (resp.ok) {
      const blob = await resp.blob();
      // 过滤 200 但返回 HTML 错误页的情况；部分服务器 blob.type 为空，放行
      const okType = !blob.type || blob.type.startsWith("image/");
      if (okType && blob.size > 0 && blob.size < 256 * 1024) data = await blobToDataUrl(blob);
    }
  } catch (e) {
    // 抓取失败时使用兜底图标
  }
  if (favCache.size >= 500) favCache.clear();
  favCache.set(url, { data, ts: Date.now() });
  return data;
}

// ===== favicon 失败自愈：有图标抓取失败时延迟重试，成功后广播刷新 =====
const favRetryTimers = new Map();
function scheduleFavRetry(windowId) {
  if (!windowId || favRetryTimers.has(windowId)) return;
  favRetryTimers.set(
    windowId,
    setTimeout(async () => {
      favRetryTimers.delete(windowId);
      try {
        const tabs = await chrome.tabs.query({ windowId });
        let fixed = false;
        await Promise.all(
          tabs.map(async (t) => {
            if (!isFetchableFavUrl(t.favIconUrl)) return; // data: / chrome:// 等无需重试
            const hit = favCache.get(t.favIconUrl);
            if (hit && hit.data) return; // 已有成功结果
            const data = await faviconToDataUrl(t.favIconUrl, true); // 强制绕过失败冷却
            if (data) fixed = true;
          })
        );
        if (fixed) broadcast(windowId);
      } catch (e) {
        // 窗口可能已关闭
      }
    }, FAIL_TTL + 1000)
  );
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
      let failed = false;
      const list = await Promise.all(
        tabs.map(async (t) => {
          const fav = (await faviconToDataUrl(t.favIconUrl)) || FALLBACK_ICON;
          // 仅 http(s) 图标抓取失败才需要重试；chrome:// 等内部页面无图标可抓
          if (fav === FALLBACK_ICON && isFetchableFavUrl(t.favIconUrl)) failed = true;
          return { id: t.id, title: t.title, url: t.url, active: t.active, fav };
        })
      );
      if (failed) scheduleFavRetry(windowId); // 有图标抓取失败，稍后重试并自动刷新
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
