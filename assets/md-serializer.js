// Lightweight DOM-to-Markdown serializer for LightMD WYSIWYG editing
(function (global) {
  function cleanText(s) {
    return (s || '').replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n');
  }

  function serializeInline(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      return cleanText(node.nodeValue);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toUpperCase();
    if (tag === 'BR') return '\n';
    if (tag === 'INPUT' && node.type === 'checkbox') return '';
    if (node.classList && (node.classList.contains('code-block-head') || node.classList.contains('code-copy-btn'))) {
      return '';
    }

    let inner = '';
    for (const child of node.childNodes) {
      inner += serializeInline(child);
    }

    switch (tag) {
      case 'STRONG':
      case 'B':
        return inner.trim() ? `**${inner}**` : inner;
      case 'EM':
      case 'I':
        return inner.trim() ? `*${inner}*` : inner;
      case 'DEL':
      case 'S':
      case 'STRIKE':
        return inner.trim() ? `~~${inner}~~` : inner;
      case 'CODE': {
        const raw = cleanText(node.textContent);
        if (!raw) return '';
        if (raw.includes('`')) return '`` ' + raw + ' ``';
        return '`' + raw + '`';
      }
      case 'A': {
        const href = node.getAttribute('href') || '';
        if (!href) return inner;
        return `[${inner || href}](${href})`;
      }
      case 'IMG': {
        const src = node.dataset.origSrc || node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || '';
        return `![${alt}](${src})`;
      }
      case 'MARK':
        return inner;
      default:
        return inner;
    }
  }

  function serializeList(listEl, indentLevel) {
    const isOrdered = listEl.tagName.toUpperCase() === 'OL';
    const indent = '  '.repeat(indentLevel);
    const lines = [];
    let num = parseInt(listEl.getAttribute('start') || '1', 10) || 1;

    for (const li of listEl.children) {
      if (li.tagName.toUpperCase() !== 'LI') continue;

      const cb = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
      let prefix = isOrdered ? `${num++}. ` : '- ';
      if (cb) {
        prefix = `- [${cb.checked ? 'x' : ' '}] `;
      }

      let inlineParts = [];
      const subLists = [];
      for (const child of li.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const cTag = child.tagName.toUpperCase();
          if (cTag === 'UL' || cTag === 'OL') {
            subLists.push(child);
            continue;
          }
          if (cTag === 'P') {
            inlineParts.push(serializeChildrenInline(child).trim());
            continue;
          }
        }
        inlineParts.push(serializeInline(child));
      }

      const lineText = inlineParts.join('').replace(/\n+/g, ' ').trim();
      lines.push(indent + prefix + lineText);

      for (const sub of subLists) {
        lines.push(serializeList(sub, indentLevel + 1));
      }
    }
    return lines.join('\n');
  }

  function serializeChildrenInline(el) {
    let out = '';
    for (const child of el.childNodes) {
      out += serializeInline(child);
    }
    return out;
  }

  function serializeTable(tableEl) {
    const rows = Array.from(tableEl.querySelectorAll('tr'));
    if (!rows.length) return '';

    const grid = rows.map((tr) =>
      Array.from(tr.children)
        .filter((c) => c.tagName === 'TH' || c.tagName === 'TD')
        .map((cell) => serializeChildrenInline(cell).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim())
    );

    const colCount = Math.max(...grid.map((r) => r.length), 1);
    const padRow = (r) => {
      const copy = r.slice();
      while (copy.length < colCount) copy.push('');
      return '| ' + copy.join(' | ') + ' |';
    };

    const alignments = [];
    const firstRowCells = Array.from(rows[0].children).filter((c) => c.tagName === 'TH' || c.tagName === 'TD');
    for (let i = 0; i < colCount; i++) {
      const align = (firstRowCells[i]?.style?.textAlign || firstRowCells[i]?.getAttribute('align') || '').toLowerCase();
      if (align === 'center') alignments.push(':---:');
      else if (align === 'right') alignments.push('---:');
      else alignments.push(':---');
    }

    const out = [padRow(grid[0]), '| ' + alignments.join(' | ') + ' |'];
    for (let i = 1; i < grid.length; i++) {
      out.push(padRow(grid[i]));
    }
    return out.join('\n');
  }

  function serializeCodeBlock(wrapOrPre) {
    let lang = '';
    let pre = wrapOrPre;
    if (wrapOrPre.classList && wrapOrPre.classList.contains('code-block-wrap')) {
      const headSpan = wrapOrPre.querySelector('.code-block-head > span');
      if (headSpan) {
        const t = headSpan.textContent.trim();
        if (t && t !== 'text') lang = t;
      }
      pre = wrapOrPre.querySelector('pre') || wrapOrPre;
    }
    const codeEl = pre.querySelector('code') || pre;
    if (!lang && codeEl.className) {
      const m = codeEl.className.match(/language-([\w+-]+)/i);
      if (m) lang = m[1];
    }
    const code = cleanText(codeEl.textContent).replace(/\n$/, '');
    const fence = code.includes('```') ? '~~~~' : '```';
    return `${fence}${lang}\n${code}\n${fence}`;
  }

  function serializeBlock(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      const t = cleanText(node.nodeValue).trim();
      return t;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toUpperCase();
    if (node.classList && node.classList.contains('code-block-wrap')) {
      return serializeCodeBlock(node);
    }
    if (node.classList && node.classList.contains('table-wrap')) {
      const tbl = node.querySelector('table');
      return tbl ? serializeTable(tbl) : '';
    }

    switch (tag) {
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6': {
        const level = parseInt(tag.slice(1), 10);
        const text = serializeChildrenInline(node).replace(/\n+/g, ' ').trim();
        return '#'.repeat(level) + ' ' + text;
      }
      case 'P': {
        const text = serializeChildrenInline(node).replace(/\n+$/, '');
        return text.trim() === '' ? '' : text;
      }
      case 'DIV': {
        // Contenteditable often creates <div> for new lines
        const hasBlockChild = Array.from(node.children).some((c) =>
          ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR'].includes(c.tagName.toUpperCase())
        );
        if (hasBlockChild) {
          return serializeBlocks(node);
        }
        const text = serializeChildrenInline(node).replace(/\n+$/, '');
        return text.trim() === '' ? '' : text;
      }
      case 'HR':
        return '---';
      case 'PRE':
        return serializeCodeBlock(node);
      case 'BLOCKQUOTE': {
        const inner = serializeBlocks(node);
        return inner
          .split('\n')
          .map((line) => (line.trim() === '' ? '>' : '> ' + line))
          .join('\n');
      }
      case 'UL':
      case 'OL':
        return serializeList(node, 0);
      case 'TABLE':
        return serializeTable(node);
      default:
        return serializeChildrenInline(node).trim();
    }
  }

  function serializeBlocks(container) {
    const blocks = [];
    for (const child of container.childNodes) {
      const b = serializeBlock(child);
      if (b !== '') {
        blocks.push(b);
      }
    }
    return blocks.join('\n\n') + (blocks.length ? '\n' : '');
  }

  global.LightMDSerializer = {
    toMarkdown: serializeBlocks,
  };
})(window);
