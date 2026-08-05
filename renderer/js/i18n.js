/* 多语言：中文为主，附带英文。切换后立即生效，无需重启 */
(function () {
  'use strict';

  const DICT = {
    'zh-CN': {
      'app.name': '文件夹管家',
      'app.sub': '看懂你电脑里的每一个文件夹',
      'search.placeholder': '搜索文件夹名称、标签、用途说明…',
      'btn.scan': '扫描',
      'btn.scan.title': '增量扫描（只读取变化过的目录）',
      'btn.settings': '设置',
      'nav.home': '首页',
      'nav.browse': '浏览文件夹',
      'nav.tags': '按标签查找',
      'nav.settings': '设置',
      'side.places': '位置',
      'side.addRoot': '添加常用文件夹',
      'side.tags': '标签',
      'side.manageTags': '管理标签',
      'tag.and': '同时满足',
      'tag.or': '任一满足',
      'filter.placeholder': '在当前目录中筛选…',
      'detail.empty': '选中一个文件夹，这里会显示它的用途说明和标签。',
      'ready': '就绪',
      // 新增
      'nav.butler': 'AI 文件管家',
      'butler.placeholder': '问我：我的合同文件放在哪？',
      'butler.send': '发送',
      'dash.welcome': '欢迎使用文件夹管家',
      'dash.progress': '已标注进度',
      'dash.index': '索引状态',
      'dash.tags': '标签总数',
      'dash.topTags': '常用标签',
      'dash.quickOps': '快捷操作',
      'dash.pickFolder': '选择文件夹开始浏览',
      'dash.askButler': '问 AI 文件管家',
      'dash.batchTag': '批量 AI 打标签',
      'dash.openSettings': '打开设置',
      'space.title': '空间占用分析',
      'space.treemap': '树图',
      'space.list': '列表',
      'space.largeFiles': '大文件',
      'preview.unsupported': '该格式暂不支持预览',
      'dedup.title': '重复文件检测',
      'dedup.none': '没有发现重复文件',
      'notif.scanComplete': '扫描完成',
      'notif.largeFiles': '发现大文件',
      'notif.tagComplete': '批量打标签完成',
      'fav.title': '收藏夹',
      'age.title': '文件年龄分布',
    },
    en: {
      'app.name': 'FolderSense',
      'app.sub': 'Understand every folder on your disk',
      'search.placeholder': 'Search folder names, tags, descriptions…',
      'btn.scan': 'Scan',
      'btn.scan.title': 'Incremental scan (only re-reads changed folders)',
      'btn.settings': 'Settings',
      'nav.home': 'Home',
      'nav.browse': 'Browse',
      'nav.tags': 'Find by tag',
      'nav.settings': 'Settings',
      'side.places': 'Places',
      'side.addRoot': 'Add a folder',
      'side.tags': 'Tags',
      'side.manageTags': 'Manage tags',
      'tag.and': 'Match all',
      'tag.or': 'Match any',
      'filter.placeholder': 'Filter in this folder…',
      'detail.empty': 'Select a folder to see its description and tags.',
      'ready': 'Ready',
      // New
      'nav.butler': 'AI Butler',
      'butler.placeholder': 'Ask me: Where are my contracts?',
      'butler.send': 'Send',
      'dash.welcome': 'Welcome to FolderSense',
      'dash.progress': 'Annotation Progress',
      'dash.index': 'Index Status',
      'dash.tags': 'Total Tags',
      'dash.topTags': 'Top Tags',
      'dash.quickOps': 'Quick Actions',
      'dash.pickFolder': 'Pick a folder to browse',
      'dash.askButler': 'Ask AI Butler',
      'dash.batchTag': 'Batch AI Tagging',
      'dash.openSettings': 'Open Settings',
      'space.title': 'Space Analysis',
      'space.treemap': 'Treemap',
      'space.list': 'List',
      'space.largeFiles': 'Large Files',
      'preview.unsupported': 'Preview not available for this format',
      'dedup.title': 'Duplicate File Finder',
      'dedup.none': 'No duplicates found',
      'notif.scanComplete': 'Scan Complete',
      'notif.largeFiles': 'Large Files Found',
      'notif.tagComplete': 'Batch Tagging Complete',
      'fav.title': 'Favorites',
      'age.title': 'File Age Distribution',
    },
  };

  const I18N = {
    lang: 'zh-CN',
    set(lang) {
      this.lang = DICT[lang] ? lang : 'zh-CN';
      document.documentElement.lang = this.lang;
      this.apply();
    },
    t(key, fallback) {
      const d = DICT[this.lang] || DICT['zh-CN'];
      return d[key] !== undefined ? d[key] : (fallback !== undefined ? fallback : key);
    },
    apply(root) {
      const r = root || document;
      r.querySelectorAll('[data-i18n]').forEach((n) => {
        n.textContent = I18N.t(n.dataset.i18n, n.textContent);
      });
      r.querySelectorAll('[data-i18n-ph]').forEach((n) => {
        n.placeholder = I18N.t(n.dataset.i18nPh, n.placeholder);
      });
      r.querySelectorAll('[data-i18n-title]').forEach((n) => {
        n.title = I18N.t(n.dataset.i18nTitle, n.title);
      });
    },
  };

  window.I18N = I18N;
})();
