// ==UserScript==
// @name         rvzs — DevPanel
// @namespace    https://github.com/Celesth/rvzs
// @version      2.1.0
// @description  Resizable code executor (multi-tab, userscript-level access) + network logger with yt-dlp builder
// @author       Celesth
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const VIDEO_EXT = /\.(mp4|webm|mkv|mov|avi|flv|m4v|ts|m2ts|mts|mp2t|m3u8|mpd|f4v|ogg|ogv|3gp)(\?[^"]*)?$/i;

  // ─── Cookie helpers ──────────────────────────────────────────────────────────
  function getSiteCookies() {
    try {
      const raw = document.cookie;
      return raw ? raw.split(';').map(s => s.trim()).filter(Boolean).join('; ') : '';
    } catch { return ''; }
  }

  // ─── yt-dlp command builder ──────────────────────────────────────────────────
  function buildYtdlpCmd(url) {
    const cookies = getSiteCookies();
    const origin  = location.origin;
    const referer = location.href;
    const ua      = navigator.userAgent;
    const parts   = [
      'yt-dlp',
      `--extractor-args "generic:impersonate"`,
      `--add-header "Origin: ${origin}"`,
      `--add-header "Referer: ${referer}"`,
      `--add-header "User-Agent: ${ua}"`,
      cookies ? `--add-header "Cookie: ${cookies}"` : '',
      `-o "%(title)s.%(ext)s"`,
      `"${url}"`,
    ].filter(Boolean);
    return parts.join(' \\\n  ');
  }

  // ─── Persistence ─────────────────────────────────────────────────────────────
  const LS_KEY = 'rvzs_dp_state';

  function saveState() {
    try {
      const data = {
        open: state.open,
        tab: state.tab,
        execTabs: state.execTabs,
        activeExecTab: state.activeExecTab,
        execTabId: state.execTabId,
        history: state.history,
        histIdx: state.histIdx,
        panelW: state.panelW,
        panelH: state.panelH,
        panelL: state.panelL,
        panelB: state.panelB,
        outH: state.outH,
      };
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch {}
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  // ─── State ───────────────────────────────────────────────────────────────────
  const saved = loadState();
  const state = {
    open:          false,
    tab:           'executor',
    logs:          [],
    filter:        '',
    methodFilter:  'ALL',
    execTabs:      [{ id: 1, title: 'Tab 1', code: '' }],
    activeExecTab: 1,
    execTabId:     1,
    history:       [],
    histIdx:       -1,
    panelW:        760,
    panelH:        560,
    panelL:        20,
    panelB:        20,
    outH:          130,
    ...(saved ? {
      tab: saved.tab,
      execTabs: saved.execTabs,
      activeExecTab: saved.activeExecTab,
      execTabId: saved.execTabId,
      history: saved.history,
      histIdx: saved.histIdx,
      panelW: saved.panelW,
      panelH: saved.panelH,
      panelL: saved.panelL,
      panelB: saved.panelB,
      outH: saved.outH ?? 130,
    } : {}),
  };

  const _detailOpen = new Set();

  // ─── Request intercept ───────────────────────────────────────────────────────
  let _lid = 0;
  const nid = () => ++_lid;

  function addLog(entry) {
    state.logs.unshift(entry);
    if (state.logs.length > 500) state.logs.pop();
    if (state.tab === 'logger') prependLogRow(entry);
  }

  const OrigXHR = unsafeWindow.XMLHttpRequest;
  class HookedXHR extends OrigXHR {
    open(m, u, ...r) { this._m = m; this._u = u; this._t = 0; return super.open(m, u, ...r); }
    send(...a) {
      this._t = Date.now();
      this.addEventListener('readystatechange', () => {
        if (this.readyState === 4) addLog({
          id: nid(), method: (this._m || 'GET').toUpperCase(), url: this._u || '',
          status: this.status,
          type: (this.getResponseHeader('content-type') || '').split(';')[0] || '—',
          ts: Date.now(), duration: Date.now() - (this._t || Date.now()),
          size: this.getResponseHeader('content-length') || '?', src: 'XHR',
        });
      });
      return super.send(...a);
    }
  }
  unsafeWindow.XMLHttpRequest = HookedXHR;

  const _origFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = async function (input, init) {
    const url    = typeof input === 'string' ? input : input?.url || '';
    const method = (init?.method || (typeof input === 'object' ? input?.method : null) || 'GET').toUpperCase();
    const start  = Date.now();
    try {
      const res = await _origFetch.apply(this, arguments);
      addLog({
        id: nid(), method, url, status: res.status,
        type: (res.headers.get('content-type') || '').split(';')[0] || '—',
        ts: Date.now(), duration: Date.now() - start,
        size: res.headers.get('content-length') || '?', src: 'fetch',
      });
      return res;
    } catch (e) {
      addLog({ id: nid(), method, url, status: 0, type: 'error', ts: Date.now(), duration: Date.now() - start, size: '?', src: 'fetch' });
      throw e;
    }
  };

  // ─── Styles ──────────────────────────────────────────────────────────────────
  GM_addStyle(`
    @import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500;600;700&display=swap');

    :root {
      --dp-bg:      #09090b;
      --dp-surface: #0f0f11;
      --dp-border:  #27272a;
      --dp-border2: #3f3f46;
      --dp-text:    #fafafa;
      --dp-muted:   #71717a;
      --dp-muted2:  #52525b;
      --dp-dim:     #18181b;
      --dp-hover:   #1c1c1f;
      --dp-ok:      #4ade80;
      --dp-err:     #f87171;
      --dp-warn:    #facc15;
      --dp-info:    #60a5fa;
      --dp-font:    'Geist Mono','JetBrains Mono',monospace;
      --dp-r:       6px;
      --dp-shadow:  0 0 0 1px #27272a, 0 20px 60px rgba(0,0,0,0.95);
    }

    #dp-fab {
      position: fixed; bottom: 20px; left: 20px; z-index: 2147483647;
      width: 40px; height: 40px; border-radius: var(--dp-r);
      background: var(--dp-text); color: var(--dp-bg); border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 12px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.1);
      transition: transform .15s, box-shadow .15s;
      font-family: var(--dp-font); font-size: 14px; font-weight: 700;
      -webkit-tap-highlight-color: transparent; user-select: none;
    }
    #dp-fab:hover  { transform: scale(1.06); box-shadow: 0 4px 20px rgba(0,0,0,0.8); }
    #dp-fab:active { transform: scale(0.96); }

    #dp-panel {
      position: fixed; z-index: 2147483646;
      background: var(--dp-bg); border: 1px solid var(--dp-border);
      border-radius: 10px; display: flex; flex-direction: column;
      box-shadow: var(--dp-shadow); font-family: var(--dp-font);
      transform: scale(0.96) translateY(8px); opacity: 0; pointer-events: none;
      transform-origin: bottom left; overflow: hidden;
      transition: transform .2s cubic-bezier(.34,1.3,.64,1), opacity .15s ease;
      min-width: 400px; min-height: 280px;
    }
    #dp-panel.open         { transform: none; opacity: 1; pointer-events: all; }
    #dp-panel.resizing     { transition: none; user-select: none; }
    #dp-panel.dp-maximized { border-radius: 0; }

    .dp-rz {
      position: absolute; z-index: 20; background: transparent;
    }
    .dp-rz-n  { top:-3px;   left:10px;  right:10px;  height:7px;  cursor:n-resize;  }
    .dp-rz-s  { bottom:-3px;left:10px;  right:10px;  height:7px;  cursor:s-resize;  }
    .dp-rz-e  { right:-3px; top:10px;   bottom:10px; width:7px;   cursor:e-resize;  }
    .dp-rz-w  { left:-3px;  top:10px;   bottom:10px; width:7px;   cursor:w-resize;  }
    .dp-rz-ne { top:-3px;   right:-3px; width:12px;  height:12px; cursor:ne-resize; }
    .dp-rz-nw { top:-3px;   left:-3px;  width:12px;  height:12px; cursor:nw-resize; }
    .dp-rz-se { bottom:-3px;right:-3px; width:14px;  height:14px; cursor:se-resize; z-index:21; }
    .dp-rz-sw { bottom:-3px;left:-3px;  width:12px;  height:12px; cursor:sw-resize; }
    .dp-rz-se::after {
      content:'';position:absolute;bottom:4px;right:4px;
      width:8px;height:8px;
      border-right:2px solid var(--dp-border2);
      border-bottom:2px solid var(--dp-border2);
      border-radius:1px; opacity:.6;
    }

    #dp-titlebar {
      display:flex; align-items:center;
      padding:0 14px; height:42px; flex-shrink:0;
      border-bottom:1px solid var(--dp-border);
      background:var(--dp-surface);
      cursor:move; user-select:none;
    }
    .dp-dots { display:flex; gap:6px; flex-shrink:0; }
    .dp-dot  { width:11px; height:11px; border-radius:50%; border:1px solid rgba(255,255,255,0.08); }
    .dp-dot-r{ background:#ff5f57; } .dp-dot-y{ background:#febc2e; } .dp-dot-g{ background:#28c840; }
    #dp-title {
      font-size:11px; font-weight:500; color:var(--dp-muted);
      letter-spacing:.04em; flex:1; padding-left:10px; pointer-events:none;
    }
    .dp-close {
      background:none; border:none; color:var(--dp-muted2); cursor:pointer;
      font-size:14px; padding:4px 6px; border-radius:4px; line-height:1;
      transition:color .1s,background .1s; font-family:var(--dp-font);
      -webkit-tap-highlight-color:transparent;
    }
    .dp-close:hover { color:var(--dp-text); background:var(--dp-hover); }

    #dp-tabs {
      display:flex; gap:0; border-bottom:1px solid var(--dp-border);
      flex-shrink:0; background:var(--dp-surface); padding:0 10px;
    }
    .dp-tab {
      padding:9px 14px; font-size:11px; font-weight:500;
      font-family:var(--dp-font); border:none; background:none;
      color:var(--dp-muted); cursor:pointer; letter-spacing:.04em;
      border-bottom:2px solid transparent; margin-bottom:-1px;
      transition:color .12s, border-color .12s;
      -webkit-tap-highlight-color:transparent;
    }
    .dp-tab:hover { color:var(--dp-text); }
    .dp-tab.active { color:var(--dp-text); border-bottom-color:var(--dp-text); }

    #dp-executor, #dp-logger { display:none; flex:1; flex-direction:column; overflow:hidden; min-height:0; }
    #dp-executor.active, #dp-logger.active { display:flex; }

    #dp-exec-tabs-bar {
      display:flex; align-items:center;
      border-bottom:1px solid var(--dp-border);
      background:var(--dp-surface); flex-shrink:0;
      overflow-x:auto; scrollbar-width:none; gap:0;
    }
    #dp-exec-tabs-bar::-webkit-scrollbar { display:none; }
    .dp-exec-tab {
      display:flex; align-items:center; gap:6px;
      padding:6px 12px 6px 14px; font-size:10px; font-weight:500;
      font-family:var(--dp-font); border:none;
      border-right:1px solid var(--dp-border);
      background:none; color:var(--dp-muted); cursor:pointer;
      letter-spacing:.03em; white-space:nowrap;
      transition:color .1s, background .1s; position:relative;
      min-width:80px;
    }
    .dp-exec-tab:hover { color:var(--dp-text); background:var(--dp-hover); }
    .dp-exec-tab.active { color:var(--dp-text); background:var(--dp-bg); }
    .dp-exec-tab.active::after {
      content:''; position:absolute; bottom:0; left:0; right:0; height:2px;
      background:var(--dp-text);
    }
    .dp-exec-tab-close {
      display:inline-flex; align-items:center; justify-content:center;
      width:14px; height:14px; border-radius:3px;
      font-size:10px; line-height:1; color:var(--dp-muted2);
      transition:color .1s, background .1s;
      border:none; background:none; cursor:pointer; padding:0;
      font-family:var(--dp-font);
    }
    .dp-exec-tab-close:hover { color:var(--dp-text); background:var(--dp-border); }
    #dp-new-tab-btn {
      padding:6px 12px; font-size:16px; line-height:1; color:var(--dp-muted2);
      background:none; border:none; cursor:pointer; flex-shrink:0;
      transition:color .1s; font-family:var(--dp-font);
    }
    #dp-new-tab-btn:hover { color:var(--dp-text); }

    #dp-exec-toolbar {
      display:flex; align-items:center; gap:6px; padding:6px 12px;
      border-bottom:1px solid var(--dp-border);
      background:var(--dp-surface); flex-shrink:0;
    }
    .dp-badge {
      font-size:9px; font-weight:600; letter-spacing:.08em;
      padding:2px 7px; border-radius:3px;
      border:1px solid var(--dp-border2);
      color:var(--dp-muted); background:var(--dp-dim);
    }
    #dp-exec-actions { margin-left:auto; display:flex; gap:6px; }

    .dp-btn {
      font-family:var(--dp-font); font-size:10px; font-weight:600;
      letter-spacing:.05em; padding:4px 12px; border-radius:var(--dp-r);
      cursor:pointer; transition:all .12s; border:1px solid;
      -webkit-tap-highlight-color:transparent;
    }
    .dp-btn-ghost {
      background:transparent; border-color:var(--dp-border2); color:var(--dp-muted);
    }
    .dp-btn-ghost:hover { border-color:var(--dp-text); color:var(--dp-text); background:var(--dp-hover); }
    .dp-btn-primary {
      background:var(--dp-text); border-color:var(--dp-text); color:var(--dp-bg);
    }
    .dp-btn-primary:hover  { background:#e4e4e7; border-color:#e4e4e7; }
    .dp-btn-primary:active { background:#d4d4d8; }

    #dp-editor-area {
      display:flex; flex:1; overflow:hidden; min-height:0;
    }
    #dp-gutter {
      width:44px; flex-shrink:0; background:var(--dp-surface);
      border-right:1px solid var(--dp-border);
      padding:14px 0; overflow:hidden; user-select:none;
    }
    .dp-lnum {
      display:block; font-family:var(--dp-font); font-size:11px;
      color:var(--dp-muted2); line-height:1.7;
      text-align:right; padding-right:10px;
    }
    #dp-textarea {
      flex:1; background:var(--dp-bg); color:var(--dp-text);
      border:none; outline:none; resize:none;
      font-family:var(--dp-font); font-size:12.5px; line-height:1.7;
      padding:14px 16px; tab-size:2; caret-color:var(--dp-text);
      box-sizing:border-box;
    }
    #dp-textarea::selection { background:rgba(255,255,255,0.15); }
    #dp-textarea::placeholder { color:var(--dp-muted2); }

    /* ── Output pane ── */
    #dp-output-wrap {
      flex-shrink:0; display:flex; flex-direction:column;
      border-top:1px solid var(--dp-border);
      position:relative;
    }
    #dp-output-splitter {
      position:absolute; top:-4px; left:0; right:0; height:8px;
      cursor:ns-resize; z-index:10; background:transparent;
    }
    #dp-output-splitter:hover,
    #dp-output-splitter.active { background:rgba(255,255,255,0.06); }
    #dp-output-header {
      display:flex; align-items:center; gap:8px; padding:5px 12px;
      border-bottom:1px solid var(--dp-border);
      background:var(--dp-surface); flex-shrink:0;
    }
    #dp-output-title { font-size:10px; font-weight:600; color:var(--dp-muted); letter-spacing:.06em; }
    #dp-copy-output {
      margin-left:auto; background:none; border:none; color:var(--dp-muted2);
      cursor:pointer; font-size:12px; padding:2px 5px; border-radius:3px;
      font-family:var(--dp-font); transition:color .1s,background .1s;
    }
    #dp-copy-output:hover { color:var(--dp-text); background:var(--dp-hover); }
    #dp-output {
      flex:1; overflow-y:auto; padding:6px 14px;
      scrollbar-width:thin; scrollbar-color:var(--dp-border2) transparent;
    }
    #dp-output::-webkit-scrollbar { width:4px; }
    #dp-output::-webkit-scrollbar-thumb { background:var(--dp-border2); border-radius:2px; }
    .dp-out-line {
      font-size:11.5px; line-height:1.65; padding:1px 0;
      font-family:var(--dp-font); word-break:break-all;
    }
    .dp-out-log   { color:var(--dp-text); }
    .dp-out-info  { color:var(--dp-info); }
    .dp-out-warn  { color:var(--dp-warn); }
    .dp-out-error { color:var(--dp-err); }
    .dp-out-ret   { color:var(--dp-muted); }
    .dp-out-ret::before { content:'← '; color:var(--dp-muted2); }
    .dp-out-ts    { color:var(--dp-muted2); margin-right:8px; font-size:10px; }

    /* ── Logger toolbar ── */
    #dp-log-toolbar {
      display:flex; align-items:center; gap:6px; flex-wrap:wrap;
      padding:7px 12px; border-bottom:1px solid var(--dp-border);
      background:var(--dp-surface); flex-shrink:0;
    }
    #dp-search-wrap { position:relative; flex:1; min-width:120px; }
    #dp-search-icon { position:absolute; left:9px; top:50%; transform:translateY(-50%); color:var(--dp-muted2); pointer-events:none; font-size:13px; }
    #dp-search {
      width:100%; background:var(--dp-dim); border:1px solid var(--dp-border);
      border-radius:var(--dp-r); color:var(--dp-text); font-family:var(--dp-font);
      font-size:11px; padding:5px 10px 5px 28px; outline:none;
      transition:border-color .12s; box-sizing:border-box;
    }
    #dp-search:focus { border-color:var(--dp-border2); }
    #dp-search::placeholder { color:var(--dp-muted2); }

    .dp-method-filter { display:flex; gap:3px; flex-wrap:wrap; }
    .dp-mf-btn {
      font-family:var(--dp-font); font-size:9px; font-weight:600; letter-spacing:.06em;
      padding:3px 8px; border-radius:4px; border:1px solid var(--dp-border);
      background:transparent; color:var(--dp-muted); cursor:pointer; transition:all .1s;
    }
    .dp-mf-btn:hover { border-color:var(--dp-border2); color:var(--dp-text); }
    .dp-mf-btn.active { background:var(--dp-text); border-color:var(--dp-text); color:var(--dp-bg); }
    #dp-log-count { font-size:10px; color:var(--dp-muted2); white-space:nowrap; font-weight:500; }

    /* ── Logger table ── */
    #dp-log-table-wrap {
      flex:1; overflow-y:auto; min-height:0;
      scrollbar-width:thin; scrollbar-color:var(--dp-border2) transparent;
    }
    #dp-log-table-wrap::-webkit-scrollbar { width:4px; }
    #dp-log-table-wrap::-webkit-scrollbar-thumb { background:var(--dp-border2); border-radius:2px; }

    #dp-log-table {
      width:100%; border-collapse:collapse;
      font-size:11px; font-family:var(--dp-font);
    }
    #dp-log-table thead th {
      position:sticky; top:0; background:var(--dp-surface);
      color:var(--dp-muted); font-weight:600; font-size:10px; letter-spacing:.06em;
      text-align:left; padding:6px 10px; border-bottom:1px solid var(--dp-border);
      user-select:none; white-space:nowrap;
    }
    #dp-log-table tbody tr.dp-log-row {
      border-bottom:1px solid rgba(39,39,42,0.5);
      transition:background .07s; cursor:pointer;
    }
    #dp-log-table tbody tr.dp-log-row:hover { background:var(--dp-hover); }
    #dp-log-table tbody td { padding:5px 10px; vertical-align:middle; max-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

    .dp-td-method { width:58px; }
    .dp-td-status { width:44px; }
    .dp-td-src    { width:44px; }
    .dp-td-vid    { width:30px; text-align:center; }
    .dp-td-url    { }
    .dp-td-dur    { width:60px; }
    .dp-td-time   { width:68px; }

    .dp-method {
      font-size:9px; font-weight:700; letter-spacing:.06em;
      padding:2px 5px; border-radius:3px; border:1px solid;
    }
    .dp-m-GET    { color:#86efac; border-color:rgba(134,239,172,.3); background:rgba(134,239,172,.07); }
    .dp-m-POST   { color:#93c5fd; border-color:rgba(147,197,253,.3); background:rgba(147,197,253,.07); }
    .dp-m-PUT    { color:#fcd34d; border-color:rgba(252,211,77,.3);  background:rgba(252,211,77,.07);  }
    .dp-m-DELETE { color:#f87171; border-color:rgba(248,113,113,.3); background:rgba(248,113,113,.07); }
    .dp-m-PATCH  { color:#c4b5fd; border-color:rgba(196,181,253,.3); background:rgba(196,181,253,.07); }
    .dp-m-OTHER  { color:var(--dp-muted); border-color:var(--dp-border); background:transparent; }

    .dp-status-ok   { color:var(--dp-ok); }
    .dp-status-redir{ color:var(--dp-info); }
    .dp-status-err  { color:var(--dp-err); }
    .dp-status-pend { color:var(--dp-muted); }

    .dp-dur { color:var(--dp-muted); }
    .dp-dur.fast   { color:#86efac; } .dp-dur.medium { color:#fcd34d; } .dp-dur.slow { color:#f87171; }
    .dp-src-badge { font-size:9px; color:var(--dp-muted2); border:1px solid var(--dp-border); padding:1px 5px; border-radius:3px; }

    .dp-vid-btn {
      font-size:9px; padding:2px 6px; border-radius:3px; cursor:pointer;
      font-family:var(--dp-font); font-weight:700; letter-spacing:.04em;
      background:rgba(74,222,128,0.1); border:1px solid rgba(74,222,128,0.25);
      color:var(--dp-ok); transition:all .1s; white-space:nowrap;
    }
    .dp-vid-btn:hover { background:rgba(74,222,128,0.2); }

    tr.dp-row-detail { background:var(--dp-dim); border-bottom:1px solid var(--dp-border); }
    tr.dp-row-detail td { padding:10px 14px; }
    .dp-detail-inner { display:flex; flex-direction:column; gap:6px; }
    .dp-detail-url { font-size:10.5px; color:var(--dp-text); word-break:break-all; line-height:1.6; }
    .dp-detail-meta { display:flex; gap:14px; flex-wrap:wrap; font-size:10px; color:var(--dp-muted); }
    .dp-detail-meta span b { color:var(--dp-text); font-weight:500; }
    .dp-detail-actions { display:flex; gap:6px; flex-wrap:wrap; }

    .dp-ytdlp-box {
      display:none; background:var(--dp-bg);
      border:1px solid rgba(74,222,128,0.2); border-radius:6px;
      padding:10px 12px; margin-top:4px;
    }
    .dp-ytdlp-box.show { display:block; }
    .dp-ytdlp-code {
      font-size:10px; color:var(--dp-ok); white-space:pre-wrap; word-break:break-all;
      line-height:1.7; margin-bottom:6px; font-family:var(--dp-font);
    }
    .dp-ytdlp-meta { font-size:9px; color:var(--dp-muted); margin-bottom:8px; }

    .dp-check-result {
      font-size:10px; font-family:var(--dp-font); padding:4px 0;
      display:none;
    }
    .dp-check-result.checking { display:block; color:var(--dp-muted); }
    .dp-check-result.ok       { display:block; color:var(--dp-ok); }
    .dp-check-result.err      { display:block; color:var(--dp-err); }
    .dp-check-result.warn     { display:block; color:var(--dp-warn); }

    .dp-empty { text-align:center; padding:40px 20px; color:var(--dp-muted2); font-size:11px; letter-spacing:.04em; }
    .dp-empty-icon { font-size:26px; display:block; margin-bottom:8px; opacity:.4; }

    #dp-toast {
      position:fixed; bottom:68px; left:20px;
      background:var(--dp-text); color:var(--dp-bg);
      font-family:var(--dp-font); font-size:11px; font-weight:600;
      padding:6px 14px; border-radius:var(--dp-r);
      z-index:2147483648; opacity:0; pointer-events:none;
      transform:translateY(4px); transition:all .18s ease;
    }
    #dp-toast.show { opacity:1; transform:none; }

    @media (max-width:600px) {
      #dp-panel { left:6px !important; right:6px !important; width:auto !important; bottom:16px !important; min-width:unset; }
      #dp-fab   { left:16px; bottom:16px; }
      .dp-td-dur, .dp-td-time, .dp-td-src { display:none; }
    }
  `);

  // ─── Build UI ─────────────────────────────────────────────────────────────────
  function buildUI() {
    const fab = document.createElement('button');
    fab.id    = 'dp-fab';
    fab.title = 'DevPanel';
    fab.textContent = '⌗';
    document.documentElement.appendChild(fab);
    fab.addEventListener('click', togglePanel);

    const toast = document.createElement('div');
    toast.id = 'dp-toast';
    document.documentElement.appendChild(toast);

    const panel = document.createElement('div');
    panel.id = 'dp-panel';
    panel.innerHTML = `
      <div class="dp-rz dp-rz-n"  data-rz="n"></div>
      <div class="dp-rz dp-rz-s"  data-rz="s"></div>
      <div class="dp-rz dp-rz-e"  data-rz="e"></div>
      <div class="dp-rz dp-rz-w"  data-rz="w"></div>
      <div class="dp-rz dp-rz-ne" data-rz="ne"></div>
      <div class="dp-rz dp-rz-nw" data-rz="nw"></div>
      <div class="dp-rz dp-rz-se" data-rz="se"></div>
      <div class="dp-rz dp-rz-sw" data-rz="sw"></div>

      <div id="dp-titlebar">
        <div class="dp-dots">
          <div class="dp-dot dp-dot-r"></div>
          <div class="dp-dot dp-dot-y"></div>
          <div class="dp-dot dp-dot-g"></div>
        </div>
        <span id="dp-title">devpanel · ${location.hostname}</span>
        <button class="dp-close" id="dp-close">✕</button>
      </div>

      <div id="dp-tabs">
        <button class="dp-tab active" data-tab="executor">Executor</button>
        <button class="dp-tab" data-tab="logger">Network</button>
      </div>

      <div id="dp-executor" class="active">
        <div id="dp-exec-tabs-bar">
          <button id="dp-new-tab-btn" title="New tab">+</button>
        </div>
        <div id="dp-exec-toolbar">
          <span class="dp-badge">JS</span>
          <span class="dp-badge">unsafeWindow</span>
          <span class="dp-badge">GM_xmlhttpRequest</span>
          <div id="dp-exec-actions">
            <button class="dp-btn dp-btn-ghost" id="dp-hist-prev" title="Prev history (Alt+↑)">↑</button>
            <button class="dp-btn dp-btn-ghost" id="dp-hist-next" title="Next history (Alt+↓)">↓</button>
            <button class="dp-btn dp-btn-ghost" id="dp-clear-code">Clear</button>
            <button class="dp-btn dp-btn-ghost" id="dp-clear-output" style="color:var(--dp-muted2)">Clear out</button>
            <button class="dp-btn dp-btn-primary" id="dp-run">▶ Run</button>
          </div>
        </div>
        <div id="dp-editor-area">
          <div id="dp-gutter"></div>
          <textarea id="dp-textarea" spellcheck="false"
            placeholder="// Full userscript-level access&#10;// unsafeWindow, GM_xmlhttpRequest, fetch, document…&#10;// Ctrl+Enter to run · Alt+↑↓ for history&#10;&#10;console.log(document.title)"></textarea>
        </div>
        <div id="dp-output-wrap">
          <div id="dp-output-splitter" title="Drag to resize output"></div>
          <div id="dp-output-header">
            <span id="dp-output-title">OUTPUT</span>
            <button id="dp-copy-output" title="Copy all output">⧉</button>
          </div>
          <div id="dp-output"></div>
        </div>
      </div>

      <div id="dp-logger">
        <div id="dp-log-toolbar">
          <div id="dp-search-wrap">
            <span id="dp-search-icon">⌕</span>
            <input id="dp-search" type="text" placeholder="Filter by URL, method, status, type…" autocomplete="off" spellcheck="false"/>
          </div>
          <div class="dp-method-filter">
            <button class="dp-mf-btn active" data-mf="ALL">ALL</button>
            <button class="dp-mf-btn" data-mf="GET">GET</button>
            <button class="dp-mf-btn" data-mf="POST">POST</button>
            <button class="dp-mf-btn" data-mf="XHR">XHR</button>
            <button class="dp-mf-btn" data-mf="VIDEO">VIDEO</button>
          </div>
          <span id="dp-log-count">0 reqs</span>
          <button class="dp-btn dp-btn-ghost" id="dp-export-log" style="padding:3px 8px;font-size:9px" title="Export logs as JSON">↓</button>
          <button class="dp-btn dp-btn-ghost" id="dp-clear-log" style="padding:3px 8px;font-size:9px">Clear</button>
        </div>
        <div id="dp-log-table-wrap">
          <table id="dp-log-table">
            <thead>
              <tr>
                <th class="dp-td-method">Method</th>
                <th class="dp-td-status">Status</th>
                <th class="dp-td-src">Src</th>
                <th class="dp-td-vid">▼</th>
                <th class="dp-td-url">URL</th>
                <th class="dp-td-dur">ms</th>
                <th class="dp-td-time">Time</th>
              </tr>
            </thead>
            <tbody id="dp-log-tbody"></tbody>
          </table>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    applyPanelGeometry();
    setupResizeDrag(panel);

    // ── Maximize/restore on titlebar double-click ──
    let prevGeom = null;
    panel.querySelector('#dp-titlebar').addEventListener('dblclick', () => {
      if (panel.classList.contains('dp-maximized')) {
        if (prevGeom) {
          state.panelW = prevGeom.w; state.panelH = prevGeom.h;
          state.panelL = prevGeom.l; state.panelB = prevGeom.b;
        }
        panel.classList.remove('dp-maximized');
      } else {
        prevGeom = { w: state.panelW, h: state.panelH, l: state.panelL, b: state.panelB };
        state.panelL = 0; state.panelB = 0;
        state.panelW = window.innerWidth;
        state.panelH = window.innerHeight;
        panel.classList.add('dp-maximized');
      }
      applyPanelGeometry();
      saveState();
    });

    // ── Output pane resizing ──
    (function setupOutputResize() {
      const splitter = document.getElementById('dp-output-splitter');
      const wrap = document.getElementById('dp-output-wrap');
      if (!splitter || !wrap) return;
      let sy = 0, sh = 0;
      const onMove = (e) => {
        const dy = e.clientY - sy;
        const ph = document.getElementById('dp-panel');
        const avail = (ph ? ph.offsetHeight : 600) - 200; // leave room for toolbar etc
        const nh = Math.max(60, Math.min(avail, sh - dy));
        wrap.style.height = nh + 'px';
        state.outH = nh;
      };
      const onUp = () => {
        splitter.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        saveState();
      };
      splitter.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        sy = e.clientY;
        sh = wrap.offsetHeight;
        splitter.classList.add('active');
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
      });
    })();

    // Close
    panel.querySelector('#dp-close').addEventListener('click', () => setOpen(false));

    // Main tabs
    panel.querySelectorAll('.dp-tab').forEach(b =>
      b.addEventListener('click', () => switchMainTab(b.dataset.tab))
    );

    // Keyboard shortcuts for main tabs
    document.addEventListener('keydown', (e) => {
      if (!state.open) return;
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const tabs = ['executor', 'logger'];
        const idx = tabs.indexOf(state.tab);
        switchMainTab(e.shiftKey ? tabs[(idx - 1 + tabs.length) % tabs.length] : tabs[(idx + 1) % tabs.length]);
      }
    });

    // Executor
    panel.querySelector('#dp-run').addEventListener('click', runCode);
    panel.querySelector('#dp-clear-code').addEventListener('click', () => {
      const ta = document.getElementById('dp-textarea');
      if (ta) { ta.value = ''; getActiveExecTab().code = ''; updateGutter(); saveState(); }
    });
    panel.querySelector('#dp-clear-output').addEventListener('click', () => {
      const out = document.getElementById('dp-output');
      if (out) out.innerHTML = '';
    });
    panel.querySelector('#dp-copy-output').addEventListener('click', () => {
      const out = document.getElementById('dp-output');
      if (!out) return;
      const text = Array.from(out.querySelectorAll('.dp-out-line'))
        .map(el => el.textContent.replace(/^\d{2}:\d{2}:\d{2}\s*/, ''))
        .join('\n');
      if (text) { GM_setClipboard(text); showToast('Output copied'); }
    });
    panel.querySelector('#dp-hist-prev').addEventListener('click', histPrev);
    panel.querySelector('#dp-hist-next').addEventListener('click', histNext);
    panel.querySelector('#dp-new-tab-btn').addEventListener('click', () => { newExecTab(); saveState(); });

    const ta = panel.querySelector('#dp-textarea');
    ta.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, en = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
        ta.selectionStart = ta.selectionEnd = s + 2;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCode(); }
      if (e.altKey && e.key === 'ArrowUp')   { e.preventDefault(); histPrev(); }
      if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); histNext(); }
    });
    ta.addEventListener('input', () => { getActiveExecTab().code = ta.value; updateGutter(); saveState(); });
    ta.addEventListener('scroll', () => {
      const g = document.getElementById('dp-gutter');
      if (g) g.scrollTop = ta.scrollTop;
    });

    // Logger
    panel.querySelector('#dp-search').addEventListener('input', e => {
      state.filter = e.target.value;
      renderLoggerFull();
    });
    panel.querySelector('#dp-clear-log').addEventListener('click', () => {
      state.logs = [];
      _detailOpen.clear();
      renderLoggerFull();
    });
    panel.querySelector('#dp-export-log').addEventListener('click', () => {
      const json = JSON.stringify(state.logs, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `devpanel-logs-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      showToast('Logs exported');
    });
    panel.querySelectorAll('.dp-mf-btn').forEach(b => {
      b.addEventListener('click', () => {
        panel.querySelectorAll('.dp-mf-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.methodFilter = b.dataset.mf;
        renderLoggerFull();
      });
    });

    renderExecTabs();
    updateGutter();

    // Restore output height
    const ow = document.getElementById('dp-output-wrap');
    if (ow) ow.style.height = state.outH + 'px';

    // Open panel if it was open
    if (saved?.open) {
      setOpen(true);
      if (saved.tab !== 'executor') switchMainTab(saved.tab);
    }
  }

  // ─── Panel geometry ───────────────────────────────────────────────────────────
  function applyPanelGeometry() {
    const p = document.getElementById('dp-panel');
    if (!p) return;
    const maxW = window.innerWidth  - state.panelL - 10;
    const maxH = window.innerHeight - state.panelB - 10;
    const w = Math.min(state.panelW, maxW);
    const h = Math.min(state.panelH, maxH);
    const l = Math.max(0, Math.min(state.panelL, window.innerWidth  - w));
    const b = Math.max(0, Math.min(state.panelB, window.innerHeight - h));
    p.style.width  = w + 'px';
    p.style.height = h + 'px';
    p.style.left   = l + 'px';
    p.style.bottom = b + 'px';
  }

  // ─── Resize & drag ────────────────────────────────────────────────────────────
  function setupResizeDrag(panel) {
    let mode = null, startX = 0, startY = 0, startW = 0, startH = 0, startL = 0, startB = 0;
    const MIN_W = 400, MIN_H = 280;

    const onDown = (e, m) => {
      if (e.button !== 0) return;
      mode   = m;
      startX = e.clientX; startY = e.clientY;
      startW = panel.offsetWidth;  startH = panel.offsetHeight;
      startL = panel.offsetLeft;
      startB = parseInt(panel.style.bottom) || state.panelB;
      panel.classList.add('resizing');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    };

    const onMove = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let w = startW, h = startH, l = startL, b = startB;

      if (mode === 'drag') {
        l = startL + dx;
        b = startB - dy;
      } else {
        if (mode.includes('e')) w = Math.max(MIN_W, startW + dx);
        if (mode.includes('w')) { w = Math.max(MIN_W, startW - dx); l = startL + (startW - w); }
        if (mode.includes('s')) h = Math.max(MIN_H, startH + dy);
        if (mode.includes('n')) { h = Math.max(MIN_H, startH - dy); b = startB + (startH - h); }
      }

      l = Math.max(0, Math.min(l, window.innerWidth  - w));
      b = Math.max(0, Math.min(b, window.innerHeight - h));

      panel.style.width  = w + 'px';
      panel.style.height = h + 'px';
      panel.style.left   = l + 'px';
      panel.style.bottom = b + 'px';

      state.panelW = w; state.panelH = h;
      state.panelL = l; state.panelB = b;
    };

    const onUp = () => {
      mode = null;
      panel.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveState();
    };

    panel.querySelectorAll('.dp-rz').forEach(el => {
      el.addEventListener('mousedown', e => onDown(e, el.dataset.rz));
    });

    const titlebar = panel.querySelector('#dp-titlebar');
    titlebar.addEventListener('mousedown', e => {
      if (e.target.classList.contains('dp-close')) return;
      onDown(e, 'drag');
    });

    let touchStartX = 0, touchStartY = 0, touchL = 0, touchB = 0;
    titlebar.addEventListener('touchstart', e => {
      const t = e.touches[0];
      touchStartX = t.clientX; touchStartY = t.clientY;
      touchL = panel.offsetLeft;
      touchB = parseInt(panel.style.bottom) || state.panelB;
    }, { passive: true });
    titlebar.addEventListener('touchmove', e => {
      const t = e.touches[0];
      const l = Math.max(0, touchL + (t.clientX - touchStartX));
      const b = Math.max(0, touchB - (t.clientY - touchStartY));
      panel.style.left   = Math.min(l, window.innerWidth  - panel.offsetWidth)  + 'px';
      panel.style.bottom = Math.min(b, window.innerHeight - panel.offsetHeight) + 'px';
      state.panelL = parseInt(panel.style.left) || 0;
      state.panelB = parseInt(panel.style.bottom) || 0;
    }, { passive: true });
    titlebar.addEventListener('touchend', () => { saveState(); }, { passive: true });
  }

  // ─── Exec tabs ───────────────────────────────────────────────────────────────
  function getActiveExecTab() {
    return state.execTabs.find(t => t.id === state.activeExecTab) || state.execTabs[0];
  }

  function renderExecTabs() {
    const bar = document.getElementById('dp-exec-tabs-bar');
    if (!bar) return;
    const plusBtn = bar.querySelector('#dp-new-tab-btn');
    bar.querySelectorAll('.dp-exec-tab').forEach(el => el.remove());

    state.execTabs.forEach(tab => {
      const btn = document.createElement('button');
      btn.className = 'dp-exec-tab' + (tab.id === state.activeExecTab ? ' active' : '');
      btn.dataset.tabId = tab.id;
      btn.innerHTML = `<span class="dp-exec-tab-label">${escHtml(tab.title)}</span>${
        state.execTabs.length > 1
          ? `<span class="dp-exec-tab-close" data-close="${tab.id}">✕</span>`
          : ''
      }`;
      btn.addEventListener('click', e => {
        if (e.target.dataset.close) return;
        switchExecTab(tab.id);
      });
      const closeEl = btn.querySelector('[data-close]');
      if (closeEl) closeEl.addEventListener('click', e => { e.stopPropagation(); closeExecTab(tab.id); saveState(); });
      bar.insertBefore(btn, plusBtn);
    });
  }

  function switchExecTab(id) {
    const cur = getActiveExecTab();
    const ta  = document.getElementById('dp-textarea');
    if (ta && cur) cur.code = ta.value;

    state.activeExecTab = id;
    const next = getActiveExecTab();
    if (ta && next) { ta.value = next.code || ''; updateGutter(); }
    renderExecTabs();
    saveState();
  }

  function newExecTab() {
    const id   = ++state.execTabId;
    const tab  = { id, title: `Tab ${id}`, code: '' };
    state.execTabs.push(tab);
    switchExecTab(id);
  }

  function closeExecTab(id) {
    if (state.execTabs.length <= 1) return;
    const idx  = state.execTabs.findIndex(t => t.id === id);
    state.execTabs.splice(idx, 1);
    if (state.activeExecTab === id) {
      const next = state.execTabs[Math.min(idx, state.execTabs.length - 1)];
      state.activeExecTab = next.id;
      const ta = document.getElementById('dp-textarea');
      if (ta) { ta.value = next.code || ''; updateGutter(); }
    }
    renderExecTabs();
    saveState();
  }

  // ─── Gutter ──────────────────────────────────────────────────────────────────
  function updateGutter() {
    const ta = document.getElementById('dp-textarea');
    const g  = document.getElementById('dp-gutter');
    if (!ta || !g) return;
    const lines = ta.value.split('\n').length;
    let html = '';
    for (let i = 1; i <= Math.max(lines, 1); i++) html += `<span class="dp-lnum">${i}</span>`;
    g.innerHTML = html;
  }

  // ─── Code execution (userscript-level scope) ─────────────────────────────────
  function runCode() {
    const ta   = document.getElementById('dp-textarea');
    const code = ta?.value?.trim();
    if (!code) return;

    if (state.history[0] !== code) { state.history.unshift(code); if (state.history.length > 50) state.history.pop(); }
    state.histIdx = -1;
    saveState();

    const captured = [];
    const ts = () => new Date().toLocaleTimeString([], { hour12: false });

    const fakeConsole = {
      log:   (...a) => { captured.push({ level:'log',   text: a.map(safeStr).join(' '), t: ts() }); unsafeWindow.console.log?.(...a); },
      info:  (...a) => { captured.push({ level:'info',  text: a.map(safeStr).join(' '), t: ts() }); unsafeWindow.console.info?.(...a); },
      warn:  (...a) => { captured.push({ level:'warn',  text: a.map(safeStr).join(' '), t: ts() }); unsafeWindow.console.warn?.(...a); },
      error: (...a) => { captured.push({ level:'error', text: a.map(safeStr).join(' '), t: ts() }); unsafeWindow.console.error?.(...a); },
      dir:   (...a) => { captured.push({ level:'log',   text: a.map(safeStr).join(' '), t: ts() }); },
      __ret: (v)    => { captured.push({ level:'ret',   text: safeStr(v), t: ts() }); },
    };

    try {
      const fn = new Function(
        'console', 'window', 'unsafeWindow', 'GM_xmlhttpRequest', 'GM_setClipboard', 'fetch', '__ret',
        `"use strict";
        try {
          const __r = (function() {
            ${code}
          })();
          if (typeof __r !== 'undefined') __ret(__r);
        } catch(e) { console.error(e.message || String(e)); }`
      );
      fn(fakeConsole, unsafeWindow, unsafeWindow, GM_xmlhttpRequest, GM_setClipboard, _origFetch, fakeConsole.__ret);
    } catch (e) {
      captured.push({ level: 'error', text: e.message || String(e), t: ts() });
    }

    const out = document.getElementById('dp-output');
    if (!out) return;
    if (captured.length === 0) {
      captured.push({ level: 'ret', text: 'undefined', t: ts() });
    }
    captured.forEach(({ level, text, t }) => {
      const line = document.createElement('div');
      line.className = `dp-out-line dp-out-${level}`;
      line.innerHTML = `<span class="dp-out-ts">${t}</span>${escHtml(text)}`;
      out.appendChild(line);
    });
    out.scrollTop = out.scrollHeight;
  }

  // ─── History ─────────────────────────────────────────────────────────────────
  function histPrev() {
    if (!state.history.length) return;
    state.histIdx = Math.min(state.histIdx + 1, state.history.length - 1);
    const ta = document.getElementById('dp-textarea');
    if (ta) { ta.value = state.history[state.histIdx]; getActiveExecTab().code = ta.value; updateGutter(); }
  }
  function histNext() {
    state.histIdx = Math.max(state.histIdx - 1, -1);
    const ta = document.getElementById('dp-textarea');
    if (ta) { ta.value = state.histIdx === -1 ? '' : state.history[state.histIdx]; getActiveExecTab().code = ta.value; updateGutter(); }
  }

  // ─── Logger: full re-render ──────────────────────────────────────────────────
  function renderLoggerFull() {
    const tbody = document.getElementById('dp-log-tbody');
    const count = document.getElementById('dp-log-count');
    if (!tbody) return;

    const logs = filteredLogs();
    if (count) count.textContent = `${logs.length} req${logs.length !== 1 ? 's' : ''}`;

    tbody.innerHTML = '';

    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="dp-empty"><span class="dp-empty-icon">◎</span>No requests matched.</div></td></tr>`;
      return;
    }

    logs.forEach(log => {
      const row = buildLogRow(log);
      tbody.appendChild(row);
      if (_detailOpen.has(log.id)) {
        const detail = buildDetailRow(log);
        tbody.appendChild(detail);
      }
    });
  }

  // ─── Logger: prepend single new row ──────────────────────────────────────────
  function prependLogRow(log) {
    const tbody = document.getElementById('dp-log-tbody');
    const count = document.getElementById('dp-log-count');
    if (!tbody) return;

    const empty = tbody.querySelector('td[colspan]');
    if (empty) tbody.innerHTML = '';

    if (!matchesFilter(log)) {
      if (count) count.textContent = `${filteredLogs().length} req${filteredLogs().length !== 1 ? 's' : ''}`;
      return;
    }

    const row = buildLogRow(log);
    tbody.insertBefore(row, tbody.firstChild);
    if (count) count.textContent = `${filteredLogs().length} req${filteredLogs().length !== 1 ? 's' : ''}`;
  }

  // ─── Filter helpers ───────────────────────────────────────────────────────────
  function matchesFilter(log) {
    const q   = state.filter.toLowerCase().trim();
    const mf  = state.methodFilter || 'ALL';
    const isV = VIDEO_EXT.test(log.url);
    const matchQ  = !q || log.url.toLowerCase().includes(q) || String(log.status).includes(q)
                    || log.method.toLowerCase().includes(q) || log.type.toLowerCase().includes(q);
    const matchMF = mf === 'ALL'   ? true
                  : mf === 'XHR'   ? log.src === 'XHR'
                  : mf === 'VIDEO' ? isV
                  : log.method === mf;
    return matchQ && matchMF;
  }

  function filteredLogs() {
    return state.logs.filter(matchesFilter);
  }

  // ─── Build a log row <tr> ────────────────────────────────────────────────────
  function buildLogRow(log) {
    const isVideo = VIDEO_EXT.test(log.url);
    const mKey    = ['GET','POST','PUT','DELETE','PATCH'].includes(log.method) ? log.method : 'OTHER';
    const mCls    = `dp-m-${mKey}`;
    const sCls    = log.status >= 200 && log.status < 300 ? 'dp-status-ok'
                  : log.status >= 300 && log.status < 400 ? 'dp-status-redir'
                  : log.status >= 400 ? 'dp-status-err' : 'dp-status-pend';
    const durCls  = log.duration < 100 ? 'fast' : log.duration < 500 ? 'medium' : 'slow';
    const time    = new Date(log.ts).toLocaleTimeString([], { hour12: false });
    const urlShort = (() => {
      try {
        const u = new URL(log.url);
        const p = u.pathname + (u.search ? u.search.slice(0, 22) + (u.search.length > 22 ? '…' : '') : '');
        return p;
      } catch { return log.url.slice(0, 50); }
    })();

    const row = document.createElement('tr');
    row.className   = 'dp-log-row';
    row.dataset.lid = log.id;
    row.innerHTML = `
      <td class="dp-td-method"><span class="dp-method ${mCls}">${log.method}</span></td>
      <td class="dp-td-status ${sCls}">${log.status || '—'}</td>
      <td class="dp-td-src"><span class="dp-src-badge">${log.src}</span></td>
      <td class="dp-td-vid">${isVideo ? `<button class="dp-vid-btn" title="yt-dlp command">▼</button>` : ''}</td>
      <td class="dp-td-url" title="${escHtml(log.url)}">${escHtml(urlShort)}</td>
      <td class="dp-td-dur"><span class="dp-dur ${durCls}">${log.duration}ms</span></td>
      <td class="dp-td-time">${time}</td>
    `;

    if (isVideo) {
      row.querySelector('.dp-vid-btn').addEventListener('click', e => {
        e.stopPropagation();
        toggleDetail(log, row);
        setTimeout(() => {
          const box = document.querySelector(`.dp-ytdlp-box[data-for-vid="${log.id}"]`);
          if (box && !box.classList.contains('show')) box.classList.add('show');
        }, 10);
      });
    }

    row.addEventListener('click', () => toggleDetail(log, row));
    return row;
  }

  // ─── Build a detail <tr> ─────────────────────────────────────────────────────
  function buildDetailRow(log) {
    const isVideo = VIDEO_EXT.test(log.url);
    const cmd     = isVideo ? buildYtdlpCmd(log.url) : '';
    const cookies = getSiteCookies();
    const cookieCnt = cookies ? cookies.split(';').length : 0;

    const detail = document.createElement('tr');
    detail.className   = 'dp-row-detail';
    detail.dataset.forLog = String(log.id);
    detail.innerHTML = `
      <td colspan="7">
        <div class="dp-detail-inner">
          <div class="dp-detail-url">${escHtml(log.url)}</div>
          <div class="dp-detail-meta">
            <span>Method <b>${log.method}</b></span>
            <span>Status <b>${log.status || '—'}</b></span>
            <span>Type <b>${log.type}</b></span>
            <span>Duration <b>${log.duration}ms</b></span>
            <span>Size <b>${log.size}B</b></span>
            <span>Src <b>${log.src}</b></span>
          </div>
          <div class="dp-detail-actions">
            <button class="dp-btn dp-btn-ghost" style="font-size:9px;padding:3px 9px" data-act="copy-url">⧉ URL</button>
            <button class="dp-btn dp-btn-ghost" style="font-size:9px;padding:3px 9px" data-act="inject">→ Executor</button>
            ${isVideo ? `<button class="dp-btn dp-btn-ghost" style="font-size:9px;padding:3px 9px;color:var(--dp-ok);border-color:rgba(74,222,128,0.3)" data-act="ytdlp">▼ yt-dlp</button>` : ''}
            <button class="dp-btn dp-btn-ghost" style="font-size:9px;padding:3px 9px;color:var(--dp-info);border-color:rgba(96,165,250,0.3)" data-act="check">⬡ Check link</button>
          </div>
          ${isVideo ? `
          <div class="dp-ytdlp-box" data-for-vid="${log.id}">
            <div class="dp-ytdlp-code">${escHtml(cmd)}</div>
            <div class="dp-ytdlp-meta">${
              cookieCnt > 0
                ? `🍪 ${cookieCnt} cookie(s) from ${location.hostname} injected`
                : `⚠ No cookies found for ${location.hostname}`
            }</div>
            <div style="display:flex;gap:6px">
              <button class="dp-btn dp-btn-ghost" style="font-size:9px;padding:3px 9px" data-act="copy-cmd">⧉ Copy command</button>
              <button class="dp-btn dp-btn-ghost" style="font-size:9px;padding:3px 9px" data-act="copy-url-only">⧉ Copy URL</button>
            </div>
          </div>` : ''}
          <div class="dp-check-result" data-check-id="${log.id}"></div>
        </div>
      </td>`;

    detail.querySelector('[data-act="copy-url"]')?.addEventListener('click', () => { GM_setClipboard(log.url); showToast('URL copied'); });
    detail.querySelector('[data-act="inject"]')?.addEventListener('click', () => {
      const code = `fetch("${log.url}", { method: "${log.method}" })\n  .then(r => r.json())\n  .then(d => console.log(d))\n  .catch(e => console.error(e));`;
      const ta = document.getElementById('dp-textarea');
      if (ta) { ta.value = code; getActiveExecTab().code = code; updateGutter(); switchMainTab('executor'); }
    });
    detail.querySelector('[data-act="ytdlp"]')?.addEventListener('click', () => {
      const box = detail.querySelector(`.dp-ytdlp-box[data-for-vid="${log.id}"]`);
      if (box) box.classList.toggle('show');
    });
    detail.querySelector('[data-act="copy-cmd"]')?.addEventListener('click', () => { GM_setClipboard(cmd); showToast('Command copied!'); });
    detail.querySelector('[data-act="copy-url-only"]')?.addEventListener('click', () => { GM_setClipboard(log.url); showToast('URL copied'); });
    detail.querySelector('[data-act="check"]')?.addEventListener('click', () => checkLink(log.url, log.id));

    return detail;
  }

  // ─── Toggle detail ───────────────────────────────────────────────────────────
  function toggleDetail(log, row) {
    const tbody = document.getElementById('dp-log-tbody');
    if (!tbody) return;

    const existing = tbody.querySelector(`.dp-row-detail[data-for-log="${log.id}"]`);
    if (existing) {
      const isHidden = existing.style.display === 'none';
      existing.style.display = isHidden ? '' : 'none';
      if (isHidden) _detailOpen.add(log.id);
      else          _detailOpen.delete(log.id);
    } else {
      const detail = buildDetailRow(log);
      row.insertAdjacentElement('afterend', detail);
      _detailOpen.add(log.id);
    }
  }

  // ─── Link checker ────────────────────────────────────────────────────────────
  function checkLink(url, logId) {
    const el = document.querySelector(`.dp-check-result[data-check-id="${logId}"]`);
    if (!el) return;
    el.className  = 'dp-check-result checking';
    el.textContent = '⟳ Checking…';

    GM_xmlhttpRequest({
      method: 'HEAD',
      url,
      headers: {
        'Referer':        location.href,
        'Origin':         location.origin,
        'User-Agent':     navigator.userAgent,
      },
      onload(res) {
        const ct = (res.responseHeaders?.match(/content-type:\s*([^\r\n]+)/i)?.[1] || '').trim() || '—';
        const cl = res.responseHeaders?.match(/content-length:\s*(\d+)/i)?.[1];
        if (res.status >= 200 && res.status < 400) {
          el.className  = 'dp-check-result ok';
          el.textContent = `✓ ${res.status} OK — ${ct}${cl ? ' · ' + formatBytes(+cl) : ''}`;
        } else {
          el.className  = 'dp-check-result err';
          el.textContent = `✗ HTTP ${res.status} ${ct !== '—' ? '— ' + ct : ''}`;
        }
      },
      onerror()   { el.className = 'dp-check-result err';  el.textContent = '✗ Network error (CORS or DNS)'; },
      ontimeout() { el.className = 'dp-check-result warn'; el.textContent = '⏱ Timeout'; },
      timeout: 12000,
    });
  }

  // ─── Panel / tab ─────────────────────────────────────────────────────────────
  function togglePanel() { setOpen(!state.open); }
  function setOpen(v) {
    state.open = v;
    document.getElementById('dp-panel').classList.toggle('open', v);
    if (v && state.tab === 'logger') renderLoggerFull();
    saveState();
  }
  function switchMainTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.dp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('dp-executor').classList.toggle('active', tab === 'executor');
    document.getElementById('dp-logger').classList.toggle('active', tab === 'logger');
    if (tab === 'logger') renderLoggerFull();
  }

  // ─── Toast ────────────────────────────────────────────────────────────────────
  let _tt;
  function showToast(msg) {
    const t = document.getElementById('dp-toast');
    if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(_tt); _tt = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function safeStr(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }
  function formatBytes(n) {
    if (!n || isNaN(n)) return '?';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildUI);
  else buildUI();

})();
