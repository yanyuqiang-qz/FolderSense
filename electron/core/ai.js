'use strict';
/**
 * AI 打标模块
 *
 * 隐私原则（重要）：
 *  - 默认只发送「文件夹画像」：文件夹名、子文件夹名、扩展名统计、文件数量与大小、
 *    以及可选的采样文件名。**从不读取、也从不发送任何文件内容**。
 *  - 完整绝对路径默认不发送（避免泄露用户名、盘符结构），只发送文件夹名本身。
 *  - 每次请求可写入本地审计日志，用户可随时查看到底发出去了什么。
 *  - 未配置 API Key 时自动降级为「本地规则推断」，完全离线可用。
 */
const fsp = require('node:fs/promises');
const { CAT_LABEL_ZH } = require('./fileTypes');
const { files } = require('./paths');

const PROMPT_VERSION = 'v1';

const SYSTEM_PROMPT = `你是一个本地文件管理助手。用户会给你一条「文件或文件夹的画像」（只包含名称、扩展名、类型、子项结构等元数据，不含任何文件内容）。
请你推断它的用途，并输出简体中文结果。

如果是文件夹：说明这个文件夹是做什么的，标签覆盖用途、内容类型、所属领域。
如果是文件：说明这个文件大概是做什么用的（例如「项目源代码」「会议录音」「安装程序」「设计稿源文件」等），标签覆盖文件类型、用途、领域。

要求：
1. summary：一句话说明它是做什么的，15~50 个汉字，面向不懂英文的普通用户；遇到英文名词在括号里加中文解释。
2. tags：3~5 个中文语义标签，每个 2~6 个字，用于分类检索。不要重复，不要包含标点。
3. category：从 ["用途","项目","内容类型","状态"] 中选一个最贴切的。
4. confidence：0 到 1 的小数，表示你对这个判断的把握。信息不足时必须给低分（<0.5），不要编造。
5. reason：不超过 40 字，说明你的判断依据。

只输出 JSON，不要输出任何解释性文字或 Markdown 代码块。格式：
{"summary":"...","tags":["...","..."],"category":"...","confidence":0.8,"reason":"..."}`;

/** 把画像转成给模型看的紧凑文本（同时也是给用户看的"将要发送的数据"） */
function buildPayload(profile, aiSettings) {
  const lines = [];
  const isFile = profile.itemType === 'file';

  if (isFile) {
    lines.push(`类型：文件`);
    lines.push(`文件名称：${profile.name}`);
    if (aiSettings.sendFullPath) lines.push(`完整路径：${profile.fullPath}`);
    else if (profile.parentName) lines.push(`上级文件夹名称：${profile.parentName}`);
    lines.push(`扩展名：${profile.ext || '无'}　文件大类：${CAT_LABEL_ZH[profile.cat] || profile.cat}　大小：${formatSize(profile.size)}`);
    if (profile.mtimeMs) lines.push(`最近修改时间：${new Date(profile.mtimeMs).toLocaleDateString('zh-CN')}`);
  } else {
    lines.push(`类型：文件夹`);
    lines.push(`文件夹名称：${profile.name}`);
    if (aiSettings.sendFullPath) {
      lines.push(`完整路径：${profile.fullPath}`);
    } else if (profile.parentName) {
      lines.push(`上级文件夹名称：${profile.parentName}`);
    }
    lines.push(`直接子文件夹数：${profile.dirCount}，直接文件数：${profile.fileCount}，直接文件总大小：${formatSize(profile.totalSizeOfDirectFiles)}`);

    if (profile.categories?.length) {
      lines.push('文件大类分布：' + profile.categories
        .map((c) => `${CAT_LABEL_ZH[c.cat] || c.cat}×${c.count}`).join('、'));
    }
    if (profile.extHistogram?.length) {
      lines.push('扩展名分布：' + profile.extHistogram
        .map((e) => `.${e.ext}×${e.count}`).join('、'));
    }
    if (profile.subDirNames?.length) {
      lines.push('子文件夹名（最多 25 个）：' + profile.subDirNames.join('、'));
    }
    if (profile.grandChildSample?.length) {
      const s = profile.grandChildSample
        .map((g) => `${g.dir}/{${g.children.join(', ')}}`).join(' ; ');
      lines.push('二级结构抽样：' + s);
    }
    if (profile.markers?.length) {
      lines.push('识别到的特征：' + profile.markers.join('、'));
    }
    if (aiSettings.sendFileNames && profile.sampleFileNames?.length) {
      lines.push(`采样文件名（最多 ${aiSettings.maxSampleFiles} 个，仅文件名不含内容）：` + profile.sampleFileNames.join('、'));
    }
    if (profile.newestMtime) {
      lines.push(`最近修改时间：${new Date(profile.newestMtime).toLocaleDateString('zh-CN')}`);
    }
  }
  const n = aiSettings.tagCount || 5;
  lines.push(`\n请生成约 ${n} 个中文标签，并给出中文用途说明。`);
  return lines.join('\n');
}

function formatSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// ---------------- AI 文件管家（对话找文件） ----------------
const BUTLER_SYSTEM_PROMPT = `你是用户的「本地文件管家」。用户的电脑里很多文件/文件夹都已经有了一句话说明和标签，整理在下面的「已知文件清单」里（只含名称、说明、标签，**不含文件内容，也不含完整磁盘路径**）。

你的任务：用简体中文、像真人助手一样，回答用户关于“某个文件/文件夹在哪、是干嘛的”这类问题。例如：
- “我的合同放在哪？”
- “上次旅游的照片在哪个文件夹？”
- “和工作有关的文档都在哪里？”

规则：
1. 只能依据「已知文件清单」回答，绝对不要编造清单里没有的文件或路径。
2. 回答要口语化、面向不懂电脑的普通用户，避免英文术语；提到文件时直接用清单里的「名称」。
3. 如果用户问“在哪”，明确告诉他在哪个文件夹/文件，并引用清单里的编号（如“见第 3 条”）。
4. 如果清单里找不到，就老实说“在你的文件说明里没有找到相关记录”，并建议他先对那个文件所在的文件夹做一次「AI 分析」。
5. 最后务必以 JSON 输出：{"answer":"你的口语化回答","matchIndices":[相关条目的编号数组，编号从 1 开始，最多 8 个；没有就为 []]}。

只输出 JSON，不要输出任何解释性文字或 Markdown 代码块。`;

/** 把候选清单拼成给模型看的文本（不含完整路径，保护隐私） */
function buildButlerPayload(candidates) {
  const lines = candidates.map((c, i) => {
    const parts = [`[${i + 1}] 名称：${c.name}`];
    if (c.summary) parts.push(`说明：${c.summary}`);
    if (c.tags && c.tags.length) parts.push(`标签：${c.tags.join('、')}`);
    if (c.note) parts.push(`备注：${c.note}`);
    return parts.join('\n    ');
  });
  return '已知文件清单（共 ' + candidates.length + ' 条）：\n' + lines.join('\n') + '\n';
}

/**
 * 本地关键词预检索：从索引里挑出和提问最相关的若干条。
 * 中文没有空格，用「标点切分 + 2 字滑动窗口（bigram）」生成检索词，
 * 既能命中“合同”这种短词，也能让“旅游照片”命中标签里带“旅游”“照片”的条目。
 */
