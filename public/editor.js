const MONACO_VERSION = '0.47.0';
const MONACO_LOADER = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs/loader.js`;
const MONACO_BASE = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min`;

const editorSurfaceEl = document.getElementById('editorSurface');
const editorShellEl = document.querySelector('.editor-shell');
const monacoHostEl = document.getElementById('codeEditor');

let monacoInstance = null;
let languageClient = null;
let socket = null;
let currentWorkspace = '';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function setMonacoEnvironment() {
  window.MonacoEnvironment = {
    getWorkerUrl: function (_moduleId, _label) {
      const workerMain = `${MONACO_BASE}/vs/base/worker/workerMain.js`;
      const baseUrl = `${MONACO_BASE}`;
      return `data:text/javascript;charset=utf-8,${encodeURIComponent(
        `self.MonacoEnvironment={baseUrl:'${baseUrl}'};importScripts('${workerMain}');`
      )}`;
    }
  };
}

function createWebSocketUrl(workspacePath) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams();
  if (workspacePath) {
    params.set('workspace', workspacePath);
  }
  return `${protocol}://${location.host}/lsp?${params.toString()}`;
}

function pathToUri(pathValue) {
  if (!pathValue) return null;
  if (pathValue.startsWith('~')) return null;
  const normalized = pathValue.replace(/\\/g, '/');
  const prefix = normalized.startsWith('/') ? 'file://' : 'file:///';
  return `${prefix}${encodeURI(normalized)}`;
}

async function startLanguageClient(workspacePath) {
  if (!monacoInstance) return;
  if (languageClient) {
    try {
      await languageClient.stop();
    } catch (_) {}
    languageClient = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
  currentWorkspace = workspacePath || '';

  const [{ listen }, { MonacoLanguageClient, CloseAction, ErrorAction }] = await Promise.all([
    import('https://esm.sh/vscode-ws-jsonrpc@3.2.0'),
    import('https://esm.sh/monaco-languageclient@7.0.1')
  ]);

  socket = new WebSocket(createWebSocketUrl(currentWorkspace));
  socket.addEventListener('error', (event) => {
    console.warn('LSP socket error', event);
  });

  listen({
    webSocket: socket,
    onConnection: (connection) => {
      const workspaceUri = pathToUri(currentWorkspace);
      const workspaceFolder = workspaceUri
        ? { uri: workspaceUri, name: currentWorkspace.split('/').pop() || 'workspace' }
        : null;
      languageClient = new MonacoLanguageClient({
        name: 'Python Language Client',
        clientOptions: {
          documentSelector: ['python'],
          workspaceFolder: workspaceFolder || undefined,
          errorHandler: {
            error: () => ErrorAction.Continue,
            closed: () => CloseAction.Restart
          }
        },
        connectionProvider: {
          get: () => Promise.resolve(connection)
        }
      });
      languageClient.start();
      connection.onClose(() => languageClient && languageClient.stop());
    }
  });
}

function getWorkspaceFromStorage() {
  try {
    return localStorage.getItem('anki-ide-workspace') || '';
  } catch (_) {
    return '';
  }
}

function createEditorAdapter(editor) {
  return {
    getValue: () => editor.getValue(),
    setValue: (value) => editor.setValue(value),
    onChange: (handler) => editor.onDidChangeModelContent(handler),
    onScroll: (handler) => editor.onDidScrollChange(handler),
    getScrollTop: () => editor.getScrollTop(),
    setScrollTop: (value) => editor.setScrollTop(value),
    focus: () => editor.focus(),
    setWorkspace: (pathValue) => startLanguageClient(pathValue)
  };
}

async function initMonaco() {
  if (!editorSurfaceEl || !monacoHostEl) return;
  try {
    setMonacoEnvironment();
    await loadScript(MONACO_LOADER);
    window.require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
    window.require(['vs/editor/editor.main'], () => {
      monacoInstance = window.monaco.editor.create(monacoHostEl, {
        language: 'python',
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: `'JetBrains Mono', 'SF Mono', 'Consolas', monospace`,
        fontSize: 13,
        lineHeight: 20
      });

      editorShellEl?.classList.add('monaco-ready');
      const adapter = createEditorAdapter(monacoInstance);
      const workspace = getWorkspaceFromStorage();
      if (workspace) {
        startLanguageClient(workspace);
      }

      window.dispatchEvent(new CustomEvent('editor:ready', { detail: { adapter } }));
    });
  } catch (error) {
    console.warn('Monaco failed to load, using fallback editor.', error);
  }
}

initMonaco();
