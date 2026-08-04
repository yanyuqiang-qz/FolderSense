'use strict';
const { app, BrowserWindow, shell, session } = require('electron');
const path = require('node:path');

const { initDataRoot } = require('./core/paths');
const { Settings } = require('./core/settings');
const { Library } = require('./core/library');
const { Indexer } = require('./core/indexer');
const { TagJobRunner } = require('./core/tagJob');
const { registerIpc } = require('./ipc');

const isDev = process.argv.includes('--dev');

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

async function bootstrap() {
  initDataRoot(app);

  ctx.settings = new Settings();
  await ctx.settings.init();

  ctx.library = new Library();
  await ctx.library.init();

  ctx.indexer = new Indexer();
  await ctx.indexer.init();
  ctx.indexer.onProgress = (p) => ctx.send('index:progress', p);

  ctx.jobs = new TagJobRunner({
    settingsRef: () => ctx.settings,
    library: ctx.library,
    send: ctx.send,
  });

  registerIpc(ctx, () => win);
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
  createWindow();

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
