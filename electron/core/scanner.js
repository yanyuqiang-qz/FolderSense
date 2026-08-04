'use strict';
/**
 * 文件系统扫描内核
 * 设计要点：
 *  1) 懒加载：只有展开某个目录时才 readdir，从不预先递归整盘
 *  2) 目录缓存：以 目录 mtime 作为版本号，mtime 未变直接命中内存 LRU，避免重复 IO
 *  3) 分页：单目录条目过多时分批返回，避免一次性把 10 万条塞给渲染进程
 *  4) 全部使用 lstat + withFileTypes，不跟随符号链接（除非用户开启）
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { extOf, categoryOf, detectMarkers } = require('./fileTypes');

// ---------------- LRU 目录缓存 ----------------
class LRU {
  constructor(limit = 400) {
    this.limit = limit;
    this.map = new Map();
  }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
  }
  delete(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

const dirCache = new LRU(500);
let cacheHits = 0;
let cacheMisses = 0;

function cacheStats() {
  return { size: dirCache.size, hits: cacheHits, misses: cacheMisses };
}
function clearCache(p) {
  if (p) dirCache.delete(normalize(p));
  else dirCache.clear();
}

// ---------------- 工具 ----------------
function normalize(p) {
  if (!p) return p;
  let n = path.resolve(p);
  // Windows 盘符统一大写，避免 c:\ 与 C:\ 被当成两个 key
  if (process.platform === 'win32' && /^[a-z]:/.test(n)) n = n[0].toUpperCase() + n.slice(1);
  return n;
}

function isHidden(name, fullPath) {
  if (name.startsWith('.')) return true;
  return false;
}

function makeExcluder(scanSettings) {
  const names = new Set((scanSettings.excludeNames || []).map((s) => s.toLowerCase()));
  const keywords = (scanSettings.excludeKeywords || []).filter(Boolean).map((s) => s.toLowerCase());
  return function excluded(name) {
    const low = name.toLowerCase();
    if (names.has(low)) return true;
    for (const k of keywords) if (low.includes(k)) return true;
    return false;
  };
}

// ---------------- 根节点 ----------------
async function getRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
    await Promise.all(letters.map(async (L) => {
      const p = `${L}:\\`;
      try {
        await fsp.access(p);
        roots.push({ path: p, name: `${L}: 本地磁盘`, kind: 'drive' });
      } catch { /* 盘不存在 */ }
    }));
    roots.sort((a, b) => a.path.localeCompare(b.path));
  } else {
    roots.push({ path: '/', name: '根目录 /', kind: 'drive' });
    if (process.platform === 'darwin') {
      try {
        const vols = await fsp.readdir('/Volumes');
        for (const v of vols) roots.push({ path: `/Volumes/${v}`, name: v, kind: 'drive' });
      } catch { /* ignore */ }
    }
  }
  const home = os.homedir();
  const quick = [
    { p: home, n: '主目录', k: 'home' },
    { p: path.join(home, 'Desktop'), n: '桌面', k: 'desktop' },
    { p: path.join(home, 'Documents'), n: '文档', k: 'documents' },
    { p: path.join(home, 'Downloads'), n: '下载', k: 'downloads' },
    { p: path.join(home, 'Pictures'), n: '图片', k: 'pictures' },
  ];
  for (const q of quick) {
    try {
      const st = await fsp.stat(q.p);
      if (st.isDirectory()) roots.push({ path: normalize(q.p), name: q.n, kind: q.k });
    } catch { /* 不存在 */ }
  }
  return roots;
}

// ---------------- 目录读取 ----------------
/**
 * 读取单层目录（懒加载核心）
 * @returns {{path, entries, total, truncated, fromCache, mtimeMs}}
 */
