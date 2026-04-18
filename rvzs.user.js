// ==UserScript==
// @name         rvzs — Video Scraper
// @namespace    https://github.com/Celesth/rvzs
// @version      1.1.0
// @description  Advanced video fragment & stream scraper with MSE blob capture and yt-dlp command builder
// @author       Celesth
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-start
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // ─── Palette ────────────────────────────────────────────────────────────────
  const COLORS = {
    base:     '#1e1e2e',
    mantle:   '#181825',
    crust:    '#11111b',
    surface0: '#313244',
    surface1: '#45475a',
    overlay0: '#6c7086',
    text:     '#cdd6f4',
    subtext:  '#a6adc8',
    pink:     '#f38ba8',
    mauve:    '#cba6f7',
    peach:    '#fab387',
    yellow:   '#f9e2af',
    green:    '#a6e3a1',
    teal:     '#94e2d5',
    blue:     '#89b4fa',
    lavender: '#b4befe',
  };

  // ─── Constants ───────────────────────────────────────────────────────────────
  const MSE_LIMIT = 100 * 1024 * 1024; // 100 MB hard cap per stream

  // ─── State ───────────────────────────────────────────────────────────────────
  const state = {
    open:        false,
    tab:         'list',
    captured:    [],   // { id, type, url, mime, source, ts, size }
    log:         [],
    impersonate: 'chrome',
    mseStreams:  {},   // key → { id, mime, chunks[], totalBytes, dropped, active }
  };

  let _uid = 0;
  const uid = () => ++_uid;

  // ─── Network intercept helpers ───────────────────────────────────────────────
  const VIDEO_EXT  = /\.(mp4|webm|mkv|mov|avi|flv|m4v|ts|m2ts|mts|mp2t|vtt|m3u8|mpd|f4v|ogg|ogv|3gp)(\?|$)/i;
  const MEDIA_MIME = /^(video|audio|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml|x-mpeg|octet-stream))/i;
  const FRAG_EXT   = /\.ts(\?|$)/i;
  const HLS_EXT    = /\.m3u8(\?|$)/i;
  const DASH_EXT   = /\.mpd(\?|$)/i;
  const ENC_KEYS   = /\.(key|pem|bin)(\?|$)/i;

  function classify(url, mime) {
    if (FRAG_EXT.test(url))    return 'ts';
    if (HLS_EXT.test(url))     return 'hls';
    if (DASH_EXT.test(url))    return 'dash';
    if (ENC_KEYS.test(url))    return 'key';
    if (/\.mp4/i.test(url))    return 'mp4';
    if (/\.webm/i.test(url))   return 'webm';
    if (MEDIA_MIME.test(mime)) return 'xhr';
    if (VIDEO_EXT.test(url))   return 'video';
    return null;
  }

  function addCapture(url, type, source, mime = '', size = '') {
    if (state.captured.find(c => c.url === url)) return;
    const entry = { id: uid(), type, url, mime, source, ts: Date.now(), size };
    state.captured.unshift(entry);
    pushLog(`[${type.toUpperCase()}] ${source}: ${truncUrl(url)}`);
    renderList();
    updateBadge();
  }

  function pushLog(msg) {
    state.log.unshift(msg);
    if (state.log.length > 300) state.log.pop();
    if (state.tab === 'log') renderLog();
  }

  function truncUrl(u, n = 72) {
    try { const p = new URL(u); return (p.origin + p.pathname).slice(0, n) + (u.length > n ? '…' : ''); }
    catch { return u.slice(0, n); }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  MSE / SourceBuffer Hook
  //  Intercepts appendBuffer() BEFORE chunks reach the blob URL so we can
  //  collect raw ArrayBuffers and concatenate them into a downloadable file.
  // ════════════════════════════════════════════════════════════════════════════
  (function hookMSE() {
    const OrigMS              = unsafeWindow.MediaSource;
    const origAddSourceBuffer = OrigMS.prototype.addSourceBuffer;
    const origEndOfStream     = OrigMS.prototype.endOfStream;
    const origAppendBuffer    = unsafeWindow.SourceBuffer.prototype.appendBuffer;

    let _msCount = 0;

    OrigMS.prototype.addSourceBuffer = function (mime) {
      const sb = origAddSourceBuffer.call(this, mime);

      // First buffer added → register the stream
      if (!this._rvzs_id) {
        this._rvzs_id = ++_msCount;
        const key = `mse-${this._rvzs_id}`;
        state.mseStreams[key] = {
          id:         uid(),
          key,
          mime:       mime || 'video/mp4',
          chunks:     [],
          totalBytes: 0,
          dropped:    false,
          active:     true,
          startTs:    Date.now(),
          _renderPending: false,
        };
        pushLog(`[MSE] New stream #${this._rvzs_id} — ${mime}`);
        renderMse();
      }

      const msKey  = `mse-${this._rvzs_id}`;
      sb._rvzs_key = msKey;

      // Override appendBuffer on this specific SourceBuffer instance
      sb.appendBuffer = function (buffer) {
        const stream = state.mseStreams[msKey];
        if (stream && !stream.dropped) {
          // Normalise to plain ArrayBuffer
          let ab;
          if (buffer instanceof ArrayBuffer) {
            ab = buffer.slice(0);
          } else if (ArrayBuffer.isView(buffer)) {
            ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
          } else {
            ab = buffer;
          }

          if (stream.totalBytes + ab.byteLength > MSE_LIMIT) {
            stream.dropped = true;
            pushLog(`[MSE] Stream ${msKey} hit 100 MB limit — collection stopped`);
            renderMse();
          } else {
            stream.chunks.push(ab);
            stream.totalBytes += ab.byteLength;
            // Throttle re-render (≤ every 500 ms) to avoid layout thrash
            if (!stream._renderPending) {
              stream._renderPending = true;
              setTimeout(() => {
                stream._renderPending = false;
                renderMse();
              }, 500);
            }
          }
        }
        return origAppendBuffer.call(this, buffer);
      };

      return sb;
    };

    // Mark stream stopped when MediaSource signals end
    OrigMS.prototype.endOfStream = function (...args) {
      if (this._rvzs_id) {
        const s = state.mseStreams[`mse-${this._rvzs_id}`];
        if (s) { s.active = false; renderMse(); }
      }
      return origEndOfStream.apply(this, args);
    };
  })();

  // ─── XHR Hook ────────────────────────────────────────────────────────────────
  const OrigXHR = unsafeWindow.XMLHttpRequest;
  class HookedXHR extends OrigXHR {
    open(method, url, ...rest) { this._rvzs_url = url; return super.open(method, url, ...rest); }
    send(...args) {
      this.addEventListener('readystatechange', () => {
        if (this.readyState === 4) {
          const mime = this.getResponseHeader('content-type') || '';
          const size = this.getResponseHeader('content-length') || '';
          const t = classify(this._rvzs_url, mime);
          if (t) addCapture(this._rvzs_url, t, 'XHR', mime, size);
        }
      });
      return super.send(...args);
    }
  }
  unsafeWindow.XMLHttpRequest = HookedXHR;

  // ─── Fetch Hook ──────────────────────────────────────────────────────────────
  const origFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = async function (input) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const res = await origFetch.apply(this, arguments);
    try {
      const mime = res.headers.get('content-type') || '';
      const size = res.headers.get('content-length') || '';
      const t = classify(url, mime);
      if (t) addCapture(url, t, 'fetch', mime, size);
    } catch {}
    return res;
  };

  // ─── DOM scan ────────────────────────────────────────────────────────────────
  function scanDOM() {
    document.querySelectorAll('video[src], video > source[src]').forEach(el => {
      const url = el.src || el.getAttribute('src');
      if (!url) return;
      if (url.startsWith('blob:')) {
        addCapture(url, 'blob', 'DOM-blob', '', '');
      } else {
        addCapture(url, classify(url, '') || 'video', 'DOM', '', '');
      }
    });
  }
  const domObserver = new MutationObserver(scanDOM);
  document.addEventListener('DOMContentLoaded', () => {
    scanDOM();
    domObserver.observe(document.body, { childList: true, subtree: true });
  });

  // ─── yt-dlp command builder ──────────────────────────────────────────────────
  const IMPERSONATORS = {
    chrome:  '--impersonate chrome',
    firefox: '--impersonate firefox',
    safari:  '--impersonate safari',
    edge:    '--impersonate edge',
    none:    '',
  };

  function buildCmd(entry) {
    const imp     = IMPERSONATORS[state.impersonate] || '';
    const ref     = `--referer "${location.href}"`;
    const ua      = `--user-agent "${navigator.userAgent}"`;
    const cookies = `--cookies-from-browser chrome`;
    const out     = `-o "%(title)s.%(ext)s"`;
    const extra   = (entry.type === 'hls' || entry.type === 'dash') ? '--hls-use-mpegts' : '';
    return ['yt-dlp', imp, ref, ua, cookies, out, extra, `"${entry.url}"`].filter(Boolean).join(' ');
  }

  // ─── MSE download ────────────────────────────────────────────────────────────
  function downloadMseStream(key) {
    const stream = state.mseStreams[key];
    if (!stream || stream.chunks.length === 0) { showToast('No data collected yet'); return; }

    // Merge all ArrayBuffers into one
    const totalSize = stream.chunks.reduce((a, b) => a + b.byteLength, 0);
    const merged    = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of stream.chunks) {
      merged.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    // Determine best extension from MIME type
    const mime = stream.mime || 'video/mp4';
    const ext  = mime.includes('webm')                                   ? 'webm'
               : mime.includes('mp2t') || mime.includes('mpegts')        ? 'ts'
               : mime.includes('ogg')                                    ? 'ogg'
               : 'mp4';

    const blob    = new Blob([merged], { type: mime });
    const blobUrl = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href        = blobUrl;
    a.download    = `rvzs-${key}-${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);

    pushLog(`[MSE] ⬇ Downloaded ${formatBytes(totalSize)} (${stream.chunks.length} chunks) as .${ext}`);
    showToast(`Downloading ${formatBytes(totalSize)}…`);
  }

  function clearMseStream(key) {
    const s = state.mseStreams[key];
    if (s) { s.chunks = []; s.totalBytes = 0; s.dropped = false; }
    renderMse();
    showToast('Stream buffer reset');
  }

  // ─── Styles ──────────────────────────────────────────────────────────────────
  GM_addStyle(`
    :root {
      --rvzs-base:   ${COLORS.base};
      --rvzs-mantle: ${COLORS.mantle};
      --rvzs-crust:  ${COLORS.crust};
      --rvzs-s0:     ${COLORS.surface0};
      --rvzs-s1:     ${COLORS.surface1};
      --rvzs-ov:     ${COLORS.overlay0};
      --rvzs-text:   ${COLORS.text};
      --rvzs-sub:    ${COLORS.subtext};
      --rvzs-pink:   ${COLORS.pink};
      --rvzs-mauve:  ${COLORS.mauve};
      --rvzs-peach:  ${COLORS.peach};
      --rvzs-yellow: ${COLORS.yellow};
      --rvzs-green:  ${COLORS.green};
      --rvzs-blue:   ${COLORS.blue};
      --rvzs-teal:   ${COLORS.teal};
      --rvzs-lav:    ${COLORS.lavender};
      --rvzs-glass:  rgba(30,30,46,0.86);
      --rvzs-blur:   saturate(180%) blur(20px);
    }

    /* ── FAB ── */
    #rvzs-fab {
      position: fixed; bottom: 22px; right: 22px;
      z-index: 2147483647;
      width: 52px; height: 52px; border-radius: 50%;
      background: linear-gradient(135deg, var(--rvzs-mauve), var(--rvzs-blue));
      border: none; cursor: pointer; color: #fff;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 24px rgba(137,180,250,0.30);
      transition: transform .18s cubic-bezier(.34,1.56,.64,1), box-shadow .18s ease;
      outline: none; -webkit-tap-highlight-color: transparent;
    }
    #rvzs-fab:hover  { transform: scale(1.1); box-shadow: 0 6px 32px rgba(203,166,247,0.45); }
    #rvzs-fab:active { transform: scale(0.95); }
    #rvzs-fab svg    { width: 24px; height: 24px; }

    #rvzs-badge {
      position: absolute; top: -4px; right: -4px;
      min-width: 18px; height: 18px; padding: 0 4px;
      background: var(--rvzs-pink); color: var(--rvzs-crust);
      border-radius: 9px; font-family: 'JetBrains Mono', monospace;
      font-size: 10px; font-weight: 700;
      display: none; align-items: center; justify-content: center;
      box-shadow: 0 2px 8px rgba(243,139,168,0.4);
    }
    #rvzs-badge.show { display: flex; }

    /* ── Panel ── */
    #rvzs-panel {
      position: fixed; bottom: 84px; right: 16px;
      z-index: 2147483646;
      width: min(540px, calc(100vw - 32px));
      max-height: min(700px, calc(100vh - 108px));
      background: var(--rvzs-glass);
      backdrop-filter: var(--rvzs-blur);
      -webkit-backdrop-filter: var(--rvzs-blur);
      border: 1px solid rgba(203,166,247,0.15); border-radius: 14px;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 8px 40px rgba(0,0,0,0.55),
                  0 0 0 1px rgba(180,190,254,0.07) inset,
                  0 1px 0 rgba(255,255,255,0.04) inset;
      transform: translateY(16px) scale(0.97); opacity: 0; pointer-events: none;
      transition: transform .22s cubic-bezier(.34,1.4,.64,1), opacity .18s ease;
      font-family: 'JetBrains Mono', 'IBM Plex Mono', monospace;
    }
    #rvzs-panel.open { transform: none; opacity: 1; pointer-events: all; }

    /* ── Header ── */
    #rvzs-header {
      display: flex; align-items: center; gap: 10px;
      padding: 13px 16px 11px;
      border-bottom: 1px solid rgba(203,166,247,0.10);
      background: rgba(24,24,37,0.55); flex-shrink: 0;
    }
    .rvzs-logo {
      font-size: 13px; font-weight: 700; letter-spacing: .12em;
      background: linear-gradient(90deg, var(--rvzs-mauve), var(--rvzs-blue));
      -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
    }
    .rvzs-domain {
      font-size: 10px; color: var(--rvzs-sub);
      flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .rvzs-icon-btn {
      background: none; border: none; color: var(--rvzs-sub); cursor: pointer;
      padding: 4px; border-radius: 6px; display: flex; align-items: center;
      transition: color .12s, background .12s; -webkit-tap-highlight-color: transparent;
    }
    .rvzs-icon-btn:hover { color: var(--rvzs-text); background: rgba(255,255,255,0.06); }

    /* ── Tabs ── */
    #rvzs-tabs {
      display: flex; padding: 8px 12px 0; gap: 4px;
      border-bottom: 1px solid rgba(203,166,247,0.08);
      flex-shrink: 0; overflow-x: auto; scrollbar-width: none;
    }
    #rvzs-tabs::-webkit-scrollbar { display: none; }
    .rvzs-tab {
      padding: 5px 11px; font-size: 10px; font-weight: 600; letter-spacing: .06em;
      border: 1px solid transparent; border-radius: 6px 6px 0 0;
      background: none; color: var(--rvzs-sub); cursor: pointer; white-space: nowrap;
      transition: all .14s; -webkit-tap-highlight-color: transparent;
    }
    .rvzs-tab:hover { color: var(--rvzs-text); }
    .rvzs-tab.active {
      color: var(--rvzs-mauve);
      border-color: rgba(203,166,247,0.22); border-bottom-color: transparent;
      background: rgba(203,166,247,0.06);
    }

    /* ── Toolbar ── */
    #rvzs-toolbar {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      padding: 7px 12px; border-bottom: 1px solid rgba(203,166,247,0.07);
      background: rgba(17,17,27,0.3); flex-shrink: 0;
    }
    #rvzs-toolbar label { font-size: 10px; color: var(--rvzs-sub); letter-spacing: .05em; }
    #rvzs-imp-select {
      background: var(--rvzs-s0); border: 1px solid rgba(203,166,247,0.15);
      border-radius: 5px; color: var(--rvzs-text); font-family: inherit;
      font-size: 10px; padding: 3px 7px; cursor: pointer; outline: none;
    }
    .rvzs-tb-btn {
      padding: 4px 10px; font-size: 10px; font-family: inherit; font-weight: 600;
      border-radius: 5px; cursor: pointer; letter-spacing: .05em;
      transition: all .14s; border: 1px solid;
      -webkit-tap-highlight-color: transparent;
    }
    .rvzs-tb-btn.scan {
      background: rgba(203,166,247,0.12); border-color: rgba(203,166,247,0.25);
      color: var(--rvzs-lav);
    }
    .rvzs-tb-btn.scan:hover { background: rgba(203,166,247,0.22); }
    .rvzs-tb-btn.clear {
      margin-left: auto;
      background: rgba(243,139,168,0.10); border-color: rgba(243,139,168,0.20);
      color: var(--rvzs-pink);
    }
    .rvzs-tb-btn.clear:hover { background: rgba(243,139,168,0.20); }

    /* ── Content panels ── */
    #rvzs-list, #rvzs-mse-panel, #rvzs-cmd-panel, #rvzs-log-panel {
      display: none; overflow-y: auto; flex: 1;
      scrollbar-width: thin; scrollbar-color: var(--rvzs-s1) transparent;
    }
    #rvzs-list::-webkit-scrollbar,
    #rvzs-mse-panel::-webkit-scrollbar,
    #rvzs-cmd-panel::-webkit-scrollbar,
    #rvzs-log-panel::-webkit-scrollbar { width: 5px; }
    #rvzs-list::-webkit-scrollbar-thumb,
    #rvzs-mse-panel::-webkit-scrollbar-thumb,
    #rvzs-cmd-panel::-webkit-scrollbar-thumb,
    #rvzs-log-panel::-webkit-scrollbar-thumb { background: var(--rvzs-s1); border-radius: 3px; }

    #rvzs-list.active,
    #rvzs-mse-panel.active,
    #rvzs-cmd-panel.active,
    #rvzs-log-panel.active { display: block; }

    #rvzs-list      { padding: 6px 8px; }
    #rvzs-mse-panel { padding: 10px 12px; }
    #rvzs-cmd-panel { padding: 10px 14px; }
    #rvzs-log-panel { padding: 8px 12px; }

    /* ── Empty state ── */
    .rvzs-empty {
      color: var(--rvzs-ov); font-size: 11px;
      text-align: center; padding: 32px 16px; letter-spacing: .04em;
    }
    .rvzs-empty span { display: block; font-size: 28px; margin-bottom: 8px; }

    /* ── Capture list items ── */
    .rvzs-item {
      display: flex; flex-direction: column; gap: 5px;
      padding: 9px 11px; border-radius: 8px;
      border: 1px solid transparent; margin-bottom: 5px;
      transition: all .14s; background: rgba(49,50,68,0.40);
      position: relative; overflow: hidden;
    }
    .rvzs-item::before {
      content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
      border-radius: 3px 0 0 3px; background: var(--item-accent, var(--rvzs-s1));
    }
    .rvzs-item:hover { border-color: rgba(203,166,247,0.15); background: rgba(49,50,68,0.7); }
    .rvzs-item-top   { display: flex; align-items: center; gap: 7px; }
    .rvzs-type-badge {
      font-size: 9px; font-weight: 700; letter-spacing: .08em;
      padding: 2px 6px; border-radius: 4px; flex-shrink: 0;
    }
    .rvzs-item-url {
      font-size: 10px; color: var(--rvzs-sub);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
    }
    .rvzs-item-meta {
      font-size: 9px; color: var(--rvzs-ov);
      display: flex; gap: 10px; padding-left: 3px;
    }
    .rvzs-item-actions { display: flex; gap: 5px; flex-wrap: wrap; }

    /* ── Buttons ── */
    .rvzs-action-btn {
      padding: 3px 9px; font-size: 9px; font-family: inherit;
      font-weight: 600; letter-spacing: .05em; border-radius: 5px;
      cursor: pointer; transition: all .12s; border: 1px solid;
      -webkit-tap-highlight-color: transparent;
    }
    .rvzs-action-btn.copy { background: rgba(137,180,250,0.12); border-color: rgba(137,180,250,0.25); color: var(--rvzs-blue); }
    .rvzs-action-btn.copy:hover { background: rgba(137,180,250,0.22); }
    .rvzs-action-btn.cmd  { background: rgba(203,166,247,0.12); border-color: rgba(203,166,247,0.25); color: var(--rvzs-mauve); }
    .rvzs-action-btn.cmd:hover  { background: rgba(203,166,247,0.22); }
    .rvzs-action-btn.open { background: rgba(166,227,161,0.10); border-color: rgba(166,227,161,0.20); color: var(--rvzs-green); }
    .rvzs-action-btn.open:hover { background: rgba(166,227,161,0.18); }
    .rvzs-action-btn.dl   { background: rgba(148,226,213,0.12); border-color: rgba(148,226,213,0.25); color: var(--rvzs-teal); }
    .rvzs-action-btn.dl:hover   { background: rgba(148,226,213,0.22); }
    .rvzs-action-btn.del  { background: rgba(243,139,168,0.08); border-color: rgba(243,139,168,0.15); color: var(--rvzs-pink); }
    .rvzs-action-btn.del:hover  { background: rgba(243,139,168,0.15); }

    /* ── MSE stream cards ── */
    .rvzs-mse-card {
      background: rgba(49,50,68,0.50); border: 1px solid rgba(148,226,213,0.15);
      border-radius: 10px; padding: 11px 13px; margin-bottom: 8px;
      position: relative; overflow: hidden;
    }
    .rvzs-mse-card::before {
      content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
      background: var(--rvzs-teal); border-radius: 3px 0 0 3px;
    }
    .rvzs-mse-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
    .rvzs-mse-label {
      font-size: 9px; font-weight: 700; letter-spacing: .1em;
      padding: 2px 7px; border-radius: 4px;
      background: rgba(148,226,213,0.15); color: var(--rvzs-teal);
    }
    .rvzs-mse-status {
      font-size: 9px; padding: 2px 7px; border-radius: 4px; font-weight: 600;
    }
    .rvzs-mse-status.recording {
      background: rgba(166,227,161,0.15); color: var(--rvzs-green);
      animation: rvzs-pulse 1.4s ease-in-out infinite;
    }
    .rvzs-mse-status.stopped { background: rgba(108,112,134,0.20); color: var(--rvzs-ov); }
    .rvzs-mse-status.capped  { background: rgba(243,139,168,0.15); color: var(--rvzs-pink); }
    @keyframes rvzs-pulse { 0%,100%{opacity:1} 50%{opacity:.45} }

    .rvzs-mse-mime { font-size: 9px; color: var(--rvzs-ov); margin-left: auto; }
    .rvzs-mse-progress {
      height: 4px; border-radius: 2px;
      background: var(--rvzs-s0); margin-bottom: 7px; overflow: hidden;
    }
    .rvzs-mse-bar {
      height: 100%; border-radius: 2px;
      background: linear-gradient(90deg, var(--rvzs-teal), var(--rvzs-blue));
      transition: width .4s ease;
    }
    .rvzs-mse-stats {
      font-size: 9px; color: var(--rvzs-sub);
      display: flex; gap: 12px; margin-bottom: 8px; flex-wrap: wrap;
    }
    .rvzs-mse-note {
      font-size: 9px; color: var(--rvzs-ov); margin-bottom: 7px; line-height: 1.5;
    }
    .rvzs-mse-actions { display: flex; gap: 6px; }

    /* ── Command entries ── */
    .rvzs-cmd-entry {
      background: var(--rvzs-crust); border: 1px solid rgba(203,166,247,0.10);
      border-radius: 7px; padding: 9px 11px; margin-bottom: 8px;
    }
    .rvzs-cmd-url  { font-size: 9px; color: var(--rvzs-ov); margin-bottom: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rvzs-cmd-code { font-size: 10px; color: var(--rvzs-green); word-break: break-all; white-space: pre-wrap; line-height: 1.6; margin-bottom: 6px; }

    /* ── Log ── */
    .rvzs-log-line {
      font-size: 9.5px; color: var(--rvzs-sub); padding: 2px 0;
      border-bottom: 1px solid rgba(255,255,255,0.03);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .rvzs-log-line .tag { color: var(--rvzs-mauve); margin-right: 4px; }

    /* ── Toast ── */
    #rvzs-toast {
      position: fixed; bottom: 86px; left: 50%;
      transform: translateX(-50%) translateY(10px);
      background: rgba(166,227,161,0.15); border: 1px solid rgba(166,227,161,0.30);
      color: var(--rvzs-green); padding: 7px 16px; border-radius: 20px;
      font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 600;
      z-index: 2147483648; opacity: 0; pointer-events: none;
      transition: all .22s cubic-bezier(.34,1.4,.64,1);
      backdrop-filter: blur(12px); white-space: nowrap;
    }
    #rvzs-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

    /* ── Mobile ── */
    @media (max-width: 540px) {
      #rvzs-panel { right: 8px; left: 8px; width: auto; bottom: 80px; }
      #rvzs-fab   { bottom: 18px; right: 18px; }
    }
  `);

  // ─── Type → visual style map ─────────────────────────────────────────────────
  const TYPE_STYLE = {
    ts:    { accent: COLORS.yellow,   bg: `rgba(249,226,175,0.15)`, color: COLORS.yellow },
    hls:   { accent: COLORS.peach,    bg: `rgba(250,179,135,0.15)`, color: COLORS.peach },
    dash:  { accent: COLORS.blue,     bg: `rgba(137,180,250,0.15)`, color: COLORS.blue },
    mp4:   { accent: COLORS.green,    bg: `rgba(166,227,161,0.15)`, color: COLORS.green },
    webm:  { accent: COLORS.teal,     bg: `rgba(148,226,213,0.15)`, color: COLORS.teal },
    video: { accent: COLORS.lavender, bg: `rgba(180,190,254,0.15)`, color: COLORS.lavender },
    xhr:   { accent: COLORS.mauve,    bg: `rgba(203,166,247,0.15)`, color: COLORS.mauve },
    key:   { accent: COLORS.pink,     bg: `rgba(243,139,168,0.18)`, color: COLORS.pink },
    blob:  { accent: COLORS.teal,     bg: `rgba(148,226,213,0.13)`, color: COLORS.teal },
  };
  const getStyle = t => TYPE_STYLE[t] || TYPE_STYLE.video;

  // ─── Build UI ─────────────────────────────────────────────────────────────────
  function buildUI() {
    // FAB
    const fab = document.createElement('button');
    fab.id = 'rvzs-fab';
    fab.title = 'rvzs — Video Scraper';
    fab.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9"/>
        <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none"/>
      </svg>
      <span id="rvzs-badge"></span>`;
    document.documentElement.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'rvzs-panel';
    panel.innerHTML = `
      <div id="rvzs-header">
        <span class="rvzs-logo">rvzs</span>
        <span class="rvzs-domain">${location.hostname}</span>
        <button class="rvzs-icon-btn" id="rvzs-close-btn" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div id="rvzs-tabs">
        <button class="rvzs-tab active" data-tab="list">Captures</button>
        <button class="rvzs-tab" data-tab="mse">MSE Blob</button>
        <button class="rvzs-tab" data-tab="cmd">Commands</button>
        <button class="rvzs-tab" data-tab="log">Log</button>
      </div>

      <div id="rvzs-toolbar">
        <label>impersonate</label>
        <select id="rvzs-imp-select">
          <option value="chrome">Chrome</option>
          <option value="firefox">Firefox</option>
          <option value="safari">Safari</option>
          <option value="edge">Edge</option>
          <option value="none">None</option>
        </select>
        <button class="rvzs-tb-btn scan" id="rvzs-scan-btn">↻ Scan DOM</button>
        <button class="rvzs-tb-btn clear" id="rvzs-clear-btn">✕ Clear All</button>
      </div>

      <div id="rvzs-list" class="active"></div>
      <div id="rvzs-mse-panel"></div>
      <div id="rvzs-cmd-panel"></div>
      <div id="rvzs-log-panel"></div>
    `;
    document.documentElement.appendChild(panel);

    // Toast
    const toast = document.createElement('div');
    toast.id = 'rvzs-toast';
    document.documentElement.appendChild(toast);

    // Events
    fab.addEventListener('click', togglePanel);
    panel.querySelector('#rvzs-close-btn').addEventListener('click', () => setOpen(false));
    panel.querySelector('#rvzs-scan-btn').addEventListener('click', () => { scanDOM(); showToast('DOM scanned'); });
    panel.querySelector('#rvzs-clear-btn').addEventListener('click', clearAll);
    panel.querySelector('#rvzs-imp-select').addEventListener('change', e => {
      state.impersonate = e.target.value;
      if (state.tab === 'cmd') renderCmd();
    });
    panel.querySelectorAll('.rvzs-tab').forEach(btn =>
      btn.addEventListener('click', () => switchTab(btn.dataset.tab))
    );
  }

  // ─── Panel logic ──────────────────────────────────────────────────────────────
  function togglePanel() { setOpen(!state.open); }
  function setOpen(v) {
    state.open = v;
    document.getElementById('rvzs-panel').classList.toggle('open', v);
    if (v) { state.tab = state.tab || 'list'; renderAll(); }
  }

  const PANEL_IDS = {
    list: 'rvzs-list',
    mse:  'rvzs-mse-panel',
    cmd:  'rvzs-cmd-panel',
    log:  'rvzs-log-panel',
  };

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.rvzs-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab)
    );
    Object.entries(PANEL_IDS).forEach(([k, id]) =>
      document.getElementById(id)?.classList.toggle('active', k === tab)
    );
    renderAll();
  }

  function renderAll() {
    renderList();
    renderMse();
    if (state.tab === 'cmd') renderCmd();
    if (state.tab === 'log') renderLog();
  }

  function updateBadge() {
    const badge = document.getElementById('rvzs-badge');
    if (!badge) return;
    const n = state.captured.length;
    badge.textContent = n > 99 ? '99+' : n;
    badge.classList.toggle('show', n > 0);
  }

  function clearAll() {
    state.captured = [];
    state.log = [];
    renderAll();
    updateBadge();
    showToast('Captures cleared');
  }

  // ─── Render: Captures ────────────────────────────────────────────────────────
  function renderList() {
    const el = document.getElementById('rvzs-list');
    if (!el) return;
    if (state.captured.length === 0) {
      el.innerHTML = `<div class="rvzs-empty"><span>📡</span>No captures yet.<br>Browse pages with video to detect streams.</div>`;
      return;
    }
    el.innerHTML = state.captured.map(item => {
      const s    = getStyle(item.type);
      const time = new Date(item.ts).toLocaleTimeString();
      return `
        <div class="rvzs-item" style="--item-accent:${s.accent}">
          <div class="rvzs-item-top">
            <span class="rvzs-type-badge" style="background:${s.bg};color:${s.color}">${item.type.toUpperCase()}</span>
            <span class="rvzs-item-url" title="${escHtml(item.url)}">${escHtml(truncUrl(item.url, 56))}</span>
          </div>
          <div class="rvzs-item-meta">
            <span>⏱ ${time}</span>
            <span>📡 ${item.source}</span>
            ${item.mime ? `<span>🗂 ${item.mime.split(';')[0]}</span>` : ''}
            ${item.size ? `<span>📦 ${formatBytes(+item.size)}</span>` : ''}
          </div>
          <div class="rvzs-item-actions">
            <button class="rvzs-action-btn copy" data-act="copy" data-id="${item.id}">⧉ Copy URL</button>
            ${item.type !== 'blob' ? `<button class="rvzs-action-btn cmd" data-act="cmd" data-id="${item.id}">⌘ yt-dlp</button>` : ''}
            ${item.type !== 'blob' ? `<button class="rvzs-action-btn open" data-act="open" data-id="${item.id}">↗ Open</button>` : ''}
            <button class="rvzs-action-btn del" data-act="del" data-id="${item.id}">✕</button>
          </div>
        </div>`;
    }).join('');

    el.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id   = +btn.dataset.id;
        const item = state.captured.find(c => c.id === id);
        if (!item) return;
        switch (btn.dataset.act) {
          case 'copy': GM_setClipboard(item.url); showToast('URL copied!'); break;
          case 'cmd':  GM_setClipboard(buildCmd(item)); showToast('Command copied!'); break;
          case 'open': unsafeWindow.open(item.url, '_blank'); break;
          case 'del':
            state.captured = state.captured.filter(c => c.id !== id);
            renderList(); updateBadge();
            break;
        }
      });
    });
  }

  // ─── Render: MSE Blob tab ────────────────────────────────────────────────────
  function renderMse() {
    const el = document.getElementById('rvzs-mse-panel');
    if (!el) return;
    const streams = Object.values(state.mseStreams);

    if (streams.length === 0) {
      el.innerHTML = `<div class="rvzs-empty"><span>🧩</span>No MSE streams detected yet.<br>Press play on a video and chunks<br>will be captured automatically.</div>`;
      return;
    }

    el.innerHTML = streams.map(s => {
      const pct     = Math.min(100, (s.totalBytes / MSE_LIMIT) * 100).toFixed(1);
      const status  = s.dropped ? 'capped' : s.active ? 'recording' : 'stopped';
      const statusL = s.dropped ? '⚠ cap hit' : s.active ? '● Recording' : '■ Stopped';
      const canDl   = s.chunks.length > 0;
      return `
        <div class="rvzs-mse-card">
          <div class="rvzs-mse-card-header">
            <span class="rvzs-mse-label">${s.key.toUpperCase()}</span>
            <span class="rvzs-mse-status ${status}">${statusL}</span>
            <span class="rvzs-mse-mime">${s.mime.split(';')[0]}</span>
          </div>
          <div class="rvzs-mse-progress">
            <div class="rvzs-mse-bar" style="width:${pct}%"></div>
          </div>
          <div class="rvzs-mse-stats">
            <span>📦 ${formatBytes(s.totalBytes)}</span>
            <span>🗂 ${s.chunks.length} chunks</span>
            <span>📊 ${pct}% of 100 MB</span>
          </div>
          ${s.dropped ? `<div class="rvzs-mse-note">⚠ Collection stopped at 100 MB. Download what was captured or reset to continue.</div>` : ''}
          <div class="rvzs-mse-actions">
            <button class="rvzs-action-btn dl"  data-mse-dl="${s.key}" ${canDl ? '' : 'disabled style="opacity:.4;cursor:not-allowed"'}>⬇ Download</button>
            <button class="rvzs-action-btn del" data-mse-clr="${s.key}">↺ Reset</button>
          </div>
        </div>`;
    }).join('');

    el.querySelectorAll('[data-mse-dl]').forEach(btn => {
      btn.addEventListener('click', () => downloadMseStream(btn.dataset.mseDl));
    });
    el.querySelectorAll('[data-mse-clr]').forEach(btn => {
      btn.addEventListener('click', () => clearMseStream(btn.dataset.MseClr || btn.getAttribute('data-mse-clr')));
    });
  }

  // ─── Render: Commands ────────────────────────────────────────────────────────
  function renderCmd() {
    const el = document.getElementById('rvzs-cmd-panel');
    if (!el) return;
    const items = state.captured.filter(c => c.type !== 'blob');
    if (items.length === 0) {
      el.innerHTML = `<div class="rvzs-empty"><span>🛠</span>No commands yet.</div>`;
      return;
    }
    el.innerHTML = items.map(item => `
      <div class="rvzs-cmd-entry">
        <div class="rvzs-cmd-url">${escHtml(truncUrl(item.url, 70))}</div>
        <div class="rvzs-cmd-code">${escHtml(buildCmd(item))}</div>
        <button class="rvzs-action-btn cmd" data-cmd-id="${item.id}">⧉ Copy</button>
      </div>`).join('');
    el.querySelectorAll('[data-cmd-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const item = state.captured.find(c => c.id === +btn.dataset.cmdId);
        if (item) { GM_setClipboard(buildCmd(item)); showToast('Command copied!'); }
      });
    });
  }

  // ─── Render: Log ─────────────────────────────────────────────────────────────
  function renderLog() {
    const el = document.getElementById('rvzs-log-panel');
    if (!el) return;
    if (state.log.length === 0) {
      el.innerHTML = `<div class="rvzs-empty"><span>📋</span>No activity yet.</div>`;
      return;
    }
    el.innerHTML = state.log.map(l => {
      const m = l.match(/^\[([A-Z0-9]+)\]\s(.+)/);
      return m
        ? `<div class="rvzs-log-line"><span class="tag">[${m[1]}]</span>${escHtml(m[2])}</div>`
        : `<div class="rvzs-log-line">${escHtml(l)}</div>`;
    }).join('');
  }

  // ─── Toast ────────────────────────────────────────────────────────────────────
  let _toastTimer;
  function showToast(msg) {
    const t = document.getElementById('rvzs-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function formatBytes(n) {
    if (!n || isNaN(n)) return '?';
    if (n < 1024)       return n + ' B';
    if (n < 1048576)    return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    buildUI();
    setTimeout(scanDOM, 1200);
    setTimeout(scanDOM, 3500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
