'use strict';
/** 扩展名 -> 大类，用于图标、统计与本地启发式推断 */
const MAP = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'heic', 'raw', 'cr2', 'nef', 'tif', 'tiff'],
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'rmvb'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'ape', 'mid'],
  document: ['doc', 'docx', 'pdf', 'txt', 'rtf', 'odt', 'md', 'pages', 'wps', 'epub', 'mobi'],
  sheet: ['xls', 'xlsx', 'csv', 'tsv', 'ods', 'et'],
  slide: ['ppt', 'pptx', 'odp', 'key', 'dps'],
  code: ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'sh', 'bat', 'ps1', 'sql', 'html', 'css', 'scss', 'less', 'vue', 'json', 'yml', 'yaml', 'toml', 'xml', 'ipynb', 'lua', 'dart', 'm', 'r'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg', 'pkg'],
  executable: ['exe', 'msi', 'app', 'deb', 'rpm', 'apk', 'appimage', 'bin'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'eot'],
  design: ['fig', 'sketch', 'xd', 'psd', 'ai', 'cdr', 'indd'],
  model3d: ['obj', 'fbx', 'stl', 'blend', 'gltf', 'glb', 'dae', '3ds', 'step', 'dwg', 'dxf'],
  data: ['db', 'sqlite', 'parquet', 'log', 'dat', 'bak', 'pkl', 'h5', 'npy'],
};

const EXT_TO_CAT = new Map();
for (const [cat, list] of Object.entries(MAP)) {
  for (const e of list) if (!EXT_TO_CAT.has(e)) EXT_TO_CAT.set(e, cat);
}

const CAT_LABEL_ZH = {
  image: '图片', video: '视频', audio: '音频', document: '文档', sheet: '表格',
  slide: '演示', code: '代码', archive: '压缩包', executable: '程序', font: '字体',
  design: '设计稿', model3d: '三维/图纸', data: '数据', other: '其它', folder: '文件夹',
};

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

function categoryOf(name) {
  const e = extOf(name);
  return EXT_TO_CAT.get(e) || 'other';
}

/** 目录里的“标志性文件”，对判断用途极有帮助 */
const MARKER_FILES = {
  'package.json': 'Node.js 前端/JS 项目',
  'pnpm-lock.yaml': 'Node.js 项目',
  'requirements.txt': 'Python 项目',
  'pyproject.toml': 'Python 项目',
  'pom.xml': 'Java Maven 项目',
  'build.gradle': 'Java/Android Gradle 项目',
  'cargo.toml': 'Rust 项目',
  'go.mod': 'Go 项目',
  'dockerfile': '容器化项目',
  'readme.md': '含说明文档的项目',
  '.git': 'Git 版本库',
  'index.html': '网页项目',
  'makefile': 'C/C++ 或通用构建项目',
  '.sln': 'Visual Studio 解决方案',
  'composer.json': 'PHP 项目',
  'gemfile': 'Ruby 项目',
};

function detectMarkers(names) {
  const set = new Set(names.map((n) => n.toLowerCase()));
  const found = [];
  for (const [k, v] of Object.entries(MARKER_FILES)) {
    if (set.has(k)) found.push(v);
  }
  return [...new Set(found)];
}

module.exports = { MAP, EXT_TO_CAT, CAT_LABEL_ZH, extOf, categoryOf, detectMarkers, MARKER_FILES };
