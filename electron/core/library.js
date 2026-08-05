'use strict';
/**
 * 标签库 + 文件夹注记（AI 结果 / 用户自定义）
 *
 * 关键设计：
 *  - 标签注册表统一管理（含颜色、分类、来源），AI 产出的标签会自动登记，
 *    因此 AI 标签与手动标签可以用同一套颜色 / 过滤 / 统计逻辑。
 *  - 用户对 AI 结果的“覆盖”不是删除，而是记录在 removedAiTagIds / summaryOverride，
 *    这样重新生成时不会把用户明确删掉的标签又加回来，用户也能一键恢复。
 *  - 每条注记保存文件夹指纹与 inode，路径失效时可自动重连。
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { JsonStore } = require('./jsonStore');
const { files } = require('./paths');

const PALETTE = [
  '#e05561', '#e0894f', '#d9b34a', '#5aab5a', '#3fa9a0',
  '#4a90d9', '#7a6ad9', '#b463c4', '#c4638f', '#6d7f8c',
];

const DEFAULT_CATEGORIES = [
  { id: 'purpose', name: '用途' },
  { id: 'project', name: '项目' },
  { id: 'content', name: '内容类型' },
  { id: 'status', name: '状态' },
  { id: 'custom', name: '其它' },
];

function uid(prefix = 't') {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

class Library {
  constructor() {
    this.tags = new JsonStore(files.tags(), {
      version: 1,
      categories: DEFAULT_CATEGORIES,
      items: [],
    });
    this.ann = new JsonStore(files.annotations(), {
      version: 1,
      items: {},
    });
  }

  async init() {
    await this.tags.load();
    await this.ann.load();
    const t = this.tags.get();
    if (!t.categories || !t.categories.length) {
      t.categories = DEFAULT_CATEGORIES;
      this.tags.markDirty();
    }
  }

  // ---------------- 标签注册表 ----------------
  listTags() {
    const usage = new Map();
    for (const a of Object.values(this.ann.get().items)) {
      for (const id of this.effectiveTagIds(a)) usage.set(id, (usage.get(id) || 0) + 1);
    }
    return this.tags.get().items.map((t) => ({ ...t, usage: usage.get(t.id) || 0 }));
  }

  listCategories() {
    return this.tags.get().categories;
  }

  upsertCategory(cat) {
    this.tags.update((d) => {
      const i = d.categories.findIndex((c) => c.id === cat.id);
      if (i >= 0) d.categories[i] = { ...d.categories[i], ...cat };
      else d.categories.push({ id: cat.id || uid('c'), name: cat.name });
      return d;
    });
    return this.listCategories();
  }

  deleteCategory(id) {
    this.tags.update((d) => {
      d.categories = d.categories.filter((c) => c.id !== id);
      for (const t of d.items) if (t.category === id) t.category = 'custom';
      return d;
    });
    return this.listCategories();
  }

  findTagByName(name) {
    const n = String(name).trim().toLowerCase();
    return this.tags.get().items.find((t) => t.name.toLowerCase() === n);
  }

  ensureTag(name, opts = {}) {
    const clean = String(name).trim().slice(0, 24);
    if (!clean) return null;
    const found = this.findTagByName(clean);
    if (found) return found;
    const items = this.tags.get().items;
    const tag = {
      id: uid(),
      name: clean,
      color: opts.color || PALETTE[items.length % PALETTE.length],
      category: opts.category || 'custom',
      source: opts.source || 'user',
      createdAt: Date.now(),
    };
    this.tags.update((d) => { d.items.push(tag); return d; });
    return tag;
  }

  createTag(input) {
    if (this.findTagByName(input.name)) {
      throw new Error(`标签「${input.name}」已存在`);
    }
    return this.ensureTag(input.name, input);
  }

  updateTag(id, patch) {
    let updated = null;
    this.tags.update((d) => {
      const t = d.items.find((x) => x.id === id);
      if (!t) throw new Error('标签不存在');
      if (patch.name !== undefined) {
        const dup = d.items.find((x) => x.id !== id && x.name.toLowerCase() === String(patch.name).trim().toLowerCase());
        if (dup) throw new Error(`标签「${patch.name}」已存在`);
        t.name = String(patch.name).trim().slice(0, 24);
      }
      if (patch.color !== undefined) t.color = patch.color;
      if (patch.category !== undefined) t.category = patch.category;
      updated = t;
      return d;
    });
    return updated;
  }

  deleteTag(id) {
    this.tags.update((d) => { d.items = d.items.filter((t) => t.id !== id); return d; });
    this.ann.update((d) => {
      for (const a of Object.values(d.items)) {
        a.userTagIds = (a.userTagIds || []).filter((x) => x !== id);
        a.aiTagIds = (a.aiTagIds || []).filter((x) => x !== id);
        a.removedAiTagIds = (a.removedAiTagIds || []).filter((x) => x !== id);
      }
      return d;
    });
    return true;
  }

  // ---------------- 注记 ----------------
  _blank(p) {
    return {
      path: p,
      name: path.basename(p) || p,
      aiSummary: '',
      aiTagIds: [],
      aiConfidence: null,
      aiModel: '',
      aiSource: '',        // 'remote' | 'local'
      aiGeneratedAt: 0,
      aiReason: '',
      removedAiTagIds: [],
      userTagIds: [],
      summaryOverride: '',
      note: '',
      fingerprint: null,
      status: 'ok',
      history: [],
      updatedAt: Date.now(),
    };
  }

  raw(p) {
    return this.ann.get().items[p] || null;
  }

  ensure(p) {
    const d = this.ann.get();
    if (!d.items[p]) {
      d.items[p] = this._blank(p);
      this.ann.markDirty();
    }
    return d.items[p];
  }

  effectiveTagIds(a) {
    if (!a) return [];
    const removed = new Set(a.removedAiTagIds || []);
    const set = new Set();
    for (const id of a.aiTagIds || []) if (!removed.has(id)) set.add(id);
    for (const id of a.userTagIds || []) set.add(id);
    return [...set];
  }

  /** 组装成界面直接可用的视图对象 */
  view(p) {
    const a = this.raw(p);
    if (!a) return null;
    const tagMap = new Map(this.tags.get().items.map((t) => [t.id, t]));
    const removed = new Set(a.removedAiTagIds || []);
    return {
      path: a.path,
      name: a.name,
      summary: a.summaryOverride || a.aiSummary,
      aiSummary: a.aiSummary,
      summaryOverride: a.summaryOverride,
      note: a.note,
      confidence: a.aiConfidence,
      aiModel: a.aiModel,
      aiSource: a.aiSource,
      aiReason: a.aiReason,
      aiGeneratedAt: a.aiGeneratedAt,
      status: a.status,
      history: a.history || [],
      tags: this.effectiveTagIds(a).map((id) => {
        const t = tagMap.get(id);
        if (!t) return null;
        return { ...t, fromAi: (a.aiTagIds || []).includes(id), fromUser: (a.userTagIds || []).includes(id) };
      }).filter(Boolean),
      removedAiTags: [...removed].map((id) => tagMap.get(id)).filter(Boolean),
      hasAi: !!a.aiGeneratedAt,
    };
  }

  viewMany(paths) {
    const out = {};
    for (const p of paths) {
      const v = this.view(p);
      if (v) out[p] = v;
    }
    return out;
  }

  setAIResult(p, result, fingerprint) {
    const a = this.ensure(p);
    const tagIds = [];
    for (const name of result.tags || []) {
      const t = this.ensureTag(name, { source: 'ai', category: result.category || 'purpose' });
      if (t) tagIds.push(t.id);
    }
    a.aiSummary = String(result.summary || '').slice(0, 400);
    a.aiTagIds = tagIds;
    a.aiConfidence = typeof result.confidence === 'number' ? Math.max(0, Math.min(1, result.confidence)) : null;
    a.aiModel = result.model || '';
    a.aiSource = result.source || 'remote';
    a.aiReason = String(result.reason || '').slice(0, 300);
    a.aiGeneratedAt = Date.now();
    if (fingerprint) a.fingerprint = fingerprint;
    a.name = path.basename(p) || p;
    a.status = 'ok';
    a.updatedAt = Date.now();
    this.ann.markDirty();
    return this.view(p);
  }

  addUserTagByName(p, name, opts = {}) {
    const tag = this.ensureTag(name, { source: 'user', category: opts.category, color: opts.color });
    if (!tag) return this.view(p);
    const a = this.ensure(p);
    a.removedAiTagIds = (a.removedAiTagIds || []).filter((x) => x !== tag.id);
    if (!a.userTagIds.includes(tag.id)) a.userTagIds.push(tag.id);
    a.updatedAt = Date.now();
    this.ann.markDirty();
    return this.view(p);
  }

  addTagId(p, tagId) {
    const a = this.ensure(p);
    a.removedAiTagIds = (a.removedAiTagIds || []).filter((x) => x !== tagId);
    if (!a.userTagIds.includes(tagId)) a.userTagIds.push(tagId);
    a.updatedAt = Date.now();
    this.ann.markDirty();
    return this.view(p);
  }

  /** 移除某个标签：AI 标签会被记入“已否决”，用户标签直接删 */
  removeTagFrom(p, tagId) {
    const a = this.ensure(p);
    a.userTagIds = (a.userTagIds || []).filter((x) => x !== tagId);
    if ((a.aiTagIds || []).includes(tagId) && !(a.removedAiTagIds || []).includes(tagId)) {
      a.removedAiTagIds.push(tagId);
    }
    a.updatedAt = Date.now();
    this.ann.markDirty();
    return this.view(p);
  }

  restoreAiTags(p) {
    const a = this.ensure(p);
    a.removedAiTagIds = [];
    a.updatedAt = Date.now();
    this.ann.markDirty();
    return this.view(p);
  }

  setNote(p, note) {
    const a = this.ensure(p);
    a.note = String(note || '').slice(0, 2000);
    a.updatedAt = Date.now();
    this.ann.markDirty();
    return this.view(p);
  }

  setSummaryOverride(p, text) {
    const a = this.ensure(p);
    a.summaryOverride = String(text || '').slice(0, 400);
    a.updatedAt = Date.now();
    this.ann.markDirty();
    return this.view(p);
  }

  setFingerprint(p, fp) {
    const a = this.ensure(p);
    a.fingerprint = fp;
    this.ann.markDirty();
  }

  clearAnnotation(p) {
    this.ann.update((d) => { delete d.items[p]; return d; });
    return true;
  }

  /** 有注记（标签/备注/AI 结果）的全部路径 */
  annotatedPaths() {
    return Object.keys(this.ann.get().items);
  }

  /**
   * 导出供「AI 文件管家」检索用的精简清单。
   * 只包含名称、说明、标签、备注等元数据，绝不包含文件内容或完整路径以外的敏感信息。
   * @returns {Array<{path,name,summary,tags:string[],note,updatedAt}>}
   */
  buildIndex() {
    const tagMap = new Map(this.tags.get().items.map((t) => [t.id, t.name]));
    const out = [];
    for (const a of Object.values(this.ann.get().items)) {
      out.push({
        path: a.path,
        name: a.name,
        summary: a.summaryOverride || a.aiSummary,
        tags: this.effectiveTagIds(a).map((id) => tagMap.get(id)).filter(Boolean),
        note: a.note,
        updatedAt: a.updatedAt || 0,
      });
    }
    return out;
  }

  allAnnotations() {
    return Object.values(this.ann.get().items);
  }

  /**
   * 按标签检索
   * @param {string[]} tagIds
   * @param {'and'|'or'} mode
   */
  searchByTags(tagIds, mode = 'and') {
    const want = new Set(tagIds);
    if (!want.size) return [];
    const res = [];
    for (const a of Object.values(this.ann.get().items)) {
      const have = new Set(this.effectiveTagIds(a));
      let ok;
      if (mode === 'or') ok = [...want].some((t) => have.has(t));
      else ok = [...want].every((t) => have.has(t));
      if (ok) res.push(a.path);
    }
    return res;
  }

  /** 关键词检索（用途说明 / 备注 / 标签名 / 文件夹名） */
  searchText(q) {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return [];
    const tagMap = new Map(this.tags.get().items.map((t) => [t.id, t.name.toLowerCase()]));
    const res = [];
    for (const a of Object.values(this.ann.get().items)) {
      const hay = [
        a.name, a.aiSummary, a.summaryOverride, a.note,
        ...this.effectiveTagIds(a).map((id) => tagMap.get(id) || ''),
      ].join(' ').toLowerCase();
      if (hay.includes(query)) res.push(a.path);
    }
    return res;
  }

  /** 路径迁移：把旧路径上的所有注记搬到新路径 */
  relink(oldPath, newPath, method = 'manual') {
    this.ann.update((d) => {
      const a = d.items[oldPath];
      if (!a) return d;
      delete d.items[oldPath];
      a.path = newPath;
      a.name = path.basename(newPath);
      a.status = 'ok';
      a.history = a.history || [];
      a.history.push({ from: oldPath, to: newPath, at: Date.now(), method });
      a.updatedAt = Date.now();
      d.items[newPath] = a;
      return d;
    });
    return this.view(newPath);
  }

  markStatus(p, status) {
    const a = this.raw(p);
    if (a) { a.status = status; this.ann.markDirty(); }
  }

  stats() {
    const items = Object.values(this.ann.get().items);
    return {
      annotated: items.length,
      withAi: items.filter((a) => a.aiGeneratedAt).length,
      withNote: items.filter((a) => a.note).length,
      missing: items.filter((a) => a.status === 'missing').length,
      tags: this.tags.get().items.length,
    };
  }

  exportAll() {
    return {
      exportedAt: new Date().toISOString(),
      app: 'FolderSense',
      tags: this.tags.get(),
      annotations: this.ann.get(),
    };
  }

  importAll(data, mode = 'merge') {
    if (!data || !data.tags || !data.annotations) throw new Error('文件格式不正确');
    if (mode === 'replace') {
      this.tags.update((d) => { Object.assign(d, data.tags); return d; });
      this.ann.update((d) => { Object.assign(d, data.annotations); return d; });
    } else {
      this.tags.update((d) => {
        const byName = new Map(d.items.map((t) => [t.name.toLowerCase(), t]));
        for (const t of data.tags.items || []) {
          if (!byName.has(t.name.toLowerCase())) d.items.push(t);
        }
        return d;
      });
      this.ann.update((d) => {
        for (const [k, v] of Object.entries(data.annotations.items || {})) {
          if (!d.items[k]) d.items[k] = v;
        }
        return d;
      });
    }
    return this.stats();
  }

  async flush() {
    await this.tags.flush();
    await this.ann.flush();
  }
}

module.exports = { Library, PALETTE, DEFAULT_CATEGORIES };
