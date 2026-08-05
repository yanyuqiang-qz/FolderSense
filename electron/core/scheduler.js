/**
 * 定时任务调度器：支持定时自动扫描
 * 使用 setTimeout 递归实现，退出时自动取消
 */
const scheduler = {
  timers: new Map(),
  /** @type {Map<string, {intervalMs:number, lastRunAt:number}>} */
  tasks: new Map(),

  /**
   * 注册一个定时任务
   * @param {string} id 任务 ID
   * @param {function} fn 要执行的异步函数
   * @param {number} intervalMs 间隔毫秒
   */
  schedule(id, fn, intervalMs) {
    this.cancel(id); // 避免重复
    if (intervalMs < 60000) intervalMs = 60000; // 最少 1 分钟

    const run = async () => {
      try { await fn(); } catch (e) { console.error(`[Scheduler] ${id} error:`, e.message); }
      const task = this.tasks.get(id);
      if (task) {
        task.lastRunAt = Date.now();
        this.timers.set(id, setTimeout(run, task.intervalMs));
      }
    };

    this.tasks.set(id, { intervalMs, lastRunAt: 0 });
    // 首次执行延迟 10 秒（等应用完全启动）
    this.timers.set(id, setTimeout(run, 10000));
  },

  /** 取消任务 */
  cancel(id) {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
    this.tasks.delete(id);
  },

  /** 取消所有任务 */
  cancelAll() {
    for (const id of this.timers.keys()) this.cancel(id);
  },

  /** 获取所有任务状态 */
  status() {
    const result = {};
    for (const [id, task] of this.tasks) {
      result[id] = { ...task, active: this.timers.has(id) };
    }
    return result;
  },
};

module.exports = scheduler;
