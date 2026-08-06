'use strict';
/**
 * IPC 路由：渲染进程能做的所有事情都在这里，且全部经过参数校验。
 */
const { ipcMain, dialog, shell, app } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');

const scanner = require('./core/scanner');
const ai = require('./core/ai');
const sizeScanner = require('./core/sizeScanner');
const scheduler = require('./core/scheduler');
const { verifyAndRelink } = require('./core/relink');
const { DEFAULTS, DEFAULT_EXCLUDES } = require('./core/settings');

function ok(data) { return { ok: true, data }; }
function fail(e) {
  const msg = String(e && e.message ? e.message : e);
  console.error('[ipc]', msg);
  return { ok: false, error: msg };
}

function requireString(v, name) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${name} 无效`);
  return v;
}

function registerIpc(ctx, getWin) {
  const { settings, library, indexer, jobs } = ctx;
  const H = (channel, handler) => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try { return ok(await handler(...args)); } catch (e) { return fail(e); }
    });
  };

  // ---------------- 应用信息 ----------------
  H('app:info', async () => ({
    version: app.getVersion(),
    name: app.getName(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    dataDir: app.getPath('userData'),
    locale: app.getLocale(),
  }));

  // ---------------- 设置 ----------------
  H('settings:get', async () => settings.publicView());

  H('settings:patch', async (partial) => {
    if (!partial || typeof partial !== 'object') throw new Error('参数无效');
    if (partial.ai) { delete partial.ai.apiKeyEnc; delete partial.ai.apiKeyPlain; }
    const v = settings.patch(partial);
    if (partial.scan) scanner.clearCache();
    await settings.flush();
    return v;
  });

  H('settings:setApiKey', async (key) => {
    settings.setApiKey(typeof key === 'string' ? key.trim() : '');
    await settings.flush();
    return settings.publicView();
  });

  H('settings:testAi', async () => ai.testConnection(settings.all(), settings.getApiKey()));

  H('settings:listModels', async () => ai.listModels(settings.all(), settings.getApiKey()));

  H('settings:reset', async (section) => {
    if (section && DEFAULTS[section]) {
      settings.patch({ [section]: structuredClone(DEFAULTS[section]) });
    } else {
      settings.patch(structuredClone(DEFAULTS));
    }
    await settings.flush();
    scanner.clearCache();
    return settings.publicView();
  });

  // ---------------- 文件系统 ----------------
  H('fs:roots', async () => {
    const sys = await scanner.getRoots();
    const custom = (settings.all().scan.roots || []).map((p) => ({
      path: p, name: path.basename(p) || p, kind: 'custom',
    }));
    return { system: sys, custom };
  });

  H('fs:list', async (dirPath, opts) => {
    requireString(dirPath, 'dirPath');
    return scanner.listDir(dirPath, settings.all(), opts || {});
  });

  H('fs:profile', async (dirPath) => {
    requireString(dirPath, 'dirPath');
    return scanner.buildProfile(dirPath, settings.all());
  });

  H('fs:reveal', async (p) => {
    requireString(p, 'path');
    shell.showItemInFolder(scanner.normalize(p));
    return true;
  });

  H('fs:open', async (p) => {
    requireString(p, 'path');
    const err = await shell.openPath(scanner.normalize(p));
    if (err) throw new Error(err);
    return true;
  });

  H('fs:pickFolder', async (opts = {}) => {
    const res = await dialog.showOpenDialog(getWin(), {
      title: opts.title || '选择文件夹',
      properties: ['openDirectory', 'createDirectory', ...(opts.multi ? ['multiSelections'] : [])],
    });
    if (res.canceled) return [];
    return res.filePaths.map(scanner.normalize);
  });

  H('fs:clearCache', async (p) => { scanner.clearCache(p); return true; });
  H('fs:cacheStats', async () => scanner.cacheStats());

  // ---------------- 索引 ----------------
  H('index:summary', async () => indexer.summary());

  H('index:scan', async (roots) => {
    const s = settings.all();
    let targets = Array.isArray(roots) && roots.length ? roots : s.scan.roots;
    if (!targets || !targets.length) throw new Error('尚未设置扫描范围，请先在「设置」里添加要扫描的文件夹');
    targets = targets.map(scanner.normalize);
    const r = indexer.startScan(targets, s.scan);
    if (!r.ok) {
      throw new Error(r.reason === 'already-scanning' ? '正在扫描中，请稍候' : '没有可扫描的目录');
    }
    return r;
  });

  H('index:cancel', async () => indexer.cancelScan());

  H('index:search', async (query, opts) => indexer.search(query, opts || {}));

  H('index:clear', async () => { indexer.clear(); await indexer.flush(); return indexer.summary(); });

  // ---------------- 标签库 ----------------
  H('lib:tags', async () => library.listTags());
  H('lib:createTag', async (input) => library.createTag(input || {}));
  H('lib:updateTag', async (id, patch) => library.updateTag(requireString(id, 'id'), patch || {}));
  H('lib:deleteTag', async (id) => library.deleteTag(requireString(id, 'id')));
  H('lib:categories', async () => library.listCategories());
  H('lib:upsertCategory', async (cat) => library.upsertCategory(cat || {}));
  H('lib:deleteCategory', async (id) => library.deleteCategory(requireString(id, 'id')));

  H('lib:views', async (paths) => {
    if (!Array.isArray(paths)) return {};
    return library.viewMany(paths.map(scanner.normalize));
  });

  H('lib:addTag', async (p, name, opts) =>
    library.addUserTagByName(scanner.normalize(requireString(p, 'path')), requireString(name, 'name'), opts || {}));

  H('lib:addTagId', async (p, tagId) =>
    library.addTagId(scanner.normalize(requireString(p, 'path')), requireString(tagId, 'tagId')));

  H('lib:removeTag', async (p, tagId) =>
    library.removeTagFrom(scanner.normalize(requireString(p, 'path')), requireString(tagId, 'tagId')));

  H('lib:restoreAi', async (p) => library.restoreAiTags(scanner.normalize(requireString(p, 'path'))));

  H('lib:setNote', async (p, note) =>
    library.setNote(scanner.normalize(requireString(p, 'path')), note));

  H('lib:setSummary', async (p, text) =>
    library.setSummaryOverride(scanner.normalize(requireString(p, 'path')), text));

  H('lib:clearAnnotation', async (p) =>
    library.clearAnnotation(scanner.normalize(requireString(p, 'path'))));

  H('lib:searchByTags', async (tagIds, mode) => {
    const paths = library.searchByTags(Array.isArray(tagIds) ? tagIds : [], mode || 'and');
    return decorate(paths, library);
  });

  H('lib:searchText', async (q) => decorate(library.searchText(q), library));

  H('lib:listAnnotated', async () => decorate(library.annotatedPaths(), library));

  H('lib:stats', async () => library.stats());

  H('lib:export', async () => {
    const res = await dialog.showSaveDialog(getWin(), {
      title: '导出标签数据',
      defaultPath: `foldersense-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled) return { canceled: true };
    await fsp.writeFile(res.filePath, JSON.stringify(library.exportAll(), null, 2), 'utf8');
    return { canceled: false, path: res.filePath };
  });

  H('lib:import', async (mode) => {
    const res = await dialog.showOpenDialog(getWin(), {
      title: '导入标签数据',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled) return { canceled: true };
    const raw = await fsp.readFile(res.filePaths[0], 'utf8');
    const stats = library.importAll(JSON.parse(raw), mode || 'merge');
    await library.flush();
    return { canceled: false, stats };
  });

  // ---------------- AI ----------------
  H('ai:preview', async (dirPath) => {
    const s = settings.all();
    const profile = await scanner.buildItemProfile(requireString(dirPath, 'dirPath'), s);
    return {
      payload: ai.buildPayload(profile, s.ai),
      system: ai.SYSTEM_PROMPT,
      endpoint: `${String(s.ai.baseUrl || '').replace(/\/+$/, '')}/chat/completions`,
      model: s.ai.model,
      willSendFileNames: !!s.ai.sendFileNames,
      willSendFullPath: !!s.ai.sendFullPath,
      willSendFileContent: false,
      hasApiKey: !!settings.getApiKey(),
    };
  });

  H('ai:analyzeOne', async (dirPath) => {
    const p = scanner.normalize(requireString(dirPath, 'dirPath'));
    const s = settings.all();
    const profile = await scanner.buildItemProfile(p, s);
    const result = await ai.analyze(profile, s, settings.getApiKey());
    let fp = null;
    if (profile.itemType === 'folder') {
      try { fp = await scanner.computeFingerprint(p, s); } catch { /* ignore */ }
    }
    const view = library.setAIResult(p, result, fp);
    await library.flush();
    return view;
  });

  H('ai:batch', async (paths, opts) => {
    if (!Array.isArray(paths) || !paths.length) throw new Error('请先选择要打标签的文件夹');
    return jobs.start(paths, opts || {});
  });

  H('ai:cancel', async () => jobs.cancel());
  H('ai:status', async () => jobs.status());
  H('ai:audit', async (limit) => ai.readAudit(limit || 200));
  H('ai:clearAudit', async () => ai.clearAudit());

  /* ---------------- AI 文件管家（对话找文件） ---------------- */
  H('ai:chat', async (messages) => {
    if (!Array.isArray(messages) || !messages.length) throw new Error('消息为空');
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user' || !String(last.content || '').trim()) {
      throw new Error('最后一条必须是用户消息');
    }
    const s = settings.all();
    const index = library.buildIndex();
    const candidates = ai.localRetrieve(index, last.content, 40);
    const apiKey = settings.getApiKey();

    // 离线兜底：没开启 AI 或没填 Key 时，用本地关键词直接回答
    if (!s.ai.enabled || !apiKey) {
      return { source: 'local', answer: ai.localAnswer(last.content, candidates), matches: candidates.slice(0, 12) };
    }

    const history = messages.slice(0, -1)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: String(m.content || '') }));

    try {
      const r = await ai.chat(last.content, history, candidates, s, apiKey);
      const matches = [];
      const seen = new Set();
      for (const n of r.matchIndices || []) {
        const i = Number(n) - 1;
        if (i >= 0 && i < candidates.length && !seen.has(i)) { seen.add(i); matches.push(candidates[i]); }
      }
      if (!matches.length && candidates.length) matches.push(...candidates.slice(0, 3));
      return { source: 'remote', answer: r.answer, matches: matches.slice(0, 8) };
    } catch (e) {
      // 远程失败也别让用户空手而归：退回本地关键词结果
      return {
        source: 'local-fallback',
        answer: `AI 暂时连不上（${e.message}）。不过我用本地记录帮你找到了这些可能相关的文件，你看看是不是：`,
        matches: candidates.slice(0, 12),
      };
    }
  });

  // ---------------- 标签跟随 ----------------
  H('relink:verify', async () => verifyAndRelink({
    library, indexer, settingsRef: () => settings,
  }));

  H('relink:apply', async (oldPath, newPath) => {
    const o = scanner.normalize(requireString(oldPath, 'oldPath'));
    const n = scanner.normalize(requireString(newPath, 'newPath'));
    if (!(await scanner.exists(n))) throw new Error('目标文件夹不存在');
    return library.relink(o, n, 'manual');
  });

  // ---------------- 空间分析 ----------------
  H('size:scan', async (dirPath) => {

  // ---------------- 年龄分布 ----------------
  H('age:distribution', async (dirPath) => {
    const p = scanner.normalize(requireString(dirPath, 'dirPath'));
    const s = settings.all();
    const profile = await scanner.buildProfile(p, s);
    // 如果 profile 里没有文件级 mtime 数据，快速扫描一层
    const buckets = { week: 0, month: 0, quarter: 0, half: 0, older: 0 };
    const now = Date.now();
    const WEEK = 7 * 86400000;
    const MONTH = 30 * 86400000;
    try {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.name.startsWith('.') && ent.isFile()) {
          try {
            const stat = await fsp.stat(path.join(p, ent.name));
            const age = now - stat.mtimeMs;
            if (age < WEEK) buckets.week++;
            else if (age < MONTH) buckets.month++;
            else if (age < MONTH * 3) buckets.quarter++;
            else if (age < MONTH * 6) buckets.half++;
            else buckets.older++;
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
    return { buckets, total: Object.values(buckets).reduce((a, b) => a + b, 0), dirName: path.basename(p) };
  });

  // ---------------- 文件预览 ----------------
    const p = scanner.normalize(requireString(dirPath, 'dirPath'));
    const controller = new AbortController();
    // 设置超时（5分钟）
    const timer = setTimeout(() => controller.abort(), 300000);
    try {
      const result = await sizeScanner.scanSize(p, {
        signal: controller.signal,
        maxDepth: settings.all().scan?.maxDepth || 10,
      });
      // 只返回前 N 个目录和文件（避免传输过大）
      return {
        dirs: result.dirs.slice(0, 200),
        files: result.files.slice(0, sizeScanner.DEFAULT_TOP_N),
        totalDirs: result.dirs.length,
        totalFiles: result.files.length,
        totalSize: result.totalSize,
        treemap: sizeScanner.buildTreemapData(result.dirs.slice(0, 50)),
      };
    } finally { clearTimeout(timer); }
  });

  // ---------------- 文件预览 ----------------
  H('fs:preview', async (filePath) => {
    const p = scanner.normalize(requireString(filePath, 'filePath'));
    const MAX_BYTES = 4096; // 只读前 4KB
    try {
      const stat = await fsp.stat(p);
      if (!stat.isFile()) throw new Error('不是文件');
      const ext = path.extname(p).toLowerCase();
      // 图片：返回 base64 缩略图信息
      if (/\.(png|jpe?g|gif|bmp|webp|ico|svg)$/i.test(ext)) {
        const buf = await fsp.readFile(p);
        return { type: 'image', ext, size: stat.size, data: `data:${mimeFromExt(ext)};base64,${buf.toString('base64').slice(0, 100)}...`, isTruncated: true };
      }
      // 文本/代码
      if (/\.(txt|md|csv|log|json|xml|html?|css|js|ts|py|java|c(cpp|h)?|go|rs|sh|bat|ps1|yml|yaml|toml|ini|cfg|conf)$/i.test(ext)) {
        const buf = await fsp.readFile(p, { encoding: 'utf-8' });
        const text = buf.slice(0, MAX_BYTES);
        return { type: 'text', ext, size: stat.size, content: text, isTruncated: buf.length > MAX_BYTES };
      }
      // Office 文档：抽取文本预览
      if (/\.(docx|xlsx|pptx)$/i.test(ext)) {
        try {
          const text = extractOfficeText(p, ext.toLowerCase());
          if (text && text.trim()) return { type: 'text', ext, size: stat.size, content: text, isTruncated: text.length >= PREVIEW_BYTES, office: true };
        } catch { /* 抽取失败则走下方兜底 */ }
      }
      // PDF：抽取文本预览
      if (ext === '.pdf') {
        try {
          const text = await extractPdfText(p);
          if (text && text.trim()) return { type: 'text', ext, size: stat.size, content: text, isTruncated: text.length >= PREVIEW_BYTES, pdf: true };
        } catch { /* 抽取失败则走下方兜底 */ }
      }
      // 其它格式只返回元信息
      return { type: 'binary', ext, size: stat.size, previewable: false };
    } catch (e) {
      return { error: e.message, previewable: false };
    }
  });

  // ---------------- 批量文件操作 ----------------
  H('fs:move', async (paths, destDir) => {
    const dest = scanner.normalize(requireString(destDir, 'destDir'));
    if (!(await scanner.exists(dest))) throw new Error('目标文件夹不存在');
    const results = [];
    for (const src of paths) {
      const s = scanner.normalize(src);
      const fileName = path.basename(s);
      const target = path.join(dest, fileName);
      try { await fsp.rename(s, target); results.push({ from: s, to: target, ok: true }); }
      catch (e) { results.push({ from: s, to: target, ok: false, error: e.message }); }
    }
    return results;
  });

  H('fs:copy', async (paths, destDir) => {
    const dest = scanner.normalize(requireString(destDir, 'destDir'));
    if (!(await scanner.exists(dest))) throw new Error('目标文件夹不存在');
    const results = [];
    for (const src of paths) {
      const s = scanner.normalize(src);
      const fileName = path.basename(s);
      const target = path.join(dest, fileName);
      try { await fsp.copyFile(s, target); results.push({ from: s, to: target, ok: true }); }
      catch (e) { results.push({ from: s, to: target, ok: false, error: e.message }); }
    }
    return results;
  });

  H('fs:trash', async (paths) => {
    const results = [];
    for (const src of paths) {
      const s = scanner.normalize(src);
      try { await shell.trashItem(s); results.push({ path: s, ok: true }); }
      catch (e) { results.push({ path: s, ok: false, error: e.message }); }
    }
    return results;
  });

  // ---------------- 收藏夹 ----------------
  H('favorites:get', async () => settings.all().favorites || []);

  H('favorites:add', async (p) => {
    const favPath = scanner.normalize(requireString(p, 'path'));
    const favs = [...(settings.all().favorites || [])];
    if (!favs.includes(favPath)) {
      favs.unshift(favPath);
      await settings.patch({ favorites: favs });
      await settings.flush();
    }
    return settings.all().favorites || [];
  });

  H('favorites:remove', async (p) => {
    const favPath = scanner.normalize(requireString(p, 'path'));
    const favs = (settings.all().favorites || []).filter((x) => x !== favPath);
    await settings.patch({ favorites: favs.length ? favs : undefined });
    await settings.flush();
    return settings.all().favorites || [];
  });

  // ---------------- 重复文件检测 ----------------
  H('dedup:scan', async (dirPath) => {
    const p = scanner.normalize(requireString(dirPath, 'dirPath'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600000); // 10分钟超时
    return dedupScan(p, controller.signal);
  });

  // ---------------- 定时任务调度器 ----------------
  H('scheduler:status', async () => scheduler.status());

  H('scheduler:toggle', async (config) => {
    if (!config || typeof config !== 'object') throw new Error('参数无效');
    settings.patch({ scheduler: config });
    await settings.flush();
    // 通知 main.js 重新应用调度器设置（通过事件让 main 层处理）
    const { ipcMain } = require('electron');
    ipcMain.emit('scheduler:settings-changed', config);
    return settings.all().scheduler;
  });

  // ---------------- 清理助手扫描 ----------------
  H('clean:scan', async (root) => {
    const p = scanner.normalize(requireString(root, 'root'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600000); // 10分钟上限
    try {
      return await cleanScan(p, settings.all(), controller.signal);
    } finally {
      clearTimeout(controller);
    }
  });

  // ---------------- 同名文件夹合并建议 ----------------
  H('merge:suggest', async (root) => {
    const p = scanner.normalize(requireString(root, 'root'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600000); // 10分钟上限
    try {
      return await mergeSuggest(p, settings.all(), controller.signal);
    } finally {
      clearTimeout(controller);
    }
  });

  H('merge:apply', async (targetPath, sourcePaths) => {
    requireString(targetPath, 'targetPath');
    if (!Array.isArray(sourcePaths) || !sourcePaths.length) throw new Error('未选择要合并的源文件夹');
    return mergeApply(scanner.normalize(targetPath), sourcePaths.map((x) => scanner.normalize(x)));
  });
}

/** 预览文本上限 */
const PREVIEW_BYTES = 4096;

/** 从 Office 文档（docx/xlsx/pptx）抽取文本，纯 JS（adm-zip 解包 XML） */
function extractOfficeText(filePath, ext) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  if (ext === '.docx') {
    const e = entries.find((x) => x.entryName === 'word/document.xml');
    if (!e) return '';
    let xml = e.getData().toString('utf8');
    xml = xml.replace(/<w:p[ >]/g, '\n').replace(/<\/w:p>/g, '');
    return stripXml(xml);
  }
  if (ext === '.xlsx') {
    const e = entries.find((x) => x.entryName === 'xl/sharedStrings.xml');
    if (!e) return '';
    const xml = e.getData().toString('utf8');
    const texts = [...xml.matchAll(/<t[^>]*>(.*?)<\/t>/g)].map((m) => m[1]);
    return texts.join('   ').slice(0, PREVIEW_BYTES);
  }
  if (ext === '.pptx') {
    const slides = entries
      .filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x.entryName))
      .sort((a, b) => a.entryName.localeCompare(b.entryName));
    const parts = slides.map((s) => {
      const x = s.getData().toString('utf8');
      return [...x.matchAll(/<a:t[^>]*>(.*?)<\/a:t>/g)].map((m) => m[1]).join(' ');
    });
    return parts.join('\n\n').slice(0, PREVIEW_BYTES);
  }
  return '';
}

function stripXml(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

/** 从 PDF 抽取文本（pdfjs-dist legacy build，纯 JS，无原生依赖） */
async function extractPdfText(filePath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fsp.readFile(filePath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false, disableFontFace: true }).promise;
  let text = '';
  const maxPages = Math.min(doc.numPages, 5);
  try {
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const str = tc.items.map((it) => it.str || '').join(' ');
      text += (i > 1 ? '\n\n' : '') + str;
      if (text.length > PREVIEW_BYTES) break;
    }
  } finally {
    await doc.destroy();
  }
  return text.slice(0, PREVIEW_BYTES);
}

