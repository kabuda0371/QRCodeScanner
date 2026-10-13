// 二维码识别助手 - 内容脚本
// 识别流水线：原生 BarcodeDetector → jsQR(原始/Otsu 二值化, 多尺度) → zxing-cpp WASM(最强引擎)
(() => {
  'use strict';
  if (window.__QRSCANNER_LOADED__) return;
  window.__QRSCANNER_LOADED__ = true;

  // 单图识别的最大尺寸上限（超出等比缩小）；整页扫描用更小的上限换取速度
  const MAX_DIMENSION = 2200;
  const PAGE_SCAN_CAP = 1100;

  // 测试页标记（仅供 test/test.html 自动化验证，在普通页面不写任何属性）
  const TEST_PAGE = !!document.querySelector('[data-qrscanner-autoscan]');
  function testMark(k, v) {
    if (!TEST_PAGE) return;
    try { document.body.setAttribute(k, String(v)); } catch (e) { /* 忽略 */ }
  }

  /* ================= 操作令牌（新操作取消旧操作） ================= */

  let currentOp = null;
  function beginOp() {
    if (currentOp) currentOp.cancelled = true;
    currentOp = { cancelled: false };
    return currentOp;
  }

  /* ================= 基础工具 ================= */

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片加载失败'));
      img.src = dataUrl;
    });
  }

  // 等待页面图片加载完成（微信弹窗等动态填充 src 的场景）
  function waitForImage(img, timeoutMs = 4000) {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      img.addEventListener('load', () => finish(true));
      img.addEventListener('error', () => finish(false));
      setTimeout(() => finish(img.complete && img.naturalWidth > 0), timeoutMs);
    });
  }

  function imageToImageData(img, maxDim = MAX_DIMENSION) {
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (!w || !h) return null;
    const cap = (maxDim && maxDim > 0) ? maxDim : MAX_DIMENSION;
    const scale = Math.min(1, cap / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    try {
      ctx.drawImage(img, 0, 0, cw, ch);
      return ctx.getImageData(0, 0, cw, ch);
    } catch (e) {
      return null; // 画布被跨域图片污染，或图片处于损坏/未加载状态
    }
  }

  function downscaleImageData(imageData, factor) {
    if (factor >= 1) return imageData;
    const w = Math.max(1, Math.round(imageData.width * factor));
    const h = Math.max(1, Math.round(imageData.height * factor));
    const src = document.createElement('canvas');
    src.width = imageData.width;
    src.height = imageData.height;
    src.getContext('2d').putImageData(imageData, 0, 0);
    const dst = document.createElement('canvas');
    dst.width = w;
    dst.height = h;
    const ctx = dst.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  // 四周加白色静区（二维码贴边时提高识别率）
  function padImageData(imageData, padPx) {
    if (!padPx || padPx <= 0) return imageData;
    const w = imageData.width + padPx * 2;
    const h = imageData.height + padPx * 2;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.putImageData(imageData, padPx, padPx);
    return ctx.getImageData(0, 0, w, h);
  }

  // Otsu 自适应阈值二值化（提高低对比度/彩色二维码识别率）
  function binarizeOtsu(imageData) {
    const { data } = imageData;
    const n = data.length / 4;
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const lum = (data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000;
      hist[lum | 0]++;
    }
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, maxVar = 0, threshold = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > maxVar) { maxVar = v; threshold = t; }
    }
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const lum = (data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000;
      const v = lum >= threshold ? 255 : 0;
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
    }
    return new ImageData(out, imageData.width, imageData.height);
  }

  /* ================= zxing-cpp WASM 引擎 ================= */

  let zxingModulePromise = null;
  function ensureZxingModule() {
    if (!zxingModulePromise) {
      if (typeof ZXingWASM === 'undefined' || !ZXingWASM.prepareZXingModule) {
        zxingModulePromise = Promise.resolve(null);
      } else {
        zxingModulePromise = ZXingWASM.prepareZXingModule({
          overrides: {
            locateFile: (path) => chrome.runtime.getURL('lib/' + path),
          },
        }).then(() => ZXingWASM).catch((e) => {
          console.warn('[QRScanner] zxing 引擎初始化失败，将使用回退引擎', e);
          return null;
        });
      }
    }
    return zxingModulePromise;
  }

  async function zxingDetect(imageData) {
    const ZXing = await ensureZxingModule();
    if (!ZXing || !ZXing.readBarcodes) return null;
    try {
      const results = await ZXing.readBarcodes(imageData, {
        formats: ['QRCode', 'MicroQRCode'],
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        tryDownscale: true,
        binarizer: 'LocalAverage',
        maxNumberOfSymbols: 1,
      });
      if (results && results.length && results[0].text) return results[0].text;
    } catch (e) { /* 继续 */ }
    return null;
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), ms)),
    ]);
  }

  let nativeDetectorCache = null;
  async function nativeDetect(imageData) {
    if (typeof BarcodeDetector === 'undefined') return null;
    try {
      if (!nativeDetectorCache) {
        nativeDetectorCache = new BarcodeDetector({ formats: ['qr_code'] });
      }
      const results = await withTimeout(nativeDetectorCache.detect(imageData), 4000);
      if (results && results.length > 0 && results[0].rawValue) return results[0].rawValue;
    } catch (e) { /* 继续 */ }
    return null;
  }

  function jsqrDetect(imageData) {
    if (typeof jsQR === 'undefined') return null;
    try {
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'attemptBoth',
      });
      if (code && code.data) return code.data;
    } catch (e) { /* 继续 */ }
    return null;
  }

  /* ================= 统一识别入口 ================= */

  async function decodeImageData(imageData, opts = {}) {
    const isLive = () => !opts.op || !opts.op.cancelled;
    const step = (t) => { if (opts.onStep) opts.onStep(t); };

    step('① 快速引擎识别中…');
    // 1) 原生引擎：1x 与 0.5x
    for (const scale of [1, 0.5]) {
      if (!isLive()) return null;
      const t = await nativeDetect(scale === 1 ? imageData : downscaleImageData(imageData, scale));
      if (t) return t;
    }
    // 2) jsQR：原始 + Otsu 二值化，1x 与 0.5x
    for (const scale of [1, 0.5]) {
      if (!isLive()) return null;
      const id = scale === 1 ? imageData : downscaleImageData(imageData, scale);
      const t = jsqrDetect(id);
      if (t) return t;
      const t2 = jsqrDetect(binarizeOtsu(id));
      if (t2) return t2;
    }
    // 3) zxing-cpp：最强引擎（多区域、多尺度、旋转、反色、局部自适应二值化）
    if (!isLive()) return null;
    step('② 增强引擎深度识别中…');
    const t = await zxingDetect(imageData);
    if (t) return t;
    return null;
  }

  function isLikelyUrl(text) {
    return /^https?:\/\//i.test(text) || /^www\./i.test(text);
  }

  function normalizeUrl(text) {
    return /^www\./i.test(text) ? 'https://' + text : text;
  }

  function typeLabel(text) {
    if (/^https?:\/\//i.test(text) || /^www\./i.test(text)) return '链接';
    if (/^weixin:\/\//i.test(text)) return '微信';
    if (/^WIFI:/i.test(text)) return 'WiFi 配置';
    if (/^tel:/i.test(text)) return '电话';
    if (/^mailto:/i.test(text)) return '邮箱';
    if (/^BEGIN:VCARD/i.test(text)) return '名片';
    return '文本';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) { /* 继续尝试 execCommand */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ================= 界面（Shadow DOM 隔离样式） ================= */

  let host = null;

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.id = '__qrscanner_host';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .container {
        position: fixed; top: 16px; right: 16px; z-index: 2147483647;
        width: 380px; max-width: calc(100vw - 32px);
        font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      }
      .card {
        background: #fff; border-radius: 12px; overflow: hidden;
        box-shadow: 0 12px 32px rgba(0,0,0,.28), 0 2px 8px rgba(0,0,0,.16);
        animation: qrIn .22s ease;
      }
      @keyframes qrIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
      .header {
        display: flex; align-items: center; gap: 8px;
        padding: 10px 14px; color: #fff;
        background: linear-gradient(135deg, #1a73e8, #3b82f6);
      }
      .header .logo { font-size: 16px; }
      .header .title { flex: 1; font-size: 13px; font-weight: 600; }
      .header .close {
        cursor: pointer; border: none; background: rgba(255,255,255,.18);
        color: #fff; width: 22px; height: 22px; border-radius: 50%;
        font-size: 12px; line-height: 22px; text-align: center;
      }
      .header .close:hover { background: rgba(255,255,255,.35); }
      .body { padding: 14px 16px; font-size: 13px; color: #202124; }
      .tag {
        display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px;
        background: #e8f0fe; color: #1a73e8; margin-bottom: 8px;
      }
      .text {
        background: #f8f9fa; border: 1px solid #e8eaed; border-radius: 8px;
        padding: 10px 12px; word-break: break-all; white-space: pre-wrap;
        max-height: 180px; overflow-y: auto; user-select: text;
      }
      .actions { display: flex; gap: 8px; margin-top: 12px; }
      button.btn {
        cursor: pointer; border: none; border-radius: 8px; padding: 8px 14px;
        font-size: 13px; font-weight: 500; font-family: inherit;
      }
      button.primary { background: #1a73e8; color: #fff; }
      button.primary:hover { background: #1557b0; }
      button.ghost { background: #f1f3f4; color: #3c4043; }
      button.ghost:hover { background: #e2e5e8; }
      .result-list { display: flex; flex-direction: column; gap: 10px; max-height: 55vh; overflow-y: auto; }
      .result-item { border: 1px solid #e8eaed; border-radius: 10px; padding: 10px 12px; }
      .result-item .text { max-height: 72px; }
      .result-item .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
      .result-item .idx { color: #5f6368; font-size: 12px; flex: 1; }
      .progress { color: #5f6368; font-size: 13px; padding: 4px 0; }
      .status-body { display: flex; align-items: center; gap: 10px; padding: 12px 16px; font-size: 13px; color: #202124; }
      .spinner {
        width: 14px; height: 14px; flex: none; border-radius: 50%;
        border: 2px solid #c6dafc; border-top-color: #1a73e8;
        animation: qrSpin .8s linear infinite;
      }
      @keyframes qrSpin { to { transform: rotate(360deg); } }
      .hint-line { color: #5f6368; font-size: 12px; margin-top: 8px; line-height: 1.6; }
      .toast-wrap { position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%); z-index: 2147483647; }
      .toast {
        background: rgba(32,33,36,.92); color: #fff; font-size: 13px;
        padding: 10px 18px; border-radius: 20px; box-shadow: 0 4px 16px rgba(0,0,0,.25);
        animation: qrIn .2s ease; max-width: 70vw;
      }
    `;
    shadow.appendChild(style);
    const container = document.createElement('div');
    container.className = 'container';
    shadow.appendChild(container);
    document.documentElement.appendChild(host);
    return host;
  }

  function renderCard(contentHtml) {
    const shadow = ensureHost().shadowRoot;
    const container = shadow.querySelector('.container');
    container.innerHTML = contentHtml;
    return container;
  }

  function closePanel() {
    if (host && host.isConnected) {
      const container = host.shadowRoot.querySelector('.container');
      if (container) container.innerHTML = '';
    }
  }

  /* ---- 单条 toast（不堆积，自动消失） ---- */

  let toastEl = null;
  let toastTimer = null;
  function toast(message, isError = false) {
    const shadow = ensureHost().shadowRoot;
    let wrap = shadow.querySelector('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      shadow.appendChild(wrap);
    }
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      wrap.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.background = isError ? 'rgba(217,48,37,.94)' : 'rgba(32,33,36,.92)';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toastEl) { toastEl.remove(); toastEl = null; }
    }, 2500);
  }

  function clearToasts() {
    clearTimeout(toastTimer);
    if (toastEl) { toastEl.remove(); toastEl = null; }
  }

  /* ---- 步骤状态卡（透明显示识别进度，原地更新不堆积） ---- */

  function showStatusCard(text, onClose) {
    renderCard(`
      <div class="card">
        <div class="header">
          <span class="logo">🔍</span>
          <span class="title">二维码识别助手</span>
          <button class="close" title="取消">✕</button>
        </div>
        <div class="body status-body">
          <span class="spinner"></span>
          <span data-step>${escapeHtml(text)}</span>
        </div>
      </div>
    `);
    const container = ensureHost().shadowRoot.querySelector('.container');
    container.querySelector('.close').addEventListener('click', () => {
      if (onClose) onClose();
      closePanel();
    });
  }

  function updateStatusCard(text) {
    if (!host || !host.isConnected) return false;
    const el = host.shadowRoot.querySelector('[data-step]');
    if (el) { el.textContent = text; return true; }
    return false;
  }

  // 状态卡：已存在则更新文字，否则新建
  function status(text, onClose) {
    if (!updateStatusCard(text)) showStatusCard(text, onClose);
  }

  /* ---- 结果卡 ---- */

  function showResult(text) {
    const isUrl = isLikelyUrl(text);
    renderCard(`
      <div class="card">
        <div class="header">
          <span class="logo">✅</span>
          <span class="title">二维码识别成功</span>
          <button class="close" title="关闭">✕</button>
        </div>
        <div class="body">
          <span class="tag">${typeLabel(text)}</span>
          <div class="text">${escapeHtml(text)}</div>
          <div class="actions">
            <button class="btn primary" data-act="copy">复制内容</button>
            ${isUrl ? '<button class="btn primary" data-act="open">打开链接</button>' : ''}
          </div>
        </div>
      </div>
    `);
    const container = ensureHost().shadowRoot.querySelector('.container');
    container.querySelector('.close').addEventListener('click', () => {
      clearToasts();
      closePanel();
    });
    container.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      const ok = await copyText(text);
      closePanel(); // 复制后清空消息
      clearToasts();
      toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择复制', !ok);
    });
    const openBtn = container.querySelector('[data-act="open"]');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        closePanel(); // 跳转后清空消息
        clearToasts();
        window.open(normalizeUrl(text), '_blank', 'noopener');
      });
    }
  }

  function showMultiResult(results) {
    const items = results.map((r, idx) => {
      const isUrl = isLikelyUrl(r.text);
      return `
        <div class="result-item">
          <span class="tag">${typeLabel(r.text)}</span>
          <div class="text">${escapeHtml(r.text)}</div>
          <div class="row">
            <span class="idx">第 ${idx + 1} 个二维码</span>
            <button class="btn primary" data-act="copy" data-i="${idx}">复制</button>
            ${isUrl ? `<button class="btn ghost" data-act="open" data-i="${idx}">打开链接</button>` : ''}
          </div>
        </div>`;
    }).join('');
    renderCard(`
      <div class="card">
        <div class="header">
          <span class="logo">✅</span>
          <span class="title">识别到 ${results.length} 个二维码</span>
          <button class="close" title="关闭">✕</button>
        </div>
        <div class="body"><div class="result-list">${items}</div></div>
      </div>
    `);
    const container = ensureHost().shadowRoot.querySelector('.container');
    container.querySelector('.close').addEventListener('click', () => {
      clearToasts();
      closePanel();
    });
    container.querySelectorAll('[data-act="copy"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const text = results[Number(btn.dataset.i)].text;
        const ok = await copyText(text);
        closePanel();
        clearToasts();
        toast(ok ? '已复制到剪贴板' : '复制失败', !ok);
      });
    });
    container.querySelectorAll('[data-act="open"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        closePanel();
        clearToasts();
        window.open(normalizeUrl(results[Number(btn.dataset.i)].text), '_blank', 'noopener');
      });
    });
  }

  /* ---- 失败卡（说明已尝试的步骤） ---- */

  function showFailure(title, detail) {
    renderCard(`
      <div class="card">
        <div class="header">
          <span class="logo">⚠️</span>
          <span class="title">${escapeHtml(title)}</span>
          <button class="close" title="关闭">✕</button>
        </div>
        <div class="body">
          <div style="line-height:1.7;">${escapeHtml(detail)}</div>
          <div class="hint-line">💡 提示：右键 →「✂️ 框选区域识别二维码」手动框选二维码区域</div>
        </div>
      </div>
    `);
    const container = ensureHost().shadowRoot.querySelector('.container');
    container.querySelector('.close').addEventListener('click', () => {
      clearToasts();
      closePanel();
    });
  }

  // 点击面板以外区域自动关闭
  document.addEventListener('pointerdown', (e) => {
    if (host && host.isConnected && !host.contains(e.target)) closePanel();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  }, true);

  /* ================= 识别逻辑 ================= */

  // 本 frame 在顶层视口中的偏移（iframe 场景）
  function frameViewportOffset() {
    try {
      if (window.frameElement) {
        const r = window.frameElement.getBoundingClientRect();
        return { x: r.left, y: r.top };
      }
    } catch (e) { /* 跨域 frame 无法获取，按 0 处理 */ }
    return { x: 0, y: 0 };
  }

  function findImageBySrc(srcUrl) {
    if (!srcUrl) return null;
    let target;
    try { target = new URL(srcUrl, location.href).href; } catch (e) { target = srcUrl; }
    const targetNoQuery = target.split('?')[0];
    const targetBase = targetNoQuery.split('/').pop();
    const scoreSrc = (raw) => {
      if (!raw) return 0;
      let s;
      try { s = new URL(raw, location.href).href; }
      catch (e) { s = raw; }
      if (s === target) return 3;
      const sNoQuery = s.split('?')[0];
      if (sNoQuery === targetNoQuery) return 2;
      if (targetBase && sNoQuery.split('/').pop() === targetBase) return 1;
      return 0;
    };
    const scoreOf = (img) => Math.max(
      scoreSrc(img.currentSrc),
      scoreSrc(img.src),
      scoreSrc(img.getAttribute('data-src')),
      scoreSrc(img.getAttribute('data-original'))
    );
    let best = null, bestScore = 0, bestArea = 0;
    for (const img of document.querySelectorAll('img')) {
      const sc = scoreOf(img);
      if (sc <= 0) continue;
      const r = img.getBoundingClientRect();
      const area = r.width * r.height;
      if (sc > bestScore || (sc === bestScore && area > bestArea)) {
        best = img; bestScore = sc; bestArea = area;
      }
    }
    return best;
  }

  async function decodeImageElement(img, opts = {}) {
    const isLive = () => !opts.op || !opts.op.cancelled;
    const step = (t) => { if (opts.onStep) opts.onStep(t); };
    const cap = opts.cap || MAX_DIMENSION;
    const waitForLoad = opts.waitForLoad !== false;

    // 0) 等待图片加载完成（微信跳转弹窗等动态填充 src 的场景）
    // 仅对「已有 src 但尚未加载完」的图片等待；无 src 的懒加载图直接跳过（走后续抓取方案）
    if (waitForLoad && !(img.complete && img.naturalWidth > 0) && (img.currentSrc || img.src)) {
      step('⏳ 等待图片加载完成…');
      await waitForImage(img, 4000);
      if (!isLive()) return null;
    }

    // 方案 1：直接绘制（同源图片最快）
    step('① 正在读取图片…');
    let imageData = imageToImageData(img, cap);
    if (imageData) {
      const r = await decodeImageData(imageData, opts);
      if (r) return r;
    }
    if (!isLive()) return null;

    // 方案 2：后台抓取原图（解决跨域图片导致画布被污染的问题）
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original');
    if (src && /^(https?:|data:)/i.test(src)) {
      step('② 图片跨域，正在后台抓取原图…');
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'fetch-image',
          url: src,
          referrer: location.href,
        });
        if (resp && resp.ok && resp.dataUrl) {
          const img2 = await loadImage(resp.dataUrl);
          imageData = imageToImageData(img2, cap);
          if (imageData) {
            const r = await decodeImageData(imageData, opts);
            if (r) return r;
          }
        }
      } catch (e) { /* 继续 */ }
    }
    if (!isLive()) return null;

    // 方案 3：截取屏幕可见区域兜底（含 iframe 偏移修正）
    const rect = img.getBoundingClientRect();
    if (rect.width > 20 && rect.height > 20) {
      step('③ 正在截取屏幕区域识别…');
      try {
        const off = frameViewportOffset();
        const resp = await chrome.runtime.sendMessage({
          type: 'capture-region',
          rect: {
            x: rect.left + off.x,
            y: rect.top + off.y,
            width: rect.width,
            height: rect.height,
          },
          dpr: window.devicePixelRatio || 1,
        });
        if (resp && resp.ok && resp.dataUrl) {
          const img3 = await loadImage(resp.dataUrl);
          imageData = imageToImageData(img3, cap);
          if (imageData) {
            const r = await decodeImageData(padImageData(imageData, 24), opts);
            if (r) return r;
          }
        }
      } catch (e) { /* 忽略 */ }
    }
    return null;
  }

  async function decodeBackgroundElement(el, opts = {}) {
    const cap = opts.cap || MAX_DIMENSION;
    const bg = getComputedStyle(el).backgroundImage || '';
    const m = bg.match(/url\(["']?(.*?)["']?\)/);
    const src = m && m[1];
    if (!src) return null;
    if (src.startsWith('data:')) {
      try {
        const img = await loadImage(src);
        const imageData = imageToImageData(img, cap);
        if (imageData) return await decodeImageData(imageData, opts);
      } catch (e) { return null; }
    }
    if (/^https?:/i.test(src)) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'fetch-image',
          url: src,
          referrer: location.href,
        });
        if (resp && resp.ok && resp.dataUrl) {
          const img = await loadImage(resp.dataUrl);
          const imageData = imageToImageData(img, cap);
          if (imageData) return await decodeImageData(imageData, opts);
        }
      } catch (e) { /* 忽略 */ }
    }
    return null;
  }

  /* ================= 框选区域识别 ================= */

  function cropImageData(imageData, sx, sy, sw, sh) {
    const out = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) {
      const row = (sy + y) * imageData.width * 4 + sx * 4;
      out.set(imageData.data.subarray(row, row + sw * 4), y * sw * 4);
    }
    return new ImageData(out, sw, sh);
  }

  // 从选区覆盖的 <img> 元素裁剪解码（快、不依赖截图 API）
  async function decodeRegionFromImage(rect, opts) {
    // 遍历页面图片，找覆盖选区 80% 以上的元素（不依赖 elementsFromPoint，视口外元素也有效）
    let img = null;
    let bestCover = 0;
    for (const el of document.querySelectorAll('img')) {
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) continue;
      const cw = Math.min(r.right, rect.x + rect.width) - Math.max(r.left, rect.x);
      const ch = Math.min(r.bottom, rect.y + rect.height) - Math.max(r.top, rect.y);
      if (cw > 0 && ch > 0) {
        const cover = cw * ch;
        if (cover > rect.width * rect.height * 0.8 && cover > bestCover) {
          bestCover = cover;
          img = el;
        }
      }
    }
    if (!img) return null;

    const r = img.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return null;
    const cap = opts.cap || MAX_DIMENSION;

    // 按显示比例把选区映射到图片像素坐标并裁剪解码
    const decodeCrop = async (sourceImg) => {
      const id = imageToImageData(sourceImg, cap);
      if (!id) return null;
      const scaleX = id.width / r.width;
      const scaleY = id.height / r.height;
      const sx = Math.max(0, Math.round((rect.x - r.left) * scaleX));
      const sy = Math.max(0, Math.round((rect.y - r.top) * scaleY));
      const sw = Math.min(id.width - sx, Math.round(rect.width * scaleX));
      const sh = Math.min(id.height - sy, Math.round(rect.height * scaleY));
      if (sw < 20 || sh < 20) return null;
      const crop = cropImageData(id, sx, sy, sw, sh);
      return decodeImageData(padImageData(crop, 24), opts);
    };

    // A) 直接裁剪（同源/内嵌图片）
    const t1 = await decodeCrop(img);
    if (t1) return t1;

    // B) 跨域图片：后台抓取原图后按比例裁剪
    const src = img.currentSrc || img.src ||
      img.getAttribute('data-src') || img.getAttribute('data-original');
    if (src && /^https?:/i.test(src)) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'fetch-image',
          url: src,
          referrer: location.href,
        });
        if (resp && resp.ok && resp.dataUrl) {
          const img2 = await loadImage(resp.dataUrl);
          const t2 = await decodeCrop(img2);
          if (t2) return t2;
        }
      } catch (e) { /* 忽略 */ }
    }
    return null;
  }

  // 屏幕截图兜底（带重试），失败抛出具体原因
  async function captureRegionWithRetry(rect) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const off = frameViewportOffset();
        const resp = await chrome.runtime.sendMessage({
          type: 'capture-region',
          rect: {
            x: rect.x + off.x,
            y: rect.y + off.y,
            width: rect.width,
            height: rect.height,
          },
          dpr: window.devicePixelRatio || 1,
        });
        if (resp && resp.ok && resp.dataUrl) return resp.dataUrl;
        lastErr = (resp && resp.error) || '截图失败';
      } catch (e) {
        lastErr = (e && e.message) || String(e);
      }
    }
    throw new Error(lastErr || '屏幕截图失败');
  }

  // 框选区域识别的完整流水线（供 onUp 与自动化自测共用）
  async function decodeRegion(rect, op, step) {
    step('正在从页面图片裁剪选区…');
    const t1 = await decodeRegionFromImage(rect, { op, onStep: step });
    if (t1 || op.cancelled) return t1;

    step('正在截取屏幕区域…');
    const dataUrl = await captureRegionWithRetry(rect);
    if (op.cancelled) return null;

    step('正在识别选区…');
    const img = await loadImage(dataUrl);
    const imageData = imageToImageData(img, 1600);
    if (!imageData) return null;
    return decodeImageData(padImageData(imageData, 32), { op, onStep: step });
  }

  let regionSelecting = false;

  function startRegionSelect() {
    if (regionSelecting) return;
    regionSelecting = true;
    const op = beginOp();
    const ov = document.createElement('div');
    ov.id = '__qrscanner_overlay';
    ov.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;cursor:crosshair;user-select:none;-webkit-user-select:none;touch-action:none;';
    const sh = ov.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        .hint {
          position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
          background: rgba(26,115,232,.95); color: #fff;
          font: 13px/1.5 system-ui, "Microsoft YaHei", sans-serif;
          padding: 8px 16px; border-radius: 8px; z-index: 1; pointer-events: none;
          box-shadow: 0 4px 12px rgba(0,0,0,.25); white-space: nowrap;
        }
        .sel {
          position: fixed; display: none; pointer-events: none;
          border: 2px dashed #fff;
          box-shadow: 0 0 0 9999px rgba(0,0,0,.35), inset 0 0 0 1px rgba(26,115,232,.7);
        }
      </style>
      <div class="hint">✂️ 拖拽框选二维码区域（稍留白边）· Esc 取消</div>
      <div class="sel"></div>
    `;
    document.documentElement.appendChild(ov);

    let startX = 0, startY = 0, dragging = false;
    const sel = sh.querySelector('.sel');

    const cleanup = () => {
      regionSelecting = false;
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('keydown', onKey, true);
      ov.remove();
    };

    const onDown = (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      sel.style.display = 'block';
      updateSel(e);
      try { ov.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      e.preventDefault();
    };

    const updateSel = (e) => {
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      sel.style.left = x + 'px';
      sel.style.top = y + 'px';
      sel.style.width = Math.abs(e.clientX - startX) + 'px';
      sel.style.height = Math.abs(e.clientY - startY) + 'px';
    };

    const onMove = (e) => {
      if (!dragging) return;
      updateSel(e);
      e.preventDefault();
    };

    const onUp = async (e) => {
      if (!dragging) return;
      dragging = false;
      const rect = {
        x: Math.min(startX, e.clientX),
        y: Math.min(startY, e.clientY),
        width: Math.abs(e.clientX - startX),
        height: Math.abs(e.clientY - startY),
      };
      cleanup();
      if (rect.width < 30 || rect.height < 30) {
        toast('选区太小，请重新框选', true);
        return;
      }
      // 等遮罩移除后的画面提交到合成器，避免截图里包含遮罩
      await new Promise((r) => setTimeout(r, 150));
      if (op.cancelled) return;
      status('① 正在截取选区…', () => { op.cancelled = true; });
      try {
        const text = await decodeRegion(rect, op, (t) => { if (!op.cancelled) status(t); });
        if (op.cancelled) return;
        if (text) {
          closePanel();
          showResult(text);
        } else {
          showFailure('未能识别出二维码',
            '已尝试：页面图片裁剪 → 屏幕截图识别。\n请框选稍大一些（含完整二维码与白边）后重试。');
        }
      } catch (err) {
        if (!op.cancelled) {
          showFailure('截图失败', String((err && err.message) || err));
        }
      }
    };

    const onKey = (e) => {
      if (e.key === 'Escape') cleanup();
    };

    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('keydown', onKey, true);
  }

  /* ================= 整页扫描 ================= */

  function showScanning(total, onCancel) {
    renderCard(`
      <div class="card">
        <div class="header">
          <span class="logo">🔍</span>
          <span class="title">正在扫描本页二维码…</span>
          <button class="close" title="取消">✕</button>
        </div>
        <div class="body">
          <div class="status-body" style="padding:0 0 8px;">
            <span class="spinner"></span>
            <span data-progress>已检查 0 / ${total} 张图片</span>
          </div>
        </div>
      </div>
    `);
    const container = ensureHost().shadowRoot.querySelector('.container');
    container.querySelector('.close').addEventListener('click', () => {
      if (onCancel) onCancel();
      closePanel();
    });
  }

  function updateProgress(done, total) {
    if (!host || !host.isConnected) return;
    const el = host.shadowRoot.querySelector('[data-progress]');
    if (el) el.textContent = `已检查 ${done} / ${total} 张图片`;
  }

  async function scanPage() {
    testMark('data-qrscanner-scan-start', '1');
    const op = beginOp();
    const candidates = [];
    const seen = new Set();
    const push = (src, el) => {
      if (!src || !/^(https?:|data:)/i.test(src) || seen.has(src)) return;
      seen.add(src);
      let area = 0;
      try {
        const r = el.getBoundingClientRect();
        area = r.width * r.height;
      } catch (e) { /* 忽略 */ }
      candidates.push({ src, el, area });
    };

    document.querySelectorAll('img').forEach((img) => {
      push(
        img.currentSrc || img.src ||
        img.getAttribute('data-src') || img.getAttribute('data-original') || '',
        img
      );
    });
    document.querySelectorAll('div,section,article,aside,span,a,p,li,figure,header,footer').forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage || '';
      const m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m) push(m[1], el);
    });

    // 优先识别页面中较大的图片
    candidates.sort((a, b) => b.area - a.area);
    const limited = candidates.slice(0, 40);
    if (!limited.length) {
      toast('本页未找到可识别的图片', true);
      return 0;
    }

    showScanning(limited.length, () => { op.cancelled = true; });
    const results = [];
    let done = 0;
    const worker = async (c) => {
      if (op.cancelled) { done += 1; updateProgress(done, limited.length); return; }
      try {
        let text = null;
        if (c.el && c.el.tagName === 'IMG') {
          text = await decodeImageElement(c.el, { cap: PAGE_SCAN_CAP, waitForLoad: true, op });
        } else if (c.el && c.el.tagName !== 'IMG') {
          text = await decodeBackgroundElement(c.el, { cap: PAGE_SCAN_CAP, op });
        }
        if (!text && !op.cancelled) {
          const resp = await chrome.runtime.sendMessage({
            type: 'fetch-image',
            url: c.src,
            referrer: location.href,
          });
          if (resp && resp.ok && resp.dataUrl) {
            const img = await loadImage(resp.dataUrl);
            const imageData = imageToImageData(img, PAGE_SCAN_CAP);
            if (imageData) text = await decodeImageData(imageData, { op });
          }
        }
        if (text && !op.cancelled) results.push({ src: c.src, text });
      } catch (e) { /* 跳过该图片 */ }
      done += 1;
      testMark('data-qrscanner-scan-progress', done + '/' + limited.length);
      updateProgress(done, limited.length);
    };

    const CONCURRENCY = 4;
    let i = 0;
    const runners = [];
    for (let k = 0; k < CONCURRENCY; k++) {
      runners.push((async () => {
        while (i < limited.length && !op.cancelled) await worker(limited[i++]);
      })());
    }
    await Promise.all(runners);
    testMark('data-qrscanner-scan-end', '1');

    if (op.cancelled) return 0;
    if (results.length) {
      showMultiResult(results);
    } else {
      closePanel();
      toast('未在本页识别到二维码', true);
    }
    return results.length;
  }

  /* ================= 消息入口 ================= */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return undefined;

    if (msg.type === 'scan-image') {
      (async () => {
        const op = beginOp();
        status('正在定位图片…', () => { op.cancelled = true; });
        const img = findImageBySrc(msg.srcUrl);
        if (!img) {
          if (!op.cancelled) {
            showFailure('未找到目标图片', '请直接在二维码图片上右键，选择「识别此图片中的二维码」。');
          }
          sendResponse({ ok: false });
          return;
        }
        if (op.cancelled) { sendResponse({ ok: false }); return; }
        const text = await decodeImageElement(img, { op, onStep: (t) => { if (!op.cancelled) status(t); } });
        if (op.cancelled) { sendResponse({ ok: false }); return; }
        if (text) {
          showResult(text);
          sendResponse({ ok: true });
        } else {
          showFailure('未能识别出二维码',
            '已尝试：直接解码 → 后台抓取原图 → 屏幕截图识别。\n请试试下方提示的手动框选，或放大页面后重试。');
          sendResponse({ ok: false });
        }
      })();
      return true;
    }

    if (msg.type === 'scan-region') {
      startRegionSelect();
      sendResponse({ ok: true });
      return undefined;
    }

    if (msg.type === 'scan-page') {
      scanPage()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    return undefined;
  });

  /* ================= 自测钩子（仅供 test/test.html 使用） ================= */

  function pgmToImageData(base64) {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    let i = 0;
    const readToken = () => {
      for (;;) {
        if (i >= bytes.length) return '';
        const c = bytes[i];
        if (c === 0x23) { // 注释行
          while (i < bytes.length && bytes[i] !== 0x0a) i++;
          continue;
        }
        if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) { i++; continue; }
        break;
      }
      const start = i;
      while (i < bytes.length && ![0x20, 0x0a, 0x0d, 0x09, 0x23].includes(bytes[i])) i++;
      return new TextDecoder().decode(bytes.subarray(start, i));
    };
    if (readToken() !== 'P5') return null;
    const w = parseInt(readToken(), 10);
    const h = parseInt(readToken(), 10);
    parseInt(readToken(), 10); // maxval
    i++; // 头部与数据之间的单个空白字符
    if (!(w > 0 && h > 0) || i + w * h > bytes.length) return null;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const v = bytes[i + p];
      const o = p * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
    return { data, width: w, height: h };
  }

  function runSelfTest() {
    const targets = document.querySelectorAll('[data-selftest]');
    if (!targets.length) return;
    for (const el of targets) {
      const expect = (el.getAttribute('data-selftest') || '').trim();
      const pgm = el.getAttribute('data-selftest-pgm');
      const mark = (statusText) => el.setAttribute('data-selftest-result', statusText);
      if (pgm) {
        // 同步路径：嵌入的 PGM 像素 → jsQR，保证自测结果确定性
        try {
          const id = pgmToImageData(pgm);
          if (!id) { mark('ERROR:pgm'); continue; }
          const code = jsQR(id.data, id.width, id.height, { inversionAttempts: 'attemptBoth' });
          if (code && code.data && code.data.trim() === expect) mark('PASS');
          else mark('MISMATCH:' + (code ? code.data : 'null'));
        } catch (e) {
          mark('ERROR:' + e);
        }
      } else {
        // 异步路径：完整走 decodeImageElement（含 zxing 引擎、跨域抓取）
        (async () => {
          try {
            const text = await decodeImageElement(el, { op: { cancelled: false } });
            if (text && text.trim() === expect) mark('PASS');
            else mark('MISMATCH:' + (text || 'null'));
          } catch (e) {
            mark('ERROR:' + e);
          }
        })();
      }
    }
    // CSS 背景图二维码自测（异步）
    document.querySelectorAll('[data-selftest-bg]').forEach((el) => {
      const expect = (el.getAttribute('data-selftest-bg') || '').trim();
      (async () => {
        try {
          const text = await decodeBackgroundElement(el);
          el.setAttribute('data-selftest-result',
            text && text.trim() === expect ? 'PASS' : 'MISMATCH:' + (text || 'null'));
        } catch (e) {
          el.setAttribute('data-selftest-result', 'ERROR:' + e);
        }
      })();
    });
  }
  runSelfTest();

  // 自测钩子：页面带 data-qrscanner-autoscan 标记时，自动执行一次整页扫描，
  // 并把结果数写入 data-qrscanner-scan-done（仅供 test/test.html 自动化验证）
  if (document.querySelector('[data-qrscanner-autoscan]')) {
    testMark('data-qrscanner-hook', '1');
    setTimeout(async () => {
      try {
        const n = await scanPage();
        document.body.setAttribute('data-qrscanner-scan-done', String(n));
        // 框选流水线自测：串行在整页扫描之后执行（避免并发干扰），
        // 对同源图 qr2 与跨域图 qr5 的元素区域执行完整框选流程
        if (location.search.indexOf('e2e') >= 0) {
          try {
            let ok = 0;
            const cases = [
              ['[data-id="qr2"] img', '恭喜！网申二维码识别测试通过'],
              ['#qr5', 'https://www.example.com/network-test'],
            ];
            testMark('data-qrscanner-region-test', 'start');
            for (const [sel, expect] of cases) {
              const el = document.querySelector(sel);
              if (!el) continue;
              const r = el.getBoundingClientRect();
              const text = await decodeRegion(
                { x: r.left, y: r.top, width: r.width, height: r.height },
                { cancelled: false },
                (t) => testMark('data-qrscanner-region-phase', t)
              );
              testMark('data-qrscanner-region-step', sel + ':' + (text || 'null'));
              if (text && text.trim() === expect.trim()) ok += 1;
            }
            document.body.setAttribute('data-qrscanner-region-test', ok + '/' + cases.length);
          } catch (e2) {
            document.body.setAttribute('data-qrscanner-region-test', 'error:' + e2);
          }
        }
      } catch (e) {
        document.body.setAttribute('data-qrscanner-scan-done', 'error:' + e);
      }
    }, 0);
  }
})();
