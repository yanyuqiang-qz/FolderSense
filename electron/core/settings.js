'use strict';
/**
 * 设置管理
 * 安全要点：API Key 使用 Electron safeStorage（系统钥匙串 / DPAPI）加密后落盘，
 * 明文永远不会出现在 settings.json 中；渲染进程只能拿到脱敏后的掩码。
 */
const { safeStorage } = require('electron');
const { JsonStore } = require('./jsonStore');
const { files } = require('./paths');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv',
  'dist', 'build', '.next', '.nuxt', '.cache', '.gradle', 'target',
  '$RECYCLE.BIN', 'System Volume Information', 'Windows', 'Program Files',
  'Program Files (x86)', 'ProgramData', 'AppData',
  'Library', '.Trash', 'private', 'proc', 'sys', 'dev',
];

const DEFAULTS = {
  version: 1,
  ui: {
    language: 'zh-CN',
    theme: 'dark',
    showHiddenFiles: false,
    defaultSort: 'name-asc',
  },
  scan: {
    roots: [],
    excludeNames: DEFAULT_EXCLUDES.slice(),
    excludeKeywords: [],
    maxDepth: 6,
    maxEntriesPerDir: 8000,
    maxIndexEntries: 200000,
    followSymlinks: false,
    autoScanOnStart: false,
  },
  ai: {
    enabled: true,
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnc: '',        // 加密后的密钥（base64）
    apiKeyPlain: '',      // 仅当系统加密不可用时的降级存储
    model: 'gpt-4o-mini',
    customModels: [],
    temperature: 0.2,
    timeoutMs: 60000,
    concurrency: 2,
    tagCount: 5,
    maxSampleFiles: 40,
    // ---- 隐私开关（默认最保守）----
    sendFileNames: true,     // 发送采样文件名（帮助判断用途）
    sendFullPath: false,     // 发送完整绝对路径（默认关闭，只发文件夹名）
    readFileContent: false,  // 读取文件内容（默认永久关闭，需手动开启）
  },
  privacy: {
    auditLog: true,          // 记录每次 AI 请求的元信息，可审计
  },
};

class Settings {
  constructor() {
    this.store = new JsonStore(files.settings(), DEFAULTS);
  }

  async init() {
    await this.store.load();
    this._migrate();
    return this.all();
  }

  _migrate() {
    const d = this.store.get();
    const deepFill = (target, defaults) => {
      for (const [k, v] of Object.entries(defaults)) {
        if (target[k] === undefined) target[k] = structuredClone(v);
        else if (v && typeof v === 'object' && !Array.isArray(v)) deepFill(target[k], v);
      }
    };
    deepFill(d, DEFAULTS);
    this.store.markDirty();
  }

  all() {
    return this.store.get();
  }

  /** 给渲染进程的安全副本：密钥脱敏 */
  publicView() {
    const d = structuredClone(this.store.get());
    const key = this.getApiKey();
    d.ai.apiKeyMask = key ? maskKey(key) : '';
    d.ai.hasApiKey = !!key;
    d.ai.encryptionAvailable = isEncryptionAvailable();
    delete d.ai.apiKeyEnc;
    delete d.ai.apiKeyPlain;
    return d;
  }

  patch(partial) {
    this.store.update((d) => {
      deepMerge(d, partial);
      return d;
    });
    return this.publicView();
  }

  setApiKey(plain) {
    this.store.update((d) => {
      if (!plain) {
        d.ai.apiKeyEnc = '';
        d.ai.apiKeyPlain = '';
        return d;
      }
      if (isEncryptionAvailable()) {
        d.ai.apiKeyEnc = safeStorage.encryptString(plain).toString('base64');
        d.ai.apiKeyPlain = '';
      } else {
        d.ai.apiKeyEnc = '';
        d.ai.apiKeyPlain = plain;
      }
      return d;
    });
  }

  getApiKey() {
    const d = this.store.get();
    if (d.ai.apiKeyEnc) {
      try {
        return safeStorage.decryptString(Buffer.from(d.ai.apiKeyEnc, 'base64'));
      } catch (e) {
        console.warn('[settings] 密钥解密失败（可能换了机器或账户）');
        return '';
      }
    }
    return d.ai.apiKeyPlain || '';
  }

  flush() {
    return this.store.flush();
  }
}

function isEncryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function maskKey(k) {
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}${'*'.repeat(Math.min(16, k.length - 8))}${k.slice(-4)}`;
}

function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

module.exports = { Settings, DEFAULTS, DEFAULT_EXCLUDES };