/** 给检索结果补上名称、是否存在、注记视图 */
function decorate(paths, library) {
  return paths.map((p) => {
    const v = library.view(p);
    return {
      path: p,
      name: path.basename(p) || p,
      parent: path.dirname(p),
      annotation: v,
      status: v?.status || 'ok',
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** 扩展名到 MIME 的简单映射 */
function mimeFromExt(ext) {
  const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

/**
 * 重复文件检测：按大小初筛 → SHA256 比对
 */
async function dedupScan(dirPath, signal) {
  const crypto = require('crypto');
  const fs2 = require('fs');

  // 第一步：收集所有文件及其大小
  const sizeMap = new Map(); // size -> [{path,name}]
  async function collect(dir) {
    if (signal?.aborted) throw new Error('cancelled');
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (signal?.aborted) throw new Error('cancelled');
      if (!ent.name.startsWith('.') && ent.isFile()) {
        const fp = path.join(dir, ent.name);
        try {
          const stat = await fsp.stat(fp);
          const arr = sizeMap.get(stat.size) || [];
          arr.push({ path: fp, name: ent.name });
          sizeMap.set(stat.size, arr);
        } catch { /* skip */ }
      } else if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== '$RECYCLE.BIN' && ent.name !== 'System Volume Information') {
        await collect(path.join(dir, ent.name));
      }
    }
  }
  await collect(dirPath);

  // 第二步：只对有相同大小的文件组做哈希比对
  const groups = [];
  for (const [size, files] of sizeMap) {
    if (files.length < 2) continue;
    if (signal?.aborted) throw new Error('cancelled');
    const hashMap = new Map();
    for (const f of files) {
      if (signal?.aborted) throw new Error('cancelled');
      try {
        const hash = crypto.createHash('sha256');
        const stream = fs2.createReadStream(f.path, { highWaterMark: 1024 * 1024 });
        for await (const chunk of stream) hash.update(chunk);
        const digest = hash.digest('hex').slice(0, 16); // 取前16位够用了
        const arr = hashMap.get(digest) || [];
        arr.push(f);
        hashMap.set(digest, arr);
      } catch { /* skip unreadable */ }
    }
    for (const [hash, dups] of hashMap) {
      if (dups.length >= 2) {
        groups.push({ hash, files: dups, size });
      }
    }
  }

  // 按浪费空间排序（每组总大小 - 保留一份）
  groups.sort((a, b) => (b.size * (b.files.length - 1)) - (a.size * (a.files.length - 1)));
  return { groups, totalGroups: groups.length, totalWastedBytes: groups.reduce((s, g) => s + g.size * (g.files.length - 1), 0) };
}

/**
 * 清理助手扫描：在指定根目录下寻找可清理的候选文件
 * - 大文件（>200MB）
 * - 老旧文件（>1 年未修改且 >10MB）
 * - 临时/缓存/下载目录中的文件
 * - 重复文件（>50MB 的同大小文件做 SHA256 比对）
 */
async function cleanScan(root, s, signal) {
  const fs2 = require('fs');
  const crypto = require('crypto');
  const LARGE = 200 * 1024 * 1024;
  const OLD_BYTES = 10 * 1024 * 1024;
  const OLD_MS = 365 * 86400000;
  const DUP_MIN = 50 * 1024 * 1024;
  const MAX_FILES = 300000;

  const candidates = [];
  const sizeMap = new Map(); // size -> [path]，用于重复检测
  const now = Date.now();
  const yearAgo = now - OLD_MS;
  const tempRe = /[\\/](Temp|tmp|Cache|Caches|Downloads|下载|临时文件|回收站|\$RECYCLE\.BIN|thumbnails|Thumbnails)/i;
  let scanned = 0;

  async function walk(dir, depth) {
    if (signal?.aborted) throw new Error('cancelled');
    if (scanned > MAX_FILES || depth > 14) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (signal?.aborted) throw new Error('cancelled');
      if (scanned > MAX_FILES) return;
      if (ent.name.startsWith('.')) continue;
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (DEFAULT_EXCLUDES.includes(ent.name)) continue;
        if (s?.scan?.excludeNames?.includes(ent.name)) continue;
        await walk(fp, depth + 1);
      } else if (ent.isFile()) {
        scanned++;
        let st;
        try { st = await fsp.stat(fp); } catch { continue; }
        const size = st.size;
        let category = null, reason = '';
        if (size > LARGE) { category = 'large'; reason = '体积超过 200MB 的大文件'; }
        else if (st.mtimeMs < yearAgo && size > OLD_BYTES) { category = 'old'; reason = '超过一年未修改'; }
        else if (tempRe.test(fp)) { category = 'temp'; reason = '位于临时 / 缓存 / 下载目录'; }
        if (category) candidates.push({ path: fp, name: ent.name, size, mtimeMs: st.mtimeMs, category, reason });
        if (size > DUP_MIN) {
          const arr = sizeMap.get(size) || [];
          arr.push(fp);
          sizeMap.set(size, arr);
        }
      }
    }
  }
  await walk(root, 0);

  // 重复文件检测（仅在大文件中比对，控制成本）
  const groups = [];
  for (const [size, files] of sizeMap) {
    if (files.length < 2) continue;
    if (signal?.aborted) throw new Error('cancelled');
    const hashMap = new Map();
    for (const fp of files) {
      try {
        const hash = crypto.createHash('sha256');
        const stream = fs2.createReadStream(fp, { highWaterMark: 1024 * 1024 });
        for await (const chunk of stream) hash.update(chunk);
        const digest = hash.digest('hex').slice(0, 16);
        const arr = hashMap.get(digest) || [];
        arr.push(fp);
        hashMap.set(digest, arr);
      } catch { /* 跳过不可读 */ }
    }
    for (const [hash, dups] of hashMap) {
      if (dups.length >= 2) {
        groups.push({ hash, size, files: dups.map((f) => ({ path: f, name: path.basename(f) })) });
      }
    }
  }
  groups.sort((a, b) => (b.size * (b.files.length - 1)) - (a.size * (a.files.length - 1)));

  const byCat = { large: [], old: [], temp: [] };
  for (const c of candidates) byCat[c.category].push(c);
  const totalBytes = candidates.reduce((a, c) => a + c.size, 0)
    + groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0);

  return { candidates, groups, byCat, totalBytes, scanned, root };
}