function queryTokens(q) {
  const toks = [];
  const splitRe = /[\s,，。、;；:：!！?？()（）'""]+/;
  for (const t of q.split(splitRe).map((s) => s.trim()).filter(Boolean)) {
    toks.push({ t: t.toLowerCase(), w: 3 });
  }
  const clean = q.toLowerCase().replace(splitRe, '');
  if (clean.length >= 2) {
    for (let i = 0; i < clean.length - 1; i++) toks.push({ t: clean.slice(i, i + 2), w: 2 });
  }
  if (clean.length > 0 && clean.length <= 8) toks.push({ t: clean, w: 4 });
  return toks;
}

function localRetrieve(index, query, k) {
  const q = String(query || '').trim();
  if (!index.length) return [];
  if (!q) {
    return index.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, k);
  }
  const toks = queryTokens(q);
  const scored = index.map((item) => {
    const name = (item.name || '').toLowerCase();
    const summary = (item.summary || '').toLowerCase();
    const tags = (item.tags || []).join(' ').toLowerCase();
    const note = (item.note || '').toLowerCase();
    const hay = [name, summary, tags, note];
    let score = 0;
    for (const { t, w } of toks) {
      if (!t) continue;
      for (const h of hay) {
        if (h.includes(t)) { score += w; break; }
      }
    }
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  let top = scored.filter((s) => s.score > 0).slice(0, k);
  if (top.length < 8) {
    const seen = new Set(top.map((s) => s.item.path));
    for (const s of scored) {
      if (top.length >= k) break;
      if (!seen.has(s.item.path)) { seen.add(s.item.path); top.push(s); }
    }
  }
  return top.map((s) => s.item);
}

/** 离线兜底：没有 API Key 时，用本地关键词结果直接回答 */
function localAnswer(question, candidates) {
  const q = String(question || '').trim();
  if (!candidates.length) {
    return `目前我还没有记录任何文件或文件夹的说明，所以暂时不知道你的东西放在哪。\n\n你可以这样做：先用左边「浏览文件夹」找到你常找不到的那个文件夹，选中它，点「AI 生成标签」或「递归分析子项」，让我记住里面每个文件是干嘛的。之后你就能直接问我“${q || '某某文件'}放在哪”了。`;
  }
  const top = candidates.slice(0, 8);
  const lines = top.map((c, i) => `${i + 1}. ${c.name}${c.summary ? ' —— ' + c.summary : ''}`).join('\n');
  return `（未配置 AI，已用本地关键词在记录里帮你找了最相关的 ${top.length} 条）\n\n可能相关的文件/文件夹：\n${lines}\n\n点开下面的结果就能直接打开或定位文件。`;
}

/** 调用 AI 回答“文件在哪”类问题，返回 {answer, matchIndices} */
async function chat(question, history, candidates, settings, apiKey, signal) {
  const ai = settings.ai || {};
  const payload = buildButlerPayload(candidates);
  const userContent = `已知文件清单：\n${payload}\n\n用户问题：${question}\n\n请只输出 JSON（answer + matchIndices）。`;
  const { parsed } = await callRemote(userContent, ai, apiKey, signal, BUTLER_SYSTEM_PROMPT, history || []);
  const answer = String(parsed.answer || '').trim();
  let matchIndices = Array.isArray(parsed.matchIndices) ? parsed.matchIndices : [];
  matchIndices = matchIndices.map((n) => Number(n)).filter((n) => Number.isInteger(n)).slice(0, 8);
  return { answer: answer || '（AI 没有返回说明）', matchIndices };
}

// ---------------- 远程调用 ----------------
async function callRemote(payloadText, aiSettings, apiKey, signal, systemPrompt, historyMsgs) {
  const base = String(aiSettings.baseUrl || '').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const messages = [
    { role: 'system', content: systemPrompt || SYSTEM_PROMPT },
    ...(Array.isArray(historyMsgs) ? historyMsgs.map((m) => ({ role: m.role, content: m.content })) : []),
    { role: 'user', content: payloadText },
  ];
  const body = {
    model: aiSettings.model,
    temperature: aiSettings.temperature ?? 0.2,
    messages,
  };
  // 优先要求结构化输出；部分服务不支持时会在下面兜底解析
  body.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), aiSettings.timeoutMs || 60000);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('请求超时或已取消');
    throw new Error('网络请求失败：' + e.message);
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    // response_format 不被支持时重试一次
    if (res.status === 400 && /response_format/i.test(detail)) {
      delete body.response_format;
      const res2 = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res2.ok) throw new Error(`AI 服务返回 ${res2.status}：${(await res2.text()).slice(0, 200)}`);
      return extract(await res2.json());
    }
    throw new Error(`AI 服务返回 ${res.status}：${friendlyHttp(res.status)} ${detail}`);
  }
  return extract(await res.json());
}

function friendlyHttp(code) {
  const m = {
    401: 'API Key 无效或未授权',
    403: '没有访问该模型的权限',
    404: '接口地址或模型名不存在',
    429: '请求过于频繁 / 额度不足',
    500: '服务端内部错误',
    502: '网关错误', 503: '服务暂不可用',
  };
  return m[code] || '';
}

function extract(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回内容为空');
  return { parsed: parseJsonLoose(content), usage: json.usage || null, raw: content };
}

function parseJsonLoose(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch { /* 继续尝试 */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* 继续 */ }
  }
  throw new Error('无法解析 AI 返回的 JSON：' + t.slice(0, 120));
}