async function readDirRaw(dirPath, settings) {
  const p = normalize(dirPath);
  const scan = settings.scan || {};
  let dirStat;
  try {
    dirStat = await fsp.stat(p);
  } catch (e) {
    throw wrapFsError(e, p);
  }
  if (!dirStat.isDirectory()) throw new Error('不是文件夹: ' + p);

  const cached = dirCache.get(p);
  if (cached && cached.mtimeMs === dirStat.mtimeMs && cached.cfg === cfgKey(scan)) {
    cacheHits++;
    return { ...cached, fromCache: true };
  }
  cacheMisses++;

  const excluded = makeExcluder(scan);
  let dirents;
  try {
    dirents = await fsp.readdir(p, { withFileTypes: true });
  } catch (e) {
    throw wrapFsError(e, p);
  }

  const limit = scan.maxEntriesPerDir || 8000;
  const truncated = dirents.length > limit;
  const slice = truncated ? dirents.slice(0, limit) : dirents;

  const entries = [];
  // 并发 stat，控制批量大小避免句柄耗尽
  const BATCH = 128;
  for (let i = 0; i < slice.length; i += BATCH) {
    const chunk = slice.slice(i, i + BATCH);
    const results = await Promise.all(chunk.map(async (d) => {
      const name = d.name;
      const full = path.join(p, name);
      let isDir = d.isDirectory();
      let isLink = d.isSymbolicLink();
      let size = 0, mtimeMs = 0, ino = 0, dev = 0, birthtimeMs = 0;
      try {
        const st = await fsp.lstat(full);
        size = Number(st.size) || 0;
        mtimeMs = st.mtimeMs;
        birthtimeMs = st.birthtimeMs;
        ino = Number(st.ino) || 0;
        dev = Number(st.dev) || 0;
        if (isLink && scan.followSymlinks) {
          try {
            const rst = await fsp.stat(full);
            isDir = rst.isDirectory();
          } catch { /* 断链 */ }
        }
      } catch {
        // 权限不足等，仍然展示条目，只是缺少元信息
      }
      return {
        name,
        path: full,
        isDir,
        isLink,
        size,
        mtimeMs,
        birthtimeMs,
        ino, dev,
        ext: isDir ? '' : extOf(name),
        cat: isDir ? 'folder' : categoryOf(name),
        hidden: isHidden(name, full),
        excluded: isDir && excluded(name),
      };
    }));
    entries.push(...results);
  }

  const payload = {
    path: p,
    entries,
    total: dirents.length,
    truncated,
    mtimeMs: dirStat.mtimeMs,
    cfg: cfgKey(scan),
    readAt: Date.now(),
  };
  dirCache.set(p, payload);
  return { ...payload, fromCache: false };
}

function cfgKey(scan) {
  return `${(scan.excludeNames || []).length}|${(scan.excludeKeywords || []).join(',')}|${scan.followSymlinks ? 1 : 0}|${scan.maxEntriesPerDir}`;
}

function wrapFsError(e, p) {
  const map = {
    EACCES: '没有访问权限',
    EPERM: '操作被系统拒绝',
    ENOENT: '路径不存在（可能已被移动或删除）',
    ENOTDIR: '不是文件夹',
    EBUSY: '文件夹被占用',
    EMFILE: '打开的文件过多，请稍后重试',
  };
  const err = new Error(`${map[e.code] || e.message}：${p}`);
  err.code = e.code;
  err.path = p;
  return err;
}

/**
 * 对外的列目录接口：读取 + 过滤 + 排序 + 分页
 */
async function listDir(dirPath, settings, opts = {}) {
  const {
    sort = 'name-asc',
    query = '',
    onlyDirs = false,
    typeFilter = '',   // 'image' | 'video' | ...
    offset = 0,
    limit = 500,
    showHidden = null,
    includeExcluded = false,
  } = opts;

  const raw = await readDirRaw(dirPath, settings);
  const wantHidden = showHidden === null ? !!settings.ui?.showHiddenFiles : !!showHidden;

  let list = raw.entries;
  if (!wantHidden) list = list.filter((e) => !e.hidden);
  if (!includeExcluded) list = list.filter((e) => !e.excluded);
  if (onlyDirs) list = list.filter((e) => e.isDir);
  if (typeFilter) list = list.filter((e) => e.cat === typeFilter);
  if (query) {
    const q = query.toLowerCase();
    list = list.filter((e) => e.name.toLowerCase().includes(q));
  }

  list = sortEntries(list, sort);
  const total = list.length;
  const page = list.slice(offset, offset + limit);

  return {
    path: raw.path,
    entries: page,
    total,
    rawTotal: raw.total,
    truncated: raw.truncated,
    fromCache: raw.fromCache,
    hasMore: offset + limit < total,
  };
}

function sortEntries(list, sort) {
  const [field, dir] = String(sort).split('-');
  const s = dir === 'desc' ? -1 : 1;
  const coll = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const arr = list.slice();
  arr.sort((a, b) => {
    // 文件夹始终在前
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    switch (field) {
      case 'size': return (a.size - b.size) * s;
      case 'mtime': return (a.mtimeMs - b.mtimeMs) * s;
      case 'type': {
        const c = coll.compare(a.ext || '', b.ext || '');
        return c !== 0 ? c * s : coll.compare(a.name, b.name);
      }
      case 'name':
      default: return coll.compare(a.name, b.name) * s;
    }
  });
  return arr;
}

// ---------------- 文件夹画像（供 AI / 详情面板使用） ----------------
/**
 * 只读取元数据：名称、类型分布、结构，不读取任何文件内容
 */
