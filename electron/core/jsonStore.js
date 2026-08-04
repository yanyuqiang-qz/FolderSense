'use strict';
/**
 * 轻量 JSON 持久化层
 * - 原子写入（先写临时文件再 rename），避免断电/崩溃导致数据文件损坏
 * - 写入防抖 + 退出时强制 flush
 * - 自动备份上一版本（.bak），损坏时可回滚
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

class JsonStore {
  /**
   * @param {string} file 绝对路径
   * @param {object} defaults 默认数据
   * @param {object} [opts]
   */
  constructor(file, defaults, opts = {}) {
    this.file = file;
    this.defaults = defaults;
    this.debounceMs = opts.debounceMs ?? 400;
    this.pretty = opts.pretty ?? true;
    this.data = null;
    this._timer = null;
    this._writing = null;
    this._dirty = false;
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      this.data = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 主文件损坏，尝试从备份恢复
        try {
          const raw = await fsp.readFile(this.file + '.bak', 'utf8');
          this.data = JSON.parse(raw);
          console.warn('[store] 主文件损坏，已从备份恢复:', this.file);
        } catch {
          console.warn('[store] 读取失败，使用默认值:', this.file, err.message);
          this.data = null;
        }
      }
    }
    if (!this.data || typeof this.data !== 'object') {
      this.data = structuredClone(this.defaults);
      this._dirty = true;
      await this.flush();
    }
    return this.data;
  }

  get() {
    if (!this.data) throw new Error('JsonStore 尚未 load(): ' + this.file);
    return this.data;
  }

  /** 修改数据并安排落盘 */
  update(mutator) {
    const result = mutator(this.get());
    this.markDirty();
    return result;
  }

  markDirty() {
    this._dirty = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this.flush().catch((e) => console.error('[store] 写入失败', this.file, e));
    }, this.debounceMs);
  }

  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty) return;
    if (this._writing) {
      await this._writing;
      if (!this._dirty) return;
    }
    this._dirty = false;
    this._writing = this._write();
    try {
      await this._writing;
    } finally {
      this._writing = null;
    }
  }

  async _write() {
    const dir = path.dirname(this.file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const json = this.pretty
      ? JSON.stringify(this.data, null, 2)
      : JSON.stringify(this.data);
    await fsp.writeFile(tmp, json, 'utf8');
    // 保留一份上一版本作为备份
    try {
      if (fs.existsSync(this.file)) await fsp.copyFile(this.file, this.file + '.bak');
    } catch { /* 备份失败不阻塞主流程 */ }
    await fsp.rename(tmp, this.file);
  }
}

module.exports = { JsonStore };
