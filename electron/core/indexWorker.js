'use strict';
/**
 * 后台索引 Worker（worker_threads）
 * 单独线程做全量/增量扫描，主进程与界面完全不卡顿。
 *
 * 增量策略：
 *   目录的 mtime 只在“直接子项发生增删改名”时变化。
 *   因此若某目录 mtime 与上次索引一致，可直接复用上次记录的子项列表，
 *   省掉 readdir + N 次 lstat；只需对子目录继续递归（仍是 1 次 stat/目录）。
 */
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { roots, scan, existing } = workerData;

const excludeNames = new Set((scan.excludeNames || []).map((s) => s.toLowerCase()));
const excludeKeywords = (scan.excludeKeywords || []).filter(Boolean).map((s) => s.toLowerCase());
const maxDepth = scan.maxDepth ?? 6;
const maxEntries = scan.maxIndexEntries ?? 200000;
const includeHidden = !!scan.includeHidden;

function isExcluded(name) {
  const low = name.toLowerCase();
  if (excludeNames.has(low)) return true;
  for (const k of excludeKeywords) if (low.includes(k)) return true;
  if (!includeHidden && name.startsWith('.')) return true;
  return false;
}

// 上次索引：Map<path, entry>，以及 parent -> children[]
const prev = new Map();
const prevChildren = new Map();
for (const e of existing || []) {
  prev.set(e.p, e);
  const pa = path.dirname(e.p);
  if (!prevChildren.has(pa)) prevChildren.set(pa, []);
  prevChildren.get(pa).push(e);
}

const out = new Map();
let scanned = 0;
let reusedDirs = 0;
let readDirs = 0;
let errors = 0;
let lastReport = 0;
let cancelled = false;

parentPort.on('message', (msg) => {
  if (msg === 'cancel') cancelled = true;
});

function report(current, done = false) {
  const now = Date.now();
  if (!done && now - lastReport < 120) return;
  lastReport = now;
  parentPort.postMessage({
    type: done ? 'done' : 'progress',
    scanned,
    reusedDirs,
    readDirs,
    errors,
    total: out.size,
    current,
  });
}

async function walk() {
  /** @type {{dir:string, depth:number}[]} */
  const queue = [];
  for (const r of roots) queue.push({ dir: r, depth: 0 });

  while (queue.length) {
    if (cancelled) break;
    if (out.size >= maxEntries) {
      parentPort.postMessage({ type: 'limit', total: out.size, limit: maxEntries });
      break;
    }
    const { dir, depth } = queue.shift();

    let st;
    try {
      st = await fsp.stat(dir);
    } catch {
      errors++;
      continue;
    }
    if (!st.isDirectory()) continue;

    // 自身入索引
    if (!out.has(dir)) {
      out.set(dir, { p: dir, d: 1, s: 0, m: st.mtimeMs, dp: depth, sc: 0, c: 0 });
    }

    const old = prev.get(dir);
    let children = null;

    if (old && old.sc && old.m === st.mtimeMs && (prevChildren.get(dir) || []).length === old.c) {
      // 命中增量缓存，直接复用子项记录
      children = prevChildren.get(dir) || [];
      reusedDirs++;
      for (const ch of children) {
        if (!out.has(ch.p)) out.set(ch.p, { ...ch, dp: depth + 1 });
      }
    } else {
      readDirs++;
      let dirents;
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        errors++;
        const self = out.get(dir);
        if (self) { self.sc = 0; }
        continue;
      }
      children = [];
      const limit = scan.maxEntriesPerDir || 8000;
      for (const d of dirents.slice(0, limit)) {
        const name = d.name;
        const full = path.join(dir, name);
        const isDir = d.isDirectory();
        if (isDir && isExcluded(name)) continue;
        if (!isDir && !includeHidden && name.startsWith('.')) continue;
        let size = 0, m = 0;
        try {
          const s2 = fs.statSync(full, { throwIfNoEntry: false });
          if (s2) { size = Number(s2.size) || 0; m = s2.mtimeMs; }
        } catch { /* 忽略单个条目失败 */ }
        const rec = { p: full, d: isDir ? 1 : 0, s: size, m, dp: depth + 1, sc: 0, c: 0 };
        children.push(rec);
        out.set(full, rec);
      }
    }

    const self = out.get(dir);
    if (self) { self.sc = 1; self.c = children.length; }
    scanned++;

    if (depth < maxDepth) {
      for (const ch of children) {
        if (ch.d) {
          const base = path.basename(ch.p);
          if (isExcluded(base)) continue;
          queue.push({ dir: ch.p, depth: depth + 1 });
        }
      }
    }
    report(dir);
  }

  report('', true);
  parentPort.postMessage({
    type: 'result',
    entries: [...out.values()],
    stats: { scanned, reusedDirs, readDirs, errors, total: out.size, cancelled },
  });
}

walk().catch((e) => {
  parentPort.postMessage({ type: 'error', message: String(e && e.message || e) });
});
