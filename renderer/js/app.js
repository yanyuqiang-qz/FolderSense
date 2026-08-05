/* 应用入口：装配各模块、事件绑定、生命周期 */
(function () {
  'use strict';

  const App = {};

  App.boot = async function () {
    try {
      S.appInfo = await U.call('appInfo');
      S.settings = await U.call('settingsGet');
    } catch (e) {
      document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif">启动失败：' + U.esc(e.message) + '</div>';
      return;
    }

    App.applySettings();
    Explorer.init();
    bindUI();
    subscribeEvents();

    await S.refreshTags();
    Tags.renderCloud();
    await App.loadPlaces();

    S.indexSummary = await U.safeCall('indexSummary');
    App.updateIndexPill();

    // 默认展开主目录
    const home = S.roots.system.find((r) => r.kind === 'home') || S.roots.custom[0] || S.roots.system[0];
    if (home) {
      S.expanded.add(home.path);
      await Explorer.loadChildren(home.path);
    }
    Explorer.render();

    // 后台静默检查失效标签
    setTimeout(async () => {
      const st = await U.safeCall('libStats');
      if (st && st.annotated > 0) {
        const rep = await U.safeCall('relinkVerify');
        if (rep && (rep.relinked.length || rep.candidates.length)) {
          U.toast(`检测到 ${rep.missing} 个文件夹换了位置，已自动接回 ${rep.relinked.length} 个标签` +
            (rep.candidates.length ? `，还有 ${rep.candidates.length} 个待你确认` : ''), 'warn', 8000);
        }
      }
      updateStatus();
    }, 1500);

    updateStatus();
  };

  App.applySettings = function () {
    const s = S.settings;
    document.body.dataset.theme = s.ui.theme || 'dark';
    I18N.set(s.ui.language || 'zh-CN');
    S.showHidden = !!s.ui.showHiddenFiles;
    S.sort = s.ui.defaultSort || 'name-asc';
    const sh = U.$('#showHidden'); if (sh) sh.checked = S.showHidden;
    const ss = U.$('#sortSelect'); if (ss) ss.value = S.sort;
  };

  /* ---------------- 位置列表 ---------------- */
  App.loadPlaces = async function () {
    const r = await U.safeCall('fsRoots');
    if (!r) return;
    S.roots = r;
    const box = U.$('#placesList');
    box.replaceChildren();

    const add = (item, custom) => {
      const row = U.el('div', {
        class: 'place' + (S.cwd === item.path ? ' active' : ''),
        title: item.path,
        onclick: () => { App.switchView('browse'); Explorer.openDir(item.path); },
      }, [
        U.icon(item.kind === 'home' ? 'home' : 'folder'),
        U.el('span', { text: item.name }),
        custom ? U.el('span', { class: 'mini del', title: '从常用中移除', onclick: async (e) => {
          e.stopPropagation();
          const next = S.settings.scan.roots.filter((x) => x !== item.path);
          const v = await U.safeCall('settingsPatch', { scan: { roots: next } });
          if (v) { S.settings = v; App.loadPlaces(); }
        } }, [U.icon('close')]) : null,
      ].filter(Boolean));
      box.appendChild(row);
    };

    if (r.custom.length) {
      box.appendChild(U.el('div', { style: { fontSize: '10.5px', color: 'var(--text-faint)', padding: '2px 6px' }, text: '常用' }));
      r.custom.forEach((x) => add(x, true));
    }
    box.appendChild(U.el('div', { style: { fontSize: '10.5px', color: 'var(--text-faint)', padding: '6px 6px 2px' }, text: '本机' }));
    r.system.forEach((x) => add(x, false));
    Explorer.render();
  };

  /* ---------------- 视图切换 ---------------- */
  App.switchView = function (name) {
    S.view = name;
    U.$$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    U.$$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    if (name === 'settings') SettingsView.render();
    if (name === 'tags') Tags.runFilter();
  };

  /* ---------------- 索引 ---------------- */
  App.startScan = async function () {
    const roots = S.settings.scan.roots || [];
    if (!roots.length) {
      const yes = await U.confirm('还没设置扫描范围',
        '扫描索引用于「全局搜索」和「文件夹移动后自动找回标签」。<br>现在去设置里添加要扫描的文件夹吗？');
      if (yes) App.switchView('settings');
      return;
    }
    const r = await U.safeCall('indexScan');
    if (r) U.toast('开始扫描…', '', 2000);
  };

  App.updateIndexPill = function () {
    const pill = U.$('#indexPill');
    const txt = U.$('#indexPillText');
    const s = S.indexSummary;
    if (!s || !s.total) {
      pill.className = 'pill';
      txt.textContent = '索引未建立';
    } else {
      pill.className = 'pill ready';
      txt.textContent = `已索引 ${s.dirs.toLocaleString()} 个文件夹`;
    }
  };

  /* ---------------- 主进程事件 ---------------- */
  function subscribeEvents() {
    window.api.on('index:progress', (p) => {
      const pill = U.$('#indexPill');
      const txt = U.$('#indexPillText');
      if (p.type === 'progress') {
        pill.className = 'pill active';
        txt.textContent = `扫描中 ${p.total.toLocaleString()} 项`;
        U.$('#statusLeft').textContent = '正在扫描：' + (p.current || '');
      } else if (p.type === 'finished') {
        S.indexSummary = p.summary;
        App.updateIndexPill();
        const st = p.stats || {};
        U.toast(`扫描完成：${(p.summary.total || 0).toLocaleString()} 个条目，其中增量复用 ${st.reusedDirs || 0} 个目录，耗时 ${((st.elapsed || 0) / 1000).toFixed(1)} 秒`, 'ok', 6000);
        U.$('#statusLeft').textContent = '就绪';
        if (S.view === 'settings') SettingsView.render();
      } else if (p.type === 'limit') {
        U.toast(`已达到索引上限 ${p.limit.toLocaleString()} 条，可在设置里调大`, 'warn', 6000);
      } else if (p.type === 'error') {
        U.toast('扫描出错：' + p.message, 'err');
      }
    });

    window.api.on('tag:progress', async (p) => {
      const el = U.$('#statusJob');
      if (p.running) {
        el.textContent = `批量打标签 ${p.done}/${p.total}　成功 ${p.ok}　失败 ${p.failed}　当前：${U.basename(p.current || '')}`;
      } else {
        el.textContent = '';
        if (p.phase === 'finished' || p.phase === 'cancelled') {
          U.toast(`${p.phase === 'cancelled' ? '已取消' : '批量完成'}：成功 ${p.ok}，失败 ${p.failed}` +
            (p.skipped ? `，跳过已有结果 ${p.skipped}` : ''), p.failed ? 'warn' : 'ok', 6000);
          if (p.errors && p.errors.length) console.warn('批量失败明细', p.errors);
          // 刷新可见区域的注记
          for (const path of [...S.ann.keys()]) S.ann.delete(path);
          await S.refreshTags();
          Tags.renderCloud();
          Explorer.render();
          if (Detail.current()) Detail.reload(Detail.current());
          updateStatus();
        }
      }
    });
  }

  /* ---------------- 状态栏 ---------------- */
  async function updateStatus() {
    const st = await U.safeCall('libStats');
    if (!st) return;
    U.$('#statusRight').textContent =
      `已标注 ${st.annotated} 个项目　AI 生成 ${st.withAi}　标签 ${st.tags} 个` +
      (st.missing ? `　失效 ${st.missing}` : '');
  }
  App.updateStatus = updateStatus;

  /* ---------------- UI 绑定 ---------------- */
  function bindUI() {
    U.$$('.nav-item').forEach((b) => b.addEventListener('click', () => App.switchView(b.dataset.view)));

    U.$('#btnSettings').addEventListener('click', () => App.switchView('settings'));
    U.$('#btnScan').addEventListener('click', () => App.startScan());
    U.$('#btnManageTags').addEventListener('click', () => Tags.openManager());
    U.$('#btnAddRoot').addEventListener('click', async () => {
      const picked = await U.safeCall('fsPickFolder', { multi: true });
      if (!picked || !picked.length) return;
      const next = [...new Set([...(S.settings.scan.roots || []), ...picked])];
      const v = await U.safeCall('settingsPatch', { scan: { roots: next } });
      if (v) { S.settings = v; await App.loadPlaces(); U.toast('已添加到常用位置', 'ok'); }
    });

    U.$('#btnTheme').addEventListener('click', async () => {
      const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
      document.body.dataset.theme = next;
      const v = await U.safeCall('settingsPatch', { ui: { theme: next } });
      if (v) S.settings = v;
    });

    // 视图模式
    U.$$('.seg-btn').forEach((b) => b.addEventListener('click', () => {
      U.$$('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      Explorer.setMode(b.dataset.mode);
    }));

    // 筛选 / 排序
    const filterI = U.$('#filterInput');
    filterI.addEventListener('input', U.debounce(() => {
      S.filter = filterI.value.trim();
      Explorer.resetCache();
      Explorer.render();
    }, 260));

    U.$('#typeFilter').addEventListener('change', (e) => {
      S.typeFilter = e.target.value;
      Explorer.resetCache(); Explorer.render();
    });
    U.$('#sortSelect').addEventListener('change', (e) => {
      S.sort = e.target.value;
      Explorer.resetCache(); Explorer.render();
      U.safeCall('settingsPatch', { ui: { defaultSort: S.sort } });
    });
    U.$('#showFiles').addEventListener('change', (e) => {
      S.showFiles = e.target.checked;
      Explorer.resetCache(); Explorer.render();
    });
    U.$('#showHidden').addEventListener('change', (e) => {
      S.showHidden = e.target.checked;
      Explorer.resetCache(); Explorer.render();
    });

    // 全局搜索
    const gs = U.$('#globalSearch');
    gs.addEventListener('input', U.debounce(async () => {
      const q = gs.value.trim();
      if (!q) { Explorer.clearSearch(); return; }
      App.switchView('browse');
      const [byIndex, byAnn] = await Promise.all([
        U.call('indexSearch', q, { onlyDirs: true, limit: 200 }).catch(() => []),
        U.call('libSearchText', q).catch(() => []),
      ]);
      const seen = new Set();
      const merged = [];
      for (const a of byAnn) {
        if (seen.has(a.path)) continue;
        seen.add(a.path);
        merged.push({ path: a.path, name: a.name, isDir: true });
      }
      for (const b of byIndex) {
        if (seen.has(b.path)) continue;
        seen.add(b.path);
        merged.push(b);
      }
      if (!merged.length && !S.indexSummary?.total) {
        U.toast('还没有建立索引，全局搜索只能查到已打标签的文件夹。可在设置里添加扫描范围。', 'warn', 6000);
      }
      Explorer.showSearchResults(merged);
    }, 300));
    gs.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { gs.value = ''; Explorer.clearSearch(); }
    });

    // 标签检索页
    U.$('#tagTextSearch').addEventListener('input', U.debounce((e) => Tags.searchText(e.target.value), 280));
    U.$('#btnShowAllAnnotated').addEventListener('click', () => {
      S.activeTagIds.clear(); Tags.renderCloud(); Tags.runFilter();
    });
    U.$('#btnVerifyLinks').addEventListener('click', () => Tags.verifyLinks());
    U.$$('input[name="tagMode"]').forEach((r) => r.addEventListener('change', () => {
      S.tagMode = r.value; if (r.checked) Tags.runFilter();
    }));

    // 批量操作
    U.$('#btnBulkTag').addEventListener('click', () => bulkTag(false));
    U.$('#btnBulkRetag').addEventListener('click', () => bulkTag(true));
    U.$('#btnBulkClear').addEventListener('click', () => Explorer.clearChecked());
    U.$('#btnBulkAddTag').addEventListener('click', bulkAddTag);

    // 快捷键
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); gs.focus(); gs.select(); }
      if (e.key === 'F5') { e.preventDefault(); Explorer.refreshCurrent(); }
      if (e.key === 'Escape' && S.checked.size) Explorer.clearChecked();
    });
  }

  async function bulkTag(force) {
    const paths = [...S.checked];
    if (!paths.length) return;
    const recursive = U.$('#bulkRecursive').checked;
    const depth = S.settings.ai.recursiveMaxDepth ?? 3;
    const hasKey = S.settings.ai.hasApiKey && S.settings.ai.enabled;
    const scope = recursive ? `递归分析每个选中文件夹下最多 <b>${depth}</b> 层的所有子文件夹和文件` : `对 <b>${paths.length}</b> 个文件夹`;
    const msg = hasKey
      ? `将${scope}调用 AI 生成说明和标签。<br>
         每个项目会发送一次请求（只发名称和类型，不发文件内容），可能产生 API 费用。`
      : `尚未配置 AI，将使用<b>离线规则</b>${scope}推断用途（免费、不联网，但准确度较低）。`;
    if (!(await U.confirm(force ? '重新生成标签' : '批量生成标签', msg))) return;
    const r = await U.safeCall('aiBatch', paths, { force, recursive });
    if (r) {
      U.toast(`任务已开始：${r.total} 个待处理` + (r.skipped ? `，${r.skipped} 个已有结果被跳过` : ''), '', 4000);
      if (r.total === 0) U.toast('都已经有结果了，如需覆盖请点「重新生成」', 'warn');
    }
  }

  async function bulkAddTag() {
    const paths = [...S.checked];
    if (!paths.length) return;
    const name = await U.prompt('批量添加标签', `给选中的 ${paths.length} 个文件夹加上同一个标签`);
    if (!name) return;
    let n = 0;
    for (const p of paths) {
      const v = await U.safeCall('libAddTag', p, name);
      if (v) { S.setAnn(p, v); n++; }
    }
    await S.refreshTags();
    Tags.renderCloud();
    Explorer.render();
    App.updateStatus();
    U.toast(`已给 ${n} 个文件夹添加标签「${name}」`, 'ok');
  }

  window.App = App;
  document.addEventListener('DOMContentLoaded', App.boot);
})();
