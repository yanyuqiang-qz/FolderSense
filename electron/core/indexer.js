'use strict';
/**
 * 索引管理器（主进程侧）
 * - 持久化扫描索引，重启后秒开、无需重扫
 * - 驱动 Worker 做增量扫描并向界面推送进度
 * - 提供全局搜索（路径/名称）与候选查找（标签重连用）
 */
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { JsonStore } = require('./jsonStore');
const { files } = require('./paths');

const INDEX_VERSION = 1;

class Indexer {
  constructor() {
    this.store = new JsonStore(files.index(), {
      version: INDEX_VERSION,
      updatedAt: 0,
      roots: [],
      stats: {},
      entries: [],
    }, { pretty: false, debounceMs: 1500 });
    /** @type {Map<string, {p:string,d:number,s:number,m:number,dp:number,sc:number,c:number}>} */
    this.map = new Map();
    this.worker = null;
    this.scanning = false;
    this.onProgress = null;
    this._lastStats = null;
  }

  async init() {
    const d = await this.store.load();
    if (d.version !== INDEX_VERSION) {
      d.version = INDEX_VERSION;
      d.entries = [];
      this.store.markDirty();
    }
    this.map.clear();
    for (const row of d.entries || []) {
      const e = Array.isArray(row)
        ? { p: row[0], d: row[1], s: row[2], m: row[3], dp: row[4], sc: row[5], c: row[6] }
        : row;
      this.map.set(e.p, e);
    }
    this._lastStats = d.stats || null;
    return this.summary();
  }

  summary() {
    const d = this.store.get();
    let dirs = 0;
    for (const e of this.map.values()) if (e.d) dirs++;
    return {
      total: this.map.size,
      dirs,
      files: this.map.size - dirs,
      updatedAt: d.updatedAt || 0,
      roots: d.roots || [],
      stats: this._lastStats,
      scanning: this.scanning,
    };
  }

  /** 启动增量扫描 */
  startScan(roots, scanSettings) {
    if (this.scanning) return { ok: false, reason: 'already-scanning' };
    if (!roots || !roots.length) return { ok: false, reason: 'no-roots' };

    this.scanning = true;
    const existing = [...this.map.values()];
    const t0 = Date.now();

    this.worker = new Worker(path.join(__dirname, 'indexWorker.js'), {
      workerData: { roots, scan: scanSettings, existing },
    });

    this.worker.on('message', (msg) => {
      if (msg.type === 'progress' || msg.type === 'done') {
        this.onProgress?.({ ...msg, elapsed: Date.now() - t0 });
      } else if (msg.type === 'limit') {
        this.onProgress?.({ type: 'limit', ...msg });
      } else if (msg.type === 'error') {
        this.onProgress?.({ type: 'error', message: msg.message });
      } else if (msg.type === 'result') {
        this.map.clear();
        for (const e of msg.entries) this.map.set(e.p, e);
        this._lastStats = { ...msg.stats, elapsed: Date.now() - t0 };
        this.store.update((d) => {
          d.updatedAt = Date.now();
          d.roots = roots;
          d.stats = this._lastStats;
          d.entries = msg.entries.map((e) => [e.p, e.d, e.s, e.m, e.dp, e.sc, e.c]);
          return d;
        });
        this.scanning = false;
        this.onProgress?.({ type: 'finished', summary: this.summary(), stats: this._lastStats });
      }
    });

    this.worker.on('error', (err) => {
      this.scanning = false;
      this.onProgress?.({ type: 'error', message: String(err.message || err) });
    });
    this.worker.on('exit', () => {
      this.worker = null;
      if (this.scanning) {
        this.scanning = false;
        this.onProgress?.({ type: 'finished', summary: this.summary(), stats: this._lastStats });
      }
    });

    return { ok: true };
  }

  cancelScan() {
    if (this.worker) {
      this.worker.postMessage('cancel');
      return true;
    }
    return false;
  }

  /**
   * 全局搜索
   */
  search(query, opts = {}) {
    const { onlyDirs = true, limit = 300 } = opts;
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const results = [];
    for (const e of this.map.values()) {
      if (onlyDirs && !e.d) continue;
      const base = path.basename(e.p);
      const low = base.toLowerCase();
      const idx = low.indexOf(q);
      if (idx === -1) continue;
      let score = 0;
      if (low === q) score = 100;
      else if (idx === 0) score = 80;
      else score = 60 - Math.min(idx, 30);
      score -= Math.min(e.dp || 0, 10); // 层级越浅越优先
      results.push({ path: e.p, name: base, isDir: !!e.d, size: e.s, mtimeMs: e.m, depth: e.dp, score });
      if (results.length > 5000) break;
    }
    results.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
    return results.slice(0, limit);
  }

  /** 按 basename 精确找候选（标签重连） */
  findByBasename(name, opts = {}) {
    const target = String(name).toLowerCase();
    const res = [];
    for (const e of this.map.values()) {
      if (!e.d) continue;
      if (path.basename(e.p).toLowerCase() === target) res.push(e.p);
      if (res.length >= (opts.limit || 50)) break;
    }
    return res;
  }

  allDirs(limit = Infinity) {
    const res = [];
    for (const e of this.map.values()) {
      if (e.d) res.push(e.p);
      if (res.length >= limit) break;
    }
    return res;
  }

  has(p) { return this.map.has(p); }
  get(p) { return this.map.get(p); }

  clear() {
    this.map.clear();
    this.store.update((d) => {
      d.entries = [];
      d.updatedAt = 0;
      d.stats = {};
      return d;
    });
  }

  flush() { return this.store.flush(); }
}

module.exports = { Indexer };
