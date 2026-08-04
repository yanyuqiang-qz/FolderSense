'use strict';
/**
 * IPC 路由：渲染进程能做的所有事情都在这里，且全部经过参数校验。
 */
const { ipcMain, dialog, shell, app } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');

const scanner = require('./core/scanner');
const ai = require('./core/ai');
const { verifyAndRelink } = require('./core/relink');
const { DEFAULTS } = require('./core/settings');

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
    const profile = await scanner.buildProfile(requireString(dirPath, 'dirPath'), s);
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
    const profile = await scanner.buildProfile(p, s);
    const result = await ai.analyze(profile, s, settings.getApiKey());
    let fp = null;
    try { fp = await scanner.computeFingerprint(p, s); } catch { /* ignore */ }
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

module.exports = { registerIpc };