function normalizeResult(parsed, extra = {}) {
  const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
  const catMap = { 用途: 'purpose', 项目: 'project', 内容类型: 'content', 状态: 'status' };
  return {
    summary: String(parsed.summary || '').trim(),
    tags: tags.map((t) => String(t).trim().replace(/[，。、,.\s]+/g, '')).filter(Boolean).slice(0, 8),
    category: catMap[String(parsed.category || '').trim()] || 'purpose',
    confidence: clamp01(parsed.confidence),
    reason: String(parsed.reason || '').trim(),
    ...extra,
  };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

// ---------------- 本地启发式（离线兜底） ----------------
const FOLDER_RULES = [
  { test: (p) => p.markers.some((m) => /项目|版本库|Git/.test(m)) && p.categories.some((c) => c.cat === 'code'),
    summary: (p) => `一个软件开发项目的代码文件夹，包含源代码与配置文件。`, tags: ['开发项目', '源代码', '工作'] },
  { test: (p) => topCat(p) === 'image' && p.fileCount >= 5,
    summary: (p) => `存放图片的文件夹，共有 ${p.fileCount} 个图片文件。`, tags: ['图片素材', '照片', '媒体'] },
  { test: (p) => topCat(p) === 'video',
    summary: (p) => `存放视频的文件夹，共有 ${p.fileCount} 个视频文件。`, tags: ['视频', '媒体'] },
  { test: (p) => topCat(p) === 'audio',
    summary: () => '存放音频或音乐文件的文件夹。', tags: ['音频', '音乐', '媒体'] },
  { test: (p) => topCat(p) === 'document' || topCat(p) === 'sheet' || topCat(p) === 'slide',
    summary: () => '存放办公文档的文件夹，包含文档、表格或演示文件。', tags: ['办公文档', '资料', '工作'] },
  { test: (p) => topCat(p) === 'archive',
    summary: () => '存放压缩包的文件夹，多为下载或备份内容。', tags: ['压缩包', '备份'] },
  { test: (p) => topCat(p) === 'executable',
    summary: () => '存放安装程序或可执行文件的文件夹。', tags: ['软件安装包', '程序'] },
  { test: (p) => topCat(p) === 'design',
    summary: () => '存放设计稿源文件的文件夹。', tags: ['设计稿', '素材'] },
  { test: (p) => p.dirCount > 0 && p.fileCount === 0,
    summary: (p) => `一个用于归类的上层目录，下面有 ${p.dirCount} 个子文件夹。`, tags: ['归档目录', '分类'] },
];

const FILE_RULES = [
  { test: (p) => p.cat === 'code',
    summary: (p) => `一个 ${p.ext ? '.' + p.ext : ''} 源代码/脚本文件，属于程序开发的一部分。`, tags: ['源代码', '程序开发', '工作'] },
  { test: (p) => p.cat === 'image',
    summary: (p) => `一个图片文件，大小 ${formatSize(p.size)}。`, tags: ['图片', '媒体', '素材'] },
  { test: (p) => p.cat === 'video',
    summary: (p) => `一个视频文件，大小 ${formatSize(p.size)}。`, tags: ['视频', '媒体'] },
  { test: (p) => p.cat === 'audio',
    summary: (p) => `一个音频或录音文件，大小 ${formatSize(p.size)}。`, tags: ['音频', '音乐', '媒体'] },
  { test: (p) => p.cat === 'document',
    summary: (p) => `一个文本文档，可能是报告、笔记或资料。`, tags: ['文档', '办公', '资料'] },
  { test: (p) => p.cat === 'sheet',
    summary: (p) => `一个表格文件，可能用于数据统计或记录。`, tags: ['表格', '数据', '办公'] },
  { test: (p) => p.cat === 'slide',
    summary: (p) => `一个演示文稿，可能用于汇报或展示。`, tags: ['演示', '汇报', '办公'] },
  { test: (p) => p.cat === 'archive',
    summary: (p) => `一个压缩包文件，常用于打包传输或备份。`, tags: ['压缩包', '备份'] },
  { test: (p) => p.cat === 'executable',
    summary: (p) => `一个可执行程序或安装包。`, tags: ['程序', '软件', '安装包'] },
  { test: (p) => p.cat === 'design',
    summary: (p) => `一个设计稿源文件。`, tags: ['设计稿', '素材'] },
  { test: (p) => p.cat === 'data',
    summary: (p) => `一个数据文件，可能用于程序或分析。`, tags: ['数据', '资料'] },
];

function topCat(p) {
  if (p.itemType === 'file') return p.cat || 'other';
  return p.categories?.[0]?.cat || 'other';
}

function heuristic(profile) {
  const isFile = profile.itemType === 'file';
  const rules = isFile ? FILE_RULES : FOLDER_RULES;
  for (const r of rules) {
    try {
      if (r.test(profile)) {
        return normalizeResult({
          summary: r.summary(profile),
          tags: r.tags,
          category: '用途',
          confidence: 0.45,
          reason: '本地规则依据文件类型推断（未使用 AI）',
        }, { source: 'local', model: '本地规则' });
      }
    } catch { /* 规则异常跳过 */ }
  }
  if (isFile) {
    return normalizeResult({
      summary: `一个 ${profile.ext ? '.' + profile.ext : ''} 文件，具体用途不明确。`,
      tags: ['待确认'],
      category: '状态',
      confidence: 0.2,
      reason: '信息不足，建议配置 AI 服务后重新生成',
    }, { source: 'local', model: '本地规则' });
  }
  return normalizeResult({
    summary: `包含 ${profile.dirCount} 个子文件夹、${profile.fileCount} 个文件的文件夹，用途不明确。`,
    tags: ['待确认'],
    category: '状态',
    confidence: 0.2,
    reason: '信息不足，建议配置 AI 服务后重新生成',
  }, { source: 'local', model: '本地规则' });
}

// ---------------- 审计日志 ----------------
async function appendAudit(entry) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
    await fsp.appendFile(files.auditLog(), line, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

async function readAudit(limit = 200) {
  try {
    const txt = await fsp.readFile(files.auditLog(), 'utf8');
    const lines = txt.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return { raw: l }; }
    });
  } catch {
    return [];
  }
}

