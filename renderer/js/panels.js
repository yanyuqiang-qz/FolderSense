/**
 * 面板组件：空间分析 Treemap / 文件预览 / 重复文件检测结果
 */
(function () {
  'use strict';

  const Panels = {};

  /* ==================== 空间分析面板 ==================== */

  /**
   * 显示空间分析结果（Treemap + 列表 + 大文件 Top N）
   * @param {string} dirPath 要分析的目录
   * @param {HTMLElement} container 容器元素
   */
  Panels.showSpaceAnalysis = async function (dirPath, container) {
    container.replaceChildren(
      U.el('div', { class: 'space-loading', text: '正在分析空间占用，请稍候…' })
    );

    let data;
    try {
      data = await U.call('sizeScan', dirPath);
    } catch (e) {
      container.replaceChildren(U.el('div', { class: 'notice err' }, [
        U.icon('warn'), U.el('div', { text: '分析失败：' + e.message }),
      ]));
      return;
    }

    const totalGB = (data.totalSize / (1024 ** 3)).toFixed(2);
    const header = U.el('div', { class: 'space-header' }, [
      U.el('b', { text: '空间占用分析' }),
      U.el('span', { text: `总计 ${U.size(data.totalSize)}（${totalGB} GB） · ${data.totalDirs} 个子文件夹` }),
    ]);

    // Tab 切换：Treemap | 列表 | 大文件
    const tabs = U.el('div', { class: 'space-tabs' });
    const tabContent = U.el('div', { class: 'space-tab-content' });

    const switchTab = (name) => {
      tabs.querySelectorAll('.space-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
      if (name === 'treemap') tabContent.replaceChildren(renderTreemap(data));
      else if (name === 'list') tabContent.replaceChildren(renderSizeList(data));
      else if (name === 'files') tabContent.replaceChildren(renderLargeFiles(data));
    };

    tabs.appendChild(U.el('button', { class: 'space-tab active', dataset: { tab: 'treemap' }, onclick: () => switchTab('treemap'), text: '📊 树图' }));
    tabs.appendChild(U.el('button', { class: 'space-tab', dataset: { tab: 'list' }, onclick: () => switchTab('list'), text: '📋 列表' }));
    if (data.files.length) tabs.appendChild(U.el('button', { class: 'space-tab', dataset: { tab: 'files' }, onclick: () => switchTab('files'), text: '⚠️ 大文件 (' + data.files.length + ')' }));

    container.replaceChildren(header, tabs, tabContent);
    switchTab('treemap');
  };

  function renderTreemap(data) {
    const rects = data.treemap || [];
    if (!rects.length) return U.el('div', { class: 'empty', text: '数据不足，无法绘制树图' });

    const W = 680, H = 380;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'treemap-svg');
    // 调色板
    const colors = ['#e05561','#4a90d9','#50b87d','#f5a623','#9b6bdf','#e8873b','#51aeb8','#cf5b8f'];

    for (const r of rects) {
      const g = document.createElementNS(svgNS, 'g');
      g.style.cursor = 'pointer';
      const color = colors[r.colorIndex % colors.length];

      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', r.x); rect.setAttribute('y', r.y);
      rect.setAttribute('w', Math.max(r.w, 1)); rect.setAttribute('h', Math.max(r.h, 1));
      rect.setAttribute('fill', color);
      rect.setAttribute('stroke', 'rgba(255,255,255,.15)');
      rect.setAttribute('rx', 2);

      // 只有足够大的矩形才显示文字
      const showLabel = r.w > 40 && r.h > 20;
      const text = showLabel ? document.createElementNS(svgNS, 'text') : null;
      if (text) {
        text.setAttribute('x', r.x + 4); text.setAttribute('y', r.y + 14);
        text.setAttribute('fill', '#fff');
        text.setAttribute('font-size', Math.min(11, Math.max(8, r.w / 6)));
        text.setAttribute('style', 'pointer-events:none');
        text.textContent = r.name.length > 12 ? r.name.slice(0, 11) + '…' : r.name;
      }

      const sizeText = showLabel && r.h > 36 ? document.createElementNS(svgNS, 'text') : null;
      if (sizeText) {
        sizeText.setAttribute('x', r.x + 4); sizeText.setAttribute('y', r.y + 28);
        sizeText.setAttribute('fill', 'rgba(255,255,255,.7)');
        sizeText.setAttribute('font-size', '9');
        sizeText.setAttribute('style', 'pointer-events:none');
        sizeText.textContent = U.size(r.size);
      }

      g.appendChild(rect);
      if (text) g.appendChild(text);
      if (sizeText) g.appendChild(sizeText);

      // 点击跳转到该目录
      g.addEventListener('click', () => Explorer.openDir(r.path));

      svg.appendChild(g);
    }
    return U.el('div', { class: 'treemap-wrap' }, [svg]);
  }

  function renderSizeList(data) {
    const dirs = (data.dirs || []).slice(0, 100);
    if (!dirs.length) return U.el('div', { class: 'empty', text: '没有子文件夹' });

    const rows = U.el('div', { class: 'size-list' });
    for (const d of dirs) {
      const pct = data.totalSize ? ((d.size / data.totalSize) * 100).toFixed(1) : 0;
      const barW = Math.min(pct * 2, 100); // 最大100%宽度
      rows.appendChild(U.el('div', { class: 'size-row', title: d.path, onclick: () => Explorer.openDir(d.path) }, [
        U.el('span', { class: 'size-name', text: d.name }),
        U.el('div', { class: 'size-bar-wrap' }, [
          U.el('div', { class: 'size-bar', style: { width: barW + '%' } }),
        ]),
        U.el('span', { class: 'size-val', text: U.size(d.size) }),
        U.el('span', { class: 'size-pct', text: pct + '%' }),
        U.el('span', { class: 'size-count', text: d.fileCount + ' 项' }),
      ]));
    }
    return rows;
  }

  function renderLargeFiles(data) {
    const files = data.files || [];
    if (!files.length) return U.el('div', { class: 'notice ok' }, [U.icon('check'), U.el('div', { text: '没有超过 100MB 的大文件。' })]);

    const list = U.el('div', { class: 'large-files' });
    for (const f of files) {
      list.appendChild(U.el('div', { class: 'lf-row', title: f.path }, [
        U.el('span', { class: 'lf-name', text: f.name }),
        U.el('span', { class: 'lf-size', text: U.size(f.size) }),
        U.el('button', { class: 'btn ghost sm', text: '定位', onclick: (e) => { e.stopPropagation(); U.safeCall('fsReveal', f.path); } }),
        U.el('button', { class: 'btn ghost sm', text: '打开', onclick: (e) => { e.stopPropagation(); U.safeCall('fsOpen', f.path); } }),
      ]));
    }
    return list;
  }

  /* ==================== 文件预览 ==================== */

  Panels.showPreview = async function (filePath, container) {
    container.replaceChildren(U.el('div', { class: 'preview-loading', text: '正在读取预览…' }));

    let data;
    try {
      data = await U.call('fsPreview', filePath);
    } catch (e) {
      container.replaceChildren(U.el('div', { class: 'notice err' }, [
        U.icon('warn'), U.el('div', { text: '预览失败：' + e.message }),
      ]));
      return;
    }

    if (data.error || !data.previewable && data.type !== 'text' && data.type !== 'image') {
      container.replaceChildren(
        U.el('div', { class: 'preview-unsupported' }, [
          U.icon('file'),
          U.el('p', { text: '该格式暂不支持预览' }),
          U.el('code', { text: (data.ext || '').slice(1).toUpperCase() + ' 文件 (' + U.size(data.size || 0) + ')' }),
          U.el('div', {}, [
            U.el('button', { class: 'btn sm primary', text: '打开文件', onclick: () => U.safeCall('fsOpen', filePath) }),
            U.el('button', { class: 'btn ghost sm', text: '在资源管理器中定位', onclick: () => U.safeCall('fsReveal', filePath) }),
          ]),
        ])
      );
      return;
    }

    if (data.type === 'image') {
      container.replaceChildren(
        U.el('div', { class: 'preview-img-wrap' }, [
          U.el('img', { class: 'preview-img', src: '', alt: U.basename(filePath) }), // 需要通过 IPC 传 base64 或 file:// 协议
          U.el('div', { class: 'preview-info', text: `${U.basename(filePath)} · ${U.size(data.size)}` }),
        ])
      );
      // 图片需要特殊处理：用 file:// 协议加载
      const img = container.querySelector('.preview-img');
      img.src = 'file:///' + filePath.replace(/\\/g, '/');
      img.onerror = () => { img.alt = '图片加载失败（可能权限不足）'; };
      return;
    }

    if (data.type === 'text') {
      const pre = U.el('pre', { class: 'preview-text', text: data.content });
      container.replaceChildren(
        U.el('div', { class: 'preview-text-wrap' }, [
          U.el('div', { class: 'preview-info' }, [
            U.el('span', { text: `${U.basename(filePath)} · ${U.size(data.size)}` }),
            data.isTruncated ? U.el('span', { class: 'truncated-hint', text: '仅显示前 4KB' }) : null,
          ].filter(Boolean)),
          pre,
        ])
      );
      return;
    }
  };

  /* ==================== 重复文件检测结果 ==================== */

  Panels.showDedupResults = async function (dirPath, container) {
    container.replaceChildren(U.el('div', { class: 'dedup-loading', text: '正在查找重复文件…（可能需要一些时间）' }));

    let data;
    try {
      data = await U.call('dedupScan', dirPath);
    } catch (e) {
      container.replaceChildren(U.el('div', { class: 'notice err' }, [
        U.icon('warn'), U.el('div', { text: '检测失败：' + e.message }),
      ]));
      return;
    }

    if (!data.groups.length) {
      container.replaceChildren(U.el('div', { class: 'notice ok' }, [
        U.icon('check'), U.el('div', { text: '没有发现重复文件。' }),
      ]));
      return;
    }

    const wastedGB = (data.totalWastedBytes / (1024 ** 3)).toFixed(2);
    const header = U.el('div', { class: 'dedup-header' }, [
      U.el('b', { text: `发现 ${data.groups.length} 组重复文件` }),
      U.el('span', { text: `可释放约 ${U.size(data.totalWastedBytes)}（${wastedGB} GB）` }),
    ]);

    const list = U.el('div', { class: 'dedup-list' });
    for (const group of data.groups) {
      const groupEl = U.el('div', { class: 'dedup-group' }, [
        U.el('div', { class: 'dg-head' }, [
          U.el('span', { class: 'dg-hash', text: group.hash.slice(0, 10) + '…' }),
          U.el('span', { text: `${group.files.length} 份相同 · ${U.size(group.size)}` }),
        ]),
      ]);
      for (const f of group.files) {
        groupEl.appendChild(U.el('div', { class: 'dg-file', title: f.path }, [
          U.el('span', { class: 'dg-fname', text: f.name }),
          U.el('button', { class: 'btn ghost xs', text: '定位', onclick: (e) => { e.stopPropagation(); U.safeCall('fsReveal', f.path); } }),
        ]));
      }
      list.appendChild(groupEl);
    }

    container.replaceChildren(header, list);
  };

  window.Panels = Panels;
})();
