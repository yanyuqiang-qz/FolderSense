'use strict';
const path = require('node:path');
const os = require('node:os');

let _root = null;

/** 所有数据都写在系统标准用户数据目录，不污染被扫描的磁盘 */
function initDataRoot(app) {
  _root = path.join(app.getPath('userData'), 'data');
  return _root;
}

function dataRoot() {
  if (!_root) _root = path.join(os.homedir(), '.foldersense', 'data');
  return _root;
}

const files = {
  settings: () => path.join(dataRoot(), 'settings.json'),
  tags: () => path.join(dataRoot(), 'tags.json'),
  annotations: () => path.join(dataRoot(), 'annotations.json'),
  index: () => path.join(dataRoot(), 'index.json'),
  auditLog: () => path.join(dataRoot(), 'ai-audit.log'),
};

module.exports = { initDataRoot, dataRoot, files };
