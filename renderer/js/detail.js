/* 右侧详情面板：文件夹画像 + AI 用途说明 + 标签编辑 + 备注 */
(function () {
  'use strict';

  const Detail = {};
  let curPath = null;
  let curProfile = null;
  let busy = false;

  const emptyEl = () => U.$('#detailEmpty');
  const bodyEl = () => U.$('#detailBody');

  Detail.show = async function (p) {
    curPath = p;
    emptyEl().hidden = true;
    bodyEl().hidden = false;
    bodyEl().replaceChildren(U.el('div', { class: 'empty', text: '正在读取文件夹信息…' }));

    const [profile, views] = await Promise.all([
      U.safeCall('fsProfile', p),
      U.call('libViews', [p]).catch(() => ({})),
    ]);
    if (curPath !== p) return;   // 用户已切走
    curProfile = profile;
    const ann = (views && views[p]) || null;
    S.ann.set(p, ann);
    render(p, profile, ann);
  };

  Detail.showFile = async function (r) {
    curPath = r.path;
    curProfile = { itemType: 'file', name: r.name, ext: r.ext || '', cat: r.cat || 'other', size: r.size || 0, mtimeMs: r.mtimeMs || 0 };
    emptyEl().hidden = true;
    bodyEl().hidden = false;
    bodyEl().replaceChildren(U.el('div', { class: 'empty', text: '正在读取文件信息…' }));

    const views = await U.call('libViews', [r.path]).catch(() => ({}));
    if (curPath !== r.path) return;
    const ann = (views && views[r.path]) || null;
    S.setAnn(r.path, ann);
    renderFile(r, ann);
  };

  function renderFile(r, ann) {
    const wrap = U.el('div');

    wrap.appendChild(U.el('div', { class: 'd-head' }, [
      U.icon('file'),
      U.el('div', {}, [U.el('div', { class: 'd-title', text: r.name })]),
    ]));
    wrap.appendChild(U.el('div', { class: 'd-path', text: r.path }));

    wrap.appendChild(U.el('div', { class: 'd-actions' }, [
      btn(ann && ann.hasAi ? '重新生成' : 'AI 生成标签', 'sparkle', () => Detail.analyze(r.path, true), 'primary'),
      btn('问 AI 管家', 'chat', () => window.Butler && window.Butler.askAbout(r.path)),
      btn('打开', 'external', () => U.safeCall('fsOpen', r.path)),
      btn('定位', null, () => U.safeCall('fsReveal', r.path)),
    ]));

    // 用途说明
    const sumSec = U.el('div', { class: 'd-sec' });
    sumSec.appendChild(U.el('div', { class: 'd-sec-title' }, [
      U.el('span', { text: '用途说明' }),
      U.el('div', { class: 'right' }, [
        mini('edit', '手动编辑说明（会覆盖 AI 结果）', () => editSummary(r.path, ann)),
        ann && ann.summaryOverride ? mini('refresh', '恢复为 AI 生成的说明', async () => {
          await U.safeCall('libSetSummary', r.path, '');
          reload(r.path);
        }) : null,
      ].filter(Boolean)),
    ]));
    const text = ann && ann.summary ? ann.summary : '';
    sumSec.appendChild(U.el('div', { class: 'summary-box' + (text ? '' : ' placeholder'), text: text || '还没有说明。点上面的「AI 生成标签」，让 AI 根据文件名和类型猜出它的用途。' }));
    if (ann && (ann.hasAi || ann.summaryOverride)) {
      const meta = U.el('div', { class: 'summary-meta' });
      if (ann.summaryOverride) meta.appendChild(U.el('span', { text: '✎ 由你手动编辑', style: { color: 'var(--accent)' } }));
      if (ann.confidence != null) {
        const pct = Math.round(ann.confidence * 100);
        meta.appendChild(U.el('span', { class: 'conf-bar' }, [
          U.el('span', { text: '把握' }),
          U.el('span', { class: 'conf-track' }, [U.el('i', { class: 'conf-fill', style: { width: pct + '%', background: U.confColor(ann.confidence), display: 'block' } })]),
          U.el('b', { text: pct + '%', style: { color: U.confColor(ann.confidence) } }),
        ]));
      }
      if (ann.aiModel) meta.appendChild(U.el('span', { text: '模型：' + ann.aiModel }));
      if (ann.aiSource === 'local') meta.appendChild(U.el('span', { text: '（离线规则推断）', style: { color: 'var(--warn)' } }));
      if (ann.aiGeneratedAt) meta.appendChild(U.el('span', { text: U.date(ann.aiGeneratedAt) }));
      sumSec.appendChild(meta);
      if (ann.aiReason) sumSec.appendChild(U.el('div', { class: 'hist', style: { marginTop: '6px' }, text: '判断依据：' + ann.aiReason }));
    }
    wrap.appendChild(sumSec);

    // 标签
    const tagSec = U.el('div', { class: 'd-sec' });
    tagSec.appendChild(U.el('div', { class: 'd-sec-title' }, [U.el('span', { text: '标签' })]));
    tagSec.appendChild(tagEditor(r.path, ann));
    wrap.appendChild(tagSec);

    // 备注
    const noteSec = U.el('div', { class: 'd-sec' });
    noteSec.appendChild(U.el('div', { class: 'd-sec-title' }, [U.el('span', { text: '我的备注' })]));
    const ta = U.el('textarea', { class: 'input', rows: 3, placeholder: '写点只有你自己知道的说明…', style: { width: '100%' } });
    ta.value = (ann && ann.note) || '';
    const saveNote = U.debounce(async () => {
      const v = await U.safeCall('libSetNote', r.path, ta.value);
      if (v) S.setAnn(r.path, v);
    }, 500);
    ta.addEventListener('input', saveNote);
    noteSec.appendChild(ta);
    wrap.appendChild(noteSec);

    // 文件元信息
    wrap.appendChild(U.el('div', { class: 'd-sec' }, [
      U.el('div', { class: 'd-sec-title' }, [U.el('span', { text: '文件信息' })]),
      U.el('div', { class: 'stat-grid' }, [
        stat('文件大小', U.size(r.size)),
        stat('类型', U.CAT_ZH[r.cat] || '其它'),
        stat('修改时间', U.date(r.mtimeMs)),
        stat('扩展名', r.ext ? '.' + r.ext : '无'),
      ]),
    ]));

    // 清除
    if (ann) {
      wrap.appendChild(U.el('div', { class: 'd-sec' }, [
        U.el('button', {
          class: 'btn danger sm', text: '清除这个文件的全部标注',
          onclick: async () => {
            if (!(await U.confirm('确认清除', `将删除「${U.esc(U.basename(r.path))}」的 AI 说明、标签和备注。<br>此操作不可撤销。`, true))) return;
            await U.safeCall('libClearAnnotation', r.path);
            S.ann.delete(r.path);
            reload(r.path);
            U.toast('已清除', 'ok');
          },
        }),
      ]));
    }

    bodyEl().replaceChildren(wrap);
  }

  Detail.clear = function () {
    curPath = null;
    bodyEl().hidden = true;
    emptyEl().hidden = false;
  };

  Detail.current = () => curPath;

  /* ---------------- 主渲染 ---------------- */
  function render(p, profile, ann) {
    const wrap = U.el('div');

    // 头部
    wrap.appendChild(U.el('div', { class: 'd-head' }, [
      U.icon('folder'),
      U.el('div', {}, [
        U.el('div', { class: 'd-title', text: U.basename(p) }),
      ]),
    ]));
    wrap.appendChild(U.el('div', { class: 'd-path', text: p }));

    if (ann && ann.status === 'missing') {
      wrap.appendChild(U.el('div', { class: 'notice warn' }, [
        U.icon('warn'),
        U.el('div', { html: '这个路径已经不存在了。可以在「按标签查找 → 检查失效标签」里把标签重新关联到新位置。' }),
      ]));
    }

    // 操作按钮
    wrap.appendChild(U.el('div', { class: 'd-actions' }, [
      btn(ann && ann.hasAi ? '重新生成' : 'AI 生成标签', 'sparkle', () => Detail.analyze(p, true), 'primary'),
      btn('递归分析子项', 'sparkle', () => Detail.analyzeRecursive(p)),
      btn('问 AI 管家', 'chat', () => window.Butler && window.Butler.askAbout(p)),
      btn('打开', 'external', () => U.safeCall('fsOpen', p)),
      btn('定位', null, () => U.safeCall('fsReveal', p)),
      btn('将发送什么？', 'shield', () => showPrivacyPreview(p)),
    ]));

    // ---- 用途说明 ----
    const sumSec = U.el('div', { class: 'd-sec' });
    sumSec.appendChild(U.el('div', { class: 'd-sec-title' }, [
      U.el('span', { text: '用途说明' }),
      U.el('div', { class: 'right' }, [
        mini('edit', '手动编辑说明（会覆盖 AI 结果）', () => editSummary(p, ann)),
        ann && ann.summaryOverride ? mini('refresh', '恢复为 AI 生成的说明', async () => {
          await U.safeCall('libSetSummary', p, '');
          reload(p);
        }) : null,
      ].filter(Boolean)),
    ]));

    const text = ann && ann.summary ? ann.summary : '';
    const box = U.el('div', { class: 'summary-box' + (text ? '' : ' placeholder') , text: text || '还没有说明。点上面的「AI 生成标签」，让 AI 根据文件夹结构猜出它的用途。' });
    sumSec.appendChild(box);

    if (ann && (ann.hasAi || ann.summaryOverride)) {
      const meta = U.el('div', { class: 'summary-meta' });
      if (ann.summaryOverride) {
        meta.appendChild(U.el('span', { text: '✎ 由你手动编辑', style: { color: 'var(--accent)' } }));
      }
      if (ann.confidence != null) {
        const pct = Math.round(ann.confidence * 100);
        meta.appendChild(U.el('span', { class: 'conf-bar' }, [
          U.el('span', { text: '把握' }),
          U.el('span', { class: 'conf-track' }, [
            U.el('i', { class: 'conf-fill', style: { width: pct + '%', background: U.confColor(ann.confidence), display: 'block' } }),
          ]),
          U.el('b', { text: pct + '%', style: { color: U.confColor(ann.confidence) } }),
        ]));
      }
      if (ann.aiModel) meta.appendChild(U.el('span', { text: '模型：' + ann.aiModel }));
      if (ann.aiSource === 'local') meta.appendChild(U.el('span', { text: '（离线规则推断）', style: { color: 'var(--warn)' } }));
      if (ann.aiGeneratedAt) meta.appendChild(U.el('span', { text: U.date(ann.aiGeneratedAt) }));
      sumSec.appendChild(meta);
      if (ann.aiReason) {
        sumSec.appendChild(U.el('div', { class: 'hist', style: { marginTop: '6px' }, text: '判断依据：' + ann.aiReason }));
      }
    }
    wrap.appendChild(sumSec);

    // ---- 标签 ----
    const tagSec = U.el('div', { class: 'd-sec' });
    tagSec.appendChild(U.el('div', { class: 'd-sec-title' }, [
      U.el('span', { text: '标签' }),
      U.el('div', { class: 'right' }, [
        ann && ann.removedAiTags && ann.removedAiTags.length
          ? mini('refresh', `恢复被你删掉的 ${ann.removedAiTags.length} 个 AI 标签`, async () => {
              await U.safeCall('libRestoreAi', p); reload(p);
            })
          : null,
      ].filter(Boolean)),
    ]));
    tagSec.appendChild(tagEditor(p, ann));
    wrap.appendChild(tagSec);

    // ---- 备注 ----
    const noteSec = U.el('div', { class: 'd-sec' });
    noteSec.appendChild(U.el('div', { class: 'd-sec-title' }, [U.el('span', { text: '我的备注' })]));
    const ta = U.el('textarea', {
      class: 'input', rows: 3, placeholder: '写点只有你自己知道的说明，比如「这是给客户 A 的资料，2024 年之前的」',
      style: { width: '100%' },
    });
    ta.value = (ann && ann.note) || '';
    const saveNote = U.debounce(async () => {
      const v = await U.safeCall('libSetNote', p, ta.value);
      if (v) S.setAnn(p, v);
    }, 500);
    ta.addEventListener('input', saveNote);
    noteSec.appendChild(ta);
    wrap.appendChild(noteSec);

    // ---- 内容构成 ----
    if (profile) {
      const st = U.el('div', { class: 'd-sec' });
      st.appendChild(U.el('div', { class: 'd-sec-title' }, [U.el('span', { text: '内容构成' })]));
      st.appendChild(U.el('div', { class: 'stat-grid' }, [
        stat('子文件夹', profile.dirCount),
        stat('直接文件', profile.fileCount),
        stat('文件大小', U.size(profile.totalSizeOfDirectFiles)),
        stat('最近修改', U.date(profile.newestMtime)),
      ]));

      if (profile.categories && profile.categories.length) {
        const total = profile.categories.reduce((s, c) => s + c.count, 0) || 1;
        const bar = U.el('div', { class: 'type-bar' });
        const legend = U.el('div', { class: 'type-legend' });
        profile.categories.slice(0, 6).forEach((c) => {
          const color = U.CAT_COLOR[c.cat] || '#6d7f8c';
          bar.appendChild(U.el('i', { style: { width: (c.count / total * 100) + '%', background: color, display: 'block' } }));
          legend.appendChild(U.el('span', { html: `<i style="background:${color}"></i>${U.CAT_ZH[c.cat] || c.cat} ${c.count}` }));
        });
        st.append(bar, legend);
      }

      if (profile.markers && profile.markers.length) {
        st.appendChild(U.el('div', { class: 'hist', style: { marginTop: '8px' }, text: '识别到：' + profile.markers.join('、') }));
      }
      wrap.appendChild(st);
    }

    // ---- 变更历史 ----
    if (ann && ann.history && ann.history.length) {
      const h = U.el('div', { class: 'd-sec' });
      h.appendChild(U.el('div', { class: 'd-sec-title' }, [U.el('span', { text: '标签迁移记录' })]));
      ann.history.slice(-5).reverse().forEach((x) => {
        h.appendChild(U.el('div', { class: 'hist', html:
          `${U.date(x.at)} · ${x.method === 'auto' ? '自动重连' : '手动重连'}<br><code>${U.esc(x.from)}</code> → <code>${U.esc(x.to)}</code>` }));
      });
      wrap.appendChild(h);
    }

    // ---- 危险操作 ----
    if (ann) {
      wrap.appendChild(U.el('div', { class: 'd-sec' }, [
        U.el('button', {
          class: 'btn danger sm', text: '清除这个文件夹的全部标注',
          onclick: async () => {
            if (!(await U.confirm('确认清除', `将删除「${U.esc(U.basename(p))}」的 AI 说明、标签和备注。<br>此操作不可撤销。`, true))) return;
            await U.safeCall('libClearAnnotation', p);
            S.ann.delete(p);
            reload(p);
            U.toast('已清除', 'ok');
          },
        }),
      ]));
    }

    bodyEl().replaceChildren(wrap);
  }

  /* ---------------- 标签编辑器 ---------------- */
  function tagEditor(p, ann) {
    const box = U.el('div', { class: 'tag-editor' });
    const tags = (ann && ann.tags) || [];
    tags.forEach((t) => {
      const pill = U.el('span', { class: 'tag-pill', style: U.tagStyle(t.color), title: t.fromAi ? 'AI 生成的标签' : '你添加的标签' }, [
        t.fromAi ? U.el('span', { class: 'ai-mark', text: 'AI' }) : null,
        U.el('span', { text: t.name }),
        U.el('span', { class: 'x', text: '×', onclick: async () => {
          const v = await U.safeCall('libRemoveTag', p, t.id);
          if (v) { S.setAnn(p, v); reload(p); }
        } }),
      ].filter(Boolean));
      box.appendChild(pill);
    });

    // 添加标签输入
    const holder = U.el('div', { class: 'add-tag-input' });
    const input = U.el('input', { class: 'input sm', placeholder: '+ 添加标签', style: { width: '116px' } });
    const sug = U.el('div', { class: 'suggest', hidden: true });
    holder.append(input, sug);

    let hi = -1;
    const refreshSug = () => {
      const q = input.value.trim().toLowerCase();
      const used = new Set(tags.map((t) => t.id));
      const list = S.tags
        .filter((t) => !used.has(t.id) && (!q || t.name.toLowerCase().includes(q)))
        .slice(0, 8);
      sug.replaceChildren();
      list.forEach((t, i) => {
        sug.appendChild(U.el('div', { class: i === hi ? 'hi' : '', onmousedown: (e) => { e.preventDefault(); add(t.name); } }, [
          U.el('i', { class: 'dot-tag', style: { background: t.color } }),
          U.el('span', { text: t.name }),
          U.el('span', { text: '×' + (t.usage || 0), style: { marginLeft: 'auto', opacity: .5, fontSize: '10px' } }),
        ]));
      });
      if (q && !S.tags.some((t) => t.name.toLowerCase() === q)) {
        sug.appendChild(U.el('div', { onmousedown: (e) => { e.preventDefault(); add(input.value.trim()); } }, [
          U.icon('plus'), U.el('span', { text: `新建标签「${input.value.trim()}」` }),
        ]));
      }
      sug.hidden = sug.childElementCount === 0;
    };

    async function add(name) {
      if (!name) return;
      input.value = '';
      sug.hidden = true;
      const v = await U.safeCall('libAddTag', p, name);
      if (v) {
        S.setAnn(p, v);
        await S.refreshTags();
        reload(p);
      }
    }

    input.addEventListener('input', () => { hi = -1; refreshSug(); });
    input.addEventListener('focus', refreshSug);
    input.addEventListener('blur', () => setTimeout(() => { sug.hidden = true; }, 120));
    input.addEventListener('keydown', (e) => {
      const items = Array.from(sug.children);
      if (e.key === 'ArrowDown') { hi = Math.min(hi + 1, items.length - 1); refreshSug(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { hi = Math.max(hi - 1, 0); refreshSug(); e.preventDefault(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (hi >= 0 && items[hi]) items[hi].dispatchEvent(new MouseEvent('mousedown'));
        else add(input.value.trim());
      } else if (e.key === 'Escape') { sug.hidden = true; }
    });

    box.appendChild(holder);
    return box;
  }

  /* ---------------- 动作 ---------------- */
  Detail.analyze = async function (p, force) {
    if (busy) { U.toast('上一个分析还在进行中', 'warn'); return; }
    busy = true;
    const t = U.toast('正在分析「' + U.basename(p) + '」…', '', 60000);
    try {
      const view = await U.call('aiAnalyzeOne', p);
      S.setAnn(p, view);
      await S.refreshTags();
      if (curPath === p) reload(p);
      Explorer.render();
      U.toast(`已生成：${view.summary || '（无说明）'}`, 'ok', 4000);
    } catch (e) {
      U.toast('生成失败：' + e.message, 'err');
    } finally {
      t.remove();
      busy = false;
    }
  };

  Detail.analyzeRecursive = async function (p) {
    const s = S.settings;
    const hasKey = s.ai.hasApiKey && s.ai.enabled;
    const depth = s.ai.recursiveMaxDepth ?? 3;
    const msg = hasKey
      ? `将递归分析「<b>${U.esc(U.basename(p))}</b>」下最多 <b>${depth}</b> 层深的所有文件夹和文件。<br>
         每个子项都会调用一次 AI（只发文件名和类型，不发内容），可能产生较多 API 费用。`
      : `尚未配置 AI，将使用<b>离线规则</b>递归推断「<b>${U.esc(U.basename(p))}</b>」下最多 <b>${depth}</b> 层深的所有子项（免费但不精确）。`;
    if (!(await U.confirm('递归 AI 分析', msg))) return;
    const r = await U.safeCall('aiBatch', [p], { recursive: true });
    if (r) {
      U.toast(`递归任务已开始：${r.total} 个待处理` + (r.skipped ? `，${r.skipped} 个已有结果被跳过` : ''), '', 4000);
      if (r.total === 0) U.toast('所选范围下都已经有结果了', 'warn');
    }
  };

  async function reload(p) {
    const views = await U.call('libViews', [p]).catch(() => ({}));
    const ann = (views && views[p]) || null;
    S.ann.set(p, ann);
    if (curPath === p) {
      if (curProfile && curProfile.itemType === 'file') {
        // 重新构造一个最小的文件行对象用于 renderFile
        renderFile({ path: p, name: U.basename(p), isDir: false, size: curProfile.size || 0, mtimeMs: curProfile.mtimeMs || 0, cat: curProfile.cat || 'other', ext: curProfile.ext || '' }, ann);
      } else {
        render(p, curProfile, ann);
      }
    }
    Explorer.render();
  }
  Detail.reload = reload;

  async function editSummary(p, ann) {
    const v = await U.prompt('编辑用途说明', '你写的说明会覆盖 AI 的结果，留空则恢复使用 AI 说明。', (ann && ann.summaryOverride) || (ann && ann.aiSummary) || '');
    if (v === null) return;
    const view = await U.safeCall('libSetSummary', p, v);
    if (view) { S.setAnn(p, view); reload(p); }
  }

  async function showPrivacyPreview(p) {
    const info = await U.safeCall('aiPreview', p);
    if (!info) return;
    const body = U.el('div');
    body.appendChild(U.el('div', { class: 'notice ' + (info.hasApiKey ? 'info' : 'warn') }, [
      U.icon('shield'),
      U.el('div', { html: info.hasApiKey
        ? `点击「AI 生成标签」时，<b>只有下面这段文本</b>会被发送到 <code>${U.esc(info.endpoint)}</code>（模型 ${U.esc(info.model)}）。<br>文件内容 <b>永远不会</b> 被读取或上传。`
        : '尚未配置 API Key，当前会使用<b>完全离线</b>的本地规则推断，不会有任何网络请求。下面是本地分析所依据的信息。' }),
    ]));
    body.appendChild(U.el('div', { class: 'kv', html:
      `发送文件名：<b>${info.willSendFileNames ? '是' : '否'}</b> ｜ 发送完整路径：<b>${info.willSendFullPath ? '是' : '否'}</b> ｜ 发送文件内容：<b style="color:var(--ok)">否</b>` }));
    body.appendChild(U.el('pre', { class: 'payload', text: info.payload }));
    U.modal({ title: '将要发送的数据', icon: 'shield', wide: true, body,
      buttons: [
        { text: '复制', onClick: () => U.copy(info.payload) },
        { text: '知道了', kind: 'primary', onClick: (c) => c() },
      ] });
  }

  /* ---------------- 小组件 ---------------- */
  function btn(text, icon, onClick, kind) {
    return U.el('button', { class: 'btn sm ' + (kind || ''), onclick: onClick }, [
      icon ? U.icon(icon) : null, U.el('span', { text }),
    ].filter(Boolean));
  }
  function mini(icon, title, onClick) {
    return U.el('button', { class: 'mini', title, onclick: onClick }, [U.icon(icon)]);
  }
  function stat(k, v) {
    return U.el('div', { class: 'stat' }, [
      U.el('div', { class: 'k', text: k }),
      U.el('div', { class: 'v', text: String(v ?? '—') }),
    ]);
  }

  window.Detail = Detail;
})();
