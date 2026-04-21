// ==UserScript==
// @name         rvzs — DevPanel
// @namespace    https://github.com/Celesth/rvzs
// @version      1.0.0
// @description  Code executor + filtered request logger with shadcn B&W aesthetic
// @author       Celesth
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-start
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────────
  const state = {
    open:    false,
    tab:     'executor',
    logs:    [],        // { id, method, url, status, type, ts, duration, size, headers }
    filter:  '',
    logId:   0,
    history: [],        // code history
    histIdx: -1,
  };

  // ─── Request intercept ───────────────────────────────────────────────────────
  let _lid = 0;
  const nid = () => ++_lid;

  function addLog(entry) {
    state.logs.unshift(entry);
    if (state.logs.length > 500) state.logs.pop();
    if (state.tab === 'logger') renderLogger();
  }

  // XHR hook
  const OrigXHR = unsafeWindow.XMLHttpRequest;
  class HookedXHR extends OrigXHR {
    open(method, url, ...rest) {
      this._dp_method = method;
      this._dp_url    = url;
      this._dp_start  = 0;
      return super.open(method, url, ...rest);
    }
    send(...args) {
      this._dp_start = Date.now();
      this.addEventListener('readystatechange', () => {
        if (this.readyState === 4) {
          addLog({
            id:       nid(),
            method:   this._dp_method || 'GET',
            url:      this._dp_url || '',
            status:   this.status,
            type:     (this.getResponseHeader('content-type') || '').split(';')[0] || '—',
            ts:       Date.now(),
            duration: Date.now() - (this._dp_start || Date.now()),
            size:     this.getResponseHeader('content-length') || '?',
            src:      'XHR',
          });
        }
      });
      return super.send(...args);
    }
  }
  unsafeWindow.XMLHttpRequest = HookedXHR;

  // Fetch hook
  const origFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = async function (input, init) {
    const url    = typeof input === 'string' ? input : input?.url || '';
    const method = init?.method || (typeof input === 'object' ? input?.method : null) || 'GET';
    const start  = Date.now();
    try {
      const res  = await origFetch.apply(this, arguments);
      const dur  = Date.now() - start;
      addLog({
        id:       nid(),
        method:   method.toUpperCase(),
        url,
        status:   res.status,
        type:     (res.headers.get('content-type') || '').split(';')[0] || '—',
        ts:       Date.now(),
        duration: dur,
        size:     res.headers.get('content-length') || '?',
        src:      'fetch',
      });
      return res;
    } catch (err) {
      addLog({ id: nid(), method: method.toUpperCase(), url, status: 0, type: 'error', ts: Date.now(), duration: Date.now() - start, size: '?', src: 'fetch' });
      throw err;
    }
  };

  // ─── Styles ──────────────────────────────────────────────────────────────────
  GM_addStyle(`
    @import url('https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500;600;700&display=swap');

    :root {
      --dp-bg:       #09090b;
      --dp-surface:  #0f0f11;
      --dp-border:   #27272a;
      --dp-border2:  #3f3f46;
      --dp-text:     #fafafa;
      --dp-muted:    #71717a;
      --dp-muted2:   #52525b;
      --dp-accent:   #ffffff;
      --dp-dim:      #18181b;
      --dp-input:    #0f0f11;
      --dp-hover:    #1c1c1f;
      --dp-ok:       #4ade80;
      --dp-err:      #f87171;
      --dp-warn:     #facc15;
      --dp-info:     #60a5fa;
      --dp-font:     'Geist Mono', 'JetBrains Mono', monospace;
      --dp-r:        6px;
      --dp-shadow:   0 0 0 1px #27272a, 0 8px 32px rgba(0,0,0,0.8);
    }

    /* ── FAB ── */
    #dp-fab {
      position: fixed; bottom: 20px; left: 20px;
      z-index: 2147483647;
      width: 40px; height: 40px; border-radius: var(--dp-r);
      background: var(--dp-text); color: var(--dp-bg);
      border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 2px 12px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.1);
      transition: transform .15s ease, box-shadow .15s ease;
      font-family: var(--dp-font); font-size: 14px; font-weight: 700;
      letter-spacing: -.03em;
      -webkit-tap-highlight-color: transparent;
    }
    #dp-fab:hover  { transform: scale(1.05); box-shadow: 0 4px 20px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.15); }
    #dp-fab:active { transform: scale(0.97); }

    /* ── Panel ── */
    #dp-panel {
      position: fixed;
      bottom: 20px; left: 20px;
      z-index: 2147483646;
      width: min(760px, calc(100vw - 40px));
      height: min(560px, calc(100vh - 40px));
      background: var(--dp-bg);
      border: 1px solid var(--dp-border);
      border-radius: 10px;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: var(--dp-shadow);
      font-family: var(--dp-font);
      transform: scale(0.96) translateY(8px);
      opacity: 0; pointer-events: none;
      transform-origin: bottom left;
      transition: transform .2s cubic-bezier(.34,1.3,.64,1), opacity .15s ease;
    }
    #dp-panel.open { transform: none; opacity: 1; pointer-events: all; }

    /* ── Titlebar ── */
    #dp-titlebar {
      display: flex; align-items: center;
      padding: 0 14px;
      height: 42px;
      border-bottom: 1px solid var(--dp-border);
      flex-shrink: 0;
      gap: 10px;
      background: var(--dp-surface);
    }
    .dp-dots { display: flex; gap: 6px; }
    .dp-dot  {
      width: 11px; height: 11px; border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .dp-dot-r { background: #ff5f57; }
    .dp-dot-y { background: #febc2e; }
    .dp-dot-g { background: #28c840; }
    #dp-title {
      font-size: 11px; font-weight: 500; color: var(--dp-muted);
      letter-spacing: .04em; flex: 1;
    }
    .dp-close {
      background: none; border: none; color: var(--dp-muted2);
      cursor: pointer; font-size: 14px; padding: 4px 6px;
      border-radius: 4px; line-height: 1;
      transition: color .1s, background .1s;
      font-family: var(--dp-font);
      -webkit-tap-highlight-color: transparent;
    }
    .dp-close:hover { color: var(--dp-text); background: var(--dp-hover); }

    /* ── Tab bar ── */
    #dp-tabs {
      display: flex; gap: 0;
      border-bottom: 1px solid var(--dp-border);
      flex-shrink: 0;
      background: var(--dp-surface);
      padding: 0 10px;
    }
    .dp-tab {
      padding: 9px 14px; font-size: 11px; font-weight: 500;
      font-family: var(--dp-font);
      border: none; background: none; color: var(--dp-muted);
      cursor: pointer; letter-spacing: .04em;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color .12s, border-color .12s;
      -webkit-tap-highlight-color: transparent;
    }
    .dp-tab:hover { color: var(--dp-text); }
    .dp-tab.active { color: var(--dp-text); border-bottom-color: var(--dp-text); }

    /* ── Content areas ── */
    #dp-executor, #dp-logger { display: none; flex: 1; flex-direction: column; overflow: hidden; }
    #dp-executor.active, #dp-logger.active { display: flex; }

    /* ── Executor ── */
    #dp-exec-editor-wrap {
      flex: 1; position: relative; overflow: hidden;
      border-bottom: 1px solid var(--dp-border);
    }
    #dp-exec-header {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--dp-border);
      background: var(--dp-surface); flex-shrink: 0;
    }
    .dp-badge {
      font-size: 9px; font-weight: 600; letter-spacing: .08em;
      padding: 2px 7px; border-radius: 3px;
      border: 1px solid var(--dp-border2);
      color: var(--dp-muted); background: var(--dp-dim);
    }
    #dp-exec-actions { margin-left: auto; display: flex; gap: 6px; }
    .dp-btn {
      font-family: var(--dp-font); font-size: 10px; font-weight: 600;
      letter-spacing: .05em; padding: 4px 12px; border-radius: var(--dp-r);
      cursor: pointer; transition: all .12s; border: 1px solid;
      -webkit-tap-highlight-color: transparent;
    }
    .dp-btn-ghost {
      background: transparent; border-color: var(--dp-border2); color: var(--dp-muted);
    }
    .dp-btn-ghost:hover { border-color: var(--dp-text); color: var(--dp-text); background: var(--dp-hover); }
    .dp-btn-primary {
      background: var(--dp-text); border-color: var(--dp-text); color: var(--dp-bg);
    }
    .dp-btn-primary:hover { background: #e4e4e7; border-color: #e4e4e7; }
    .dp-btn-primary:active { background: #d4d4d8; }

    #dp-textarea {
      width: 100%; height: 100%;
      background: var(--dp-bg); color: var(--dp-text);
      border: none; outline: none; resize: none;
      font-family: var(--dp-font); font-size: 12.5px; line-height: 1.7;
      padding: 14px 16px;
      tab-size: 2; caret-color: var(--dp-text);
      box-sizing: border-box;
    }
    #dp-textarea::selection { background: rgba(255,255,255,0.15); }
    #dp-textarea::placeholder { color: var(--dp-muted2); }

    /* line numbers gutter */
    #dp-exec-editor-wrap {
      display: flex;
    }
    #dp-gutter {
      width: 42px; flex-shrink: 0;
      background: var(--dp-surface);
      border-right: 1px solid var(--dp-border);
      padding: 14px 0;
      overflow: hidden;
      user-select: none;
    }
    .dp-lnum {
      display: block; font-family: var(--dp-font); font-size: 11px;
      color: var(--dp-muted2); line-height: 1.7;
      text-align: right; padding-right: 10px;
    }

    #dp-output-wrap {
      height: 140px; flex-shrink: 0;
      display: flex; flex-direction: column;
      border-top: 1px solid var(--dp-border);
    }
    #dp-output-header {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--dp-border);
      background: var(--dp-surface); flex-shrink: 0;
    }
    #dp-output-title { font-size: 10px; font-weight: 600; color: var(--dp-muted); letter-spacing: .06em; }
    #dp-output-clear { margin-left: auto; }
    #dp-output {
      flex: 1; overflow-y: auto; padding: 8px 14px;
      scrollbar-width: thin; scrollbar-color: var(--dp-border2) transparent;
    }
    #dp-output::-webkit-scrollbar { width: 4px; }
    #dp-output::-webkit-scrollbar-thumb { background: var(--dp-border2); border-radius: 2px; }
    .dp-out-line {
      font-size: 11.5px; line-height: 1.65; padding: 1px 0;
      font-family: var(--dp-font); word-break: break-all;
    }
    .dp-out-log   { color: var(--dp-text); }
    .dp-out-info  { color: var(--dp-info); }
    .dp-out-warn  { color: var(--dp-warn); }
    .dp-out-error { color: var(--dp-err); }
    .dp-out-ret   { color: var(--dp-muted); }
    .dp-out-ret::before { content: '← '; color: var(--dp-muted2); }
    .dp-out-ts    { color: var(--dp-muted2); margin-right: 8px; font-size: 10px; }

    /* ── Logger ── */
    #dp-log-toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--dp-border);
      background: var(--dp-surface); flex-shrink: 0;
    }
    #dp-search-wrap { position: relative; flex: 1; }
    #dp-search-icon {
      position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
      color: var(--dp-muted2); pointer-events: none; font-size: 13px;
    }
    #dp-search {
      width: 100%; background: var(--dp-input);
      border: 1px solid var(--dp-border); border-radius: var(--dp-r);
      color: var(--dp-text); font-family: var(--dp-font); font-size: 11px;
      padding: 5px 10px 5px 30px; outline: none;
      transition: border-color .12s; box-sizing: border-box;
    }
    #dp-search:focus { border-color: var(--dp-border2); }
    #dp-search::placeholder { color: var(--dp-muted2); }

    .dp-method-filter {
      display: flex; gap: 4px;
    }
    .dp-mf-btn {
      font-family: var(--dp-font); font-size: 9px; font-weight: 600;
      letter-spacing: .06em; padding: 3px 8px; border-radius: 4px;
      border: 1px solid var(--dp-border); background: transparent;
      color: var(--dp-muted); cursor: pointer; transition: all .1s;
    }
    .dp-mf-btn:hover { border-color: var(--dp-border2); color: var(--dp-text); }
    .dp-mf-btn.active { background: var(--dp-text); border-color: var(--dp-text); color: var(--dp-bg); }

    #dp-log-count {
      font-size: 10px; color: var(--dp-muted2); white-space: nowrap; font-weight: 500;
    }

    #dp-log-table-wrap {
      flex: 1; overflow-y: auto;
      scrollbar-width: thin; scrollbar-color: var(--dp-border2) transparent;
    }
    #dp-log-table-wrap::-webkit-scrollbar { width: 4px; }
    #dp-log-table-wrap::-webkit-scrollbar-thumb { background: var(--dp-border2); border-radius: 2px; }

    #dp-log-table {
      width: 100%; border-collapse: collapse;
      font-size: 11px; font-family: var(--dp-font);
    }
    #dp-log-table thead th {
      position: sticky; top: 0;
      background: var(--dp-surface);
      color: var(--dp-muted); font-weight: 600; font-size: 10px;
      letter-spacing: .06em; text-align: left;
      padding: 7px 12px; border-bottom: 1px solid var(--dp-border);
      user-select: none;
    }
    #dp-log-table tbody tr {
      border-bottom: 1px solid rgba(39,39,42,0.6);
      transition: background .08s; cursor: pointer;
    }
    #dp-log-table tbody tr:hover { background: var(--dp-hover); }
    #dp-log-table tbody td {
      padding: 6px 12px; color: var(--dp-text); vertical-align: middle;
      max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .dp-td-method { width: 52px; }
    .dp-td-status { width: 46px; }
    .dp-td-src    { width: 46px; }
    .dp-td-dur    { width: 56px; }
    .dp-td-time   { width: 70px; }
    .dp-td-url    { }

    .dp-method {
      font-size: 9px; font-weight: 700; letter-spacing: .06em;
      padding: 2px 6px; border-radius: 3px; border: 1px solid;
    }
    .dp-m-GET    { color: #86efac; border-color: rgba(134,239,172,.3); background: rgba(134,239,172,.07); }
    .dp-m-POST   { color: #93c5fd; border-color: rgba(147,197,253,.3); background: rgba(147,197,253,.07); }
    .dp-m-PUT    { color: #fcd34d; border-color: rgba(252,211,77,.3);  background: rgba(252,211,77,.07); }
    .dp-m-DELETE { color: #f87171; border-color: rgba(248,113,113,.3); background: rgba(248,113,113,.07); }
    .dp-m-PATCH  { color: #c4b5fd; border-color: rgba(196,181,253,.3); background: rgba(196,181,253,.07); }
    .dp-m-other  { color: var(--dp-muted); border-color: var(--dp-border); background: transparent; }

    .dp-status-ok   { color: var(--dp-ok); }
    .dp-status-redir { color: var(--dp-info); }
    .dp-status-err  { color: var(--dp-err); }
    .dp-status-pend { color: var(--dp-muted); }

    .dp-dur { color: var(--dp-muted); }
    .dp-dur.fast   { color: #86efac; }
    .dp-dur.medium { color: #fcd34d; }
    .dp-dur.slow   { color: #f87171; }

    .dp-src-badge {
      font-size: 9px; color: var(--dp-muted2);
      border: 1px solid var(--dp-border); padding: 1px 5px; border-radius: 3px;
    }

    /* Row detail drawer */
    .dp-row-detail {
      background: var(--dp-dim); border-bottom: 1px solid var(--dp-border);
    }
    .dp-row-detail td { padding: 10px 14px; }
    .dp-detail-url {
      font-size: 10.5px; color: var(--dp-text); word-break: break-all;
      line-height: 1.6; margin-bottom: 6px;
    }
    .dp-detail-meta {
      display: flex; gap: 16px; flex-wrap: wrap;
      font-size: 10px; color: var(--dp-muted);
    }
    .dp-detail-meta span b { color: var(--dp-text); font-weight: 500; }
    .dp-detail-actions { display: flex; gap: 6px; margin-top: 8px; }

    /* Empty */
    .dp-empty {
      text-align: center; padding: 40px 20px;
      color: var(--dp-muted2); font-size: 11px; letter-spacing: .04em;
    }
    .dp-empty-icon { font-size: 26px; display: block; margin-bottom: 8px; opacity: .4; }

    /* Mobile */
    @media (max-width: 600px) {
      #dp-panel { left: 8px; right: 8px; width: auto; bottom: 16px; height: min(580px, calc(100vh - 32px)); }
      #dp-fab   { left: 16px; bottom: 16px; }
      .dp-td-dur, .dp-td-time, .dp-td-src { display: none; }
    }
  `);

  // ─── Build UI ─────────────────────────────────────────────────────────────────
  function buildUI() {
    // FAB
    const fab = document.createElement('button');
    fab.id = 'dp-fab';
    fab.title = 'DevPanel';
    fab.textContent = '⌗';
    document.documentElement.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'dp-panel';
    panel.innerHTML = `
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

      <!-- ─ EXECUTOR ─ -->
      <div id="dp-executor" class="active">
        <div id="dp-exec-header">
          <span class="dp-badge">JS</span>
          <span class="dp-badge" id="dp-exec-ctx">window</span>
          <div id="dp-exec-actions">
            <button class="dp-btn dp-btn-ghost" id="dp-clear-code">Clear</button>
            <button class="dp-btn dp-btn-ghost" id="dp-hist-prev" title="Previous (↑)">↑</button>
            <button class="dp-btn dp-btn-ghost" id="dp-hist-next" title="Next (↓)">↓</button>
            <button class="dp-btn dp-btn-primary" id="dp-run">▶ Run</button>
          </div>
        </div>
        <div id="dp-exec-editor-wrap">
          <div id="dp-gutter"></div>
          <textarea id="dp-textarea" spellcheck="false" placeholder="// JavaScript — runs in page context&#10;// console.log, fetch, document, unsafeWindow all available&#10;&#10;document.title"></textarea>
        </div>
        <div id="dp-output-wrap">
          <div id="dp-output-header">
            <span id="dp-output-title">OUTPUT</span>
            <button class="dp-btn dp-btn-ghost dp-output-clear" id="dp-clear-output" style="padding:2px 8px;font-size:9px">Clear</button>
          </div>
          <div id="dp-output"></div>
        </div>
      </div>

      <!-- ─ LOGGER ─ -->
      <div id="dp-logger">
        <div id="dp-log-toolbar">
          <div id="dp-search-wrap">
            <span id="dp-search-icon">⌕</span>
            <input id="dp-search" type="text" placeholder="Filter by URL, method, status…" autocomplete="off" spellcheck="false"/>
          </div>
          <div class="dp-method-filter">
            <button class="dp-mf-btn active" data-mf="ALL">ALL</button>
            <button class="dp-mf-btn" data-mf="GET">GET</button>
            <button class="dp-mf-btn" data-mf="POST">POST</button>
            <button class="dp-mf-btn" data-mf="XHR">XHR</button>
          </div>
          <span id="dp-log-count">0 reqs</span>
          <button class="dp-btn dp-btn-ghost" id="dp-clear-log" style="padding:3px 9px;font-size:9px">Clear</button>
        </div>
        <div id="dp-log-table-wrap">
          <table id="dp-log-table">
            <thead>
              <tr>
                <th class="dp-td-method">Method</th>
                <th class="dp-td-status">Status</th>
                <th class="dp-td-src">Src</th>
                <th class="dp-td-url">URL</th>
                <th class="dp-td-dur">Time</th>
                <th class="dp-td-time">At</th>
              </tr>
            </thead>
            <tbody id="dp-log-tbody"></tbody>
          </table>
        </div>
      </div>
    `;
    document.documentElement.appendChild(panel);

    // Wire up events
    fab.addEventListener('click', togglePanel);
    panel.querySelector('#dp-close').addEventListener('click', () => setOpen(false));
    panel.querySelectorAll('.dp-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    panel.querySelector('#dp-run').addEventListener('click', runCode);
    panel.querySelector('#dp-clear-code').addEventListener('click', () => { document.getElementById('dp-textarea').value = ''; updateGutter(); });
    panel.querySelector('#dp-clear-output').addEventListener('click', clearOutput);
    panel.querySelector('#dp-clear-log').addEventListener('click', () => { state.logs = []; renderLogger(); });
    panel.querySelector('#dp-search').addEventListener('input', e => { state.filter = e.target.value; renderLogger(); });
    panel.querySelector('#dp-hist-prev').addEventListener('click', histPrev);
    panel.querySelector('#dp-hist-next').addEventListener('click', histNext);

    panel.querySelectorAll('.dp-mf-btn').forEach(b => {
      b.addEventListener('click', () => {
        panel.querySelectorAll('.dp-mf-btn').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        state.methodFilter = b.dataset.mf;
        renderLogger();
      });
    });
    state.methodFilter = 'ALL';

    // Textarea: tab key, gutter sync
    const ta = panel.querySelector('#dp-textarea');
    ta.addEventListener('keydown', e => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, end = ta.selectionEnd;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(end);
        ta.selectionStart = ta.selectionEnd = s + 2;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runCode(); }
      if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); histPrev(); }
      if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); histNext(); }
    });
    ta.addEventListener('input', updateGutter);
    ta.addEventListener('scroll', syncGutterScroll);
    updateGutter();
  }

  // ─── Gutter ──────────────────────────────────────────────────────────────────
  function updateGutter() {
    const ta    = document.getElementById('dp-textarea');
    const gutter= document.getElementById('dp-gutter');
    if (!ta || !gutter) return;
    const lines = ta.value.split('\n').length;
    let html = '';
    for (let i = 1; i <= Math.max(lines, 1); i++) {
      html += `<span class="dp-lnum">${i}</span>`;
    }
    gutter.innerHTML = html;
  }

  function syncGutterScroll() {
    const ta     = document.getElementById('dp-textarea');
    const gutter = document.getElementById('dp-gutter');
    if (ta && gutter) gutter.scrollTop = ta.scrollTop;
  }

  // ─── Code execution ──────────────────────────────────────────────────────────
  function runCode() {
    const ta   = document.getElementById('dp-textarea');
    const code = ta.value.trim();
    if (!code) return;

    // Save to history
    if (state.history[0] !== code) {
      state.history.unshift(code);
      if (state.history.length > 50) state.history.pop();
    }
    state.histIdx = -1;

    // Patch console to capture output
    const captured = [];
    const patch    = (level) => (...args) => {
      captured.push({ level, text: args.map(safeStr).join(' '), ts: Date.now() });
      unsafeWindow.console[level]?.apply(unsafeWindow.console, args);
    };

    const fakeConsole = {
      log:   patch('log'),
      info:  patch('info'),
      warn:  patch('warn'),
      error: patch('error'),
      dir:   patch('log'),
    };

    let ret, hasRet = false, errored = false;
    try {
      // Build function with patched console in scope
      const fn = new Function('console', 'window', `
        "use strict";
        try {
          const __r = (function() { ${code} })();
          if (typeof __r !== 'undefined') { console.__ret(__r); }
        } catch(e) { console.error(e.message || String(e)); }
      `);

      fakeConsole.__ret = (v) => { captured.push({ level: 'ret', text: safeStr(v), ts: Date.now() }); };

      fn(fakeConsole, unsafeWindow);
    } catch (e) {
      captured.push({ level: 'error', text: e.message || String(e), ts: Date.now() });
    }

    // Flush to output panel
    const out = document.getElementById('dp-output');
    if (!out) return;
    const ts0 = captured[0]?.ts;
    captured.forEach(({ level, text, ts }) => {
      const line = document.createElement('div');
      line.className = `dp-out-line dp-out-${level}`;
      const tStr = new Date(ts).toLocaleTimeString([], { hour12: false });
      line.innerHTML = `<span class="dp-out-ts">${tStr}</span>${escHtml(text)}`;
      out.appendChild(line);
    });
    if (captured.length === 0) {
      const line = document.createElement('div');
      line.className = 'dp-out-line dp-out-ret';
      line.textContent = 'undefined';
      out.appendChild(line);
    }
    out.scrollTop = out.scrollHeight;
  }

  function clearOutput() {
    const out = document.getElementById('dp-output');
    if (out) out.innerHTML = '';
  }

  function safeStr(v) {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  // ─── Code history ─────────────────────────────────────────────────────────────
  function histPrev() {
    if (state.history.length === 0) return;
    state.histIdx = Math.min(state.histIdx + 1, state.history.length - 1);
    const ta = document.getElementById('dp-textarea');
    if (ta) { ta.value = state.history[state.histIdx]; updateGutter(); }
  }
  function histNext() {
    state.histIdx = Math.max(state.histIdx - 1, -1);
    const ta = document.getElementById('dp-textarea');
    if (ta) { ta.value = state.histIdx === -1 ? '' : state.history[state.histIdx]; updateGutter(); }
  }

  // ─── Logger render ────────────────────────────────────────────────────────────
  let _openRow = null;

  function filteredLogs() {
    const q  = state.filter.toLowerCase().trim();
    const mf = state.methodFilter || 'ALL';
    return state.logs.filter(l => {
      const matchQ  = !q || l.url.toLowerCase().includes(q) || String(l.status).includes(q) || l.method.toLowerCase().includes(q) || l.type.toLowerCase().includes(q);
      const matchMF = mf === 'ALL' ? true
                    : mf === 'XHR' ? l.src === 'XHR'
                    : l.method === mf;
      return matchQ && matchMF;
    });
  }

  function renderLogger() {
    const tbody = document.getElementById('dp-log-tbody');
    const count = document.getElementById('dp-log-count');
    if (!tbody) return;

    const logs = filteredLogs();
    if (count) count.textContent = `${logs.length} req${logs.length !== 1 ? 's' : ''}`;

    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="dp-empty"><span class="dp-empty-icon">◎</span>No requests matched.</div></td></tr>`;
      return;
    }

    tbody.innerHTML = '';
    logs.forEach(log => {
      const row = document.createElement('tr');
      row.dataset.lid = log.id;

      const mCls  = `dp-m-${['GET','POST','PUT','DELETE','PATCH'].includes(log.method) ? log.method : 'other'}`;
      const sCls  = log.status >= 200 && log.status < 300 ? 'dp-status-ok'
                  : log.status >= 300 && log.status < 400 ? 'dp-status-redir'
                  : log.status >= 400 ? 'dp-status-err'
                  : 'dp-status-pend';
      const durCls = log.duration < 100 ? 'fast' : log.duration < 500 ? 'medium' : 'slow';
      const time  = new Date(log.ts).toLocaleTimeString([], { hour12: false });
      const urlShort = (() => {
        try { const u = new URL(log.url); return u.pathname + (u.search.length > 30 ? u.search.slice(0,30)+'…' : u.search); }
        catch { return log.url.slice(0, 60); }
      })();

      row.innerHTML = `
        <td class="dp-td-method"><span class="dp-method ${mCls}">${log.method}</span></td>
        <td class="dp-td-status ${sCls}">${log.status || '—'}</td>
        <td class="dp-td-src"><span class="dp-src-badge">${log.src}</span></td>
        <td class="dp-td-url" title="${escHtml(log.url)}">${escHtml(urlShort)}</td>
        <td class="dp-td-dur"><span class="dp-dur ${durCls}">${log.duration}ms</span></td>
        <td class="dp-td-time">${time}</td>
      `;

      row.addEventListener('click', () => toggleDetail(row, log, tbody));
      tbody.appendChild(row);
    });
  }

  function toggleDetail(row, log, tbody) {
    // Remove existing detail if open
    const existing = tbody.querySelector('.dp-row-detail');
    if (existing) {
      const wasThis = existing.dataset.forId === String(log.id);
      existing.remove();
      _openRow = null;
      if (wasThis) return;
    }

    const detail = document.createElement('tr');
    detail.className = 'dp-row-detail';
    detail.dataset.forId = String(log.id);
    detail.innerHTML = `
      <td colspan="6">
        <div class="dp-detail-url">${escHtml(log.url)}</div>
        <div class="dp-detail-meta">
          <span>Method <b>${log.method}</b></span>
          <span>Status <b>${log.status || '—'}</b></span>
          <span>Type <b>${log.type}</b></span>
          <span>Duration <b>${log.duration}ms</b></span>
          <span>Size <b>${log.size} bytes</b></span>
          <span>Source <b>${log.src}</b></span>
        </div>
        <div class="dp-detail-actions">
          <button class="dp-btn dp-btn-ghost" style="font-size:9px;padding:3px 9px" data-copy-url>⧉ Copy URL</button>
          <button class="dp-btn dp-btn-ghost" style="font-size:9px;padding:3px 9px" data-inject>→ Inject to executor</button>
        </div>
      </td>`;

    detail.querySelector('[data-copy-url]').addEventListener('click', () => {
      GM_setClipboard(log.url);
      showToast('URL copied');
    });
    detail.querySelector('[data-inject]').addEventListener('click', () => {
      const ta   = document.getElementById('dp-textarea');
      const code = `fetch("${log.url}", { method: "${log.method}" })\n  .then(r => r.json())\n  .then(d => console.log(d))\n  .catch(e => console.error(e));`;
      if (ta) { ta.value = code; updateGutter(); switchTab('executor'); }
    });

    row.insertAdjacentElement('afterend', detail);
    _openRow = log.id;
  }

  // ─── Panel / tab logic ────────────────────────────────────────────────────────
  function togglePanel() { setOpen(!state.open); }
  function setOpen(v) {
    state.open = v;
    document.getElementById('dp-panel').classList.toggle('open', v);
    if (v && state.tab === 'logger') renderLogger();
  }
  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.dp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('dp-executor').classList.toggle('active', tab === 'executor');
    document.getElementById('dp-logger').classList.toggle('active', tab === 'logger');
    if (tab === 'logger') renderLogger();
  }

  // ─── Toast ────────────────────────────────────────────────────────────────────
  let _tTimer;
  function showToast(msg) {
    let t = document.getElementById('dp-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'dp-toast';
      GM_addStyle(`
        #dp-toast {
          position: fixed; bottom: 72px; left: 20px;
          background: var(--dp-text); color: var(--dp-bg);
          font-family: var(--dp-font); font-size: 11px; font-weight: 600;
          padding: 6px 14px; border-radius: var(--dp-r);
          z-index: 2147483648; opacity: 0; pointer-events: none;
          transform: translateY(4px);
          transition: all .18s ease;
        }
        #dp-toast.show { opacity: 1; transform: none; }
      `);
      document.documentElement.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(_tTimer);
    _tTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────
  function init() { buildUI(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
