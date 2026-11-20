// Ultra-lightweight syntax highlighter for LightMD (zero dependencies)
(function (global) {
  function escHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const KW = new Set([
    'const','let','var','function','return','if','else','for','while','do','switch','case','default',
    'break','continue','class','extends','new','this','super','import','export','from','as','async',
    'await','try','catch','finally','throw','typeof','instanceof','in','of','void','null','undefined',
    'true','false','def','elif','lambda','with','yield','pass','raise','except','None','True','False',
    'and','or','not','is','global','nonlocal','package','func','type','struct','interface','map','chan',
    'go','defer','select','range','nil','int','int64','string','bool','byte','error','float64','public',
    'private','protected','static','final','enum','implements','throws','auto','template','namespace',
    'using','sizeof','include','define','fn','pub','mod','use','mut','impl','trait','match','loop',
    'SELECT','FROM','WHERE','INSERT','INTO','VALUES','UPDATE','SET','DELETE','CREATE','TABLE','DROP',
    'ALTER','JOIN','LEFT','RIGHT','INNER','OUTER','ON','GROUP','BY','ORDER','LIMIT','AS','AND','OR',
    'NOT','NULL','PRIMARY','KEY','INDEX','DISTINCT','COUNT','SUM','AVG','MIN','MAX','echo','cd','ls',
    'export','fi','then','elif','esac','done','local'
  ]);

  function highlightCode(code, lang) {
    const l = (lang || '').toLowerCase().trim();
    if (!code) return '';
    if (l === 'json') return highlightJSON(code);
    if (l === 'html' || l === 'xml' || l === 'svg') return highlightHTML(code);

    const out = [];
    let i = 0;
    const n = code.length;
    const hashComment = ['py', 'python', 'sh', 'bash', 'zsh', 'yaml', 'yml', 'toml', 'ps1', 'powershell', 'rb', 'ruby', 'r'].includes(l);
    const dashComment = ['sql', 'lua', 'haskell'].includes(l);

    while (i < n) {
      const ch = code[i];
      const next = code[i + 1] || '';

      // Line comments
      if (ch === '/' && next === '/') {
        const end = code.indexOf('\n', i);
        const slice = end === -1 ? code.slice(i) : code.slice(i, end);
        out.push('<span class="hl-com">' + escHtml(slice) + '</span>');
        i += slice.length;
        continue;
      }
      if (hashComment && ch === '#') {
        const end = code.indexOf('\n', i);
        const slice = end === -1 ? code.slice(i) : code.slice(i, end);
        out.push('<span class="hl-com">' + escHtml(slice) + '</span>');
        i += slice.length;
        continue;
      }
      if (dashComment && ch === '-' && next === '-') {
        const end = code.indexOf('\n', i);
        const slice = end === -1 ? code.slice(i) : code.slice(i, end);
        out.push('<span class="hl-com">' + escHtml(slice) + '</span>');
        i += slice.length;
        continue;
      }
      // Block comment /* ... */
      if (ch === '/' && next === '*') {
        const end = code.indexOf('*/', i + 2);
        const slice = end === -1 ? code.slice(i) : code.slice(i, end + 2);
        out.push('<span class="hl-com">' + escHtml(slice) + '</span>');
        i += slice.length;
        continue;
      }
      // Strings
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = ch;
        let j = i + 1;
        while (j < n) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code[j] === q) { j++; break; }
          if (q !== '`' && code[j] === '\n') break;
          j++;
        }
        out.push('<span class="hl-str">' + escHtml(code.slice(i, j)) + '</span>');
        i = j;
        continue;
      }
      // Numbers
      if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z0-9_$]/.test(code[i - 1]))) {
        let j = i;
        while (j < n && /[0-9a-fA-FxX._]/.test(code[j])) j++;
        out.push('<span class="hl-num">' + escHtml(code.slice(i, j)) + '</span>');
        i = j;
        continue;
      }
      // Identifiers / keywords
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(code[j])) j++;
        const word = code.slice(i, j);
        if (KW.has(word) || (l === 'sql' && KW.has(word.toUpperCase()))) {
          out.push('<span class="hl-kw">' + escHtml(word) + '</span>');
        } else if (code[j] === '(') {
          out.push('<span class="hl-fn">' + escHtml(word) + '</span>');
        } else {
          out.push(escHtml(word));
        }
        i = j;
        continue;
      }

      out.push(escHtml(ch));
      i++;
    }
    return out.join('');
  }

  function highlightJSON(code) {
    return escHtml(code).replace(
      /(&quot;(?:\\.|[^&\\])*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      function (m, str, colon, bool) {
        if (str) {
          return colon
            ? '<span class="hl-kw">' + str + '</span>' + colon
            : '<span class="hl-str">' + str + '</span>';
        }
        if (bool) return '<span class="hl-kw">' + bool + '</span>';
        return '<span class="hl-num">' + m + '</span>';
      }
    );
  }

  function highlightHTML(code) {
    return escHtml(code)
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="hl-com">$1</span>')
      .replace(/(&lt;\/?[a-zA-Z0-9-]+)/g, '<span class="hl-kw">$1</span>')
      .replace(/(&quot;[^&]*?&quot;)/g, '<span class="hl-str">$1</span>');
  }

  global.LightHighlight = { highlight: highlightCode, escapeHtml: escHtml };
})(window);