async function clearAudit() {
  try { await fsp.writeFile(files.auditLog(), '', 'utf8'); } catch { /* ignore */ }
  return true;
}

// ---------------- 对外主入口 ----------------
/**
 * 为单个文件夹生成标签
 * @returns {Promise<{summary,tags,category,confidence,reason,source,model}>}
 */
async function analyze(profile, settings, apiKey, opts = {}) {
  const ai = settings.ai || {};
  const payloadText = buildPayload(profile, ai);

  if (!ai.enabled || !apiKey) {
    const r = heuristic(profile);
    if (settings.privacy?.auditLog) {
      await appendAudit({ folder: profile.name, mode: 'local', bytes: 0, model: '本地规则' });
    }
    return r;
  }

  const t0 = Date.now();
  try {
    const { parsed, usage } = await callRemote(payloadText, ai, apiKey, opts.signal);
    const result = normalizeResult(parsed, { source: 'remote', model: ai.model });
    if (settings.privacy?.auditLog) {
      await appendAudit({
        folder: ai.sendFullPath ? profile.fullPath : profile.name,
        mode: 'remote',
        endpoint: ai.baseUrl,
        model: ai.model,
        payloadChars: payloadText.length,
        sentFileNames: !!ai.sendFileNames,
        sentFullPath: !!ai.sendFullPath,
        sentFileContent: false,
        usage,
        ms: Date.now() - t0,
      });
    }
    return result;
  } catch (e) {
    if (opts.fallbackToLocal !== false) {
      const r = heuristic(profile);
      r.reason = `AI 调用失败（${e.message}），已回退到本地规则`;
      r.confidence = Math.min(r.confidence ?? 0.3, 0.3);
      if (settings.privacy?.auditLog) {
        await appendAudit({ folder: profile.name, mode: 'remote-failed', error: e.message });
      }
      return r;
    }
    throw e;
  }
}

/** 连通性测试 */
async function testConnection(settings, apiKey) {
  const ai = settings.ai || {};
  if (!apiKey) throw new Error('尚未填写 API Key');
  const base = String(ai.baseUrl || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: ai.model,
        messages: [{ role: 'user', content: '请只回复两个字：可用' }],
        max_tokens: 16,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const t = (await res.text()).slice(0, 200);
      throw new Error(`${res.status} ${friendlyHttp(res.status)} ${t}`);
    }
    const j = await res.json();
    return { ok: true, reply: j?.choices?.[0]?.message?.content || '', model: j.model || ai.model };
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? '连接超时' : e.message);
  }
}

/** 拉取模型列表（部分服务支持 /models） */
async function listModels(settings, apiKey) {
  const base = String(settings.ai?.baseUrl || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`获取模型列表失败：${res.status}`);
  const j = await res.json();
  const arr = j.data || j.models || [];
  return arr.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean).sort();
}

module.exports = {
  analyze, buildPayload, heuristic, testConnection, listModels,
  appendAudit, readAudit, clearAudit, formatSize, PROMPT_VERSION, SYSTEM_PROMPT,
  chat, localRetrieve, localAnswer, BUTLER_SYSTEM_PROMPT,
};
