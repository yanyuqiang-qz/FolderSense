/* 仪表盘首页：全局状态一览 */
(function () {
  'use strict';

  const Dash = {};

  Dash.init = async function () {
    const el = U.$('#dashboard');
    if (!el) return;
    el.replaceChildren(U.el('div', { class: 'empty', text: '正在加载…' }));

    // 并行获取所有统计数据
    const [libStats, indexSummary, tags] = await Promise.all([
      U.safeCall('libStats').catch(() => null),
      U.call('indexSummary').catch(() => null),
      U.safeCall('libTags').catch(() => []),
    ]);

    render(el, { libStats, indexSummary, tags });
  };

  function render(el, data) {
    const { libStats, indexSummary, tags } = data;
    const annotated = libStats?.annotated || 0;
    const withAi = libStats?.withAi || 0;
    const totalTags = libStats?.tags || 0;
    const totalDirs = indexSummary?.dirs || 0;
    const totalItems = indexSummary?.total || 0;

    // 进度环
    const progressPct = totalDirs > 0 ? Math.min(100, Math.round((annotated / totalDirs) * 100)) : 0;

    // 标签 TOP 5
    const topTags = (tags || [])
      .sort((a, b) => (b.usage || 0) - (a.usage || 0))
      .slice(0, 8);

    el.replaceChildren(
      U.el('h2', { style: { marginBottom: '16px' }, text: '🏠 欢迎使用文件夹管家' }),

      // 第一行：核心指标
      U.el('div', { class: 'dash-grid' }, [
        // 已分析进度
        card('已标注进度', renderProgressRing(progressPct, annotated, totalDirs), `${annotated} / ${totalDirs} 个文件夹已标注`),
        // 索引状态
        card('索引状态', `${totalItems.toLocaleString()}`, `已索引 ${totalDirs.toLocaleString()} 个文件夹`),
        // 标签
        card('标签总数', `${totalTags}`, `AI 生成 ${withAi} 个`),
      ]),

      // 第二行：标签云 + 最近活动
      U.el('div', { class: 'dash-grid' }, [
        // 常用标签
        U.el('div', { class: 'dash-card' }, [
          U.el('div', { class: 'dash-card-title' }, [U.icon('tag'), U.el('span', { text: '常用标签' })]),
          U.el('div', { class: 'dash-tag-cloud' },
            topTags.length
              ? topTags.map((t) => U.el('span', {
                  class: 'dash-tag-chip',
                  style: { background: t.color + '22', color: t.color, borderColor: t.color + '44' },
                  text: `${t.name} (${t.usage || 0})`,
                  onclick: () => { App.switchView('tags'); Tags.runFilter(); },
                }))
              : U.el('span', { class: 'text-faint', text: '还没有标签，去给文件夹打几个吧 →', style: { color: 'var(--text-faint)', fontSize: '12px' } })
          ),
        ]),

        // 快捷操作
        U.el('div', { class: 'dash-card' }, [
          U.el('div', { class: 'dash-card-title' }, [U.el('span', { text: '⚡ 快捷操作' })]),
          U.el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
            U.el('button', { class: 'btn sm', text: '📂 选择文件夹开始浏览', onclick: () => { App.switchView('browse'); pickAndBrowse(); } }),
            U.el('button', { class: 'btn sm', text: '🤖 问 AI 文件管家', onclick: () => App.switchView('butler') }),
            U.el('button', { class: 'btn sm primary', text: '✨ 批量 AI 打标签', onclick: () => { App.switchView('browse'); } }),
            U.el('button', { class: 'btn ghost sm', text: '⚙️ 打开设置', onclick: () => App.switchView('settings') }),
          ]),
        ]),
      ]),
    );
  }

  function card(title, valueNode, subText) {
    return U.el('div', { class: 'dash-card' }, [
      U.el('div', { class: 'dash-card-title' }, [U.el('span', { text: title })]),
      typeof valueNode === 'string' ? U.el('div', { class: 'dash-card-value', text: valueNode }) : valueNode,
      U.el('div', { class: 'dash-card-sub', text: subText }),
    ]);
  }

  function renderProgressRing(pct, current, total) {
    const size = 80;
    const stroke = 6;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (pct / 100) * circumference;

    return U.el('div', { class: 'dash-progress-ring' }, [
      U.el('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` }, [
        U.el('circle', {
          cx: size / 2, cy: size / 2, r: radius,
          fill: 'none', stroke: 'var(--bg-3)', 'stroke-width': stroke,
        }),
        U.el('circle', {
          cx: size / 2, cy: size / 2, r: radius,
          fill: 'none', stroke: 'var(--accent)', 'stroke-width': stroke,
          'stroke-dasharray': circumference, 'stroke-dashoffset': offset,
          'stroke-linecap': 'round', style: { transition: 'stroke-dashoffset .6s ease' },
        }),
      ]),
      U.el('div', { class: 'dash-progress-text', text: pct + '%' }),
    ]);
  }

  async function pickAndBrowse() {
    const picked = await U.safeCall('fsPickFolder');
    if (picked) Explorer.openDir(picked);
  }

  window.Dash = Dash;
})();
