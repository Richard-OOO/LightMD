(() => {
  const TOKEN = document.querySelector('meta[name="lightmd-token"]')?.content || '';

  const state = {
    filePath: '',
    fileName: '',
    dirPath: '',
    content: '',
    savedContent: '',
    mtime: 0,
    siblings: [],
    recent: [],
    assoc: { registered: false, isDefault: false, userChoiceProgId: '', exePath: '' },
    install: { installed: false, runningInstalled: false, installExePath: '', desktopShortcut: false, startMenuShortcut: false },
    mode: 'read', // read | split | edit
    dirty: false,
    hasDoc: false,
    sidebarOpen: false,
    sidebarTab: 'toc',
    theme: localStorage.getItem('lightmd_theme') || 'light',
    fontSize: parseInt(localStorage.getItem('lightmd_fontSize') || '16', 10),
    wideReading: localStorage.getItem('lightmd_wide') === '1',
    pageView: localStorage.getItem('lightmd_pageview') !== '0',
    historyBack: [],
    findHits: [],
    findIndex: -1,
    syncingScroll: false,
    renderTimer: null,
  };

  // DOM refs
  const $ = (id) => document.getElementById(id);
  const elSidebar = $('sidebar');
  const elSbToc = $('sb-toc');
  const elSbFiles = $('sb-files');
  const elMain = $('main-area');
  const elEditor = $('editor');
  const elPreviewPane = $('preview-pane');
  const elPreview = $('preview');
  const elWelcome = $('welcome');
  const elFormatBar = $('format-bar');
  const elFileName = $('file-name');
  const elDirtyDot = $('dirty-dot');
  const elBtnSave = $('btn-save');
  const elBtnBack = $('btn-back');
  const elBtnTheme = $('btn-theme');
  const elBtnSidebar = $('btn-sidebar');
  const elStatusPath = $('status-path');
  const elStatusCursor = $('status-cursor');
  const elStatusWords = $('status-words');
  const elStatusReadtime = $('status-readtime');
  const elBtnReloadExt = $('btn-reload-ext');
  const elFindBar = $('find-bar');
  const elFindInput = $('find-input');
  const elFindCount = $('find-count');
  const elPopover = $('settings-popover');
  const elDropOverlay = $('drop-overlay');
  const elToast = $('toast');

  // ---------- API helper ----------
  async function api(url, body) {
    const opts = {
      method: body !== undefined ? 'POST' : 'GET',
      headers: { 'X-LightMD-Token': TOKEN },
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || ('请求失败 (' + res.status + ')'));
    }
    return data;
  }

  let toastTimer = null;
  function showToast(msg) {
    elToast.textContent = msg;
    elToast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elToast.classList.remove('show'), 2200);
  }

  // ---------- Preferences ----------
  const THEMES = [
    { key: 'light', label: '浅色' },
    { key: 'sepia', label: '暖纸' },
    { key: 'dark', label: '暗色' },
  ];

  function applyTheme(t) {
    state.theme = THEMES.some((x) => x.key === t) ? t : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    localStorage.setItem('lightmd_theme', state.theme);
    const info = THEMES.find((x) => x.key === state.theme);
    elBtnTheme.textContent = info.label;
  }

  function applyFontSize(sz) {
    state.fontSize = Math.max(12, Math.min(26, sz));
    document.documentElement.style.setProperty('--doc-font-size', state.fontSize + 'px');
    localStorage.setItem('lightmd_fontSize', String(state.fontSize));
  }

  function applyWideReading(wide) {
    state.wideReading = !!wide;
    document.body.classList.toggle('wide-reading', state.wideReading);
    $('chk-wide').checked = state.wideReading;
    localStorage.setItem('lightmd_wide', state.wideReading ? '1' : '0');
  }

  function applyPageView(on) {
    state.pageView = !!on;
    document.body.classList.toggle('page-view', state.pageView);
    $('chk-page-view').checked = state.pageView;
    localStorage.setItem('lightmd_pageview', state.pageView ? '1' : '0');
  }

  function setSidebar(open, tab) {
    state.sidebarOpen = !!open;
    elSidebar.classList.toggle('collapsed', !state.sidebarOpen);
    elBtnSidebar.classList.toggle('active', state.sidebarOpen);
    if (tab) switchSidebarTab(tab);
  }

  function switchSidebarTab(tab) {
    state.sidebarTab = tab;
    document.querySelectorAll('.sb-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    elSbToc.style.display = tab === 'toc' ? 'block' : 'none';
    elSbFiles.style.display = tab === 'files' ? 'block' : 'none';
  }

  function syncFromWysiwyg() {
    if (state.mode !== 'edit' || !state.hasDoc || !window.LightMDSerializer) return;
    // Clone and strip transient find highlights before serializing
    const clone = elPreview.cloneNode(true);
    clone.querySelectorAll('mark.find-hit').forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
    const md = LightMDSerializer.toMarkdown(clone);
    state.content = md;
    elEditor.value = md;
    updateTitleAndDirty();
    updateWordStats();
  }

  function refreshTOCFromPreviewDOM() {
    const toc = [];
    const seenIds = {};
    elPreview.querySelectorAll('h1, h2, h3, h4').forEach((h, idx) => {
      const text = (h.textContent || '').trim();
      if (!text) return;
      const level = parseInt(h.tagName.slice(1), 10);
      let id = 'h-' + idx + '-' + text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
      if (seenIds[id]) {
        seenIds[id]++;
        id += '-' + seenIds[id];
      } else {
        seenIds[id] = 1;
      }
      h.id = id;
      toc.push({ id, text, level });
    });
    renderTOC(toc);
  }

  function setMode(mode) {
    if (state.mode === 'edit' && mode !== 'edit') {
      syncFromWysiwyg();
      elPreview.contentEditable = 'false';
    }
    if (!state.hasDoc && mode !== 'read') {
      startNewDocument();
    }
    state.mode = mode;
    elMain.classList.remove('mode-read', 'mode-split', 'mode-edit');
    elMain.classList.add('mode-' + mode);
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    elFormatBar.classList.toggle('show', mode === 'split' || mode === 'edit');
    elStatusCursor.style.display = mode === 'split' ? 'inline' : 'none';

    if (mode === 'edit') {
      renderMarkdown();
      if (!elPreview.innerHTML.trim()) {
        elPreview.innerHTML = '<p><br></p>';
      }
      elPreview.contentEditable = 'true';
      elPreview.querySelectorAll('.code-block-head').forEach((h) => {
        h.contentEditable = 'false';
      });
      setTimeout(() => elPreview.focus(), 10);
    } else if (mode === 'split') {
      elPreview.contentEditable = 'false';
      elEditor.value = state.content;
      renderMarkdown();
      setTimeout(() => elEditor.focus(), 10);
    } else {
      elPreview.contentEditable = 'false';
      renderMarkdown();
    }
  }

  // ---------- Document Lifecycle ----------
  function updateTitleAndDirty() {
    state.dirty = state.hasDoc && (state.content !== state.savedContent);
    elDirtyDot.classList.toggle('show', state.dirty);
    elBtnSave.classList.toggle('primary', state.dirty);

    const displayName = state.hasDoc ? (state.fileName || '未命名.md') : 'LightMD';
    elFileName.textContent = displayName;
    elStatusPath.textContent = state.filePath || (state.hasDoc ? '未保存的新文档' : '就绪 · 拖拽或打开任意 .md 文件');
    elBtnBack.disabled = state.historyBack.length === 0;

    const winTitle = state.hasDoc
      ? (state.dirty ? '● ' : '') + displayName + ' — LightMD'
      : 'LightMD — 轻量化 Markdown 阅读器';
    document.title = winTitle;
    api('/api/title', { title: winTitle }).catch(() => {});
  }

  function updateWordStats() {
    if (!state.hasDoc) {
      elStatusWords.textContent = '';
      elStatusReadtime.textContent = '';
      return;
    }
    const text = state.content || '';
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
    const latinWords = (text.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
    const totalWords = cjk + latinWords;
    const mins = Math.max(1, Math.ceil(totalWords / 300));
    elStatusWords.textContent = `${totalWords} 词 · ${text.length} 字符`;
    elStatusReadtime.textContent = `预计阅读 ${mins} 分钟`;
  }

  function loadDocument(fp, { pushHistory = false } = {}) {
    if (pushHistory && state.filePath && state.filePath !== fp.filePath) {
      state.historyBack.push(state.filePath);
      if (state.historyBack.length > 30) state.historyBack.shift();
    }
    state.filePath = fp.filePath || '';
    state.fileName = fp.fileName || '未命名.md';
    state.dirPath = fp.dirPath || '';
    state.content = fp.content || '';
    state.savedContent = state.content;
    state.mtime = fp.mtime || 0;
    state.siblings = fp.siblings || [];
    if (fp.recent) state.recent = fp.recent;
    state.hasDoc = true;

    elWelcome.style.display = 'none';
    elPreview.style.display = 'block';
    elBtnReloadExt.classList.remove('show');
    elEditor.value = state.content;

    elPreview.innerHTML = state.mode === 'edit' && !state.content.trim() ? '<p><br></p>' : '';
    renderMarkdown();
    if (state.mode === 'edit') {
      if (!elPreview.innerHTML.trim()) elPreview.innerHTML = '<p><br></p>';
      elPreview.contentEditable = 'true';
      elPreview.focus();
    }
    renderSiblings();
    updateTitleAndDirty();
    updateWordStats();
    elPreviewPane.scrollTop = 0;
    elEditor.scrollTop = 0;
  }

  function confirmDiscardIfDirty() {
    if (!state.dirty) return true;
    return window.confirm('当前文档有未保存的修改，确定放弃修改并继续吗？');
  }

  async function openFileByPath(path, { baseDir = '', pushHistory = true } = {}) {
    if (!confirmDiscardIfDirty()) return;
    try {
      const fp = await api('/api/open', { path, baseDir });
      loadDocument(fp, { pushHistory });
    } catch (err) {
      showToast('打开失败：' + err.message);
    }
  }

  async function openFileDialog() {
    if (!confirmDiscardIfDirty()) return;
    try {
      const res = await api('/api/open-dialog', { dir: state.dirPath });
      if (res.cancelled) return;
      loadDocument(res, { pushHistory: true });
    } catch (err) {
      showToast('打开失败：' + err.message);
    }
  }

  function startNewDocument() {
    if (!confirmDiscardIfDirty()) return;
    api('/api/new', {}).catch(() => {});
    state.filePath = '';
    state.fileName = '未命名.md';
    state.dirPath = '';
    state.content = '';
    state.savedContent = '';
    state.mtime = 0;
    state.siblings = [];
    state.hasDoc = true;

    elWelcome.style.display = 'none';
    elPreview.style.display = 'block';
    elBtnReloadExt.classList.remove('show');
    elEditor.value = '';
    renderMarkdown();
    renderSiblings();
    updateTitleAndDirty();
    updateWordStats();
    if (state.mode === 'read') setMode('edit');
    else if (state.mode === 'edit') {
      elPreview.innerHTML = '<p><br></p>';
      elPreview.contentEditable = 'true';
      elPreview.focus();
    } else {
      elEditor.focus();
    }
  }

  async function saveCurrentFile(forceSaveAs = false) {
    if (!state.hasDoc) return;
    if (state.mode === 'edit') {
      syncFromWysiwyg();
    }
    try {
      if (!forceSaveAs && state.filePath) {
        const res = await api('/api/save', { path: state.filePath, content: state.content });
        state.mtime = res.mtime;
        state.savedContent = state.content;
        state.siblings = res.siblings || state.siblings;
        if (res.recent) state.recent = res.recent;
        elBtnReloadExt.classList.remove('show');
        updateTitleAndDirty();
        renderSiblings();
        showToast('已保存');
      } else {
        const res = await api('/api/save-as', {
          content: state.content,
          dir: state.dirPath,
          suggestedName: state.fileName || '未命名.md',
        });
        if (res.cancelled) return;
        state.filePath = res.filePath;
        state.fileName = res.fileName;
        state.dirPath = res.dirPath;
        state.mtime = res.mtime;
        state.savedContent = state.content;
        state.siblings = res.siblings || [];
        if (res.recent) state.recent = res.recent;
        elBtnReloadExt.classList.remove('show');
        updateTitleAndDirty();
        renderSiblings();
        renderMarkdown();
        showToast('已保存到 ' + state.fileName);
      }
    } catch (err) {
      showToast('保存失败：' + err.message);
    }
  }

  // ---------- Markdown Rendering & Sanitization ----------
  if (window.marked && typeof marked.use === 'function') {
    marked.use({ gfm: true, breaks: false });
  }

  function sanitizeContainer(root) {
    const blocked = root.querySelectorAll('script, iframe, object, embed, form, style');
    blocked.forEach((n) => n.remove());

    root.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const val = (attr.value || '').trim().toLowerCase();
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name);
        } else if ((name === 'href' || name === 'src') && val.startsWith('javascript:')) {
          el.removeAttribute(attr.name);
        }
      }
    });
  }

  function renderMarkdown() {
    if (!state.hasDoc) return;
    const rawHtml = window.marked ? marked.parse(state.content || '') : '<pre>' + LightHighlight.escapeHtml(state.content || '') + '</pre>';
    const tmp = document.createElement('div');
    tmp.innerHTML = rawHtml;
    sanitizeContainer(tmp);

    // 1. Wrap tables for clean horizontal scroll
    tmp.querySelectorAll('table').forEach((tbl) => {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      tbl.parentNode.insertBefore(wrap, tbl);
      wrap.appendChild(tbl);
    });

    // 2. Enhance code blocks with syntax highlight + copy button
    tmp.querySelectorAll('pre').forEach((pre) => {
      const codeEl = pre.querySelector('code');
      if (!codeEl) return;
      const cls = codeEl.className || '';
      const m = cls.match(/language-([\w+-]+)/i);
      const lang = m ? m[1] : '';
      const rawCode = codeEl.textContent || '';
      codeEl.innerHTML = LightHighlight.highlight(rawCode, lang);

      const wrap = document.createElement('div');
      wrap.className = 'code-block-wrap';
      const head = document.createElement('div');
      head.className = 'code-block-head';
      head.contentEditable = 'false';
      head.innerHTML = `<span>${LightHighlight.escapeHtml(lang || 'text')}</span>`;
      const copyBtn = document.createElement('button');
      copyBtn.className = 'code-copy-btn';
      copyBtn.textContent = '复制';
      copyBtn.dataset.code = rawCode;
      head.appendChild(copyBtn);

      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(head);
      wrap.appendChild(pre);
    });

    // 3. Rewrite relative image URLs to local-asset endpoint (keep origSrc for serialization)
    tmp.querySelectorAll('img').forEach((img) => {
      const src = (img.getAttribute('src') || '').trim();
      if (!src || /^(https?:|data:|blob:|\/local-asset)/i.test(src)) return;
      img.dataset.origSrc = src;
      if (state.dirPath || /^[a-zA-Z]:[\\/]/.test(src)) {
        const url = `/local-asset?token=${encodeURIComponent(TOKEN)}&base=${encodeURIComponent(state.dirPath)}&rel=${encodeURIComponent(src)}`;
        img.setAttribute('src', url);
      }
    });

    // 4. Enable interactive task checkboxes
    let cbIdx = 0;
    tmp.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.disabled = false;
      cb.dataset.taskIndex = String(cbIdx++);
    });

    // 5. Assign heading IDs and build TOC
    const toc = [];
    const seenIds = {};
    tmp.querySelectorAll('h1, h2, h3, h4').forEach((h, idx) => {
      const text = (h.textContent || '').trim();
      const level = parseInt(h.tagName.slice(1), 10);
      let id = 'h-' + idx + '-' + text.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '');
      if (seenIds[id]) {
        seenIds[id]++;
        id += '-' + seenIds[id];
      } else {
        seenIds[id] = 1;
      }
      h.id = id;
      toc.push({ id, text, level });
    });

    elPreview.innerHTML = tmp.innerHTML;
    renderTOC(toc);

    // Re-apply find highlights if find bar is open
    if (elFindBar.classList.contains('show') && elFindInput.value) {
      runFind(elFindInput.value, false);
    }
  }

  function renderTOC(toc) {
    if (!toc.length) {
      elSbToc.innerHTML = '<div class="sb-empty">当前文档没有标题</div>';
      return;
    }
    elSbToc.innerHTML = '';
    toc.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = `toc-item lvl-${item.level}`;
      btn.textContent = item.text;
      btn.title = item.text;
      btn.dataset.targetId = item.id;
      btn.addEventListener('click', () => {
        const target = document.getElementById(item.id);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      elSbToc.appendChild(btn);
    });
  }

  function renderSiblings() {
    if (!state.siblings.length) {
      elSbFiles.innerHTML = '<div class="sb-empty">暂无同目录 Markdown 文件</div>';
      return;
    }
    elSbFiles.innerHTML = '';
    state.siblings.forEach((f) => {
      const btn = document.createElement('button');
      btn.className = 'file-item' + (f.path.toLowerCase() === state.filePath.toLowerCase() ? ' active' : '');
      btn.textContent = f.name;
      btn.title = f.path;
      btn.addEventListener('click', () => {
        if (f.path.toLowerCase() === state.filePath.toLowerCase()) return;
        openFileByPath(f.path, { pushHistory: true });
      });
      elSbFiles.appendChild(btn);
    });
  }

  function renderWelcome() {
    elPreview.style.display = 'none';
    elWelcome.style.display = 'block';
    updateAssocUI();

    const box = $('welcome-recent');
    if (!state.recent.length) {
      box.innerHTML = '';
      return;
    }
    box.innerHTML = '<h3>最近打开</h3>';
    state.recent.forEach((p) => {
      const name = p.split(/[\\/]/).pop() || p;
      const btn = document.createElement('button');
      btn.className = 'recent-item';
      btn.innerHTML = `<span class="recent-name">${LightHighlight.escapeHtml(name)}</span><span class="recent-path">${LightHighlight.escapeHtml(p)}</span>`;
      btn.addEventListener('click', () => openFileByPath(p, { pushHistory: false }));
      box.appendChild(btn);
    });
  }

  // ---------- Preview Interactions (links, copy code, checkboxes) ----------
  elPreview.addEventListener('click', (e) => {
    // Copy code button
    const copyBtn = e.target.closest('.code-copy-btn');
    if (copyBtn) {
      const code = copyBtn.dataset.code || '';
      navigator.clipboard.writeText(code).then(() => {
        copyBtn.textContent = '已复制';
        setTimeout(() => (copyBtn.textContent = '复制'), 1400);
      }).catch(() => showToast('复制失败'));
      return;
    }

    // Interactive task checkbox
    if (e.target.matches('input[type="checkbox"][data-task-index]')) {
      const targetIdx = parseInt(e.target.dataset.taskIndex, 10);
      toggleTaskCheckboxInSource(targetIdx, e.target.checked);
      return;
    }

    // Links
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    if (state.mode === 'edit' && !e.ctrlKey) return;
    const href = (a.getAttribute('href') || '').trim();
    if (!href) return;

    if (href.startsWith('#')) {
      const raw = decodeURIComponent(href.slice(1)).toLowerCase();
      const headings = Array.from(elPreview.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      const hit = headings.find((h) => h.id.toLowerCase() === raw || h.textContent.trim().toLowerCase() === raw);
      if (hit) hit.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) {
      api('/api/open-external', { url: href }).catch(() => {});
      return;
    }
    // Local relative markdown file link (e.g. ./01_Education.md)
    const cleanHref = decodeURIComponent(href.split('#')[0].split('?')[0]);
    if (/\.(md|markdown|mdown|txt)$/i.test(cleanHref)) {
      openFileByPath(cleanHref, { baseDir: state.dirPath, pushHistory: true });
    } else {
      showToast('不支持直接打开该链接：' + href);
    }
  });

  function toggleTaskCheckboxInSource(targetIdx, checked) {
    const lines = state.content.split('\n');
    let seen = 0;
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = lines[i].match(/^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\]\s*.*)$/);
      if (m) {
        if (seen === targetIdx) {
          lines[i] = m[1] + (checked ? 'x' : ' ') + m[3];
          state.content = lines.join('\n');
          elEditor.value = state.content;
          updateTitleAndDirty();
          showToast('已更新待办状态（Ctrl+S 保存）');
          return;
        }
        seen++;
      }
    }
  }

  // ---------- Editor Helpers & Formatting ----------
  elEditor.addEventListener('input', () => {
    state.content = elEditor.value;
    updateTitleAndDirty();
    updateWordStats();
    updateCursorPos();
    if (state.mode === 'split') {
      clearTimeout(state.renderTimer);
      state.renderTimer = setTimeout(renderMarkdown, 60);
    }
  });

  function updateCursorPos() {
    const pos = elEditor.selectionStart || 0;
    const before = elEditor.value.slice(0, pos);
    const lines = before.split('\n');
    elStatusCursor.textContent = `行 ${lines.length}, 列 ${lines[lines.length - 1].length + 1}`;
  }
  elEditor.addEventListener('keyup', updateCursorPos);
  elEditor.addEventListener('click', updateCursorPos);

  function wrapSelection(before, after, placeholder) {
    const start = elEditor.selectionStart;
    const end = elEditor.selectionEnd;
    const sel = elEditor.value.slice(start, end) || placeholder;
    const replacement = before + sel + after;
    elEditor.setRangeText(replacement, start, end, 'select');
    if (start === end) {
      elEditor.setSelectionRange(start + before.length, start + before.length + placeholder.length);
    }
    elEditor.dispatchEvent(new Event('input'));
    elEditor.focus();
  }

  function prefixLine(prefix) {
    const start = elEditor.selectionStart;
    const val = elEditor.value;
    const lineStart = val.lastIndexOf('\n', start - 1) + 1;
    elEditor.setRangeText(prefix, lineStart, lineStart, 'end');
    elEditor.dispatchEvent(new Event('input'));
    elEditor.focus();
  }

  const FORMAT_ACTIONS = {
    h1: () => prefixLine('# '),
    h2: () => prefixLine('## '),
    h3: () => prefixLine('### '),
    bold: () => wrapSelection('**', '**', '加粗文字'),
    italic: () => wrapSelection('*', '*', '斜体文字'),
    strike: () => wrapSelection('~~', '~~', '删除线'),
    code: () => wrapSelection('`', '`', 'code'),
    quote: () => prefixLine('> '),
    ul: () => prefixLine('- '),
    ol: () => prefixLine('1. '),
    task: () => prefixLine('- [ ] '),
    codeblock: () => wrapSelection('\n```\n', '\n```\n', '// 在这里输入代码'),
    table: () => wrapSelection('\n| 列 1 | 列 2 | 列 3 |\n| :--- | :--- | :--- |\n| ', ' | 内容 | 内容 |\n', '内容'),
    link: () => wrapSelection('[', '](https://)', '链接文字'),
    hr: () => wrapSelection('\n---\n', '', ''),
  };

  elFormatBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fmt]');
    if (!btn) return;
    const fmt = btn.dataset.fmt;
    if (state.mode === 'edit') {
      applyWysiwygFormat(fmt);
    } else {
      const fn = FORMAT_ACTIONS[fmt];
      if (fn) fn();
    }
  });

  // ---------- WYSIWYG Preview Editing ----------
  let wysiwygSyncTimer = null;
  elPreview.addEventListener('input', () => {
    if (state.mode !== 'edit') return;
    clearTimeout(wysiwygSyncTimer);
    wysiwygSyncTimer = setTimeout(() => {
      syncFromWysiwyg();
      refreshTOCFromPreviewDOM();
    }, 90);
  });

  elPreview.addEventListener('paste', (e) => {
    if (state.mode !== 'edit') return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (text) {
      document.execCommand('insertText', false, text);
    }
  });

  function getClosestInSelection(selector) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let node = sel.anchorNode;
    if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    return node && node.closest ? node.closest(selector) : null;
  }

  function insertTableRow(table, afterRow) {
    const refRow = afterRow || table.rows[table.rows.length - 1];
    if (!refRow) return null;
    const colCount = refRow.cells.length || 2;
    const tbody = table.tBodies[0] || table;
    const newRow = document.createElement('tr');
    for (let i = 0; i < colCount; i++) {
      const td = document.createElement('td');
      td.innerHTML = '<br>';
      newRow.appendChild(td);
    }
    if (afterRow && afterRow.parentNode === tbody && afterRow.nextSibling) {
      tbody.insertBefore(newRow, afterRow.nextSibling);
    } else {
      tbody.appendChild(newRow);
    }
    return newRow;
  }

  function insertTableCol(table, colIdx) {
    Array.from(table.rows).forEach((row, rIdx) => {
      const isHead = row.parentNode && row.parentNode.tagName === 'THEAD';
      const cell = document.createElement(isHead || rIdx === 0 ? 'th' : 'td');
      cell.innerHTML = isHead ? '新列' : '<br>';
      const ref = row.cells[colIdx + 1] || null;
      row.insertBefore(cell, ref);
    });
  }

  function focusCell(cell) {
    if (!cell) return;
    const range = document.createRange();
    range.selectNodeContents(cell);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  elPreview.addEventListener('keydown', (e) => {
    if (state.mode !== 'edit') return;

    // Tab navigation inside tables or indent in lists
    if (e.key === 'Tab') {
      const cell = getClosestInSelection('td, th');
      if (cell) {
        e.preventDefault();
        const table = cell.closest('table');
        const cells = Array.from(table.querySelectorAll('th, td'));
        const idx = cells.indexOf(cell);
        if (e.shiftKey) {
          if (idx > 0) focusCell(cells[idx - 1]);
        } else {
          if (idx + 1 < cells.length) {
            focusCell(cells[idx + 1]);
          } else {
            const newRow = insertTableRow(table, cell.closest('tr'));
            if (newRow && newRow.cells[0]) focusCell(newRow.cells[0]);
            syncFromWysiwyg();
          }
        }
        return;
      }
      if (getClosestInSelection('li')) {
        e.preventDefault();
        document.execCommand(e.shiftKey ? 'outdent' : 'indent');
        return;
      }
    }

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); applyWysiwygFormat('bold'); }
      else if (k === 'i') { e.preventDefault(); applyWysiwygFormat('italic'); }
      else if (k === 'k') { e.preventDefault(); applyWysiwygFormat('link'); }
      else if (k === '`') { e.preventDefault(); applyWysiwygFormat('code'); }
    }
  });

  function applyWysiwygFormat(fmt) {
    elPreview.focus();
    const sel = window.getSelection();
    const selectedText = sel ? sel.toString() : '';

    switch (fmt) {
      case 'h1': document.execCommand('formatBlock', false, 'H1'); break;
      case 'h2': document.execCommand('formatBlock', false, 'H2'); break;
      case 'h3': document.execCommand('formatBlock', false, 'H3'); break;
      case 'bold': document.execCommand('bold'); break;
      case 'italic': document.execCommand('italic'); break;
      case 'strike': document.execCommand('strikeThrough'); break;
      case 'quote': document.execCommand('formatBlock', false, 'BLOCKQUOTE'); break;
      case 'ul': document.execCommand('insertUnorderedList'); break;
      case 'ol': document.execCommand('insertOrderedList'); break;
      case 'hr': document.execCommand('insertHorizontalRule'); break;
      case 'code': {
        const txt = LightHighlight.escapeHtml(selectedText || 'code');
        document.execCommand('insertHTML', false, `<code>${txt}</code>&nbsp;`);
        break;
      }
      case 'task': {
        const txt = LightHighlight.escapeHtml(selectedText || '待办事项');
        document.execCommand('insertHTML', false, `<ul><li><input type="checkbox"> ${txt}</li></ul>`);
        break;
      }
      case 'codeblock': {
        const txt = LightHighlight.escapeHtml(selectedText || '// 在这里输入代码');
        document.execCommand(
          'insertHTML',
          false,
          `<div class="code-block-wrap"><div class="code-block-head" contenteditable="false"><span>text</span></div><pre><code>${txt}</code></pre></div><p><br></p>`
        );
        break;
      }
      case 'table': {
        document.execCommand(
          'insertHTML',
          false,
          `<div class="table-wrap"><table><thead><tr><th>列 1</th><th>列 2</th><th>列 3</th></tr></thead><tbody><tr><td>内容</td><td>内容</td><td>内容</td></tr></tbody></table></div><p><br></p>`
        );
        break;
      }
      case 'table-row': {
        const tr = getClosestInSelection('tr');
        const tbl = tr && tr.closest('table');
        if (tbl) {
          const nr = insertTableRow(tbl, tr);
          if (nr && nr.cells[0]) focusCell(nr.cells[0]);
        } else {
          showToast('请先把光标放在表格内');
        }
        break;
      }
      case 'table-col': {
        const cell = getClosestInSelection('td, th');
        const tbl = cell && cell.closest('table');
        if (tbl) {
          insertTableCol(tbl, cell.cellIndex);
        } else {
          showToast('请先把光标放在表格内');
        }
        break;
      }
      case 'link': {
        const url = window.prompt('请输入链接地址：', 'https://');
        if (url) {
          if (selectedText) {
            document.execCommand('createLink', false, url);
          } else {
            const safeUrl = LightHighlight.escapeHtml(url);
            document.execCommand('insertHTML', false, `<a href="${safeUrl}">${safeUrl}</a>`);
          }
        }
        break;
      }
    }
    syncFromWysiwyg();
    refreshTOCFromPreviewDOM();
  }

  // Smart Tab indent & Enter list continuation
  elEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = elEditor.selectionStart;
      const end = elEditor.selectionEnd;
      if (start === end && !e.shiftKey) {
        elEditor.setRangeText('  ', start, end, 'end');
      } else {
        const val = elEditor.value;
        const lineStart = val.lastIndexOf('\n', start - 1) + 1;
        const block = val.slice(lineStart, end);
        const lines = block.split('\n');
        const next = e.shiftKey
          ? lines.map((l) => l.replace(/^ {1,2}|\t/, '')).join('\n')
          : lines.map((l) => '  ' + l).join('\n');
        elEditor.setRangeText(next, lineStart, end, 'select');
      }
      elEditor.dispatchEvent(new Event('input'));
      return;
    }

    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      const pos = elEditor.selectionStart;
      if (pos === elEditor.selectionEnd) {
        const val = elEditor.value;
        const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
        const line = val.slice(lineStart, pos);
        const taskM = line.match(/^(\s*[-*+]\s+\[[ xX]\]\s+)(.*)$/);
        const ulM = line.match(/^(\s*[-*+]\s+)(.*)$/);
        const olM = line.match(/^(\s*)(\d+)(\.\s+)(.*)$/);
        const qtM = line.match(/^(\s*>\s+)(.*)$/);

        if (taskM) {
          e.preventDefault();
          if (!taskM[2]) {
            elEditor.setRangeText('\n', lineStart, pos, 'end');
          } else {
            elEditor.setRangeText('\n' + taskM[1].replace(/\[[xX]\]/, '[ ]'), pos, pos, 'end');
          }
          elEditor.dispatchEvent(new Event('input'));
        } else if (ulM) {
          e.preventDefault();
          if (!ulM[2]) {
            elEditor.setRangeText('\n', lineStart, pos, 'end');
          } else {
            elEditor.setRangeText('\n' + ulM[1], pos, pos, 'end');
          }
          elEditor.dispatchEvent(new Event('input'));
        } else if (olM) {
          e.preventDefault();
          if (!olM[4]) {
            elEditor.setRangeText('\n', lineStart, pos, 'end');
          } else {
            elEditor.setRangeText('\n' + olM[1] + (parseInt(olM[2], 10) + 1) + olM[3], pos, pos, 'end');
          }
          elEditor.dispatchEvent(new Event('input'));
        } else if (qtM && qtM[2]) {
          e.preventDefault();
          elEditor.setRangeText('\n' + qtM[1], pos, pos, 'end');
          elEditor.dispatchEvent(new Event('input'));
        }
      }
    }
  });

  // Proportional scroll sync in Split mode + Active TOC highlight
  elEditor.addEventListener('scroll', () => {
    if (state.mode !== 'split' || state.syncingScroll) return;
    state.syncingScroll = true;
    const ratio = elEditor.scrollTop / Math.max(1, elEditor.scrollHeight - elEditor.clientHeight);
    elPreviewPane.scrollTop = ratio * (elPreviewPane.scrollHeight - elPreviewPane.clientHeight);
    requestAnimationFrame(() => (state.syncingScroll = false));
  });

  elPreviewPane.addEventListener('scroll', () => {
    if (state.mode === 'split' && !state.syncingScroll) {
      state.syncingScroll = true;
      const ratio = elPreviewPane.scrollTop / Math.max(1, elPreviewPane.scrollHeight - elPreviewPane.clientHeight);
      elEditor.scrollTop = ratio * (elEditor.scrollHeight - elEditor.clientHeight);
      requestAnimationFrame(() => (state.syncingScroll = false));
    }
    updateActiveTOC();
  });

  function updateActiveTOC() {
    if (!state.sidebarOpen || state.sidebarTab !== 'toc') return;
    const headings = Array.from(elPreview.querySelectorAll('h1, h2, h3, h4'));
    if (!headings.length) return;
    const paneTop = elPreviewPane.getBoundingClientRect().top;
    let activeId = headings[0].id;
    for (const h of headings) {
      if (h.getBoundingClientRect().top - paneTop <= 64) {
        activeId = h.id;
      } else {
        break;
      }
    }
    elSbToc.querySelectorAll('.toc-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.targetId === activeId);
    });
  }

  // ---------- Find Bar ----------
  function clearFindHighlights() {
    elPreview.querySelectorAll('mark.find-hit').forEach((m) => {
      m.replaceWith(document.createTextNode(m.textContent));
    });
    elPreview.normalize();
    state.findHits = [];
    state.findIndex = -1;
    elFindCount.textContent = '0/0';
  }

  function openFindBar() {
    elFindBar.classList.add('show');
    elFindInput.focus();
    elFindInput.select();
    if (elFindInput.value) runFind(elFindInput.value, true);
  }

  function closeFindBar() {
    elFindBar.classList.remove('show');
    clearFindHighlights();
  }

  function runFind(query, scrollToFirst = true) {
    clearFindHighlights();
    const q = (query || '').trim();
    if (!q) return;

    if (state.mode === 'edit') {
      const idx = elEditor.value.toLowerCase().indexOf(q.toLowerCase());
      if (idx !== -1) {
        elEditor.focus();
        elEditor.setSelectionRange(idx, idx + q.length);
        elFindCount.textContent = '编辑区';
      } else {
        elFindCount.textContent = '0/0';
      }
      return;
    }

    const walker = document.createTreeWalker(elPreview, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && n.parentElement.closest('.code-block-head') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    const qLower = q.toLowerCase();
    const marks = [];
    for (const node of textNodes) {
      const val = node.nodeValue;
      const lower = val.toLowerCase();
      let pos = lower.indexOf(qLower);
      if (pos === -1) continue;

      const frag = document.createDocumentFragment();
      let last = 0;
      while (pos !== -1) {
        if (pos > last) frag.appendChild(document.createTextNode(val.slice(last, pos)));
        const mark = document.createElement('mark');
        mark.className = 'find-hit';
        mark.textContent = val.slice(pos, pos + q.length);
        frag.appendChild(mark);
        marks.push(mark);
        last = pos + q.length;
        pos = lower.indexOf(qLower, last);
      }
      if (last < val.length) frag.appendChild(document.createTextNode(val.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }

    state.findHits = marks;
    if (marks.length) {
      state.findIndex = 0;
      jumpFindHit(0, scrollToFirst);
    } else {
      elFindCount.textContent = '0/0';
    }
  }

  function jumpFindHit(idx, doScroll = true) {
    const n = state.findHits.length;
    if (!n) return;
    state.findIndex = ((idx % n) + n) % n;
    state.findHits.forEach((m, i) => m.classList.toggle('current', i === state.findIndex));
    elFindCount.textContent = `${state.findIndex + 1}/${n}`;
    if (doScroll) {
      state.findHits[state.findIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  elFindInput.addEventListener('input', () => runFind(elFindInput.value, true));
  elFindInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.mode === 'edit') {
        const q = elFindInput.value.toLowerCase();
        if (!q) return;
        const start = elEditor.selectionEnd || 0;
        let idx = elEditor.value.toLowerCase().indexOf(q, start);
        if (idx === -1) idx = elEditor.value.toLowerCase().indexOf(q, 0);
        if (idx !== -1) {
          elEditor.focus();
          elEditor.setSelectionRange(idx, idx + q.length);
        }
      } else {
        jumpFindHit(state.findIndex + (e.shiftKey ? -1 : 1));
      }
    } else if (e.key === 'Escape') {
      closeFindBar();
    }
  });
  $('find-prev').addEventListener('click', () => jumpFindHit(state.findIndex - 1));
  $('find-next').addEventListener('click', () => jumpFindHit(state.findIndex + 1));
  $('find-close').addEventListener('click', closeFindBar);

  // ---------- File Association & App Install UI ----------
  function updateInstallUI() {
    const ins = state.install || {};
    const statusLabel = $('install-status-label');
    const toggleBtn = $('btn-install-toggle');
    const welcomeInstall = $('welcome-install');

    if (ins.installed && ins.desktopShortcut && ins.startMenuShortcut) {
      statusLabel.textContent = '已安装（桌面 & 开始菜单）';
      toggleBtn.textContent = '卸载应用';
      toggleBtn.classList.remove('btn-accent');
      welcomeInstall.style.display = 'none';
    } else {
      statusLabel.textContent = '当前为绿色便携运行';
      toggleBtn.textContent = '安装为应用';
      toggleBtn.classList.add('btn-accent');
      welcomeInstall.style.display = 'flex';
    }
  }

  async function installDesktopApp() {
    try {
      const res = await api('/api/app/install', {});
      state.install = res.install || state.install;
      state.assoc = res.assoc || state.assoc;
      updateInstallUI();
      updateAssocUI();
      showToast('安装成功！已创建桌面与开始菜单图标');
    } catch (err) {
      showToast('安装失败：' + err.message);
    }
  }

  async function uninstallDesktopApp() {
    if (!window.confirm('确定要卸载 LightMD 桌面应用并移除桌面/开始菜单快捷方式吗？')) return;
    try {
      const res = await api('/api/app/uninstall', {});
      state.install = res.install || state.install;
      state.assoc = res.assoc || state.assoc;
      updateInstallUI();
      updateAssocUI();
      showToast('已卸载桌面应用');
    } catch (err) {
      showToast('卸载失败：' + err.message);
    }
  }

  $('btn-install-toggle').addEventListener('click', () => {
    if (state.install.installed) uninstallDesktopApp();
    else installDesktopApp();
  });
  $('btn-welcome-install').addEventListener('click', installDesktopApp);

  function buildExportDocument(format) {
    if (!state.hasDoc) return '';
    // Clone rendered preview without copy buttons
    const clone = elPreview.cloneNode(true);
    clone.querySelectorAll('.code-copy-btn').forEach((b) => b.remove());
    const bodyHtml = clone.innerHTML;
    const title = LightHighlight.escapeHtml(state.fileName || 'LightMD 文档');

    if (format === 'doc') {
      return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; font-size: 11pt; line-height: 1.75; color: #1f2328; }
  h1 { font-size: 20pt; border-bottom: 1pt solid #d0d7de; padding-bottom: 4pt; margin-top: 16pt; }
  h2 { font-size: 15pt; border-bottom: 0.5pt solid #e5e7eb; padding-bottom: 3pt; margin-top: 14pt; }
  h3 { font-size: 12.5pt; margin-top: 11pt; }
  p { margin: 0 0 8pt; }
  blockquote { border-left: 3pt solid #3b82f6; background: #f8fafc; padding: 6pt 10pt; color: #57606a; margin: 8pt 0; }
  table { border-collapse: collapse; width: 100%; margin: 10pt 0; }
  th, td { border: 1pt solid #d0d7de; padding: 6pt 8pt; text-align: left; }
  th { background: #f3f5f8; font-weight: bold; }
  pre, code { font-family: Consolas, "Courier New", monospace; background: #f4f6f8; }
  pre { padding: 8pt 10pt; border: 1pt solid #e5e7eb; }
  code { padding: 1pt 3pt; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 820px; margin: 40px auto; padding: 0 24px; line-height: 1.8; color: #1f2328; }
  h1, h2 { border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
  blockquote { border-left: 4px solid #3b82f6; background: #f8fafc; padding: 8px 14px; margin: 12px 0; color: #57606a; }
  table { border-collapse: collapse; width: 100%; margin: 14px 0; }
  th, td { border: 1px solid #d0d7de; padding: 8px 12px; text-align: left; }
  th { background: #f3f5f8; }
  pre { background: #f4f6f8; padding: 12px 16px; border-radius: 8px; overflow-x: auto; }
  code { font-family: Consolas, monospace; background: #f1f3f5; padding: 2px 5px; border-radius: 4px; }
  pre code { background: transparent; padding: 0; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
  }

  async function exportDocument(format) {
    if (!state.hasDoc) {
      showToast('请先打开或新建一个文档');
      return;
    }
    if (state.mode === 'edit') syncFromWysiwyg();
    try {
      const htmlContent = buildExportDocument(format);
      const res = await api('/api/export', {
        format,
        content: htmlContent,
        dir: state.dirPath,
        suggestedName: state.fileName || '文档',
      });
      if (!res.cancelled) {
        showToast('已导出：' + res.fileName);
      }
    } catch (err) {
      showToast('导出失败：' + err.message);
    }
  }
  function updateAssocUI() {
    const a = state.assoc || {};
    const statusLabel = $('assoc-status-label');
    const toggleBtn = $('btn-assoc-toggle');
    const hint = $('assoc-hint');
    const winBtn = $('btn-open-win-defaults');
    const welcomeBanner = $('welcome-assoc');
    const welcomeText = $('welcome-assoc-text');
    const welcomeBtn = $('btn-welcome-assoc');

    if (a.isDefault) {
      statusLabel.textContent = '已设为 .md 默认打开方式';
      toggleBtn.textContent = '取消关联';
      toggleBtn.classList.remove('btn-accent');
      hint.style.display = 'none';
      winBtn.style.display = 'none';
      welcomeBanner.style.display = 'none';
    } else if (a.registered && a.userChoiceProgId) {
      statusLabel.textContent = '已注册（等待设为默认）';
      toggleBtn.textContent = '取消关联';
      toggleBtn.classList.remove('btn-accent');
      hint.style.display = 'block';
      hint.textContent = `Windows 当前将 .md 锁定给了 ${a.userChoiceProgId}。请右键任意 .md 文件 →「打开方式」→「选择其他应用」→ 选择 LightMD → 点击「始终」。`;
      winBtn.style.display = 'block';
      welcomeBanner.style.display = 'flex';
      welcomeBanner.classList.add('done');
      welcomeText.textContent = `已注册到打开方式列表（当前默认：${a.userChoiceProgId}），右键 .md 选择 LightMD 并点「始终」即可`;
      welcomeBtn.textContent = '打开默认应用设置';
    } else {
      statusLabel.textContent = '尚未关联 .md 文件';
      toggleBtn.textContent = '一键设为默认';
      toggleBtn.classList.add('btn-accent');
      hint.style.display = 'none';
      winBtn.style.display = 'none';
      welcomeBanner.style.display = 'flex';
      welcomeBanner.classList.remove('done');
      welcomeText.innerHTML = '设为默认打开方式后，双击任意 <code>.md</code> 文件即可直接阅读与编辑';
      welcomeBtn.textContent = '一键关联 .md';
    }
  }

  async function registerAssoc() {
    try {
      state.assoc = await api('/api/assoc/register', {});
      updateAssocUI();
      if (state.assoc.isDefault) {
        showToast('已成功设为 .md 默认打开程序！');
      } else {
        showToast('已注册！如双击仍由旧程序打开，请右键 .md → 打开方式 → 选择 LightMD');
      }
    } catch (err) {
      showToast('注册失败：' + err.message);
    }
  }

  async function unregisterAssoc() {
    try {
      state.assoc = await api('/api/assoc/unregister', {});
      updateAssocUI();
      showToast('已取消 .md 文件关联');
    } catch (err) {
      showToast('取消失败：' + err.message);
    }
  }

  $('btn-assoc-toggle').addEventListener('click', () => {
    if (state.assoc.registered) unregisterAssoc();
    else registerAssoc();
  });
  $('btn-welcome-assoc').addEventListener('click', () => {
    if (state.assoc.registered && !state.assoc.isDefault) {
      api('/api/open-default-apps', {}).catch(() => {});
    } else {
      registerAssoc();
    }
  });
  $('btn-open-win-defaults').addEventListener('click', () => {
    api('/api/open-default-apps', {}).catch(() => {});
  });

  // ---------- Toolbar & Settings Events ----------
  elBtnSidebar.addEventListener('click', () => setSidebar(!state.sidebarOpen));
  document.querySelectorAll('.sb-tab').forEach((b) => {
    b.addEventListener('click', () => switchSidebarTab(b.dataset.tab));
  });
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });
  $('btn-open').addEventListener('click', openFileDialog);
  $('btn-welcome-open').addEventListener('click', openFileDialog);
  $('btn-new').addEventListener('click', startNewDocument);
  $('btn-welcome-new').addEventListener('click', startNewDocument);
  elBtnSave.addEventListener('click', () => saveCurrentFile(false));
  $('btn-export-doc').addEventListener('click', () => exportDocument('doc'));
  $('btn-export-html').addEventListener('click', () => {
    elPopover.classList.remove('show');
    exportDocument('html');
  });
  $('btn-print').addEventListener('click', () => {
    if (!state.hasDoc) { showToast('请先打开或新建一个文档'); return; }
    if (state.mode === 'edit') syncFromWysiwyg();
    window.print();
  });
  $('btn-save-as').addEventListener('click', () => saveCurrentFile(true));
  $('btn-find').addEventListener('click', openFindBar);
  $('btn-font-dec').addEventListener('click', () => applyFontSize(state.fontSize - 1));
  $('btn-font-inc').addEventListener('click', () => applyFontSize(state.fontSize + 1));

  elBtnTheme.addEventListener('click', () => {
    const idx = THEMES.findIndex((t) => t.key === state.theme);
    applyTheme(THEMES[(idx + 1) % THEMES.length].key);
  });

  elBtnBack.addEventListener('click', () => {
    if (!state.historyBack.length) return;
    const prev = state.historyBack.pop();
    openFileByPath(prev, { pushHistory: false });
  });

  $('file-pill').addEventListener('click', () => {
    if (state.filePath) {
      api('/api/reveal', { path: state.filePath }).catch(() => {});
    }
  });
  $('btn-reveal').addEventListener('click', () => {
    if (state.filePath) {
      api('/api/reveal', { path: state.filePath }).catch(() => {});
      elPopover.classList.remove('show');
    } else {
      showToast('当前尚未打开本地文件');
    }
  });
  $('chk-wide').addEventListener('change', (e) => applyWideReading(e.target.checked));
  $('chk-page-view').addEventListener('change', (e) => applyPageView(e.target.checked));

  $('btn-settings').addEventListener('click', (e) => {
    e.stopPropagation();
    elPopover.classList.toggle('show');
    if (elPopover.classList.contains('show')) {
      api('/api/assoc/status').then((st) => {
        state.assoc = st;
        updateAssocUI();
      }).catch(() => {});
    }
  });
  document.addEventListener('click', (e) => {
    if (!elPopover.contains(e.target) && e.target !== $('btn-settings')) {
      elPopover.classList.remove('show');
    }
  });

  // External change watcher (lightweight poll every 3s when window has focus)
  setInterval(async () => {
    if (!document.hasFocus() || !state.filePath || !state.mtime) return;
    try {
      const st = await api('/api/stat', { path: state.filePath });
      if (st.exists && st.mtime && st.mtime !== state.mtime) {
        elBtnReloadExt.classList.add('show');
      }
    } catch {}
  }, 3000);

  elBtnReloadExt.addEventListener('click', () => {
    if (state.filePath) openFileByPath(state.filePath, { pushHistory: false });
  });

  // ---------- Drag & Drop ----------
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    elDropOverlay.classList.add('show');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) elDropOverlay.classList.remove('show');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    elDropOverlay.classList.remove('show');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!confirmDiscardIfDirty()) return;
    const text = await file.text();
    loadDocument({
      filePath: '',
      fileName: file.name,
      dirPath: '',
      content: text.replace(/^\uFEFF/, ''),
      mtime: 0,
      siblings: [],
    });
    showToast('已载入 ' + file.name + '（如需直接覆盖原文件，请用 Ctrl+O 或双击打开）');
  });

  // ---------- Global Keyboard Shortcuts ----------
  window.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveCurrentFile(false);
    } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveCurrentFile(true);
    } else if (ctrl && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openFileDialog();
    } else if (ctrl && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      startNewDocument();
    } else if (ctrl && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      setMode(state.mode === 'read' ? 'edit' : 'read');
    } else if (ctrl && e.key === '1') {
      e.preventDefault();
      setMode('read');
    } else if (ctrl && e.key === '2') {
      e.preventDefault();
      setMode('edit');
    } else if (ctrl && e.key === '3') {
      e.preventDefault();
      setMode('split');
    } else if (ctrl && e.key === '\\') {
      e.preventDefault();
      setSidebar(!state.sidebarOpen);
    } else if (ctrl && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      if (state.hasDoc) {
        if (state.mode === 'edit') syncFromWysiwyg();
        window.print();
      }
    } else if (ctrl && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openFindBar();
    } else if (ctrl && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      applyFontSize(state.fontSize + 1);
    } else if (ctrl && e.key === '-') {
      e.preventDefault();
      applyFontSize(state.fontSize - 1);
    } else if (ctrl && e.key === '0') {
      e.preventDefault();
      applyFontSize(16);
    } else if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      elBtnBack.click();
    } else if (e.key === 'Escape') {
      if (elFindBar.classList.contains('show')) closeFindBar();
      elPopover.classList.remove('show');
    } else if (ctrl && document.activeElement === elEditor) {
      const k = e.key.toLowerCase();
      if (k === 'b') { e.preventDefault(); FORMAT_ACTIONS.bold(); }
      else if (k === 'i') { e.preventDefault(); FORMAT_ACTIONS.italic(); }
      else if (k === 'k') { e.preventDefault(); FORMAT_ACTIONS.link(); }
      else if (k === '`') { e.preventDefault(); FORMAT_ACTIONS.code(); }
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------- Bootstrap ----------
  async function init() {
    applyTheme(state.theme);
    applyFontSize(state.fontSize);
    applyWideReading(state.wideReading);
    applyPageView(state.pageView);

    try {
      const data = await api('/api/init');
      state.recent = data.recent || [];
      state.assoc = data.assoc || state.assoc;
      state.install = data.install || state.install;
      updateInstallUI();
      updateAssocUI();

      if (data.file) {
        loadDocument(data.file, { pushHistory: false });
        // Auto-open sidebar gently if siblings exist and window is wide enough
        if (window.innerWidth >= 1050 && (data.file.siblings?.length > 1 || elSbToc.children.length > 1)) {
          setSidebar(true, 'toc');
        }
      } else {
        renderWelcome();
        updateTitleAndDirty();
        if (data.initialErr) {
          showToast('无法打开指定文件：' + data.initialErr);
        }
      }
    } catch (err) {
      showToast('初始化失败：' + err.message);
    }
  }

  init();
})();
