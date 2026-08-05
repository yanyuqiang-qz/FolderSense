/* 文件夹浏览器：树形 / 列表 两种模式，虚拟滚动 + 懒加载 */
(function () {
  'use strict';

  const ROW_H = 30;
  const OVERSCAN = 10;

  let scroller, spacer, rowsEl, emptyEl, crumbsEl;
  let rows = [];
  let lastWindow = { start: -1, end: -1 };
  let pendingAnn = new Set();

  const Explorer = {};

  Explorer.init = function () {
    scroller = U.$('#treeScroller');
    spacer = U.$('#treeSpacer');
    rowsEl = U.$('#treeRows');
    emptyEl = U.$('#treeEmpty');
    crumbsEl = U.$('#crumbs');

    scroller.addEventListener('scroll', () => renderWindow());
    window.addEventListener('resize', () => renderWindow(true));

    S.on('ann', U.debounce(() => renderWindow(true), 60));
    S.on('tags', () => renderWindow(true));
  };

  /* ---------------- 数据加载 ---------------- */
  function optKey() {
    return [S.sort, S.filter, S.typeFilter, S.showFiles, S.showHidden].join('|');
  }
  let currentOptKey = null;

  Explorer.resetCache = function () {
    S.children.clear();
    currentOptKey = optKey();
  };

  async function loadChildren(dirPath) {
    if (currentOptKey !== optKey()) Explorer.resetCache();
    if (S.children.has(dirPath)) return S.children.get(dirPath);
    if (S.loading.has(dirPath)) return null;
    S.loading.add(dirPath);
    try {
      const res = await U.call('fsList', dirPath, {
        sort: S.sort,
        query: S.filter,
        typeFilter: S.typeFilter === 'folder' ? '' : S.typeFilter,
        onlyDirs: !S.showFiles || S.typeFilter === 'folder',
        showHidden: S.showHidden,
        limit: 3000,
      });
      S.children.set(dirPath, res.entries);
      if (res.truncated) {
        U.toast(`「${U.basename(dirPath)}」条目过多（${res.rawTotal} 项），仅显示前 ${res.entries.length} 项`, 'warn', 5000);
      }
      return res.entries;
    } catch (e) {
      S.children.set(dirPath, []);
      U.toast(e.message, 'err');
      return [];
    } finally {
      S.loading.delete(dirPath);
      Explorer.render();
    }
  }
  Explorer.loadChildren = loadChildren;

  /* ---------------- 行构建 ---------------- */
  function buildRows() {
    const out = [];

    if (S.searchResults) {
      for (const r of S.searchResults) {
        out.push({
          path: r.path, name: r.name, isDir: r.isDir !== false, depth: 0,
          size: r.size, mtimeMs: r.mtimeMs, cat: r.isDir === false ? 'other' : 'folder',
          showPath: true, expandable: false,
        });
      }
      return out;
    }

    if (S.mode === 'list') {
      const cwd = S.cwd;
      if (!cwd) return out;
      const parent = U.dirname(cwd);
      if (parent && parent !== cwd) {
        out.push({ path: parent, name: '.. 返回上一级', isDir: true, depth: 0, cat: 'folder', isUp: true, expandable: false });
      }
      const kids = S.children.get(cwd);
      if (kids) {
        for (const e of kids) out.push(entryRow(e, 0));
      } else {
        loadChildren(cwd);
        out.push({ loadingRow: true, path: cwd + '#loading', depth: 0 });
      }
      return out;
    }

    // 树形
    const roots = [
      ...S.roots.custom.map((r) => ({ ...r, custom: true })),
      ...S.roots.system,
    ];
    for (const r of roots) {
      pushNode(out, { path: r.path, name: r.name, isDir: true, cat: 'folder' }, 0);
    }
    return out;
  }

  function pushNode(out, node, depth) {
    const row = { ...node, depth, expandable: node.isDir };
    out.push(row);
    if (node.isDir && S.expanded.has(node.path)) {
      row.open = true;
      const kids = S.children.get(node.path);
      if (kids === undefined) {
        if (S.loading.has(node.path)) {
          out.push({ loadingRow: true, path: node.path + '#loading', depth: depth + 1 });
        } else {
          loadChildren(node.path);
          out.push({ loadingRow: true, path: node.path + '#loading', depth: depth + 1 });
        }
      } else if (kids.length === 0) {
        out.push({ emptyRow: true, path: node.path + '#empty', depth: depth + 1 });
      } else {
        for (const e of kids) {
          if (e.isDir) pushNode(out, entryRow(e, depth + 1), depth + 1);
          else out.push(entryRow(e, depth + 1));
        }
      }
    }
    return row;
  }

  function entryRow(e, depth) {
    return {
      path: e.path, name: e.name, isDir: e.isDir, depth,
      size: e.size, mtimeMs: e.mtimeMs, cat: e.cat, ext: e.ext,
      hidden: e.hidden, isLink: e.isLink, expandable: e.isDir,
    };
  }

  /* ---------------- 渲染 ---------------- */
  Explorer.render = function () {
    rows = buildRows();
    spacer.style.height = Math.max(rows.length * ROW_H, 1) + 'px';
    lastWindow = { start: -1, end: -1 };
    renderWindow(true);
    renderCrumbs();
    updateBulkBar();

    const isEmpty = rows.length === 0;
    emptyEl.hidden = !isEmpty;
    if (isEmpty) {
      emptyEl.innerHTML = S.searchResults
        ? '<b>没有找到匹配的文件夹</b>换个关键词试试，或者先在「设置」里建立扫描索引。'
        : '<b>这里空空如也</b>换个位置看看，或调整上方的筛选条件。';
    }
  };

  function renderWindow(force) {
    const st = scroller.scrollTop;
    const h = scroller.clientHeight || 600;
    let start = Math.max(0, Math.floor(st / ROW_H) - OVERSCAN);
    let end = Math.min(rows.length, Math.ceil((st + h) / ROW_H) + OVERSCAN);
    if (!force && start === lastWindow.start && end === lastWindow.end) return;
    lastWindow = { start, end };

    rowsEl.style.transform = `translateY(${start * ROW_H}px)`;
    const frag = document.createDocumentFragment();
    const wantAnn = [];
    for (let i = start; i < end; i++) {
      const r = rows[i];
      if (!r) continue;
      frag.appendChild(renderRow(r));
      if (!r.isUp && !r.loadingRow && !r.emptyRow && !S.ann.has(r.path)) wantAnn.push(r.path);
    }
    rowsEl.replaceChildren(frag);

    if (wantAnn.length) {
      wantAnn.forEach((p) => pendingAnn.add(p));
      flushAnn();
    }
  }

  const flushAnn = U.debounce(async () => {
    const list = [...pendingAnn];
    pendingAnn.clear();
    if (list.length) await S.loadAnn(list);
  }, 90);

  function renderRow(r) {
    if (r.loadingRow) {
      return U.el('div', { class: 'row', style: { paddingLeft: (r.depth * 16 + 26) + 'px' } }, [
        U.el('div', { class: 'spin' }),
        U.el('span', { class: 'summary', text: '正在读取…' }),
      ]);
    }
    if (r.emptyRow) {
      return U.el('div', { class: 'row', style: { paddingLeft: (r.depth * 16 + 26) + 'px' } }, [
        U.el('span', { class: 'summary', text: '（空文件夹）' }),
      ]);
    }

    const ann = S.ann.get(r.path) || null;
    const cls = ['row'];
    if (S.selected === r.path) cls.push('selected');
    if (S.checked.has(r.path)) cls.push('checked');
    if (r.open) cls.push('open');
    if (ann && ann.status === 'missing') cls.push('missing');

    const node = U.el('div', {
      class: cls.join(' '),
      dataset: { path: r.path },
      style: { paddingLeft: (r.depth * 16 + 4) + 'px' },
      title: r.path,
    });

    // 展开箭头
    if (S.mode === 'tree' && !S.searchResults) {
      const tw = U.el('div', { class: 'twisty' + (r.expandable ? '' : ' leaf') }, [U.icon('chevron')]);
      if (r.expandable) {
        tw.addEventListener('click', (e) => { e.stopPropagation(); Explorer.toggle(r.path); });
      }
      node.appendChild(tw);
    }

    // 勾选框（仅文件夹，用于批量操作）
    if (r.isDir && !r.isUp) {
      const cb = U.el('input', { type: 'checkbox', class: 'cb' });
      cb.checked = S.checked.has(r.path);
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        if (cb.checked) S.checked.add(r.path); else S.checked.delete(r.path);
        node.classList.toggle('checked', cb.checked);
        updateBulkBar();
      });
      node.appendChild(cb);
    } else {
      node.appendChild(U.el('span', { style: { width: '13px', flex: 'none' } }));
    }

    // 图标
    const ic = U.icon(r.isDir ? (r.open ? 'folder-open' : 'folder') : 'file', 'ficon ' + (r.isDir ? 'folder' : 'file'));
    if (!r.isDir) ic.style.color = U.CAT_COLOR[r.cat] || 'var(--text-faint)';
    node.appendChild(ic);

    node.appendChild(U.el('span', { class: 'name' + (r.isDir ? ' dir' : ''), text: r.name }));

    // 标签色点
    if (ann && ann.tags && ann.tags.length) {
      const tg = U.el('div', { class: 'rowtags' });
      ann.tags.slice(0, 5).forEach((t) => {
        tg.appendChild(U.el('i', { class: 'dot-tag', style: { background: t.color }, title: t.name }));
      });
      node.appendChild(tg);
    }

    // 摘要 / 路径
    let summaryText = '';
    if (r.showPath) summaryText = r.path;
    else if (ann && ann.summary) summaryText = ann.summary;
    else if (ann && ann.note) summaryText = '备注：' + ann.note;
    node.appendChild(U.el('span', { class: 'summary', text: summaryText }));

    // 置信度
    if (ann && ann.confidence != null) {
      node.appendChild(U.el('span', {
        class: 'conf',
        text: Math.round(ann.confidence * 100) + '%',
        title: 'AI 置信度',
        style: { color: U.confColor(ann.confidence), background: 'color-mix(in srgb, currentColor 14%, transparent)' },
      }));
    }

    if (!r.isUp) {
      node.appendChild(U.el('span', { class: 'meta', text: r.isDir ? '' : U.size(r.size) }));
      node.appendChild(U.el('span', { class: 'meta', text: U.date(r.mtimeMs) }));
    }

    node.addEventListener('click', () => Explorer.select(r));
    node.addEventListener('dblclick', () => Explorer.activate(r));
    node.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e, r); });
    return node;
  }

  /* ---------------- 交互 ---------------- */
  Explorer.select = function (r) {
    if (r.isUp) return;
    S.selected = r.path;
    renderWindow(true);
    if (r.isDir) Detail.show(r.path);
    else Detail.showFile(r);
  };

  Explorer.activate = function (r) {
    if (!r.isDir) { U.safeCall('fsOpen', r.path); return; }
    if (S.mode === 'list' || S.searchResults) Explorer.openDir(r.path);
    else Explorer.toggle(r.path);
  };

  Explorer.toggle = async function (p) {
    if (S.expanded.has(p)) S.expanded.delete(p);
    else {
      S.expanded.add(p);
      if (!S.children.has(p)) await loadChildren(p);
    }
    Explorer.render();
  };

  Explorer.openDir = async function (p) {
    S.searchResults = null;
    U.$('#globalSearch').value = '';
    if (S.mode === 'list') {
      S.cwd = p;
      if (!S.children.has(p)) await loadChildren(p);
    } else {
      // 树模式：展开到该路径
      const segs = U.splitPath(p);
      for (const seg of segs) {
        S.expanded.add(seg.path);
        if (!S.children.has(seg.path)) await loadChildren(seg.path);
      }
      S.cwd = p;
    }
    S.selected = p;
    Detail.show(p);
    Explorer.render();
    scrollToPath(p);
  };

  function scrollToPath(p) {
    const idx = rows.findIndex((r) => r.path === p);
    if (idx >= 0) {
      const target = idx * ROW_H - scroller.clientHeight / 3;
      scroller.scrollTop = Math.max(0, target);
      renderWindow(true);
    }
  }
  Explorer.scrollToPath = scrollToPath;

  Explorer.refreshCurrent = async function () {
    const targets = S.mode === 'list' ? [S.cwd] : [...S.expanded];
    for (const t of targets) {
      if (!t) continue;
      await U.safeCall('fsClearCache', t);
      S.children.delete(t);
    }
    Explorer.render();
    U.toast('已刷新', 'ok', 1500);
  };

  Explorer.setMode = function (m) {
    S.mode = m;
    if (m === 'list' && !S.cwd) {
      const first = S.roots.custom[0] || S.roots.system.find((r) => r.kind === 'home') || S.roots.system[0];
      S.cwd = first ? first.path : null;
    }
    S.searchResults = null;
    Explorer.render();
  };

  Explorer.showSearchResults = function (list) {
    S.searchResults = list;
    Explorer.render();
    scroller.scrollTop = 0;
  };

  Explorer.clearSearch = function () {
    if (!S.searchResults) return;
    S.searchResults = null;
    Explorer.render();
  };

  /* ---------------- 面包屑 ---------------- */
  function renderCrumbs() {
    crumbsEl.replaceChildren();
    if (S.searchResults) {
      crumbsEl.appendChild(U.el('span', { class: 'crumb last', text: `搜索结果（${S.searchResults.length} 项）` }));
      crumbsEl.appendChild(U.el('button', {
        class: 'btn ghost sm', text: '返回浏览', style: { marginLeft: '8px' },
        onclick: () => { U.$('#globalSearch').value = ''; Explorer.clearSearch(); },
      }));
      return;
    }
    const p = S.mode === 'list' ? S.cwd : (S.selected || S.cwd);
    if (!p) {
      crumbsEl.appendChild(U.el('span', { class: 'crumb last', text: '全部位置' }));
      return;
    }
    const segs = U.splitPath(p);
    segs.forEach((seg, i) => {
      if (i > 0) crumbsEl.appendChild(U.el('span', { class: 'crumb-sep', text: '›' }));
      crumbsEl.appendChild(U.el('span', {
        class: 'crumb' + (i === segs.length - 1 ? ' last' : ''),
        text: seg.name,
        title: seg.path,
        onclick: () => Explorer.openDir(seg.path),
      }));
    });
  }

  /* ---------------- 批量操作栏 ---------------- */
  function updateBulkBar() {
    const bar = U.$('#bulkbar');
    const n = S.checked.size;
    bar.hidden = n === 0;
    U.$('#bulkCount').textContent = `已选 ${n} 个文件夹`;
  }
  Explorer.updateBulkBar = updateBulkBar;

  Explorer.clearChecked = function () {
    S.checked.clear();
    renderWindow(true);
    updateBulkBar();
  };

  /* ---------------- 右键菜单 ---------------- */
  let menuEl = null;
  function showMenu(e, r) {
    hideMenu();
    const items = [];
    if (r.isDir) {
      items.push({ t: '展开 / 进入', f: () => Explorer.activate(r) });
      items.push({ t: 'AI 生成标签', f: () => Detail.analyze(r.path, true) });
      items.push({ t: '递归分析子项', f: () => Detail.analyzeRecursive(r.path) });
      const isFav = (S.settings.favorites || []).includes(r.path);
      items.push({ t: isFav ? '★ 取消收藏' : '☆ 固定到收藏夹', f: async () => {
        if (isFav) await U.safeCall('favoritesRemove', r.path); else await U.safeCall('favoritesAdd', r.path);
        S.settings = await U.call('settingsGet');
        App.loadPlaces();
      }});
      items.push({ t: '空间占用分析', f: () => { Detail.show(r.path); setTimeout(() => { const btn = document.querySelector('.d-actions button:nth-child(5)'); if (btn) btn.click(); }, 100); }});
      items.push({ t: '查找重复文件', f: () => { Detail.show(r.path); setTimeout(() => { const btn = document.querySelector('.d-actions button:nth-child(6)'); if (btn) btn.click(); }, 100); }});
      items.push({ t: r.path && S.checked.has(r.path) ? '取消勾选' : '勾选（批量操作）', f: () => {
        if (S.checked.has(r.path)) S.checked.delete(r.path); else S.checked.add(r.path);
        renderWindow(true); updateBulkBar();
      } });
    } else {
      items.push({ t: '打开文件', f: () => U.safeCall('fsOpen', r.path) });
      items.push({ t: '预览文件', f: () => { Detail.showFile(r); setTimeout(() => { const btn = document.querySelector('.d-actions button:nth-child(2)'); if (btn) btn.click(); }, 100); }});
    }
    items.push({ t: '在文件管理器中显示', f: () => U.safeCall('fsReveal', r.path) });
    items.push({ t: '复制完整路径', f: () => U.copy(r.path) });

    menuEl = U.el('div', {
      class: 'suggest',
      style: { position: 'fixed', left: e.clientX + 'px', top: e.clientY + 'px', zIndex: 300, minWidth: '176px' },
    }, items.map((it) => U.el('div', { text: it.t, onclick: () => { hideMenu(); it.f(); } })));
    document.body.appendChild(menuEl);
    setTimeout(() => document.addEventListener('mousedown', hideMenu, { once: true }), 0);
  }
  function hideMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }

  window.Explorer = Explorer;
})();