/**
 * 同名文件夹合并建议：扫描根目录下的所有文件夹，按「规范化名称」分组，
 * 找出分散在多处、名字相同的文件夹，估算内容重叠度并推荐合并目标。
 * 注意：只比对文件名集合（不读内容），用于给出「是否需要合并」的方向性建议。
 */
async function mergeSuggest(root, s, signal) {
  const MAX_DIRS = 150000;
  const MAX_OVERLAP_K = 60; // 同名组超过此数量的文件夹时，跳过两两重叠计算（多为 node_modules/bin 等系统目录）
  const nameMap = new Map(); // norm -> [{path, parent, mtimeMs, fileCount, fileNames:[name]}]
  let count = 0;

  async function walk(dir, depth) {
    if (signal?.aborted) throw new Error('cancelled');
    if (count > MAX_DIRS || depth > 16) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    const subDirs = [];
    const fileNames = [];
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (DEFAULT_EXCLUDES.includes(ent.name)) continue;
        if (s?.scan?.excludeNames?.includes(ent.name)) continue;
        subDirs.push(fp);
      } else if (ent.isFile()) {
        fileNames.push(ent.name.toLowerCase());
      }
    }
    // 记录本目录为同名候选
    const norm = (dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '').toLowerCase();
    if (norm) {
      let mtimeMs = 0;
      try { mtimeMs = (await fsp.stat(dir)).mtimeMs; } catch { /* skip */ }
      const arr = nameMap.get(norm) || [];
      arr.push({ path: dir, parent: path.dirname(dir), mtimeMs, fileCount: fileNames.length, fileNames });
      nameMap.set(norm, arr);
      count++;
    }
    for (const sd of subDirs) await walk(sd, depth + 1);
  }
  await walk(root, 0);

  // 形成同名组
  const groups = [];
  for (const [norm, folders] of nameMap) {
    if (folders.length < 2) continue;
    let avgOverlap = 0;
    let computed = true;
    if (folders.length <= MAX_OVERLAP_K) {
      let overlapSum = 0, pairCount = 0;
      for (let i = 0; i < folders.length; i++) {
        for (let j = i + 1; j < folders.length; j++) {
          const setA = new Set(folders[i].fileNames);
          let inter = 0;
          for (const n of folders[j].fileNames) if (setA.has(n)) inter++;
          const union = new Set([...folders[i].fileNames, ...folders[j].fileNames]).size || 1;
          overlapSum += inter / union;
          pairCount++;
        }
      }
      avgOverlap = pairCount ? overlapSum / pairCount : 0;
    } else {
      computed = false;
    }
    // 推荐目标：文件数最多者优先，其次修改最新；路径最短的往往更"主"
    const target = folders.slice().sort(
      (a, b) => (b.fileCount - a.fileCount) || (b.mtimeMs - a.mtimeMs)
    )[0];
    groups.push({
      name: norm,
      count: folders.length,
      folders,
      avgOverlap,
      computed,
      targetPath: target.path,
      targetFileCount: target.fileCount,
    });
  }
  groups.sort((a, b) => b.count - a.count || b.avgOverlap - a.avgOverlap);

  return { groups, scanned: count, root, withDupName: groups.length };
}