async function buildProfile(dirPath, settings, opts = {}) {
  const p = normalize(dirPath);
  const maxSamples = opts.maxSamples ?? settings.ai?.maxSampleFiles ?? 40;
  const raw = await readDirRaw(p, settings);
  const dirs = raw.entries.filter((e) => e.isDir);
  const fileEntries = raw.entries.filter((e) => !e.isDir);

  const extMap = new Map();
  let totalSize = 0;
  for (const f of fileEntries) {
    totalSize += f.size;
    const k = f.ext || '(无扩展名)';
    const cur = extMap.get(k) || { ext: k, cat: f.cat, count: 0, size: 0 };
    cur.count++; cur.size += f.size;
    extMap.set(k, cur);
  }
  const extHistogram = [...extMap.values()].sort((a, b) => b.count - a.count).slice(0, 15);

  const catMap = new Map();
  for (const f of fileEntries) catMap.set(f.cat, (catMap.get(f.cat) || 0) + 1);
  const categories = [...catMap.entries()].map(([cat, count]) => ({ cat, count }))
    .sort((a, b) => b.count - a.count);

  // 抽样二级目录名（只取名字，不递归深入）
  const subDirNames = dirs.slice(0, 25).map((d) => d.name);
  let grandChildSample = [];
  for (const d of dirs.slice(0, 5)) {
    try {
      const sub = await fsp.readdir(d.path, { withFileTypes: true });
      grandChildSample.push({ dir: d.name, children: sub.slice(0, 8).map((x) => x.name) });
    } catch { /* 权限不足跳过 */ }
  }

  const markers = detectMarkers(raw.entries.map((e) => e.name));

  const newest = fileEntries.reduce((m, f) => Math.max(m, f.mtimeMs), 0);
  const oldest = fileEntries.reduce((m, f) => (m === 0 ? f.mtimeMs : Math.min(m, f.mtimeMs)), 0);

  return {
    name: path.basename(p) || p,
    parentName: path.basename(path.dirname(p)) || '',
    fullPath: p,
    fileCount: fileEntries.length,
    dirCount: dirs.length,
    totalEntries: raw.total,
    totalSizeOfDirectFiles: totalSize,
    extHistogram,
    categories,
    subDirNames,
    grandChildSample,
    markers,
    sampleFileNames: fileEntries.slice(0, maxSamples).map((f) => f.name),
    newestMtime: newest,
    oldestMtime: oldest,
  };
}

// ---------------- 文件夹指纹（用于移动/重命名后重新关联） ----------------
/**
 * 指纹由“内容结构”决定，与路径无关：
 *   子项名称集合（排序后取前 64）+ 是否目录 + 直接子项数量
 * 再配合 inode（dev:ino）做强匹配。
 */
async function computeFingerprint(dirPath, settings) {
  const p = normalize(dirPath);
  let st;
  try {
    st = await fsp.stat(p);
  } catch (e) {
    throw wrapFsError(e, p);
  }
  const raw = await readDirRaw(p, settings);
  const names = raw.entries
    .map((e) => `${e.isDir ? 'd' : 'f'}:${e.name}`)
    .sort()
    .slice(0, 64);
  const h = crypto.createHash('sha1');
  h.update(names.join('\n'));
  h.update('|count=' + raw.total);
  const structure = h.digest('hex');
  const inode = Number(st.ino) ? `${Number(st.dev)}:${Number(st.ino)}` : '';
  return {
    structure,
    inode,
    childCount: raw.total,
    birthtimeMs: Math.round(st.birthtimeMs || 0),
    sampleNames: names.slice(0, 12),
  };
}

/** 计算两个指纹的相似度 0~1 */
function fingerprintScore(a, b) {
  if (!a || !b) return 0;
  if (a.inode && b.inode && a.inode === b.inode) return 1;
  if (a.structure && a.structure === b.structure) return 0.95;
  let score = 0;
  const sa = new Set(a.sampleNames || []);
  const sb = new Set(b.sampleNames || []);
  if (sa.size && sb.size) {
    let inter = 0;
    for (const x of sa) if (sb.has(x)) inter++;
    score += 0.8 * (inter / Math.max(sa.size, sb.size));
  }
  if (a.birthtimeMs && b.birthtimeMs && Math.abs(a.birthtimeMs - b.birthtimeMs) < 2000) score += 0.15;
  return Math.min(score, 0.94);
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function statSafe(p) {
  try { return await fsp.stat(p); } catch { return null; }
}

module.exports = {
  normalize, getRoots, listDir, readDirRaw, sortEntries, buildProfile,
  computeFingerprint, fingerprintScore, clearCache, cacheStats, exists, statSafe,
  makeExcluder, wrapFsError,
};
