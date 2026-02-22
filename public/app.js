const deckListEl = document.getElementById('deckList');
const deckSearchEl = document.getElementById('deckSearch');
const deckListViewEl = document.getElementById('deckListView');
const deckDetailViewEl = document.getElementById('deckDetailView');
const deckBackBtn = document.getElementById('deckBackBtn');
const deckTitleEl = document.getElementById('deckTitle');
const deckBrowseSearchEl = document.getElementById('deckBrowseSearch');
const deckBrowseListEl = document.getElementById('deckBrowseList');
const ankiStatusEl = document.getElementById('ankiStatus');
const ankiDotEl = document.getElementById('ankiDot');
const refreshDecksBtn = document.getElementById('refreshDecks');

const workspacePathEl = document.getElementById('workspacePath');
const filePathEl = document.getElementById('filePath');
const runCmdEl = document.getElementById('runCmd');
const saveWorkspaceBtn = document.getElementById('saveWorkspace');
const loadFileBtn = document.getElementById('loadFile');
const saveFileBtn = document.getElementById('saveFile');
const runBtn = document.getElementById('runBtn');
const runOutputEl = document.getElementById('runOutput');
const runOutputPanelEl = document.getElementById('runOutputPanel');
const runOutputCloseBtn = document.getElementById('runOutputClose');
const workspaceBranchEl = document.getElementById('workspaceBranch');

const editorFallbackEl = document.getElementById('codeEditorFallback');
const gutterEl = document.getElementById('lineGutter');
const editorShellEl = document.querySelector('.editor-shell');

const terminalLogEl = document.getElementById('terminalLog');
const terminalPromptEl = document.getElementById('terminalPrompt');
const terminalSendBtn = document.getElementById('terminalSend');
const terminalModeEl = document.getElementById('terminalMode');
const debugToggleBtn = document.getElementById('debugToggle');
const terminalSpinnerEl = document.getElementById('terminalSpinner');
const appLayoutEl = document.querySelector('.app');
const workspacePaneEl = document.querySelector('.workspace');
const codexPaneEl = document.querySelector('.sidebar-right');

const STORAGE_KEYS = {
  workspace: 'anki-ide-workspace',
  filePath: 'anki-ide-filepath',
  runCmd: 'anki-ide-run-cmd',
  codeDraft: 'anki-ide-code-draft',
  terminalDebug: 'anki-ide-terminal-debug'
};

let decksCache = [];
let deckNotesCache = {};
let activeDeck = null;
let terminalDebugEnabled = false;
let terminalTurns = [];
let terminalTurnId = 0;
let editorAdapter = null;
let useCustomGutter = true;

function createFallbackEditorAdapter() {
  return {
    getValue: () => editorFallbackEl.value,
    setValue: (value) => {
      editorFallbackEl.value = value;
    },
    onChange: (handler) => editorFallbackEl.addEventListener('input', handler),
    onScroll: (handler) => editorFallbackEl.addEventListener('scroll', handler),
    getScrollTop: () => editorFallbackEl.scrollTop,
    setScrollTop: (value) => {
      editorFallbackEl.scrollTop = value;
    },
    focus: () => editorFallbackEl.focus(),
    setWorkspace: null
  };
}

function initializeEditorAdapter() {
  editorAdapter = createFallbackEditorAdapter();
  bindEditorEvents();
}

function setStatus(connected, message) {
  ankiStatusEl.textContent = message;
  if (connected) {
    ankiDotEl.classList.add('connected');
  } else {
    ankiDotEl.classList.remove('connected');
  }
}

function renderDecks(decks) {
  deckListEl.innerHTML = '';
  const fragment = document.createDocumentFragment();
  decks.forEach((deck) => {
    const li = document.createElement('li');
    li.textContent = deck;
    li.dataset.deck = deck;
    fragment.appendChild(li);
  });
  deckListEl.appendChild(fragment);
}

function filterDecks() {
  const query = deckSearchEl.value.toLowerCase().trim();
  if (!query) {
    renderDecks(decksCache);
    return;
  }
  const filtered = decksCache.filter((deck) => deck.toLowerCase().includes(query));
  renderDecks(filtered);
}

