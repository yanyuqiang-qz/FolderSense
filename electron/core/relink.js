'use strict';
/**
 * 标签跟随：文件夹被移动 / 重命名后，尽量把标签重新接上
 *
 * 匹配优先级：
 *  1. inode 完全一致（同一分区内移动/重命名 → 100% 可靠）
 *  2. 结构指纹一致（子项名称集合 + 数量的哈希 → 极高可靠）
 *  3. 同名 + 子项名相似度高（跨盘复制等场景 → 需要用户确认）
 *
 * 自动重连阈值 0.9；0.5~0.9 之间列为「待确认候选」，交给用户在界面里点确认。
 */
const path = require('node:path');
const scanner = require('./scanner');

const AUTO_THRESHOLD = 0.9;
const SUGGEST_THRESHOLD = 0.5;

/**
 * @param {object} deps { library, indexer, settingsRef }
 */
async function verifyAndRelink(deps, opts = {}) {
  const { library, indexer, settingsRef } = deps;
  const settings = settingsRef().all();
  const annPaths = library.annotatedPaths();

  const report = {
    checked: annPaths.length,
    ok: 0,
    missing: 0,
    relinked: [],
    candidates: [],   // { oldPath, options: [{path, score, reason}] }
    stillMissing: [],
  };

  const missing = [];
  for (const p of annPaths) {
    const exists = await scanner.exists(p);
    if (exists) {
      library.markStatus(p, 'ok');
      report.ok++;
      // 顺手补齐缺失的指纹，方便以后重连
      const a = library.raw(p);
      if (a && !a.fingerprint && !opts.skipFingerprint) {
        try { library.setFingerprint(p, await scanner.computeFingerprint(p, settings)); } catch { /* ignore */ }
      }
    } else {
      library.markStatus(p, 'missing');
      report.missing++;
      missing.push(p);
    }
  }

  if (!missing.length) return report;

  // 为失联条目在索引里找候选
  for (const oldPath of missing) {
    const a = library.raw(oldPath);
    const base = path.basename(oldPath);
    const seen = new Set();
    /** @type {{path:string,score:number,reason:string}[]} */
    const options = [];

    // 候选来源 1：索引里的同名目录
    for (const cand of indexer.findByBasename(base, { limit: 30 })) {
      if (cand === oldPath || seen.has(cand)) continue;
      seen.add(cand);
      options.push({ path: cand, score: 0.5, reason: '文件夹名相同' });
    }

    // 候选来源 2：索引里指纹相同的目录（应对“改了名字”的情况）
    if (a?.fingerprint) {
      const dirs = indexer.allDirs();
      let scannedCount = 0;
      for (const cand of dirs) {
        if (seen.has(cand) || cand === oldPath) continue;
        if (scannedCount++ > (opts.maxProbe ?? 4000)) break;
        // 只探测“新出现的目录”（旧索引里也存在的更可能是无关目录），先按名字快速筛
        const candBase = path.basename(cand);
        if (candBase.toLowerCase() !== base.toLowerCase() && !looksSimilar(candBase, base)) continue;
        seen.add(cand);
        options.push({ path: cand, score: 0.4, reason: '名称相近' });
      }
    }

    // 真正计算指纹得分
    const scored = [];
    for (const opt of options.slice(0, 20)) {
      if (!(await scanner.exists(opt.path))) continue;
      let s = opt.score;
      let reason = opt.reason;
      if (a?.fingerprint) {
        try {
          const fp = await scanner.computeFingerprint(opt.path, settings);
          const fs = scanner.fingerprintScore(a.fingerprint, fp);
          if (fs >= 1) { s = 1; reason = '文件系统 inode 完全一致'; }
          else if (fs >= 0.95) { s = 0.95; reason = '内部结构完全一致'; }
          else s = Math.max(s, fs);
        } catch { /* 忽略 */ }
      }
      scored.push({ path: opt.path, score: Number(s.toFixed(3)), reason });
    }
    scored.sort((x, y) => y.score - x.score);

    const best = scored[0];
    if (best && best.score >= AUTO_THRESHOLD) {
      library.relink(oldPath, best.path, 'auto');
      report.relinked.push({ from: oldPath, to: best.path, score: best.score, reason: best.reason });
    } else {
      const suggests = scored.filter((s) => s.score >= SUGGEST_THRESHOLD).slice(0, 5);
      if (suggests.length) report.candidates.push({ oldPath, options: suggests });
      else report.stillMissing.push(oldPath);
    }
  }

  await library.flush();
  return report;
}

function looksSimilar(a, b) {
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (x.includes(y) || y.includes(x)) return true;
  // 简易编辑距离阈值
  if (Math.abs(x.length - y.length) > 4) return false;
  let diff = 0;
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) diff++;
  diff += Math.abs(x.length - y.length);
  return diff <= 3;
}

module.exports = { verifyAndRelink, AUTO_THRESHOLD, SUGGEST_THRESHOLD };
