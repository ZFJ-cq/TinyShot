'use strict';

/* ============================================================
 * TinyShot — 纯前端本地图片压缩
 * 所有处理均在浏览器内完成，不发起任何网络请求。
 * ============================================================ */

(function () {
  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  const grid = $('#grid');
  const empty = $('#empty');
  const summary = $('#summary');
  const quality = $('#quality');
  const qualityValue = $('#qualityValue');
  const qualityNote = $('#qualityNote');
  const formatSel = $('#format');
  const formatNote = $('#formatNote');
  const segBtns = document.querySelectorAll('.seg-btn');
  const modePercent = $('#modePercent');
  const modeMax = $('#modeMax');
  const percentInput = $('#percent');
  const maxWInput = $('#maxW');
  const maxHInput = $('#maxH');
  const toastWrap = $('#toastWrap');

  // summary nodes
  const sumOriginal = $('#sumOriginal');
  const sumCompressed = $('#sumCompressed');
  const sumSaved = $('#sumSaved');
  const sumSavedLabel = $('#sumSavedLabel');

  // lightbox
  const lightbox = $('#lightbox');
  const lbTitle = $('#lbTitle');
  const lbOrig = $('#lbOrig');
  const lbComp = $('#lbComp');
  const lbCompFig = $('#lbCompFig');
  const lbOrigCap = $('#lbOrigCap');
  const lbCompCap = $('#lbCompCap');

  // ---------- State ----------
  let items = [];        // { id, file, name, originalSize, width, height, source, isBitmap, status, compressedBlob, compressedSize, warnings, error, els }
  let idSeq = 0;
  let recompressTimer = null;

  const EXT = {
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/png': 'png',
  };

  // 友好提示阈值
  const WARN_DIM = 8000;          // 单边超过此像素
  const WARN_PIXELS = 80_000_000; // 总像素超过 8000 万（约 80MP）
  const WARN_FILE = 25 * 1024 * 1024; // 单文件 > 25MB

  // ---------- Utils ----------
  function formatBytes(bytes, { sign = false } = {}) {
    if (bytes == null) return '—';
    if (bytes === 0) return '0 B';
    const neg = bytes < 0;
    const abs = Math.abs(bytes);
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(abs) / Math.log(1024)));
    const n = abs / Math.pow(1024, i);
    const val = (i === 0 ? n : n.toFixed(n < 10 ? 2 : 1));
    return (sign && !neg ? '+' : '') + (neg ? '-' : '') + val + ' ' + u[i];
  }

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function isHeic(file) {
    const t = (file.type || '').toLowerCase();
    if (t === 'image/heic' || t === 'image/heif') return true;
    const e = extOf(file.name);
    return e === 'heic' || e === 'heif';
  }

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    toastWrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 320);
    }, 2600);
  }

  function getParams() {
    const mode = document.querySelector('.seg-btn.active').dataset.mode;
    return {
      quality: parseFloat(quality.value),
      format: formatSel.value,
      mode,
      percent: Math.max(1, Math.min(100, parseInt(percentInput.value || '100', 10) || 100)),
      maxW: parseInt(maxWInput.value || '0', 10) || 0,
      maxH: parseInt(maxHInput.value || '0', 10) || 0,
    };
  }

  // ---------- Decode ----------
  async function decodeFile(file) {
    // 优先 createImageBitmap，可尊重 EXIF 方向，且支持更多格式
    if (window.createImageBitmap) {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        return { source: bmp, isBitmap: true, width: bmp.width, height: bmp.height };
      } catch (_) { /* 落到 Image 兜底 */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('decode-failed'));
        im.src = url;
      });
      return { source: img, isBitmap: false, width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------- Compute target dimensions ----------
  function targetSize(item, p) {
    let w = item.width, h = item.height;
    if (p.mode === 'percent') {
      const s = p.percent / 100;
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    } else {
      const ratio = w / h;
      let tw = w, th = h;
      if (p.maxW && p.maxH) {
        const r = Math.min(p.maxW / w, p.maxH / h, 1); // 不放大
        tw = Math.max(1, Math.round(w * r));
        th = Math.max(1, Math.round(h * r));
      } else if (p.maxW) {
        const r = Math.min(p.maxW / w, 1);
        tw = Math.max(1, Math.round(w * r));
        th = Math.max(1, Math.round(h * r));
      } else if (p.maxH) {
        const r = Math.min(p.maxH / h, 1);
        tw = Math.max(1, Math.round(p.maxH * ratio));
        th = Math.max(1, Math.round(p.maxH));
      }
      w = tw; h = th;
    }
    return { w, h };
  }

  // ---------- Compress ----------
  function compressItem(item) {
    const p = getParams();
    item.status = 'processing';
    updateCardStatus(item);

    const { w, h } = targetSize(item, p);

    // 离屏 canvas（按尺寸复用）
    const canvas = item._canvas || (item._canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    canvas.width = w;
    canvas.height = h;

    if (p.format === 'image/jpeg') {
      // JPEG 不支持透明，填充白底避免透明区域变黑
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.clearRect(0, 0, w, h);
    }
    try {
      ctx.drawImage(item.source, 0, 0, w, h);
    } catch (e) {
      item.status = 'error';
      item.error = '绘制失败：图片可能已损坏或过大。';
      updateCardStatus(item);
      return Promise.resolve();
    }

    const q = p.format === 'image/png' ? undefined : p.quality;

    return new Promise((resolve) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            item.status = 'error';
            item.error = '压缩失败：当前格式或参数不被浏览器支持。';
            updateCardStatus(item);
            resolve();
            return;
          }
          if (item._outUrl) URL.revokeObjectURL(item._outUrl);
          item.compressedBlob = blob;
          item.compressedSize = blob.size;
          item.compressedWidth = w;
          item.compressedHeight = h;
          item._outUrl = URL.createObjectURL(blob);
          item.status = 'done';
          updateCardStatus(item);
          resolve();
        },
        p.format,
        q
      );
    });
  }

  // ---------- Card UI ----------
  function buildCard(item) {
    const card = document.createElement('div');
    card.className = 'card';

    card.innerHTML = `
      <div class="card-head">
        <span class="card-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <button class="card-remove" title="移除" aria-label="移除">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
        </button>
      </div>
      <div class="card-warn hidden"></div>
      <div class="previews">
        <div class="preview-wrap">
          <span class="preview-tag">原图</span>
          <div class="preview"><img alt="原图预览" /></div>
        </div>
        <div class="preview-wrap">
          <span class="preview-tag">压缩后</span>
          <div class="preview"><img alt="压缩后预览" /></div>
        </div>
      </div>
      <div class="stats">
        <div class="stat-line"><span class="k">原图大小</span><span class="v" data-orig>—</span></div>
        <div class="stat-line"><span class="k">压缩后</span><span class="v" data-comp>—</span></div>
        <div class="stat-line"><span class="k">压缩率</span><span class="v" data-ratio>—</span></div>
        <div class="stat-line"><span class="k">尺寸</span><span class="v" data-dim>—</span></div>
        <div class="ratio-bar"><span data-bar></span></div>
      </div>
      <div class="card-actions">
        <button class="btn btn-primary btn-sm" data-download>下载</button>
      </div>
    `;

    item.els = {
      card,
      warn: card.querySelector('.card-warn'),
      origImg: card.querySelector('.preview img'),
      compImg: card.querySelectorAll('.preview img')[1],
      orig: card.querySelector('[data-orig]'),
      comp: card.querySelector('[data-comp]'),
      ratio: card.querySelector('[data-ratio]'),
      dim: card.querySelector('[data-dim]'),
      bar: card.querySelector('[data-bar]'),
      download: card.querySelector('[data-download]'),
    };

    item.els.origImg.src = item._inUrl;
    item.els.download.addEventListener('click', () => downloadOne(item));
    card.querySelector('.card-remove').addEventListener('click', () => removeItem(item));
    card.querySelectorAll('.preview-wrap').forEach((pw) => {
      pw.classList.add('clickable');
      pw.addEventListener('click', () => openPreview(item));
    });

    grid.appendChild(card);
    return card;
  }

  function updateCardStatus(item) {
    const els = item.els;
    if (item.status === 'processing') {
      setProcessing(item, true);
      els.comp.textContent = '处理中…';
      els.ratio.textContent = '—';
      els.bar.style.width = '0%';
      els.download.disabled = true;
    } else if (item.status === 'error') {
      setProcessing(item, false);
      els.comp.textContent = '—';
      els.ratio.textContent = '—';
      els.ratio.className = 'v bad';
      els.bar.style.width = '0%';
      els.download.disabled = true;
      toast(item.error || '处理失败', 'error');
    } else if (item.status === 'done') {
      setProcessing(item, false);
      const saved = item.originalSize - item.compressedSize;
      const ratioPct = item.originalSize ? (saved / item.originalSize) * 100 : 0;
      els.compImg.src = item._outUrl;
      els.orig.textContent = formatBytes(item.originalSize);
      els.comp.textContent = formatBytes(item.compressedSize);
      els.ratio.textContent = (ratioPct >= 0 ? '↓ ' : '↑ ') + Math.abs(ratioPct).toFixed(1) + '%';
      els.ratio.className = 'v ' + (ratioPct >= 0 ? 'good' : 'bad');
      els.dim.textContent = `${item.compressedWidth}×${item.compressedHeight}`;
      els.bar.style.width = Math.max(0, Math.min(100, ratioPct)) + '%';
      els.download.disabled = false;
    }
    updateSummary();
  }

  function setProcessing(item, on) {
    const wrap = item.els.compImg.parentElement; // .preview
    let sp = wrap.querySelector('.spinner-overlay');
    if (on) {
      if (!sp) {
        sp = document.createElement('div');
        sp.className = 'spinner-overlay';
        sp.innerHTML = '<div class="spinner"></div>';
        wrap.appendChild(sp);
      }
      item.els.compImg.style.visibility = 'hidden';
    } else {
      if (sp) sp.remove();
      item.els.compImg.style.visibility = '';
    }
  }

  function showWarnings(item, warnings) {
    const box = item.els.warn;
    if (!warnings.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = warnings.map((w) =>
      `<span class="badge ${w.level === 'danger' ? 'danger' : 'warn'}">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
        ${escapeHtml(w.text)}
      </span>`
    ).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------- Lightbox 预览 ----------
  function openPreview(item) {
    lbTitle.textContent = item.name;
    lbOrig.src = item._inUrl;
    lbOrigCap.textContent = `${item.width || '?'}×${item.height || '?'} · ${formatBytes(item.originalSize)}`;

    if (item.status === 'done' && item._outUrl) {
      lbCompFig.style.display = '';
      lbComp.src = item._outUrl;
      const saved = item.originalSize - item.compressedSize;
      const pct = item.originalSize ? (saved / item.originalSize) * 100 : 0;
      lbCompCap.textContent = `${item.compressedWidth || '?'}×${item.compressedHeight || '?'} · ${formatBytes(item.compressedSize)}`
        + (pct >= 0 ? `（↓${pct.toFixed(1)}%）` : `（↑${Math.abs(pct).toFixed(1)}%）`);
    } else if (item.status === 'error') {
      lbCompFig.style.display = '';
      lbComp.removeAttribute('src');
      lbCompCap.textContent = '压缩失败';
    } else {
      lbCompFig.style.display = 'none';
    }

    lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closePreview() {
    if (lightbox.classList.contains('hidden')) return;
    lightbox.classList.add('hidden');
    lbOrig.removeAttribute('src');
    lbComp.removeAttribute('src');
    document.body.style.overflow = '';
  }

  lightbox.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closePreview();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePreview();
  });

  // ---------- Add files ----------
  async function addFiles(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;
    let added = 0;
    for (const file of files) {
      const item = {
        id: ++idSeq,
        file,
        name: file.name || ('image-' + idSeq),
        originalSize: file.size,
        status: 'processing',
        warnings: [],
      };
      items.push(item);
      const card = buildCard(item);
      item._inUrl = URL.createObjectURL(file);
      item.els.origImg.src = item._inUrl;

      // 友好提示：格式 / 尺寸 / 体积
      const warnings = [];
      if (isHeic(file)) {
        warnings.push({
          level: 'warn',
          text: 'HEIC/HEIF 可能无法被当前浏览器解码，若下方预览为空请先用系统工具转成 JPEG/PNG/WebP。',
        });
      }
      const ext = extOf(item.name);
      if (!['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'].includes(ext)) {
        warnings.push({ level: 'warn', text: '非常见图片格式，解码结果取决于浏览器支持。' });
      }
      if (item.originalSize > WARN_FILE) {
        warnings.push({ level: 'warn', text: `文件较大（${formatBytes(item.originalSize)}），处理可能较慢。`, });
      }

      try {
        const dec = await decodeFile(file);
        item.source = dec.source;
        item.isBitmap = dec.isBitmap;
        item.width = dec.width;
        item.height = dec.height;

        if (item.width > WARN_DIM || item.height > WARN_DIM) {
          warnings.push({ level: 'warn', text: `单边尺寸较大（${item.width}×${item.height}），超大图处理可能占用大量内存。` });
        }
        if (item.width * item.height > WARN_PIXELS) {
          warnings.push({ level: 'danger', text: `像素量极高（约 ${(item.width * item.height / 1e6).toFixed(0)}MP），可能超出浏览器画布上限而失败。` });
        }
        if (isHeic(file) && item.width === 0) {
          // 某些浏览器 decode 不报错但返回 0 尺寸
          warnings.push({ level: 'danger', text: '浏览器未能读取该 HEIC 的像素数据，压缩可能失败。' });
        }

        showWarnings(item, warnings);
        item.warnings = warnings;
        await compressItem(item);
        added++;
      } catch (e) {
        item.status = 'error';
        item.error = isHeic(file)
          ? '无法解码：当前浏览器不支持 HEIC/HEIF，请转换为 JPEG/PNG/WebP 后重试。'
          : '无法读取该图片，可能格式不受支持或文件已损坏。';
        showWarnings(item, warnings);
        updateCardStatus(item);
      }
    }
    if (added) toast(`已添加 ${added} 张图片`, 'ok');
    refreshEmptyState();
  }

  function removeItem(item) {
    if (item._inUrl) URL.revokeObjectURL(item._inUrl);
    if (item._outUrl) URL.revokeObjectURL(item._outUrl);
    if (item.isBitmap && item.source && item.source.close) {
      try { item.source.close(); } catch (_) {}
    }
    if (item._canvas) item._canvas.width = item._canvas.height = 0;
    item.els.card.remove();
    items = items.filter((x) => x !== item);
    refreshEmptyState();
    updateSummary();
  }

  function refreshEmptyState() {
    const has = items.length > 0;
    empty.classList.toggle('hidden', has);
    summary.classList.toggle('hidden', !has);
  }

  // ---------- Summary ----------
  function updateSummary() {
    const done = items.filter((i) => i.status === 'done');
    const orig = done.reduce((s, i) => s + i.originalSize, 0);
    const comp = done.reduce((s, i) => s + i.compressedSize, 0);
    if (!done.length) {
      sumOriginal.textContent = '—';
      sumCompressed.textContent = '—';
      sumSaved.textContent = '—';
      sumSavedLabel.textContent = '共节省';
      sumSaved.classList.remove('negative');
      return;
    }
    const saved = orig - comp;
    const pct = orig ? (saved / orig) * 100 : 0;
    sumOriginal.textContent = formatBytes(orig);
    sumCompressed.textContent = formatBytes(comp);
    if (saved >= 0) {
      sumSavedLabel.textContent = '共节省';
      sumSaved.textContent = `${formatBytes(saved)}（${pct.toFixed(1)}%）`;
      sumSaved.classList.remove('negative');
    } else {
      sumSavedLabel.textContent = '体积增加';
      sumSaved.textContent = `${formatBytes(saved)}（${pct.toFixed(1)}%）`;
      sumSaved.classList.add('negative');
    }
  }

  // ---------- Download ----------
  function outName(item, format) {
    const base = (item.name.replace(/\.[^.]+$/, '') || 'image');
    return base + '.' + (EXT[format] || 'img');
  }

  function downloadOne(item) {
    if (item.status !== 'done' || !item.compressedBlob) return;
    const a = document.createElement('a');
    a.href = item._outUrl;
    a.download = outName(item, getParams().format);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function downloadAll() {
    const done = items.filter((i) => i.status === 'done' && i.compressedBlob);
    if (!done.length) { toast('暂无可下载的压缩结果', 'warn'); return; }
    const format = getParams().format;
    // 去重文件名（同名追加 _1, _2 ...）
    const seen = {};
    const files = done.map((item) => {
      let n = outName(item, format);
      if (seen[n] !== undefined) {
        const cnt = ++seen[n];
        n = n.replace(/(\.[^.]+)$/, '_' + cnt + '$1');
      } else {
        seen[n] = 0;
      }
      return { name: n, blob: item.compressedBlob };
    });
    toast('正在打包 ZIP…');
    const zip = await buildZip(files);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip);
    a.download = 'tinyshot_compressed.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function clearAll() {
    items.slice().forEach(removeItem);
    fileInput.value = '';
  }

  // ---------- Minimal ZIP (store, no compression) ----------
  function crc32(buf) {
    let table = crc32._t;
    if (!table) {
      table = crc32._t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function buildZip(files) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer());
      const name = enc.encode(f.name);
      const crc = crc32(data);
      const size = data.length;
      // 语言编码标志：告知解压工具文件名按 UTF-8 解码（支持中文等）
      const gpFlag = 0x0800;

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, gpFlag, true);
      local.setUint16(8, 0, true);   // store
      local.setUint16(10, 0, true);  // time
      local.setUint16(12, 0, true);  // date
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), name, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, gpFlag, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, 0, true); // last mod time
      cd.setUint16(14, 0, true); // last mod date
      cd.setUint32(16, crc, true);
      cd.setUint32(20, size, true);
      cd.setUint32(24, size, true);
      cd.setUint16(28, name.length, true);
      cd.setUint16(30, 0, true);
      cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true);
      cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true);
      cd.setUint32(42, offset, true);
      central.push({ header: new Uint8Array(cd.buffer), name });

      offset += 30 + name.length + size;
    }

    let cdSize = 0;
    central.forEach((c) => (cdSize += c.header.length + c.name.length));

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);
    eocd.setUint16(20, 0, true);

    const all = chunks.slice();
    central.forEach((c) => all.push(c.header, c.name));
    all.push(new Uint8Array(eocd.buffer));
    return new Blob(all, { type: 'application/zip' });
  }

  // ---------- Recompress all (param change) ----------
  function recompressAll() {
    items.forEach((item) => {
      if (item.source && item.width) compressItem(item);
    });
  }

  function scheduleRecompress() {
    clearTimeout(recompressTimer);
    recompressTimer = setTimeout(recompressAll, 160);
  }

  // ---------- Events ----------
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', (e) => {
    addFiles(e.target.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === 'dragleave' && dropzone.contains(e.relatedTarget)) return;
      dropzone.classList.remove('dragover');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) addFiles(dt.files);
  });
  // 阻止整个窗口的默认拖放打开行为
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // 质量
  quality.addEventListener('input', () => {
    qualityValue.textContent = parseFloat(quality.value).toFixed(2);
    scheduleRecompress();
  });

  // 格式
  function updateFormatUI() {
    const f = formatSel.value;
    const isPng = f === 'image/png';
    quality.disabled = isPng;
    qualityNote.textContent = isPng
      ? 'PNG 为无损格式，质量滑杆不生效（仅靠尺寸缩放减小体积）。'
      : '数值越低，文件越小、画质损失越多。';
    formatNote.textContent = isPng
      ? '透明背景会被保留；转为 PNG 通常体积更大。'
      : (f === 'image/webp' ? 'WebP 压缩率通常优于 JPEG，但个别老软件不识别。' : 'JPEG 会丢弃透明通道（自动填充白底）。');
  }
  formatSel.addEventListener('change', () => { updateFormatUI(); scheduleRecompress(); });

  // 尺寸模式切换
  segBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      segBtns.forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      const max = btn.dataset.mode === 'max';
      modeMax.classList.toggle('hidden', !max);
      modePercent.classList.toggle('hidden', max);
      scheduleRecompress();
    });
  });

  // 尺寸输入
  [percentInput, maxWInput, maxHInput].forEach((inp) =>
    inp.addEventListener('input', scheduleRecompress)
  );

  $('#downloadAll').addEventListener('click', downloadAll);
  $('#clearAll').addEventListener('click', clearAll);

  // ---------- Init ----------
  updateFormatUI();
  refreshEmptyState();
})();
