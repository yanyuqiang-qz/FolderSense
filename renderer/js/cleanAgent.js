/**
 * 清理助手（AI 清理 C盘 / D盘 / 任意文件夹）
 * 流程：选盘 → 扫描可清理候选（大文件/老旧/临时缓存/重复）→ AI 生成方案 → 确认后安全移入回收站
 */
(function () {
  'use strict';

  const CleanAgent = {};

  // 选中集合（path -> true）
  let selected = new Set();
  let lastResult = null;
  let rootPath = '';

  const CATS = [
    { key: 'large', title: '大文件', icon: '⚠️', risk: '谨慎', riskClass: 'risk-warn', desc: '体积超过 200MB，确认无用再删' },
    { key: 'old', title: '老旧文件', icon: '🕒', risk: '安全', riskClass: 'risk-ok', desc: '超过一年未修改' },
    { key: 'temp', title: '临时 / 缓存', icon: '🗑️', risk: '安全', riskClass: 'risk-ok', desc: '位于临时、缓存、下载目录' },
    { key: 'dup', title: '重复文件', icon: '👯', risk: '谨慎', riskClass: 'risk-warn', desc: '内容完全相同，每组可保留一份' },
  ];

  CleanAgent.init = async function () {
    const el = U.$('#cleanAgent');
    if (!el) return;
    el.replaceChildren();
    selected = new Set();
    lastResult = null;

    const h = U.el('div', { class: 'ca-header' }, [
      U.el('h2', { text: '🧹 清理助手' }),
      U.el('p', { class: 'ca-sub', text: '选择要清理的磁盘或文件夹，AI 会帮你找出大文件、老旧文件、临时缓存和重复文件，确认后再安全移入回收站（可在回收站撤销）。' }),
    ]);

    const picker = U.el('div', { class: 'ca-picker' });
    let roots = [];
    try {
      const r = await U.call('fsRoots');
      roots = (r && r.system) || [];
    } catch { /* ignore */ }
    if (!roots.length) roots = ['C:\\', 'D:\\', 'E:\\'].map((p) => ({ path: p, name: '磁盘' }));

    for (const rd of roots) {
      picker.appendChild(U.el('button', { class: 'ca-drive', onclick: () => { rootPath = rd.path; startScan(el); } }, [
        U.el('b', { text: rd.path }),
        U.el('span', { text: rd.name || '磁盘' }),
      ]));
    }
    picker.appendChild(U.el('button', { class: 'ca-drive custom', onclick: async () => {
      const picked = await U.safeCall('fsPickFolder', { title: '选择要清理的文件夹' });
      if (picked && picked.length) { rootPath = picked[0]; startScan(el); }
    } }, [
      U.el('b', { text: '📁' }),
      U.el('span', { text: '选择文件夹…' }),
    ]));

    el.replaceChildren(h, picker, U.el('div', { class: 'ca-results', id: 'caResults' }));
  };

  async function startScan(el) {
    const results = U.$('#caResults');
    results.replaceChildren(U.el('div', { class: 'ca-loading', text: `正在扫描 ${rootPath} ，请稍候…（大磁盘可能需要几分钟）` }));
    let data;
    try {
      data = await U.call('cleanScan', rootPath);
    } catch (e) {
      results.replaceChildren(U.el('div', { class: 'notice err' }, [U.icon('warn'), U.el('div', { text: '扫描失败：' + e.message })]));
      return;
    }
    lastResult = data;
    renderResults(results, data);
  }

  function renderResults(container, data) {
    selected = new Set();
    // 默认全选：大/老/临时 全部选；重复文件每组保留第一份、其余选中
    for (const c of data.candidates) selected.add(c.path);
    for (const g of data.groups) {
      g.files.forEach((f, i) => { if (i > 0) selected.add(f.path); else selected.delete(f.path); });
    }

    const banner = U.el('div', { class: 'ca-banner' }, [
      U.el('div', {}, [
        U.el('b', { text: '扫描完成' }),
        U.el('span', { text: ` · 共检查 ${data.scanned.toLocaleString()} 个文件 · 根目录 ${data.root}` }),
      ]),
      U.el('div', { class: 'ca-banner-stat' }, [
        U.el('span', { text: '预计可释放' }),
        U.el('b', { text: U.size(data.totalBytes) }),
      ]),
    ]);

    const sections = U.el('div', { class: 'ca-sections' });
    for (const cat of CATS) {
      const items = cat.key === 'dup' ? data.groups : data.byCat[cat.key];
      if (!items || !items.length) continue;
      sections.appendChild(renderCat(cat, items, data));
    }

    const aiBox = U.el('div', { class: 'ca-ai', id: 'caAi' });
    const bar = U.el('div', { class: 'ca-actionbar' }, [
      U.el('span', { class: 'ca-selinfo', id: 'caSelInfo' }),
      U.el('button', { class: 'btn sm', text: '🤖 AI 生成清理方案', onclick: () => aiSuggest(data, aiBox) }),
      U.el('button', { class: 'btn primary sm', id: 'caCleanBtn', text: '清理选中', onclick: () => doClean() }),
    ]);

    container.replaceChildren(banner, sections, aiBox, bar);
    updateBar();
  }

  function renderCat(cat, items, data) {
    const isDup = cat.key === 'dup';
    const head = U.el('div', { class: 'ca-cat-head' }, [
      U.el('span', { class: 'ca-cat-icon', text: cat.icon }),
      U.el('b', { text: cat.title }),
      U.el('span', { class: 'ca-cat-count', text: isDup ? `${items.length} 组` : `${items.length} 个` }),
      U.el('span', { class: 'ca-risk ' + cat.riskClass, text: cat.risk }),
      U.el('span', { class: 'ca-cat-desc', text: cat.desc }),
      U.el('button', { class: 'ca-cat-all', text: '全选', onclick: (e) => {
        let total = 0, on = 0;
        if (cat.key === 'dup') { for (const g of items) g.files.forEach((f, i) => { if (i > 0) { total++; if (selected.has(f.path)) on++; } }); }
        else { for (const c of items) { total++; if (selected.has(c.path)) on++; } }
        const turnOn = on < total;
        toggleCat(cat, items, turnOn);
        e.target.textContent = turnOn ? '取消全选' : '全选';
        updateBar();
      } }),
    ]);

    const list = U.el('div', { class: 'ca-cat-list' });
    if (isDup) {
      for (const g of items) {
        // 组头
        list.appendChild(U.el('div', { class: 'ca-dup-head', text: `${g.files.length} 份相同 · ${U.size(g.size)} · 每组已默认保留第一份` }));
        g.files.forEach((f, i) => {
          list.appendChild(itemRow({ path: f.path, name: f.name, size: g.size, reason: i === 0 ? '★ 保留' : '可清理' }, cat));
        });
      }
    } else {
      for (const c of items) list.appendChild(itemRow(c, cat));
    }
    return U.el('div', { class: 'ca-cat' }, [head, list]);
  }

  function itemRow(item, cat) {
    const cb = U.el('input', { type: 'checkbox', checked: selected.has(item.path) });
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(item.path); else selected.delete(item.path);
      updateBar();
    });
    return U.el('div', { class: 'ca-item' + (selected.has(item.path) ? ' on' : '') }, [
      cb,
      U.el('span', { class: 'ca-item-name', text: item.name, title: item.path }),
      U.el('span', { class: 'ca-item-reason', text: item.reason || '' }),
      U.el('span', { class: 'ca-item-size', text: U.size(item.size) }),
      U.el('button', { class: 'btn ghost xs', text: '定位', onclick: (e) => { e.stopPropagation(); U.safeCall('fsReveal', item.path); } }),
    ]);
  }

  function toggleCat(cat, items, on) {
    if (cat.key === 'dup') {
      for (const g of items) g.files.forEach((f, i) => { if (on && i > 0) selected.add(f.path); else if (!on || i === 0) selected.delete(f.path); });
    } else {
      for (const c of items) { if (on) selected.add(c.path); else selected.delete(c.path); }
    }
    // 同步复选框状态
    U.$$('#caResults .ca-item input[type=checkbox]').forEach((cb) => {
      const row = cb.closest('.ca-item');
      const name = row?.querySelector('.ca-item-name')?.textContent;
      // 通过路径定位较复杂，直接按当前集合刷新：重新渲染更简单
    });
    rerenderChecks();
  }

  // 根据 selected 集合刷新所有复选框勾选状态（避免整页重渲染丢失滚动）
  function rerenderChecks() {
    U.$$('#caResults .ca-item').forEach((row) => {
      const path = row.querySelector('.ca-item-name')?.getAttribute('title');
      const cb = row.querySelector('input[type=checkbox]');
      if (!path || !cb) return;
      const on = selected.has(path);
      cb.checked = on;
      row.classList.toggle('on', on);
    });
  }

  function sizeOf(p, res) {
    const c = res.candidates.find((x) => x.path === p);
    if (c) return c.size;
    for (const g of res.groups) {
      const f = g.files.find((x) => x.path === p);
      if (f) return g.size;
    }
    return 0;
  }

  function estimateFreed(paths, res) {
    let s = 0;
    for (const p of paths) s += sizeOf(p, res);
    return s;
  }

  function updateBar() {
    const info = U.$('#caSelInfo');
    const btn = U.$('#caCleanBtn');
    if (!info || !lastResult) return;
    const n = selected.size;
    const freed = estimateFreed([...selected], lastResult);
    info.textContent = `已选 ${n} 项 · 可释放 ${U.size(freed)}`;
    if (btn) btn.textContent = n ? `清理选中 (${n})` : '清理选中';
  }

  async function doClean() {
    const paths = [...selected];
    if (!paths.length) { U.toast('请先选择要清理的文件', 'warn'); return; }
    const freed = estimateFreed(paths, lastResult);
    if (!(await U.confirm('移入回收站', `确定把选中的 ${paths.length} 个文件移入回收站吗？可在回收站撤销。预计释放 ${U.size(freed)}。`, true))) return;
    const res = await U.safeCall('fsTrash', paths);
    const ok = (res || []).filter((r) => r.ok).length;
    const fail = paths.length - ok;
    U.toast(`已移入回收站 ${ok} 个${fail ? `，${fail} 个失败` : ''}`, ok ? 'ok' : 'err');

    const okPaths = new Set((res || []).filter((r) => r.ok).map((r) => r.path));
    lastResult.candidates = lastResult.candidates.filter((c) => !okPaths.has(c.path));
    for (const g of lastResult.groups) g.files = g.files.filter((f) => !okPaths.has(f.path));
    lastResult.groups = lastResult.groups.filter((g) => g.files.length >= 2);
    lastResult.byCat = { large: [], old: [], temp: [] };
    for (const c of lastResult.candidates) lastResult.byCat[c.category].push(c);
    lastResult.totalBytes = lastResult.candidates.reduce((a, c) => a + c.size, 0)
      + lastResult.groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0);
    selected = new Set();
    renderResults(U.$('#caResults'), lastResult);
  }

  async function aiSuggest(data, box) {
    if (!box) return;
    box.replaceChildren(U.el('div', { class: 'ca-ai-loading', text: 'AI 正在分析清理方案…' }));
    const prompt = `你是电脑清理助手。以下是扫描「${data.root}」发现的可清理项：\n`
      + `- 大文件（>200MB）：${data.byCat.large.length} 个\n`
      + `- 老旧文件（>1年未修改）：${data.byCat.old.length} 个\n`
      + `- 临时/缓存文件：${data.byCat.temp.length} 个\n`
      + `- 重复文件组：${data.groups.length} 组\n`
      + `请给一个简洁的中文清理建议，按优先级列出先清理哪些、注意什么风险，控制在 150 字内。`;
    try {
      const r = await U.safeCall('aiChat', [{ role: 'user', content: prompt }]);
      box.replaceChildren(U.el('div', { class: 'ca-ai-card' }, [
        U.el('div', { class: 'ca-ai-title', text: '🤖 AI 清理方案' }),
        U.el('div', { class: 'ca-ai-body', text: r?.answer || '(无建议)' }),
      ]));
    } catch {
      box.replaceChildren(U.el('div', { class: 'ca-ai-card' }, [
        U.el('div', { class: 'ca-ai-title', text: '🤖 清理建议（离线）' }),
        U.el('div', { class: 'ca-ai-body', text: localSuggest(data) }),
      ]));
    }
  }

  function localSuggest(data) {
    const parts = [];
    if (data.byCat.temp.length) parts.push(`优先清理「临时/缓存」中的 ${data.byCat.temp.length} 个文件，风险最低；`);
    if (data.byCat.old.length) parts.push(`超过一年未动的 ${data.byCat.old.length} 个老旧文件通常可安全删除；`);
    if (data.groups.length) parts.push(`重复文件共 ${data.groups.length} 组，每组保留一份即可；`);
    if (data.byCat.large.length) parts.push(`大文件请确认是否真的不需要再删。`);
    parts.push('清理前建议确认回收站可容纳，误删可在回收站找回。');
    return parts.join('');
  }

  window.CleanAgent = CleanAgent;
})();
