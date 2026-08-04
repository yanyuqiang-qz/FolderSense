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

const SYSTEM_PROMPT = `你是一个本地文件管理助手。用户会给你一个文件夹的「结构画像」（文件夹名称、子文件夹名、文件扩展名分布、文件数量、采样文件名等元数据，不含任何文件内容）。
请你推断这个文件夹的用途，并输出简体中文结果。

要求：
1. summary：一句话说明这个文件夹是做什么的，20~60 个汉字，面向不懂英文的普通用户，避免专业术语和英文缩写；如果必须提到英文名词，请在括号里加中文解释。
2. tags：3~6 个中文语义标签，每个 2~6 个字，用于分类检索。标签应覆盖「用途」「内容类型」「所属领域」等维度，不要重复，不要包含标点。
3. category：从 ["用途","项目","内容类型","状态"] 中选一个最贴切的。
4. confidence：0 到 1 的小数，表示你对这个判断的把握。信息不足时必须给低分（<0.5），不要编造。
5. reason：不超过 40 字，说明你的判断依据。

只输出 JSON，不要输出任何解释性文字或 Markdown 代码块。格式：
{"summary":"...","tags":["...","..."],"category":"...","confidence":0.8,"reason":"..."}`;

/** 把画像转成给模型看的紧凑文本（同时也是给用户看的"将要发送的数据"） */
function buildPayload(profile, aiSettings) {
  const lines = [];
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

// ---------------- 远程调用 ----------------
async function callRemote(payloadText, aiSettings, apiKey, signal) {
  const base = String(aiSettings.baseUrl || '').replace(/\/+$/, '');
  const url = `${base}/chat/completions`;
  const body = {
    model: aiSettings.model,
    temperature: aiSettings.temperature ?? 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: payloadText },
    ],
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
const RULES = [
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

function topCat(p) {
  return p.categories?.[0]?.cat || 'other';
}

function heuristic(profile) {
  for (const r of RULES) {
    try {
      if (r.test(profile)) {
        return normalizeResult({
          summary: r.summary(profile),
          tags: r.tags,
          category: '用途',
          confidence: 0.45,
          reason: '本地规则依据文件类型分布推断（未使用 AI）',
        }, { source: 'local', model: '本地规则' });
      }
    } catch { /* 规则异常跳过 */ }
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
};