/**
 * 执行合并：把 sourcePaths 中每个源文件夹的内容移动进 target，文件名冲突时自动加后缀，
 * 源目录变空后移入回收站（可撤销）。全程不读取文件内容。
 */
async function mergeApply(target, sources) {
  if (!(await scanner.exists(target))) throw new Error('合并目标文件夹不存在');
  const results = [];
  for (const src of sources) {
    if (src === target) { results.push({ from: src, ok: false, error: '不能合并到自身' }); continue; }
    let entries;
    try { entries = await fsp.readdir(src, { withFileTypes: true }); }
    catch (e) { results.push({ from: src, ok: false, error: e.message }); continue; }
    let moved = 0, failed = 0;
    for (const ent of entries) {
      const from = path.join(src, ent.name);
      let to = path.join(target, ent.name);
      if (await scanner.exists(to)) {
        const ext = path.extname(ent.name);
        const base = ent.name.slice(0, ent.name.length - ext.length);
        let k = 1;
        while (await scanner.exists(to)) { to = path.join(target, `${base}__${k}${ext}`); k++; }
      }
      try { await fsp.rename(from, to); moved++; } catch { failed++; }
    }
    let removed = false;
    try {
      const left = await fsp.readdir(src);
      if (!left.length) { await shell.trashItem(src); removed = true; }
    } catch { /* ignore */ }
    results.push({ from: src, ok: failed === 0, moved, removed, error: failed ? `${failed} 项移动失败` : undefined });
  }
  return results;
}

module.exports = { registerIpc };
