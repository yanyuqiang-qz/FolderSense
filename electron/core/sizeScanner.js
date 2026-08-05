/**
 * 磁盘空间分析：递归计算子文件夹/文件大小，支持 treemap 数据和大文件 Top N。
 * 使用流式遍历，不一次性加载大文件到内存。
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_TOP_N = 15;
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100MB

/**
 * 递归扫描目录大小（异步，支持取消）
 * @param {string} dirPath
 * @param {{signal?:AbortSignal, onProgress?:function, maxDepth?:number}} opts
 * @returns {Promise<{dirs:Array<{path,name,size,depth,fileCount}>, files:Array<{path,name,size}>, totalSize:number}>}
 */
async function scanSize(dirPath, opts = {}) {
  const { signal, onProgress, maxDepth = 10 } = opts;
  const result = {
    dirs: [],
    files: [],
    totalSize: 0,
  };
  let entryCount = 0;

  async function walk(dir, depth) {
    if (signal?.aborted) throw new Error('cancelled');
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch { return; }

    let dirSize = 0;
    let fileCount = 0;
    const subDirs = [];

    for (const ent of entries) {
      if (signal?.aborted) throw new Error('cancelled');
      // 跳过隐藏文件/系统文件
      if (ent.name.startsWith('.') || ent.name === '$RECYCLE.BIN' || ent.name === 'System Volume Information') continue;

      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        subDirs.push({ name: ent.name, path: fullPath });
      } else if (ent.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          const sz = stat.size || 0;
          dirSize += sz;
          fileCount++;
          result.totalSize += sz;
          entryCount++;
          if (sz >= LARGE_FILE_THRESHOLD) {
            result.files.push({ path: fullPath, name: ent.name, size: sz });
          }
          if (onProgress && entryCount % 200 === 0) onProgress({ entryCount, currentDir: dir, totalSize: result.totalSize });
        } catch { /* 权限不足等跳过 */ }
      }
    }

    // 递归子目录
    for (const sd of subDirs) {
      const subResult = await walk(sd.path, depth + 1);
      dirSize += subResult.size;
      fileCount += subResult.fileCount;
    }

    result.dirs.push({
      path: dir,
      name: path.basename(dir),
      size: dirSize,
      depth,
      fileCount,
    });

    return { size: dirSize, fileCount };
  }

  await walk(dirPath, 0);

  // 按大小排序
  result.dirs.sort((a, b) => b.size - a.size);
  result.files.sort((a, b) => b.size - a.size);

  return result;
}

/**
 * 生成 Treemap 数据（扁平矩形布局）
 * @param {Array<{name,size}>} items
 * @param {number} width
 * @param {number} height
 * @returns {Array<{name,size,x,y,w,h,colorIndex:number}>}
 */
function buildTreemapData(items, width = 800, height = 500) {
  const total = items.reduce((s, it) => s + (it.size || 0), 0);
  if (!total || !items.length) return [];

  const rects = [];
  // 简单的 slice-and-dice 算法
  layout(items.map(it => ({ ...it })), 0, 0, width, height, rects, total);
  return rects;
}

function layout(items, x, y, w, h, rects, total) {
  if (!items.length) return;
  if (items.length === 1) {
    rects.push({ ...items[0], x, y, w, h, colorIndex: rects.length % 8 });
    return;
  }

  // 按较长边切分
  const isHorizontal = w >= h;
  items.sort((a, b) => (b.size || 0) - (a.size || 0));

  const itemTotal = items.reduce((s, it) => s + (it.size || 0), 0);
  let n = 1;
  let sumFirst = items[0]?.size || 0;

  // 找到最佳分割点：使第一个矩形的宽高比最接近 1
  let bestRatio = Infinity;
  let bestN = 1;
  let runningSum = sumFirst;

  for (let i = 1; i < items.length; i++) {
    runningSum += items[i]?.size || 0;
    const frac = runningSum / itemTotal;
    let ratio;
    if (isHorizontal) {
      const rw = w * frac;
      ratio = Math.max(rw / h, h / rw);
    } else {
      const rh = h * frac;
      ratio = Math.max(rh / w, w / rh);
    }
    if (ratio < bestRatio) {
      bestRatio = ratio;
      bestN = i + 1;
    }
  }

  n = bestN;
  const first = items.splice(0, n);
  const firstSize = first.reduce((s, it) => s + (it.size || 0), 0);
  const frac = firstSize / (itemTotal || 1);

  if (isHorizontal) {
    const subW = w * frac;
    let cx = x;
    for (const item of first) {
      const iw = subW * ((item.size || 0) / (firstSize || 1));
      rects.push({ ...item, x: cx, y, w: iw, h, colorIndex: rects.length % 8 });
      cx += iw;
    }
    layout(items, x + subW, y, w - subW, h, rects, total);
  } else {
    const subH = h * frac;
    let cy = y;
    for (const item of first) {
      const ih = subH * ((item.size || 0) / (firstSize || 1));
      rects.push({ ...item, x, y: cy, w, h: ih, colorIndex: rects.length % 8 });
      cy += ih;
    }
    layout(items, x, y + subH, w, h - subH, rects, total);
  }
}

/** 预设调色板（区分类型用） */
const COLORS = [
  '#e05561', '#4a90d9', '#50b87d', '#f5a623',
  '#9b6bdf', '#e8873b', '#51aeb8', '#cf5b8f',
];

module.exports = {
  scanSize,
  buildTreemapData,
  LARGE_FILE_THRESHOLD,
  DEFAULT_TOP_N,
  COLORS,
};
