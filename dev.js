const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WATCH_ROOT = __dirname;
const IGNORE_DIRS = new Set(['node_modules', '.git']);
const RESTART_DEBOUNCE_MS = 200;

let child = null;
let restartTimer = null;

function startServer() {
  child = spawn('node', ['server.js'], {
    cwd: WATCH_ROOT,
    stdio: 'inherit'
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      console.log(`server.js exited with code ${code}`);
    }
  });
}

function stopServer() {
  if (!child) return;
  child.kill();
  child = null;
}

function scheduleRestart() {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    stopServer();
    startServer();
  }, RESTART_DEBOUNCE_MS);
}

function shouldIgnore(filePath) {
  if (!filePath) return false;
  const parts = filePath.split(path.sep);
  return parts.some((part) => IGNORE_DIRS.has(part));
}

function watchTree(rootDir) {
  fs.watch(rootDir, { recursive: true }, (_event, filename) => {
    if (shouldIgnore(filename)) return;
    scheduleRestart();
  });
}

process.on('SIGINT', () => {
  stopServer();
  process.exit(0);
});

startServer();
watchTree(WATCH_ROOT);
