'use strict';
const { app, BrowserWindow, shell, session } = require('electron');
const path = require('node:path');

const { initDataRoot } = require('./core/paths');
const { Settings } = require('./core/settings');
const { Library } = require('./core/library');
const { Indexer } = require('./core/indexer');
const { TagJobRunner } = require('./core/tagJob');
const { registerIpc } = require('./ipc');
const notifier = require('./core/notifier');
const scheduler = require('./core/scheduler');

let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch { /* 开发模式或依赖缺失时跳过 */ }

const isDev = process.argv.includes('--dev');

// 支持命令行参数：FolderSense.exe analyze "C:\path" 直接打开指定路径
const CLI_ARGS = process.argv.slice(1).filter((a) => !a.startsWith('--'));
/** @type {string|null} 要在窗口就绪后打开的路径 */
let cliOpenPath = null;
for (const arg of CLI_ARGS) {
  // 跳过非路径参数
  if (arg === 'analyze' || arg === 'scan') continue;
  const fs = require('fs');
  try { if (fs.statSync(arg)?.isDirectory()) { cliOpenPath = arg; break; } } catch { /* not a path */ }
}

/** @type {BrowserWindow|null} */
let win = null;
const ctx = {
  settings: null,
  library: null,
  indexer: null,
  jobs: null,
  send: (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  },
};

// 单实例：避免两个进程同时写同一份数据文件
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/**
 * 根据设置启动/停止定时扫描任务
 */
function applySchedulerSettings(sched) {
  if (!sched || !sched.enabled) { scheduler.cancelAll(); return; }
  const intervalMs = (sched.intervalHours || 24) * 3600000;
  scheduler.schedule('auto-scan', async () => {
    const roots = ctx.settings.all().scan?.roots;
    if (!roots || !roots.length || ctx.indexer?.isScanning) return;
    console.log('[Scheduler] 开始定时自动扫描');
    const r = ctx.indexer.startScan(roots, ctx.settings.all().scan);
    if (r.ok) notifier.scanComplete({ mode: 'scheduled' });
  }, intervalMs);
}

/**
 * 自动更新：发布模式下检查 GitHub Release 并更新
 */
function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return; // 开发模式跳过
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => {
    notifier.send('appUpdate', '有可用更新', `FolderSense ${info?.version || ''} 已发布，将在后台下载，退出时自动安装。`);
  });
  autoUpdater.on('update-downloaded', () => {
    notifier.send('appUpdate', '更新已就绪', '重启 FolderSense 即可完成更新。');
  });
  autoUpdater.on('error', (e) => console.warn('[updater]', e && e.message));
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

async function bootstrap() {
  initDataRoot(app);

  ctx.settings = new Settings();
  await ctx.settings.init();

  ctx.library = new Library();
  await ctx.library.init();

  ctx.indexer = new Indexer();
  await ctx.indexer.init();
  ctx.indexer.onProgress = (p) => {
    ctx.send('index:progress', p);
    // 扫描完成时发通知
    if (p.type === 'finished') {
      notifier.scanComplete(p.summary);
      // 磁盘内容明显变化才提醒（阈值：>2GB 或相对变化 >10%）
      const d = p.deltaBytes || 0;
      const prev = p.prevTotalSize || 0;
      const rel = prev ? Math.abs(d) / prev : 1;
      if (Math.abs(d) > 2 * 1024 ** 3 || rel > 0.1) notifier.changeDetected(d);
    }
  };

  ctx.jobs = new TagJobRunner({
    settingsRef: () => ctx.settings,
    library: ctx.library,
    send: ctx.send,
  });

  registerIpc(ctx, () => win);

  // 监听设置页对定时任务的变更
  const { ipcMain } = require('electron');
  ipcMain.on('scheduler:settings-changed', (_e, config) => applySchedulerSettings(config));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#14171c',
    title: '文件夹管家 FolderSense',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要 require ipcRenderer 之外无 Node 能力；渲染层依旧无 Node
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
    // 处理命令行参数：打开指定路径
    if (cliOpenPath) {
      win.webContents.send('cli:openPath', cliOpenPath);
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 安全：禁止渲染层跳转到外部页面 / 开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  // 关掉一切可能的权限请求（本应用不需要摄像头/麦克风/定位等）
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  await bootstrap();
  notifier.applySettings(ctx.settings.all().notifications);
  // 启动定时自动扫描任务
  applySchedulerSettings(ctx.settings.all().scheduler);
  createWindow();
  // 检查自动更新（仅发布模式）
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let flushed = false;
app.on('before-quit', async (e) => {
  if (flushed) return;
  e.preventDefault();
  try {
    ctx.indexer?.cancelScan();
    scheduler.cancelAll();
    await Promise.all([
      ctx.settings?.flush(),
      ctx.library?.flush(),
      ctx.indexer?.flush(),
    ]);
  } catch (err) {
    console.error('[quit] 数据落盘失败', err);
  }
  flushed = true;
  app.quit();
});

process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
});
