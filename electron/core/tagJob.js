'use strict';
/**
 * 批量打标任务队列
 * - 可配置并发（默认 2，避免把 API 打爆）
 * - 支持中途取消
 * - 逐条向界面推送进度，失败不中断整体任务
 */
const scanner = require('./scanner');
const ai = require('./ai');

class TagJobRunner {
  constructor({ settingsRef, library, send }) {
    this.settingsRef = settingsRef;   // () => Settings 实例
    this.library = library;
    this.send = send;                 // (channel, payload) => void
    this.current = null;
  }

  isRunning() { return !!this.current; }

  status() {
    if (!this.current) return { running: false };
    const c = this.current;
    return {
      running: true,
      jobId: c.jobId,
      total: c.total,
      done: c.done,
      ok: c.ok,
      failed: c.failed,
      skipped: c.skipped,
      current: c.currentPath,
    };
  }

  cancel() {
    if (!this.current) return false;
    this.current.cancelled = true;
    this.current.abort.abort();
    return true;
  }

  /**
   * @param {string[]} paths
   * @param {{force?:boolean}} opts force=true 时对已有 AI 结果的文件夹也重新生成
   */
  async start(paths, opts = {}) {
    if (this.current) throw new Error('已有批量任务在执行中，请先等待或取消');
    const settingsMgr = this.settingsRef();
    const settings = settingsMgr.all();
    const apiKey = settingsMgr.getApiKey();

    const targets = [];
    for (const p of paths) {
      const norm = scanner.normalize(p);
      const existing = this.library.raw(norm);
      if (!opts.force && existing && existing.aiGeneratedAt) continue;
      targets.push(norm);
    }

    const jobId = 'job_' + Date.now();
    const job = {
      jobId,
      total: targets.length,
      done: 0, ok: 0, failed: 0,
      skipped: paths.length - targets.length,
      currentPath: '',
      cancelled: false,
      abort: new AbortController(),
      errors: [],
    };
    this.current = job;
    this.send('tag:progress', { ...this.status(), phase: 'start' });

    const concurrency = Math.max(1, Math.min(8, settings.ai?.concurrency || 2));
    const queue = targets.slice();

    const worker = async () => {
      while (queue.length && !job.cancelled) {
        const p = queue.shift();
        job.currentPath = p;
        try {
          const profile = await scanner.buildProfile(p, settings);
          const result = await ai.analyze(profile, settings, apiKey, { signal: job.abort.signal });
          let fp = null;
          try { fp = await scanner.computeFingerprint(p, settings); } catch { /* 忽略 */ }
          this.library.setAIResult(p, result, fp);
          job.ok++;
        } catch (e) {
          job.failed++;
          job.errors.push({ path: p, message: String(e.message || e) });
        }
        job.done++;
        this.send('tag:progress', { ...this.status(), phase: 'running' });
      }
    };

    const runners = Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, worker);
    Promise.all(runners).then(async () => {
      await this.library.flush();
      const final = {
        ...this.status(),
        phase: job.cancelled ? 'cancelled' : 'finished',
        errors: job.errors.slice(0, 20),
      };
      this.current = null;
      this.send('tag:progress', { ...final, running: false });
    }).catch((e) => {
      this.current = null;
      this.send('tag:progress', { running: false, phase: 'error', message: String(e.message || e) });
    });

    return { jobId, total: targets.length, skipped: job.skipped };
  }
}

module.exports = { TagJobRunner };
