/**
 * 智能提醒通知：在关键事件发生时通过系统通知提醒用户
 * 使用 Electron Notification API
 */
const { Notification } = require('electron');

const NOTIF_TYPES = {
  scanComplete: 'scanComplete',       // 扫描完成
  largeFiles: 'largeFiles',           // 发现大文件
  staleFolder: 'staleFolder',         // 长时间未分析
  tagComplete: 'tagComplete',         // 批量打标签完成
  changeDetected: 'changeDetected',   // 磁盘内容明显变化
};

/** 默认配置（可被用户设置覆盖） */
const DEFAULTS = {
  [NOTIF_TYPES.scanComplete]: true,
  [NOTIF_TYPES.largeFiles]: true,
  [NOTIF_TYPES.staleFolder]: true,
  [NOTIF_TYPES.tagComplete]: true,
  [NOTIF_TYPES.changeDetected]: true,
};

class Notifier {
  constructor() {
    this.enabled = {};
    Object.assign(this.enabled, DEFAULTS);
  }

  /** 从设置加载偏好 */
  applySettings(notifSettings) {
    if (notifSettings && typeof notifSettings === 'object') {
      Object.assign(this.enabled, notifSettings);
    }
  }

  /** 当前偏好（供设置页保存） */
  getPrefs() {
    return { ...this.enabled };
  }

  /**
   * 发送系统通知
   * @param {string} type NOTIF_TYPES 之一
   * @param {string} title 标题
   * @param {string} body 内容
   */
  send(type, title, body) {
    if (!this.enabled[type]) return;
    try {
      const n = new Notification({
        title: `文件夹管家 · ${title}`,
        body,
        silent: false,
      });
      n.on('click', () => {
        // 点击通知时聚焦窗口（由主进程处理）
      });
      n.show();
    } catch (e) {
      console.warn('[Notifier] 发送通知失败:', e.message);
    }
  }

  // ---------- 便捷方法 ----------

  /** 扫描完成 */
  scanComplete(summary) {
    this.send(NOTIF_TYPES.scanComplete, '扫描完成',
      `共索引 ${summary?.total || 0} 个条目，${summary?.dirs || 0} 个文件夹。`);
  }

  /** 发现大文件 */
  largeFiles(dirName, files) {
    if (!files || !files.length) return;
    const names = files.slice(0, 3).map((f) => f.name).join('、');
    const more = files.length > 3 ? `等 ${files.length} 个` : '';
    this.send(NOTIF_TYPES.largeFiles, `${dirName} 中发现大文件`,
      `${names}${more} 超过 100MB，建议检查是否需要。`);
  }

  /** 批量打标签完成 */
  tagComplete(result) {
    this.send(NOTIF_TYPES.tagComplete, '批量打标签完成',
      `成功 ${result?.ok || 0}，失败 ${result?.failed || 0}。`);
  }

  /** 磁盘内容明显变化 */
  changeDetected(deltaBytes) {
    if (!deltaBytes) return;
    const sign = deltaBytes > 0 ? '增加了' : '减少了';
    const abs = U_size(Math.abs(deltaBytes));
    this.send(NOTIF_TYPES.changeDetected, '磁盘内容有变化',
      `自上次扫描以来，索引内容${sign}约 ${abs}。打开应用可查看详情。`);
  }
}

/** 轻量字节格式化（避免循环依赖，独立实现） */
function U_size(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

module.exports = new Notifier();
