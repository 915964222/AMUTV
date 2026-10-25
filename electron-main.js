/* 影视TV 桌面版(Electron 壳)
 * 启动内嵌服务器(复用本进程的 Node 运行时),打开电视风格窗口。
 * 测试: npx electron .
 */
const { app, BrowserWindow, Menu } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 9978;
let serverProc = null;
let win = null;

/* 错误落盘,便于诊断闪退 */
function logErr(msg) {
  try {
    fs.appendFileSync(path.join(__dirname, 'tvapp-error.log'),
      new Date().toISOString() + ' ' + msg + '\n');
  } catch {}
  console.log('[app] ' + msg);
}

process.on('uncaughtException', err => logErr('uncaughtException: ' + (err.stack || err)));
process.on('unhandledRejection', err => logErr('unhandledRejection: ' + err));

/* 视频解码/GPU 合成在某些显卡驱动上会导致 GPU 进程崩溃(表现为看着看着闪退),桌面播放用软解更稳 */
app.disableHardwareAcceleration();

function startServer() {
  // ELECTRON_RUN_AS_NODE:用 Electron 自带的 Node 跑 server.js,不依赖系统 Node
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  serverProc = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: 'pipe' });
  serverProc.stdout.on('data', d => process.stdout.write('[server] ' + d));
  serverProc.stderr.on('data', d => {
    process.stderr.write('[server] ' + d);
    const line = String(d);
    if (/error|exception|crash/i.test(line)) logErr('server stderr: ' + line.trim().slice(0, 200));
  });
  serverProc.on('exit', code => {
    console.log('[app] 内嵌服务器退出 code=' + code);
    // 服务器意外退出时自动拉起(窗口还在用)
    if (!win || !win.isDestroyed()) {
      logErr('server exited unexpectedly, respawning');
      setTimeout(startServer, 1000);
    }
  });
}

function waitServer(cb, tries = 40) {
  const http = require('http');
  const req = http.get(`http://localhost:${PORT}/`, res => { res.resume(); cb(); });
  req.on('error', () => {
    if (tries <= 0) { cb(); return; }
    setTimeout(() => waitServer(cb, tries - 1), 250);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#070b14',
    autoHideMenuBar: true,
    title: '影视TV',
    icon: path.join(__dirname, 'icons', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://localhost:${PORT}/`);
  win.webContents.on('did-finish-load', () => console.log('[app] ✔ UI 已加载 http://localhost:' + PORT));
  win.webContents.on('render-process-gone', (_e, d) => {
    logErr('渲染进程崩溃(' + d.reason + '),5秒后自动重载页面');
    setTimeout(() => { try { if (win && !win.isDestroyed()) win.loadURL(`http://localhost:${PORT}/`); } catch {} }, 5000);
  });
  win.on('closed', () => { win = null; });
  // F11 全屏(电视体验)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    }
  });
}

app.on('child-process-gone', (_e, details) => {
  logErr('child-process-gone: type=' + details.type + ' reason=' + details.reason + ' exitCode=' + details.exitCode);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  startServer();
  waitServer(() => {
    createWindow();
    console.log('[app] ✔ 桌面窗口已创建');
    if (process.env.SMOKE === '1') {
      // 冒烟模式:加载完成后自动退出(用于无界面测试)
      setTimeout(() => { console.log('[app] SMOKE OK'); app.quit(); }, 4000);
    }
  });
});

app.on('window-all-closed', () => {
  try { if (serverProc) serverProc.kill(); } catch {}
  app.quit();
});