function showDeckListView() {
  deckDetailViewEl.classList.add('hidden');
  deckListViewEl.classList.remove('hidden');
  activeDeck = null;
}

function showDeckDetailView(deckName) {
  deckTitleEl.textContent = deckName;
  deckBrowseSearchEl.value = '';
  deckDetailViewEl.classList.remove('hidden');
  deckListViewEl.classList.add('hidden');
}

function buildNoteKey(note) {
  return note.fields.join(' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function fuzzyMatch(term, text) {
  if (!term) return true;
  let ti = 0;
  let si = 0;
  while (ti < term.length && si < text.length) {
    if (term[ti] === text[si]) {
      ti += 1;
    }
    si += 1;
  }
  return ti === term.length;
}

function renderBrowseList(notes, query) {
  deckBrowseListEl.innerHTML = '';
  const fragment = document.createDocumentFragment();
  const term = query.toLowerCase().replace(/\s+/g, '');
  const matches = notes
    .map((note) => ({
      note,
      key: buildNoteKey(note).toLowerCase()
    }))
    .filter(({ key }) => fuzzyMatch(term, key.replace(/\s+/g, '')))
    .slice(0, 120);

  if (!matches.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No matches.';
    fragment.appendChild(empty);
  } else {
    matches.forEach(({ note, key }) => {
      const li = document.createElement('li');
      li.textContent = key || '(empty note)';
      fragment.appendChild(li);
    });
  }

  deckBrowseListEl.appendChild(fragment);
}

async function loadDeckNotes(deckName) {
  if (deckNotesCache[deckName]) return deckNotesCache[deckName];
  deckBrowseListEl.innerHTML = '<li>Loading cards…</li>';
  try {
    const data = await postJson('/api/anki/notes/browse', { deck: deckName, limit: 500 });
    const notes = data.notes || [];
    deckNotesCache[deckName] = notes;
    return notes;
  } catch (err) {
    deckBrowseListEl.innerHTML = `<li>${err.message}</li>`;
    return [];
  }
}

async function openDeck(deckName) {
  activeDeck = deckName;
  showDeckDetailView(deckName);
  const notes = await loadDeckNotes(deckName);
  renderBrowseList(notes, '');
}

async function fetchDecks() {
  setStatus(false, 'connecting…');
  try {
    const response = await fetch('/api/anki/decks', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to load decks');
    }
    decksCache = data.decks || [];
    setStatus(true, `${decksCache.length} decks`);
    filterDecks();
  } catch (err) {
    setStatus(false, 'offline');
    deckListEl.innerHTML = '<li>Unable to reach AnkiConnect.</li>';
  }
}

function persistState() {
  localStorage.setItem(STORAGE_KEYS.workspace, workspacePathEl.value.trim());
  localStorage.setItem(STORAGE_KEYS.filePath, filePathEl.value.trim());
  localStorage.setItem(STORAGE_KEYS.runCmd, runCmdEl.value.trim());
  localStorage.setItem(STORAGE_KEYS.codeDraft, editorAdapter.getValue());
}

function restoreState() {
  const workspace = localStorage.getItem(STORAGE_KEYS.workspace) || '';
  const filePath = localStorage.getItem(STORAGE_KEYS.filePath) || '';
  const runCmd = localStorage.getItem(STORAGE_KEYS.runCmd) || '';
  const draft = localStorage.getItem(STORAGE_KEYS.codeDraft) || '';

  workspacePathEl.value = workspace;
  filePathEl.value = filePath;
  runCmdEl.value = runCmd;
  editorAdapter.setValue(draft);
  updateGutter();

  const debugState = localStorage.getItem(STORAGE_KEYS.terminalDebug);
  terminalDebugEnabled = debugState === 'on';
  applyTerminalDebugState();
}

function updateGutter() {
  if (!useCustomGutter) return;
  const lines = editorAdapter.getValue().split('\n').length || 1;
  let output = '';
  for (let i = 1; i <= lines; i += 1) {
    output += `${i}\n`;
  }
  gutterEl.textContent = output;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

async function loadFile() {
  const workspace = workspacePathEl.value.trim();
  const filePath = filePathEl.value.trim();
  if (!filePath) {
    runOutputEl.textContent = 'Enter a file path to load.';
    return;
  }
  try {
    const data = await postJson('/api/file/read', { path: filePath, cwd: workspace });
    editorAdapter.setValue(data.content || '');
    updateGutter();
    runOutputEl.textContent = `Loaded ${filePath}`;
    persistState();
  } catch (err) {
    runOutputEl.textContent = err.message;
  }
}

async function saveFile() {
  const workspace = workspacePathEl.value.trim();
  const filePath = filePathEl.value.trim();
  if (!filePath) {
    runOutputEl.textContent = 'Enter a file path to save.';
    return;
  }
  try {
    await postJson('/api/file/save', {
      path: filePath,
      cwd: workspace,
      content: editorAdapter.getValue()
    });
    runOutputEl.textContent = `Saved ${filePath}`;
    persistState();
  } catch (err) {
    runOutputEl.textContent = err.message;
  }
}

async function runCommand() {
  const workspace = workspacePathEl.value.trim();
  const cmd = runCmdEl.value.trim();
  if (!cmd) {
    runOutputEl.textContent = 'Enter a run command.';
    runOutputPanelEl.classList.remove('hidden');
    return;
  }
  runBtn.disabled = true;
  runOutputEl.textContent = 'Running…';
  runOutputPanelEl.classList.remove('hidden');
  try {
    const data = await postJson('/api/run', { cmd, cwd: workspace });
    const output = [data.stdout, data.stderr].filter(Boolean).join('\n');
    runOutputEl.textContent = output || 'Command completed with no output.';
    persistState();
  } catch (err) {
    runOutputEl.textContent = err.message;
  } finally {
    runBtn.disabled = false;
  }
}

async function refreshBranch() {
  const workspace = workspacePathEl.value.trim();
  if (!workspace) {
    workspaceBranchEl.textContent = 'branch: --';
    workspaceBranchEl.title = '';
    return;
  }
  try {
    const data = await postJson('/api/git/branch', { cwd: workspace });
    if (data.branch) {
      workspaceBranchEl.textContent = `branch: ${data.branch}`;
      workspaceBranchEl.title = '';
    } else if (data.error) {
      const message = data.error.length > 48 ? `${data.error.slice(0, 45)}…` : data.error;
      workspaceBranchEl.textContent = `branch: unavailable (${message})`;
      workspaceBranchEl.title = data.error;
    } else {
      workspaceBranchEl.textContent = 'branch: --';
      workspaceBranchEl.title = '';
    }
  } catch (err) {
    const message = err.message.length > 48 ? `${err.message.slice(0, 45)}…` : err.message;
    workspaceBranchEl.textContent = `branch: unavailable (${message})`;
    workspaceBranchEl.title = err.message;
  }
}

async function sendTerminal() {
  const prompt = terminalPromptEl.value.trim();
  if (!prompt) return;
  const mode = terminalModeEl.value;
  const workspace = workspacePathEl.value.trim();

  const turn = {
    id: (terminalTurnId += 1),
    prompt,
    final: null,
    debug: [],
    pending: true
  };
  terminalTurns.push(turn);
  renderTerminal();
  terminalPromptEl.value = '';
  setTerminalWorking(true);

  try {
    const endpoint = mode === 'codex' ? '/api/codex' : '/api/run';
    const payload = mode === 'codex' ? { prompt, cwd: workspace } : { cmd: prompt, cwd: workspace };
    const data = await postJson(endpoint, payload);
    const output = [data.stdout, data.stderr].filter(Boolean).join('\n');
    turn.final = output || 'Command completed with no output.';
    turn.debug = data.events || [];
  } catch (err) {
    turn.final = err.message;
  } finally {
    turn.pending = false;
    setTerminalWorking(false);
    renderTerminal();
  }
}

function formatCodexEvents(events) {
  const trimmed = events.slice(-12);
  const lines = trimmed.map((event) => `• ${event}`);
  const suffix = events.length > trimmed.length ? '\n• …' : '';
  return `Codex activity:\n${lines.join('\n')}${suffix}`;
}

function setTerminalWorking(isWorking) {
  terminalSendBtn.disabled = isWorking;
  terminalPromptEl.disabled = isWorking;
  terminalSpinnerEl.classList.toggle('active', isWorking);
}

function applyTerminalDebugState() {
  terminalLogEl.dataset.debug = terminalDebugEnabled ? 'on' : 'off';
  debugToggleBtn.textContent = terminalDebugEnabled ? 'Debug: on' : 'Debug: off';
  localStorage.setItem(STORAGE_KEYS.terminalDebug, terminalDebugEnabled ? 'on' : 'off');
  renderTerminal();
}

function renderTerminal() {
  terminalLogEl.innerHTML = '';
  const fragment = document.createDocumentFragment();
  terminalTurns.forEach((turn) => {
    fragment.appendChild(buildTerminalEntry('user', `> ${turn.prompt}`));
    if (terminalDebugEnabled && turn.debug && turn.debug.length) {
      fragment.appendChild(
        buildTerminalEntry('system', formatCodexEvents(turn.debug), { debug: true })
      );
    }
    if (turn.final) {
      fragment.appendChild(buildTerminalEntry('system', turn.final));
    }
  });
  terminalLogEl.appendChild(fragment);
  terminalLogEl.scrollTop = terminalLogEl.scrollHeight;
}

function buildTerminalEntry(kind, text, options = {}) {
  const entry = document.createElement('div');
  entry.className = `terminal-entry ${kind}`;
  if (options.debug) {
    entry.classList.add('debug');
  }
  entry.textContent = text;
  return entry;
}

function setCodexFocus(isFocused) {
  if (!appLayoutEl) return;
  appLayoutEl.classList.toggle('focus-codex', isFocused);
}

function bindEditorEvents() {
  editorAdapter.onChange(() => {
    updateGutter();
    persistState();
  });
  editorAdapter.onScroll(() => {
    gutterEl.scrollTop = editorAdapter.getScrollTop();
  });
}

saveWorkspaceBtn.addEventListener('click', persistState);
saveWorkspaceBtn.addEventListener('click', refreshBranch);
saveWorkspaceBtn.addEventListener('click', () => {
  if (editorAdapter.setWorkspace) {
    editorAdapter.setWorkspace(workspacePathEl.value.trim());
  }
});
loadFileBtn.addEventListener('click', loadFile);
saveFileBtn.addEventListener('click', saveFile);
runBtn.addEventListener('click', runCommand);
runOutputCloseBtn.addEventListener('click', () => {
  runOutputPanelEl.classList.add('hidden');
});
refreshDecksBtn.addEventListener('click', fetchDecks);

deckSearchEl.addEventListener('input', filterDecks);
deckListEl.addEventListener('click', (event) => {
  const item = event.target.closest('li');
  if (!item || !item.dataset.deck) return;
  openDeck(item.dataset.deck);
});

deckBackBtn.addEventListener('click', () => {
  showDeckListView();
});

deckBrowseSearchEl.addEventListener('input', () => {
  if (!activeDeck) return;
  const notes = deckNotesCache[activeDeck] || [];
  renderBrowseList(notes, deckBrowseSearchEl.value);
});

debugToggleBtn.addEventListener('click', () => {
  terminalDebugEnabled = !terminalDebugEnabled;
  applyTerminalDebugState();
});

terminalSendBtn.addEventListener('click', sendTerminal);
terminalPromptEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    sendTerminal();
  }
});

if (codexPaneEl) {
  codexPaneEl.addEventListener('focusin', () => setCodexFocus(true));
  codexPaneEl.addEventListener('click', () => setCodexFocus(true));
}

if (workspacePaneEl) {
  workspacePaneEl.addEventListener('focusin', () => setCodexFocus(false));
  workspacePaneEl.addEventListener('click', () => setCodexFocus(false));
}

window.addEventListener('editor:ready', (event) => {
  if (!event.detail || !event.detail.adapter) return;
  editorAdapter = event.detail.adapter;
  useCustomGutter = false;
  editorShellEl?.classList.add('monaco-ready');
  bindEditorEvents();
  updateGutter();
  if (editorAdapter.setWorkspace) {
    editorAdapter.setWorkspace(workspacePathEl.value.trim());
  }
});

initializeEditorAdapter();
restoreState();
fetchDecks();
refreshBranch();
showDeckListView();
