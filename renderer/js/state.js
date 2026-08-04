/* 全局状态与数据缓存 */
(function () {
  'use strict';

  const listeners = {};

  const S = {
    // 配置
    settings: null,
    appInfo: null,

    // 标签库
    tags: [],
    tagMap: new Map(),
    categories: [],

    // 文件夹注记缓存 path -> view
    ann: new Map(),

    // 浏览状态
    roots: { system: [], custom: [] },
    mode: 'tree',              // tree | list
    cwd: null,                 // 列表模式的当前目录
    expanded: new Set(),
    children: new Map(),       // path -> entries[]
    loading: new Set(),
    selected: null,
    checked: new Set(),

    // 过滤
    sort: 'name-asc',
    filter: '',
    typeFilter: '',
    showFiles: true,
    showHidden: false,

    // 标签检索
    activeTagIds: new Set(),
    tagMode: 'and',

    // 搜索
    searchResults: null,       // 非 null 时树区域展示搜索结果

    view: 'browse',
    indexSummary: null,
    job: null,

    on(evt, fn) {
      (listeners[evt] = listeners[evt] || []).push(fn);
      return () => {
        listeners[evt] = listeners[evt].filter((f) => f !== fn);
      };
    },
    emit(evt, payload) {
      (listeners[evt] || []).forEach((f) => {
        try { f(payload); } catch (e) { console.error('[emit]', evt, e); }
      });
    },

    async refreshTags() {
      const t = await U.safeCall('libTags');
      if (t) {
        S.tags = t;
        S.tagMap = new Map(t.map((x) => [x.id, x]));
      }
      const c = await U.safeCall('libCategories');
      if (c) S.categories = c;
      S.emit('tags');
    },

    /** 批量拉取注记（供树/列表渲染显示摘要与标签） */
    async loadAnn(paths) {
      const need = paths.filter((p) => p && !S.ann.has(p));
      if (!need.length) return;
      const res = await U.safeCall('libViews', need);
      // 记录空值，避免同一路径反复请求
      for (const p of need) S.ann.set(p, (res && res[p]) || null);
      S.emit('ann');
    },

    setAnn(path, view) {
      S.ann.set(path, view);
      S.emit('ann', path);
    },

    invalidateAnn(path) {
      S.ann.delete(path);
    },

    tag(id) { return S.tagMap.get(id); },
  };

  window.S = S;
})();
