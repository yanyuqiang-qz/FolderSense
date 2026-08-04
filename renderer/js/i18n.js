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
    },
    en: {
      'app.name': 'FolderSense',
      'app.sub': 'Understand every folder on your disk',
      'search.placeholder': 'Search folder names, tags, descriptions…',
      'btn.scan': 'Scan',
      'btn.scan.title': 'Incremental scan (only re-reads changed folders)',
      'btn.settings': 'Settings',
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
