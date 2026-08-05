/* 标签云、标签管理、按标签检索、失效标签修复 */
(function () {
  'use strict';

  const Tags = {};

  /* ---------------- 侧边栏标签云 ---------------- */
  Tags.renderCloud = function () {
    const box = U.$('#tagCloud');
    box.replaceChildren();
    const list = S.tags.slice().sort((a, b) => (b.usage || 0) - (a.usage || 0) || a.name.localeCompare(b.name, 'zh'));
    if (!list.length) {
      box.appendChild(U.el('div', { class: 'hist', style: { padding: '6px 4px' },
        text: '还没有标签。选中一个文件夹后点「AI 生成标签」，或者手动添加。' }));
      return;
    }
    // 按分类分组
    const byCat = new Map();
    for (const t of list) {
      const c = t.category || 'custom';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(t);
    }
    const catName = new Map(S.categories.map((c) => [c.id, c.name]));
    for (const [cid, arr] of byCat) {
      box.appendChild(U.el('div', {
        style: { width: '100%', fontSize: '10.5px', color: 'var(--text-faint)', margin: '4px 0 1px' },
        text: catName.get(cid) || '其它',
      }));
      arr.forEach((t) => {
        const on = S.activeTagIds.has(t.id);
        const chip = U.el('span', {
          class: 'tag-chip' + (on ? ' on' : ''),
          style: U.tagStyle(t.color),
          title: `${t.name}（${t.usage || 0} 个项目）${t.source === 'ai' ? ' · AI 生成' : ''}`,
          onclick: () => {
            if (S.activeTagIds.has(t.id)) S.activeTagIds.delete(t.id);
            else S.activeTagIds.add(t.id);
            Tags.renderCloud();
            App.switchView('tags');
            Tags.runFilter();
          },
        }, [
          U.el('span', { text: t.name }),
          U.el('span', { class: 'cnt', text: String(t.usage || 0) }),
        ]);
        box.appendChild(chip);
      });
    }
  };

  /* ---------------- 按标签检索 ---------------- */
  Tags.runFilter = async function () {
    const ids = [...S.activeTagIds];
    const title = U.$('#tagResultTitle');
    let list;
    if (!ids.length) {
      list = await U.safeCall('libListAnnotated');
      title.textContent = `全部已标注的文件夹`;
    } else {
      list = await U.safeCall('libSearchByTags', ids, S.tagMode);
      const names = ids.map((i) => S.tag(i)?.name).filter(Boolean).join(S.tagMode === 'and' ? ' + ' : ' / ');
      title.textContent = `标签：${names}`;
    }
    Tags.renderResults(list || []);
  };

  Tags.searchText = async function (q) {
    if (!q.trim()) return Tags.runFilter();
    const list = await U.safeCall('libSearchText', q);
    U.$('#tagResultTitle').textContent = `搜索「${q}」`;
    Tags.renderResults(list || []);
  };

  Tags.renderResults = function (list) {
    const box = U.$('#tagResults');
    box.replaceChildren();
    if (!list.length) {
      box.appendChild(U.el('div', { class: 'empty', style: { gridColumn: '1/-1' },
        html: '<b>没有匹配的文件夹</b>试试减少标签条件，或先给一些文件夹打上标签。' }));
      return;
    }
    for (const item of list) {
      const a = item.annotation || {};
      const card = U.el('div', {
        class: 'card' + (item.status === 'missing' ? ' missing' : ''),
        onclick: () => {
          App.switchView('browse');
          Explorer.openDir(item.path);
        },
      });
      card.appendChild(U.el('div', { class: 'card-head' }, [
        U.icon('folder'),
        U.el('b', { text: item.name }),
        item.status === 'missing'
          ? U.el('span', { class: 'conf', text: '路径失效', style: { color: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 16%, transparent)' } })
          : (a.confidence != null
            ? U.el('span', { class: 'conf', text: Math.round(a.confidence * 100) + '%', style: { color: U.confColor(a.confidence), background: 'color-mix(in srgb, currentColor 14%, transparent)' } })
            : null),
      ].filter(Boolean)));
      card.appendChild(U.el('div', { class: 'card-path', text: item.parent }));
      if (a.summary) card.appendChild(U.el('div', { class: 'card-sum', text: a.summary }));
      if (a.note) card.appendChild(U.el('div', { class: 'card-sum', style: { color: 'var(--accent)' }, text: '备注：' + a.note }));
      const tg = U.el('div', { class: 'card-tags' });
      (a.tags || []).forEach((t) => {
        tg.appendChild(U.el('span', { class: 'tag-pill', style: U.tagStyle(t.color), text: t.name }));
      });
      card.appendChild(tg);
      box.appendChild(card);
    }
  };

  /* ---------------- 标签管理器 ---------------- */
  Tags.openManager = async function () {
    await S.refreshTags();
    const body = U.el('div');

    const render = () => {
      body.replaceChildren();

      // 新建
      const nameI = U.el('input', { class: 'input sm', placeholder: '新标签名称', style: { width: '150px' } });
      const colorI = U.el('input', { type: 'color', value: '#4a9eff' });
      const catI = U.el('select', { class: 'input sm' },
        S.categories.map((c) => U.el('option', { value: c.id, text: c.name })));
      body.appendChild(U.el('div', { style: { display: 'flex', gap: '7px', marginBottom: '14px', flexWrap: 'wrap' } }, [
        nameI, colorI, catI,
        U.el('button', { class: 'btn sm primary', text: '新建标签', onclick: async () => {
          if (!nameI.value.trim()) return U.toast('请输入标签名称', 'warn');
          const r = await U.safeCall('libCreateTag', { name: nameI.value.trim(), color: colorI.value, category: catI.value, source: 'user' });
          if (r) { await S.refreshTags(); render(); Tags.renderCloud(); U.toast('已创建', 'ok', 1500); }
        } }),
      ]));

      // 分类管理
      const catBox = U.el('div', { class: 'chiplist', style: { marginBottom: '14px' } });
      S.categories.forEach((c) => {
        catBox.appendChild(U.el('span', { class: 'c' }, [
          U.el('b', { text: c.name }),
          ['purpose', 'project', 'content', 'status', 'custom'].includes(c.id) ? null :
            U.el('span', { class: 'x', text: '×', onclick: async () => {
              await U.safeCall('libDeleteCategory', c.id);
              await S.refreshTags(); render(); Tags.renderCloud();
            } }),
        ].filter(Boolean)));
      });
      catBox.appendChild(U.el('button', { class: 'btn sm ghost', text: '+ 新分类', onclick: async () => {
        const n = await U.prompt('新建分类', '分类用来把标签分组，例如「客户」「年份」');
        if (!n) return;
        await U.safeCall('libUpsertCategory', { name: n });
        await S.refreshTags(); render(); Tags.renderCloud();
      } }));
      body.appendChild(U.el('div', {}, [
        U.el('div', { class: 'd-sec-title', text: '标签分类' }), catBox,
      ]));

      // 标签表
      const tbl = U.el('table', { class: 'tbl' });
      tbl.appendChild(U.el('thead', {}, [U.el('tr', {}, [
        U.el('th', { text: '颜色' }), U.el('th', { text: '名称' }),
        U.el('th', { text: '分类' }), U.el('th', { text: '来源' }),
        U.el('th', { text: '使用' }), U.el('th', { text: '' }),
      ])]));
      const tb = U.el('tbody');
      S.tags.slice().sort((a, b) => (b.usage || 0) - (a.usage || 0)).forEach((t) => {
        const ci = U.el('input', { type: 'color', value: t.color });
        ci.addEventListener('change', async () => {
          await U.safeCall('libUpdateTag', t.id, { color: ci.value });
          await S.refreshTags(); Tags.renderCloud(); Explorer.render();
        });
        const ni = U.el('input', { class: 'input sm', value: t.name, style: { width: '120px' } });
        ni.addEventListener('change', async () => {
          const r = await U.safeCall('libUpdateTag', t.id, { name: ni.value });
          if (r) { await S.refreshTags(); Tags.renderCloud(); Explorer.render(); }
          else render();
        });
        const cs = U.el('select', { class: 'input sm' }, S.categories.map((c) =>
          U.el('option', { value: c.id, text: c.name, selected: c.id === (t.category || 'custom') })));
        cs.addEventListener('change', async () => {
          await U.safeCall('libUpdateTag', t.id, { category: cs.value });
          await S.refreshTags(); Tags.renderCloud();
        });
        tb.appendChild(U.el('tr', {}, [
          U.el('td', {}, [ci]),
          U.el('td', {}, [ni]),
          U.el('td', {}, [cs]),
          U.el('td', { text: t.source === 'ai' ? 'AI' : '手动' }),
          U.el('td', { text: String(t.usage || 0) }),
          U.el('td', {}, [U.el('button', { class: 'mini', title: '删除标签', onclick: async () => {
            if (!(await U.confirm('删除标签', `确定删除标签「${U.esc(t.name)}」？<br>它会从所有 ${t.usage || 0} 个文件夹上移除。`, true))) return;
            await U.safeCall('libDeleteTag', t.id);
            await S.refreshTags(); render(); Tags.renderCloud(); Explorer.render();
          } }, [U.icon('trash')])]),
        ]));
      });
      tbl.appendChild(tb);
      body.appendChild(U.el('div', { class: 'd-sec-title', text: `全部标签（${S.tags.length}）` }));
      body.appendChild(tbl);
    };

    render();
    U.modal({ title: '标签管理', icon: 'tag', wide: true, body,
      buttons: [{ text: '完成', kind: 'primary', onClick: (c) => { c(); Tags.runFilter(); } }] });
  };

  /* ---------------- 失效标签检查与重连 ---------------- */
  Tags.verifyLinks = async function () {
    const t = U.toast('正在检查所有已标注的路径…', '', 60000);
    const rep = await U.safeCall('relinkVerify');
    t.remove();
    if (!rep) return;

    const body = U.el('div');
    body.appendChild(U.el('div', { class: 'kv', html:
      `共检查 <b>${rep.checked}</b> 个已标注文件夹：正常 <b>${rep.ok}</b>，失效 <b>${rep.missing}</b>，
       自动重新关联 <b style="color:var(--ok)">${rep.relinked.length}</b>，待确认 <b style="color:var(--warn)">${rep.candidates.length}</b>。` }));

    if (rep.relinked.length) {
      body.appendChild(U.el('div', { class: 'd-sec-title', style: { marginTop: '14px' }, text: '已自动重新关联' }));
      rep.relinked.forEach((r) => {
        body.appendChild(U.el('div', { class: 'hist', html:
          `<code>${U.esc(r.from)}</code><br>→ <code style="color:var(--ok)">${U.esc(r.to)}</code>　（${U.esc(r.reason)}，置信 ${Math.round(r.score * 100)}%）` }));
      });
    }

    if (rep.candidates.length) {
      body.appendChild(U.el('div', { class: 'd-sec-title', style: { marginTop: '14px' }, text: '需要你确认' }));
      rep.candidates.forEach((c) => {
        const wrap = U.el('div', { style: { marginBottom: '10px', paddingBottom: '10px', borderBottom: '1px solid var(--border-soft)' } });
        wrap.appendChild(U.el('div', { class: 'hist', html: `原路径：<code>${U.esc(c.oldPath)}</code>` }));
        c.options.forEach((o) => {
          wrap.appendChild(U.el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '5px' } }, [
            U.el('code', { style: { fontSize: '11px', flex: 1, wordBreak: 'break-all' }, text: o.path }),
            U.el('span', { class: 'conf', text: Math.round(o.score * 100) + '%', style: { color: U.confColor(o.score) } }),
            U.el('button', { class: 'btn sm primary', text: '就是它', onclick: async (e) => {
              await U.safeCall('relinkApply', c.oldPath, o.path);
              e.target.closest('div').parentElement.remove();
              U.toast('已重新关联', 'ok');
              Tags.runFilter();
            } }),
          ]));
        });
        body.appendChild(wrap);
      });
    }

    if (rep.stillMissing.length) {
      body.appendChild(U.el('div', { class: 'd-sec-title', style: { marginTop: '14px' }, text: `找不到对应位置（${rep.stillMissing.length}）` }));
      body.appendChild(U.el('div', { class: 'notice warn' }, [U.icon('warn'), U.el('div', {
        html: '这些文件夹可能被删除了，或者不在扫描索引范围内。<br>可以先在「设置」里把对应磁盘加入扫描范围再重新扫描。' })]));
      rep.stillMissing.slice(0, 20).forEach((p) => body.appendChild(U.el('div', { class: 'hist', html: `<code>${U.esc(p)}</code>` })));
    }

    U.modal({ title: '失效标签检查', icon: 'refresh', wide: true, body,
      buttons: [{ text: '完成', kind: 'primary', onClick: (c) => { c(); Tags.runFilter(); } }] });
  };

  window.Tags = Tags;
})();
