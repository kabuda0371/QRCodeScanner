// 二维码识别助手 - 后台 Service Worker
'use strict';

const MENU_SCAN_IMAGE = 'scan-image';
const MENU_SCAN_PAGE = 'scan-page';
const MENU_SCAN_REGION = 'scan-region';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_SCAN_IMAGE,
    title: '🔍 识别此图片中的二维码',
    contexts: ['image'],
  });
  chrome.contextMenus.create({
    id: MENU_SCAN_REGION,
    title: '✂️ 框选区域识别二维码',
    contexts: ['page', 'image'],
  });
  chrome.contextMenus.create({
    id: MENU_SCAN_PAGE,
    title: '🔍 扫描本页所有二维码',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === MENU_SCAN_IMAGE) {
    sendToFrame(tab.id, info.frameId ?? 0, { type: 'scan-image', srcUrl: info.srcUrl || '' });
  } else if (info.menuItemId === MENU_SCAN_REGION) {
    sendToFrame(tab.id, info.frameId ?? 0, { type: 'scan-region' });
  } else if (info.menuItemId === MENU_SCAN_PAGE) {
    sendToFrame(tab.id, info.frameId ?? 0, { type: 'scan-page' });
  }
});

// 点击工具栏图标 → 扫描本页所有二维码
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (tab && tab.id != null) {
      sendToFrame(tab.id, 0, { type: 'scan-page' });
    }
  });
}

async function sendToFrame(tabId, frameId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg, { frameId });
  } catch (e) {
    // 页面在扩展安装前已打开，内容脚本尚未注入 → 注入后重试一次
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ['lib/jsQR.js', 'lib/zxing.js', 'content.js'],
      });
      await chrome.tabs.sendMessage(tabId, msg, { frameId });
    } catch (e2) {
      // 浏览器内置页面（chrome:// 等）无法注入，静默失败
      console.warn('[QRScanner] 无法在该页面运行:', e2 && e2.message);
    }
  }
}

/* ---------------- 内容脚本请求处理 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return undefined;

  if (msg.type === 'fetch-image') {
    // 后台抓取图片（拥有 host_permissions，可绕过页面跨域限制）
    fetchImage(msg.url, msg.referrer)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
    return true; // 异步响应
  }

  if (msg.type === 'capture-region') {
    // 截取当前标签页可见区域中指定矩形（兜底方案）
    // 注意：captureVisibleTab 的第一个参数是「窗口 ID」而不是标签页 ID
    captureRegion(sender.tab && sender.tab.windowId, msg.rect, msg.dpr)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }));
    return true;
  }

  return undefined;
});

async function fetchImage(url, referrer) {
  if (!/^https?:/i.test(url)) throw new Error('仅支持 http(s) 图片地址');
  // 部分图床（如微信 mmbiz）校验 Referer：先带来源页重试，失败再裸请求
  const attempts = [];
  if (referrer) attempts.push({ referrer });
  attempts.push({});
  let lastErr = null;
  for (const opts of attempts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000); // 8 秒超时，防止挂起
    try {
      const res = await fetch(url, { credentials: 'include', signal: ctrl.signal, ...opts });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      return blobToDataUrl(blob);
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('抓取失败');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error((label || '操作') + '超时')), ms)),
  ]);
}

async function captureRegion(windowId, rect, dpr) {
  if (windowId == null) throw new Error('缺少窗口 ID');
  const dataUrl = await withTimeout(
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
    5000,
    '屏幕截图'
  );
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = dpr || 1;
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.min(Math.round(rect.width * scale), bitmap.width - sx);
  const sh = Math.min(Math.round(rect.height * scale), bitmap.height - sy);
  if (sw <= 0 || sh <= 0) throw new Error('区域超出屏幕范围');
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(outBlob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('读取图片数据失败'));
    fr.readAsDataURL(blob);
  });
}
