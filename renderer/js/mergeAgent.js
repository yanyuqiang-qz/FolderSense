/**
 * 同名文件夹合并建议（AI 帮你想清楚哪些散落各处的同名文件夹该合并）
 * 流程：选盘 → 扫描同名文件夹 → 展示分组与各位置 → AI 生成合并方案 → 确认后安全合并（冲突自动改名，空目录移入回收站可撤销）
 */
(function () {
  'use strict';

  const MergeAgent = {};

  // 选中集合（source 文件夹 path -> true，表示"要合并进目标"）
  let selected = new Set();
  let lastResult = null;
  let rootPath = '';

  MergeAgent.init = async function () {
    const el = U.$('#mergeAgent');
    if (!el) return;
    el.replaceChildren();
    selected = new Set();
    lastResult = null;

    const h = U.el('div', { class: 'ma-header' }, [
      U.el('h2', { text: '🔀 同名文件夹合并建议' }),
      U.el('p', { class: 'ma-sub', text: '选择要分析的磁盘或文件夹，FolderSense 会找出分散在多处、名字相同的文件夹，估算它们的内容重叠度并推荐一个合并目标。确认后，源文件夹的内容会合并进目标，文件名冲突自动加后缀，空目录移入回收站（可撤销）。' }),
    ]);

    const picker = U.el('div', { class: 'ma-picker' });
    let roots = [];
    try {
      const r = await U.call('fsRoots');
      roots = (r && r.system) || [];
    } catch { /* ignore */ }
    if (!roots.length) roots = ['C:\\', 'D:\\', 'E:\\'].map((p) => ({ path: p, name: '磁盘' }));

    for (const rd of roots) {
      picker.appendChild(U.el('button', { class: 'ma-drive', onclick: () => { rootPath = rd.path; startScan(el); } }, [
        U.el('b', { text: rd.path }),
        U.el('span', { text: rd.name || '磁盘' }),
      ]));
    }
    picker.appendChild(U.el('button', { class: 'ma-drive custom', onclick: async () => {
      const picked = await U.safeCall('fsPickFolder', { title: '选择要分析的文件夹' });
      if (picked && picked.length) { rootPath = picked[0]; startScan(el); }
    } }, [
      U.el('b', { text: '📁' }),
      U.el('span', { text: '选择文件夹…' }),
    ]));

    el.replaceChildren(h, picker, U.el('div', { class: 'ma-results', id: 'maResults' }));
  };

  async function startScan(el) {
    const results = U.$('#maResults');
    results.replaceChildren(U.el('div', { class: 'ma-loading', text: `正在分析 ${rootPath} 的同名文件夹，请稍候…（大磁盘可能需要几分钟）` }));
    let data;
    try {
      data = await U.call('mergeSuggest', rootPath);
    } catch (e) {
      results.replaceChildren(U.el('div', { class: 'notice err' }, [U.icon('warn'), U.el('div', { text: '分析失败：' + e.message })]));
      return;
    }
    lastResult = data;
    renderResults(results, data);
  }

  function renderResults(container, data) {
    selected = new Set();
    // 默认：每组把"非目标"的文件夹都选为待合并源
    for (const g of data.groups) {
      for (const f of g.folders) if (f.path !== g.targetPath) selected.add(f.path);
    }

    const banner = U.el('div', { class: 'ma-banner' }, [
      U.el('div', {}, [
        U.el('b', { text: '分析完成' }),
        U.el('span', { text: ` · 共检查 ${data.scanned.toLocaleString()} 个文件夹 · 发现 ${data.groups.length} 组同名文件夹 · 根目录 ${data.root}` }),
      ]),
    ]);

    if (!data.groups.length) {
      container.replaceChildren(banner, U.el('div', { class: 'ma-empty', text: '未发现分散在多处、名字相同的文件夹，目录结构挺清爽的。' }));
      return;
    }

    const sections = U.el('div', { class: 'ma-sections' });
    for (const g of data.groups) sections.appendChild(renderGroup(g));

    const aiBox = U.el('div', { class: 'ma-ai', id: 'maAi' });
    const bar = U.el('div', { class: 'ma-actionbar' }, [
      U.el('span', { class: 'ma-selinfo', id: 'maSelInfo' }),
      U.el('button', { class: 'btn sm', text: '🤖 AI 生成合并方案', onclick: () => aiSuggest(data, aiBox) }),
      U.el('button', { class: 'btn primary sm', id: 'maMergeBtn', text: '合并选中', onclick: () => doMerge() }),
    ]);

    container.replaceChildren(banner, sections, aiBox, bar);
    updateBar();
  }

  function renderGroup(g) {
    const overlapText = g.computed
      ? `内容重叠约 ${Math.round(g.avgOverlap * 100)}%`
      : '同名较多（多为系统/依赖目录，建议人工确认）';
    const head = U.el('div', { class: 'ma-group-head' }, [
      U.el('span', { class: 'ma-group-icon', text: '📁' }),
      U.el('b', { class: 'ma-group-name', text: g.name }),
      U.el('span', { class: 'ma-group-count', text: `${g.count} 个位置` }),
      U.el('span', { class: 'ma-overlap', text: overlapText }),
      U.el('span', { class: 'ma-target-tag', title: g.targetPath, text: '推荐目标：' + shortPath(g.targetPath) }),
    ]);

    const list = U.el('div', { class: 'ma-group-list' });
    for (const f of g.folders) {
      const isTarget = f.path === g.targetPath;
      const cb = U.el('input', { type: 'checkbox', checked: !isTarget && selected.has(f.path), disabled: isTarget });
      if (!isTarget) {
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(f.path); else selected.delete(f.path);
          updateBar();
        });
      }
      list.appendChild(U.el('div', { class: 'ma-item' + (isTarget ? ' target' : (selected.has(f.path) ? ' on' : '')) }, [
        cb,
        U.el('span', { class: 'ma-item-name', text: shortPath(f.path), title: f.path }),
        U.el('span', { class: 'ma-item-reason', text: isTarget ? '★ 合并目标（保留）' : `${f.fileCount} 个文件` }),
        U.el('button', { class: 'btn ghost xs', text: '定位', onclick: (e) => { e.stopPropagation(); U.safeCall('fsReveal', f.path); } }),
      ]));
    }
    return U.el('div', { class: 'ma-group' }, [head, list]);
  }

  function shortPath(p) {
    return p.length > 60 ? '…' + p.slice(p.length - 57) : p;
  }

  function updateBar() {
    const info = U.$('#maSelInfo');
    const btn = U.$('#maMergeBtn');
    if (!info || !lastResult) return;
    const n = selected.size;
    info.textContent = `已选 ${n} 个文件夹待合并`;
    if (btn) btn.textContent = n ? `合并选中 (${n})` : '合并选中';
  }

  async function doMerge() {
    const paths = [...selected];
    if (!paths.length) { U.toast('请先选择要合并进目标的文件夹', 'warn'); return; }
    if (!(await U.confirm('合并文件夹', `确定把选中的 ${paths.length} 个文件夹内容合并进各自的目标文件夹吗？源目录变空后会移入回收站（可撤销）。`, true))) return;
    // 按目标分组调用
    const byTarget = new Map();
    for (const g of lastResult.groups) {
      const srcs = g.folders.filter((f) => f.path !== g.targetPath && selected.has(f.path)).map((f) => f.path);
      if (srcs.length) {
        const arr = byTarget.get(g.targetPath) || [];
        arr.push(...srcs);
        byTarget.set(g.targetPath, arr);
      }
    }
    let totalMoved = 0, totalRemoved = 0, failed = 0;
    for (const [target, srcs] of byTarget) {
      const res = await U.safeCall('mergeApply', target, srcs);
      for (const r of (res || [])) {
        if (r.ok) { totalMoved += r.moved || 0; if (r.removed) totalRemoved++; }
        else failed++;
      }
    }
    U.toast(`已合并 ${totalMoved} 项，移入回收站 ${totalRemoved} 个空目录${failed ? `，${failed} 个源失败` : ''}`, (failed ? 'warn' : 'ok'));

    // 从结果中移除已处理的组
    const movedSet = new Set(paths);
    lastResult.groups = lastResult.groups.filter((g) => !g.folders.some((f) => movedSet.has(f.path) && f.path !== g.targetPath));
    selected = new Set();
    renderResults(U.$('#maResults'), lastResult);
  }

  async function aiSuggest(data, box) {
    if (!box) return;
    box.replaceChildren(U.el('div', { class: 'ma-ai-loading', text: 'AI 正在分析合并方案…' }));
    const top = data.groups.slice(0, 12).map((g) =>
      `- 同名「${g.name}」：${g.count} 处，重叠 ${g.computed ? Math.round(g.avgOverlap * 100) + '%' : '未知'}，推荐目标 ${shortPath(g.targetPath)}`
    ).join('\n');
    const prompt = `你是文件夹整理助手。下面是在「${data.root}」发现的同名文件夹分组：\n${top}\n`
      + `请给简洁的中文合并建议：哪些值得合并、按什么原则选目标、有哪些风险（例如内容不同会冲突），控制在 180 字内。`;
    try {
      const r = await U.safeCall('aiChat', [{ role: 'user', content: prompt }]);
      box.replaceChildren(U.el('div', { class: 'ma-ai-card' }, [
        U.el('div', { class: 'ma-ai-title', text: '🤖 AI 合并方案' }),
        U.el('div', { class: 'ma-ai-body', text: r?.answer || '(无建议)' }),
      ]));
    } catch {
      box.replaceChildren(U.el('div', { class: 'ma-ai-card' }, [
        U.el('div', { class: 'ma-ai-title', text: '🤖 合并建议（离线）' }),
        U.el('div', { class: 'ma-ai-body', text: localSuggest(data) }),
      ]));
    }
  }

  function localSuggest(data) {
    const high = data.groups.filter((g) => g.computed && g.avgOverlap > 0.6);
    const parts = [];
    if (high.length) parts.push(`优先处理重叠度高的 ${high.length} 组（如「${high.slice(0, 3).map((g) => g.name).join('、')}」），内容高度一致，合并最安全；`);
    parts.push('合并前确认源与目标内容一致，避免把不同资料覆盖；');
    parts.push('系统/依赖目录（如 bin、obj）同名极多，通常无需合并；');
    parts.push('合并后源目录会进回收站，误合可还原。');
    return parts.join('');
  }

  window.MergeAgent = MergeAgent;
})();
