const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = process.env.PORT || 5179;
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || process.cwd();
const ALLOW_OUTSIDE_WORKSPACE = process.env.ALLOW_OUTSIDE_WORKSPACE === '1';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function notFound(res) {
  sendText(res, 404, 'Not found');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10_000_000) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function safeResolve(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, targetPath);
  if (ALLOW_OUTSIDE_WORKSPACE) {
    return resolvedTarget;
  }
  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new Error('Path escapes workspace root');
  }
  return resolvedTarget;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function resolveWorkspaceCwd(inputCwd) {
  const expanded = expandHome(inputCwd || WORKSPACE_ROOT);
  return safeResolve(WORKSPACE_ROOT, expanded);
}

function runShellCommand(cmd, cwd) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === 'number' ? error.code : 0;
      const signal = error && error.signal ? error.signal : null;
      resolve({
        stdout: stdout || '',
        stderr: stderr || (error ? String(error.message || '') : ''),
        code,
        signal
      });
    });
  });
}

async function callAnkiConnect(action, params = {}) {
  const response = await fetch('http://127.0.0.1:8765', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, version: 6, params })
  });
  if (!response.ok) {
    throw new Error(`AnkiConnect HTTP ${response.status}`);
  }
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }
  return data.result;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
const OPENAI_TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
const OPENAI_CARD_MODEL = process.env.OPENAI_CARD_MODEL || 'gpt-4o-mini';
const VOICE_POC_MAX_AUDIO_BYTES = Number(process.env.VOICE_POC_MAX_AUDIO_BYTES || 8_000_000);
const voicePocFeedback = [];

function requireOpenAIKey() {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set on the server');
  }
}

function parseDataUrlBase64(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('audioBase64 is required');
  }
  const dataUrlMatch = input.match(/^data:([^,]*?),(.+)$/);
  if (dataUrlMatch) {
    const meta = dataUrlMatch[1] || '';
    const payload = dataUrlMatch[2] || '';
    if (!/;base64(?:;|$)/i.test(meta)) {
      throw new Error('Audio data URL must be base64-encoded');
    }
    const mimeType = (meta.split(';')[0] || '').trim() || null;
    return { mimeType, base64: payload };
  }
  return { mimeType: null, base64: input };
}

function decodeBase64Audio(input, fallbackMimeType) {
  const { mimeType, base64 } = parseDataUrlBase64(input);
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) {
    throw new Error('Audio payload is empty');
  }
  if (bytes.length > VOICE_POC_MAX_AUDIO_BYTES) {
    throw new Error(`Audio payload too large (${bytes.length} bytes)`);
  }
  return {
    bytes,
    mimeType: mimeType || fallbackMimeType || 'audio/webm'
  };
}

function extForMimeType(mimeType) {
  const clean = String(mimeType || '').toLowerCase();
  if (clean.includes('wav')) return 'wav';
  if (clean.includes('mpeg') || clean.includes('mp3')) return 'mp3';
  if (clean.includes('mp4') || clean.includes('m4a')) return 'm4a';
  if (clean.includes('ogg')) return 'ogg';
  if (clean.includes('webm')) return 'webm';
  return 'bin';
}

function normalizeMimeType(mimeType) {
  const raw = String(mimeType || '').trim().toLowerCase();
  if (!raw) return 'audio/webm';
  const base = raw.split(';')[0].trim();
  return base || 'audio/webm';
}

async function callOpenAITranscription({ audioBase64, mimeType, language, prompt }) {
  requireOpenAIKey();
  const decoded = decodeBase64Audio(audioBase64, mimeType);
  const normalizedMimeType = normalizeMimeType(decoded.mimeType);
  const form = new FormData();
  const ext = extForMimeType(normalizedMimeType);
  const filename = `clip.${ext}`;
  form.append('model', OPENAI_TRANSCRIBE_MODEL);
  if (language) form.append('language', String(language));
  if (prompt) form.append('prompt', String(prompt));
  form.append('file', new Blob([decoded.bytes], { type: normalizedMimeType }), filename);

  const response = await fetch(`${OPENAI_API_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    throw new Error(`Transcription response parse failed: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI transcription HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

function buildCardPrompt({ transcript, n = 1, style = 'mixed' }) {
  return [
    'You generate high-quality Anki cards from user transcripts.',
    'Return strictly valid JSON matching this shape:',
    '{"cards":[{"candidate_id":"string","card_type":"basic|cloze","front":"string|null","back":"string|null","cloze_text":"string|null","rationale":"string","tags":["string"]}]}',
    'Rules:',
    '- Preserve factual fidelity to the transcript. Do not invent facts.',
    '- Prefer atomic, unambiguous cards.',
    '- Keep answers concise.',
    '- Use cloze only when it improves recall testing.',
    `- Generate exactly ${Math.max(1, Math.min(10, Number(n) || 1))} candidates.`,
    `- Preferred style: ${style}.`,
    '- If card_type is "basic", set cloze_text to null and fill front/back.',
    '- If card_type is "cloze", set front/back to null and fill cloze_text.',
    '',
    'Transcript:',
    transcript
  ].join('\n');
}

function normalizeCardCandidates(parsed, requestedN) {
  const cards = Array.isArray(parsed?.cards) ? parsed.cards : [];
  const safe = cards
    .slice(0, Math.max(1, Math.min(10, Number(requestedN) || 1)))
    .map((card, index) => ({
      candidate_id: String(card.candidate_id || `cand_${index + 1}`),
      card_type: card.card_type === 'cloze' ? 'cloze' : 'basic',
      front: card.front == null ? null : String(card.front),
      back: card.back == null ? null : String(card.back),
      cloze_text: card.cloze_text == null ? null : String(card.cloze_text),
      rationale: String(card.rationale || ''),
      tags: Array.isArray(card.tags) ? card.tags.map((t) => String(t)).slice(0, 12) : []
    }))
    .filter((card) => {
      if (card.card_type === 'cloze') return Boolean(card.cloze_text);
      return Boolean(card.front && card.back);
    });
  if (!safe.length) {
    throw new Error('Model returned no valid card candidates');
  }
  return safe;
}

async function generateAnkiCards({ transcript, n, style }) {
  requireOpenAIKey();
  if (!transcript || !String(transcript).trim()) {
    throw new Error('transcript is required');
  }

  const response = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_CARD_MODEL,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are an expert Anki card writer. Return only JSON. Never include markdown fences or commentary.'
        },
        {
          role: 'user',
          content: buildCardPrompt({ transcript: String(transcript), n, style })
        }
      ]
    })
  });

  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (_) {
    throw new Error(`Card generation response parse failed: ${rawText.slice(0, 300)}`);
  }
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI card generation HTTP ${response.status}`;
    throw new Error(message);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Card generation returned empty content');
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Card JSON parse failed: ${String(content).slice(0, 300)}`);
  }
  const cards = normalizeCardCandidates(parsed, n);
  return {
    cards,
    model: OPENAI_CARD_MODEL
  };
}

const CODEX_INIT_TIMEOUT_MS = Number(process.env.CODEX_INIT_TIMEOUT_MS || 30_000);
const CODEX_RPC_TIMEOUT_MS = Number(process.env.CODEX_RPC_TIMEOUT_MS || 10_000);
const CODEX_LOGIN_TIMEOUT_MS = Number(process.env.CODEX_LOGIN_TIMEOUT_MS || 30_000);
const CODEX_TURN_TIMEOUT_MS = Number(process.env.CODEX_TURN_TIMEOUT_MS || 1_200_000);
const PATH_FALLBACK = [
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
].join(':');

const CODEX_SANDBOX = process.env.CODEX_SANDBOX || 'workspace-write';
const CODEX_APPROVAL_POLICY = process.env.CODEX_APPROVAL_POLICY || 'never';
const DEFAULT_CODEX_CONTEXT_PATH = path.join(
  os.homedir(),
  'code',
  'alt2',
  'openai',
  'personal',
  'morgan',
  'anki',
  'anki-card-spec.md'
);
const CODEX_CONTEXT_PATH = process.env.CODEX_CONTEXT_PATH || DEFAULT_CODEX_CONTEXT_PATH;
const CODEX_CONTEXT_TEXT = process.env.CODEX_CONTEXT_TEXT || '';
let codexContextWarningLogged = false;
const CODEX_DEBUG = process.env.CODEX_DEBUG === '1';
const CODEX_SYSTEM_MESSAGE =
  process.env.CODEX_SYSTEM_MESSAGE ||
  [
    'You are Codex running inside Anki IDE.',
    'Behave normally and answer user prompts.',
    'If the user asks about Anki, Anki cards, or AnkiConnect, follow the Anki Card Spec and include the connection steps:',
    '- Anki app running, AnkiConnect installed/enabled.',
    '- AnkiConnect uses http://127.0.0.1:8765 with JSON POST.',
    '- Use AnkiConnect API actions (e.g., deckNames, findNotes, notesInfo) rather than direct DB writes.'
  ].join('\n');

class CodexAppServer {
  constructor() {
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.threadByCwd = new Map();
    this.seededThreads = new Set();
    this.currentTurn = null;
    this.starting = null;
    this.startupStderr = '';
    this.loginWaiter = null;
  }

  async ensureStarted() {
    if (this.proc && !this.proc.killed) {
      return;
    }
    if (this.starting) {
      await this.starting;
      return;
    }
    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      const child = spawn('codex', ['app-server'], {
        env: {
          ...process.env,
          PATH: `${PATH_FALLBACK}:${process.env.PATH || ''}`
        },
        stdio: ['pipe', 'pipe', 'pipe']
      });

      child.once('error', (error) => {
        reject(error);
      });

      child.once('spawn', async () => {
        this.proc = child;
        this.rl = readline.createInterface({ input: child.stdout });
        this.rl.on('line', (line) => this.handleLine(line));
        child.stderr.on('data', (chunk) => {
          const message = chunk.toString();
          this.startupStderr += message;
          if (this.currentTurn) {
            this.currentTurn.stderr += message;
          }
        });
        child.on('close', () => this.reset());

        try {
          await this.sendRpc(
            'initialize',
            {
              clientInfo: {
                name: 'anki_ide',
                title: 'Anki IDE',
                version: '0.1.0'
              }
            },
            CODEX_INIT_TIMEOUT_MS
          );
          this.sendNotification('initialized', {});
          await this.ensureLoggedIn();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  reset() {
    this.proc = null;
    if (this.rl) {
      this.rl.close();
    }
    this.rl = null;
    this.startupStderr = '';
    this.threadByCwd.clear();
    this.seededThreads.clear();
    const pending = [...this.pending.values()];
    this.pending.clear();
    pending.forEach(({ reject }) => reject(new Error('Codex app-server exited.')));
    if (this.currentTurn) {
      this.currentTurn.reject(new Error('Codex app-server exited.'));
      this.currentTurn = null;
    }
    if (this.loginWaiter) {
      this.loginWaiter.reject(new Error('Codex app-server exited.'));
      this.loginWaiter = null;
    }
  }

  write(message) {
    if (!this.proc || !this.proc.stdin) {
      throw new Error('Codex app-server not running.');
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendNotification(method, params) {
    this.write({ method, params });
  }

  sendRpc(method, params, timeoutMs = CODEX_RPC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        if (method === 'initialize' && this.startupStderr.trim()) {
          reject(
            new Error(
              `Codex app-server timeout on ${method}. Stderr: ${this.startupStderr.trim()}`
            )
          );
          return;
        }
        reject(new Error(`Codex app-server timeout on ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });
      this.write({ method, id, params });
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || 'Codex error'));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    if (message.method) {
      this.handleNotification(message.method, message.params || {});
    }
  }

  handleNotification(method, params) {
    if (method === 'account/login/completed' && this.loginWaiter) {
      const { resolve, reject } = this.loginWaiter;
      this.loginWaiter = null;
      if (params.success) {
        resolve(params);
      } else {
        reject(new Error(params.error || 'Codex login failed.'));
      }
      return;
    }

    if (!this.currentTurn) return;
    const summary = summarizeCodexNotification(method, params);
    if (summary) {
      this.currentTurn.events.push(summary);
      if (CODEX_DEBUG) {
        console.log(`[codex] ${summary}`);
      }
    }
    const turnId = params.turnId || params.turn?.id || params.turn_id;
    if (turnId && this.currentTurn.turnId && turnId !== this.currentTurn.turnId) {
      return;
    }
    if (method === 'turn/completed') {
      this.finishTurn();
      return;
    }
    if (method.startsWith('item/')) {
      const text = extractTextFromParams(params);
      if (text) {
        this.currentTurn.stdout += text;
      }
    }
  }

  finishTurn() {
    if (!this.currentTurn) return;
    const { resolve, stdout, stderr, events } = this.currentTurn;
    this.currentTurn = null;
    resolve({ stdout: stdout.trim(), stderr: stderr.trim(), events });
  }

  async getThreadId(cwd) {
    const cached = this.threadByCwd.get(cwd);
    if (cached) return cached;
    const result = await this.sendRpc('thread/start', {
      cwd,
      approvalPolicy: CODEX_APPROVAL_POLICY,
      sandbox: CODEX_SANDBOX
    });
    const threadId = result.thread?.id;
    if (!threadId) {
      throw new Error('Codex app-server did not return a thread id.');
    }
    this.threadByCwd.set(cwd, threadId);
    return threadId;
  }

  async runTurn(prompt, cwd) {
    await this.ensureStarted();
    const threadId = await this.getThreadId(cwd);
    const input = this.buildTurnInput(prompt, threadId);
    const result = await this.sendRpc('turn/start', {
      threadId,
      input
    });
    const turnId = result.turn?.id || null;
    if (this.currentTurn) {
      throw new Error('Codex turn already in progress.');
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.currentTurn) {
          const error = new Error('Codex turn timed out.');
          error.events = this.currentTurn.events || [];
          this.currentTurn = null;
          reject(error);
          return;
        }
        reject(new Error('Codex turn timed out.'));
      }, CODEX_TURN_TIMEOUT_MS);
      this.currentTurn = {
        turnId,
        stdout: '',
        stderr: '',
        events: [],
        resolve: (payload) => {
          clearTimeout(timeout);
          resolve(payload);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      };
    });
  }

  buildTurnInput(prompt, threadId) {
    const items = [];
    const context = readCodexContext();
    if (!this.seededThreads.has(threadId)) {
      const seedParts = [CODEX_SYSTEM_MESSAGE.trim()];
      if (context) {
        seedParts.push(`Anki Card Spec (follow strictly):\n${context}`);
      }
      items.push({
        type: 'text',
        text: seedParts.join('\n\n')
      });
      this.seededThreads.add(threadId);
    }
    items.push({ type: 'text', text: prompt });
    return items;
  }

  async ensureLoggedIn() {
    const authInfo = await this.sendRpc(
      'account/read',
      { refreshToken: false },
      CODEX_LOGIN_TIMEOUT_MS
    );
    if (!authInfo.requiresOpenaiAuth) {
      return;
    }
    if (authInfo.account) {
      return;
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY is not set. Codex app-server requires authentication.'
      );
    }
    await this.sendRpc(
      'account/login/start',
      { type: 'apiKey', apiKey },
      CODEX_LOGIN_TIMEOUT_MS
    );
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.loginWaiter) {
          this.loginWaiter = null;
        }
        reject(new Error('Codex login timed out.'));
      }, CODEX_LOGIN_TIMEOUT_MS);
      this.loginWaiter = {
        resolve: (params) => {
          clearTimeout(timeout);
          resolve(params);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      };
    });
  }
}

function extractTextFromParams(params) {
  if (!params) return '';
  if (params.delta && typeof params.delta.text === 'string') {
    return params.delta.text;
  }
  const item = params.item;
  if (!item) return '';
  if (typeof item.text === 'string') return item.text;
  if (Array.isArray(item.content)) {
    return item.content
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text || '')
      .join('');
  }
  return '';
}

function summarizeCodexNotification(method, params) {
  if (method === 'turn/completed') {
    return 'turn/completed';
  }
  if (method.startsWith('item/')) {
    const text = extractTextFromParams(params);
    if (text) {
      const snippet = text.replace(/\s+/g, ' ').trim();
      return `item: ${snippet.length > 120 ? `${snippet.slice(0, 117)}…` : snippet}`;
    }
    return 'item: (non-text)';
  }
  if (method.startsWith('tool/')) {
    const name = params?.tool?.name || params?.name || 'tool';
    return `${method} ${name}`.trim();
  }
  if (method.startsWith('thread/')) {
    return method;
  }
  return null;
}

function readCodexContext() {
  if (CODEX_CONTEXT_TEXT.trim()) {
    return CODEX_CONTEXT_TEXT.trim();
  }
  if (!CODEX_CONTEXT_PATH) return '';
  const resolvedPath = expandHome(CODEX_CONTEXT_PATH);
  try {
    const text = fs.readFileSync(resolvedPath, 'utf8').trim();
    return text;
  } catch (error) {
    if (!codexContextWarningLogged) {
      console.warn(`Codex context file not found: ${resolvedPath}`);
      codexContextWarningLogged = true;
    }
    return '';
  }
}

const codexApp = new CodexAppServer();
let codexQueue = Promise.resolve();

async function sendCodexPrompt(prompt, cwd) {
  codexQueue = codexQueue
    .then(() => codexApp.runTurn(prompt, cwd))
    .catch((error) => {
      codexQueue = Promise.resolve();
      return {
        stdout: '',
        stderr: error.message || String(error),
        events: error.events || []
      };
    });
  return codexQueue;
}

function serveStatic(req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let filePath = reqUrl.pathname;
  if (filePath === '/') {
    filePath = '/index.html';
  }
  const fullPath = path.join(PUBLIC_DIR, filePath);
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    notFound(res);
    return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      notFound(res);
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleApi(req, res) {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && reqUrl.pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        workspaceRoot: WORKSPACE_ROOT,
        allowOutsideWorkspace: ALLOW_OUTSIDE_WORKSPACE
      });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    const body = await parseBody(req);

    if (reqUrl.pathname === '/api/anki/decks') {
      const decks = await callAnkiConnect('deckNames');
      sendJson(res, 200, { decks });
      return;
    }

    if (reqUrl.pathname === '/api/anki/notes/browse') {
      const deck = body.deck;
      const limit = Number(body.limit || 300);
      if (!deck) {
        sendJson(res, 400, { error: 'deck is required' });
        return;
      }
      const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 300;
      const query = `deck:\"${String(deck).replace(/\"/g, '\\"')}\"`;
      const noteIds = await callAnkiConnect('findNotes', { query });
      const limitedIds = noteIds.slice(0, safeLimit);
      const notes = limitedIds.length
        ? await callAnkiConnect('notesInfo', { notes: limitedIds })
        : [];
      const formatted = (notes || []).map((note) => ({
        id: note.noteId,
        model: note.modelName,
        fields: Object.values(note.fields || {}).map((field) => field.value || '')
      }));
      sendJson(res, 200, { notes: formatted, total: noteIds.length });
      return;
    }

    if (reqUrl.pathname === '/api/voice/transcribe') {
      const audioBase64 = body.audioBase64;
      const mimeType = body.mimeType;
      const language = body.language;
      const prompt = body.prompt;
      if (!audioBase64) {
        sendJson(res, 400, { error: 'audioBase64 is required' });
        return;
      }
      const result = await callOpenAITranscription({ audioBase64, mimeType, language, prompt });
      sendJson(res, 200, {
        clipId: `clip_${crypto.randomUUID()}`,
        transcript: String(result.text || ''),
        model: OPENAI_TRANSCRIBE_MODEL
      });
      return;
    }

    if (reqUrl.pathname === '/api/voice/cards/generate') {
      const transcript = body.transcript;
      const n = body.n;
      const style = body.style;
      const generated = await generateAnkiCards({ transcript, n, style });
      sendJson(res, 200, generated);
      return;
    }

    if (reqUrl.pathname === '/api/voice/feedback') {
      const item = {
        id: `fb_${crypto.randomUUID()}`,
        clipId: body.clipId ? String(body.clipId) : null,
        transcript: body.transcript ? String(body.transcript) : '',
        chosenCandidateId: body.chosenCandidateId ? String(body.chosenCandidateId) : null,
        chosenCard: body.chosenCard || null,
        allCandidates: Array.isArray(body.allCandidates) ? body.allCandidates : [],
        userReason: body.userReason ? String(body.userReason) : '',
        createdAt: new Date().toISOString()
      };
      if (!item.chosenCandidateId || !item.chosenCard) {
        sendJson(res, 400, { error: 'chosenCandidateId and chosenCard are required' });
        return;
      }
      voicePocFeedback.push(item);
      if (voicePocFeedback.length > 200) {
        voicePocFeedback.shift();
      }
      sendJson(res, 200, { ok: true, feedbackId: item.id, count: voicePocFeedback.length });
      return;
    }

    if (reqUrl.pathname === '/api/run') {
      const cmd = body.cmd;
      const cwd = body.cwd || WORKSPACE_ROOT;
      if (!cmd) {
        sendJson(res, 400, { error: 'cmd is required' });
        return;
      }
      const resolvedCwd = resolveWorkspaceCwd(cwd);
      const result = await runShellCommand(cmd, resolvedCwd);
      sendJson(res, 200, result);
      return;
    }

    if (reqUrl.pathname === '/api/git/branch') {
      const cwd = body.cwd || WORKSPACE_ROOT;
      const resolvedCwd = resolveWorkspaceCwd(cwd);
      const result = await runShellCommand('git rev-parse --abbrev-ref HEAD', resolvedCwd);
      if (result.code !== 0) {
        sendJson(res, 200, {
          branch: null,
          error: result.stderr.trim() || 'Not a git repository'
        });
        return;
      }
      sendJson(res, 200, { branch: result.stdout.trim() });
      return;
    }

    if (reqUrl.pathname === '/api/codex') {
      const prompt = body.prompt;
      const cwd = body.cwd || WORKSPACE_ROOT;
      if (!prompt) {
        sendJson(res, 400, { error: 'prompt is required' });
        return;
      }
      const resolvedCwd = resolveWorkspaceCwd(cwd);
      const result = await sendCodexPrompt(prompt, resolvedCwd);
      sendJson(res, 200, { ...result, code: 0, signal: null });
      return;
    }

    if (reqUrl.pathname === '/api/file/read') {
      const filePath = body.path;
      const cwd = body.cwd || WORKSPACE_ROOT;
      if (!filePath) {
        sendJson(res, 400, { error: 'path is required' });
        return;
      }
      const resolvedDir = resolveWorkspaceCwd(cwd);
      const resolvedPath = safeResolve(resolvedDir, filePath);
      const content = fs.readFileSync(resolvedPath, 'utf8');
      sendJson(res, 200, { content });
      return;
    }

    if (reqUrl.pathname === '/api/file/save') {
      const filePath = body.path;
      const cwd = body.cwd || WORKSPACE_ROOT;
      const content = body.content ?? '';
      if (!filePath) {
        sendJson(res, 400, { error: 'path is required' });
        return;
      }
      const resolvedDir = resolveWorkspaceCwd(cwd);
      const resolvedPath = safeResolve(resolvedDir, filePath);
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
      fs.writeFileSync(resolvedPath, content, 'utf8');
      sendJson(res, 200, { saved: true });
      return;
    }

    sendJson(res, 404, { error: 'Unknown endpoint' });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Server error' });
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    handleApi(req, res);
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    if (reqUrl.pathname !== '/lsp') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } catch (_) {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const workspace = reqUrl.searchParams.get('workspace') || WORKSPACE_ROOT;
  let resolvedCwd;
  try {
    resolvedCwd = resolveWorkspaceCwd(workspace);
  } catch (error) {
    ws.send(JSON.stringify({ error: error.message }));
    ws.close();
    return;
  }

  const pylsp = spawn('pylsp', [], {
    cwd: resolvedCwd,
    env: {
      ...process.env,
      PATH: `${PATH_FALLBACK}:${process.env.PATH || ''}`
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  pylsp.stderr.on('data', (chunk) => {
    console.warn(`[pylsp] ${chunk.toString()}`);
  });

  pylsp.on('error', (error) => {
    ws.send(JSON.stringify({ error: error.message }));
    ws.close();
  });

  ws.on('message', (data) => {
    const message = typeof data === 'string' ? data : data.toString();
    const payload = `Content-Length: ${Buffer.byteLength(message, 'utf8')}\r\n\r\n${message}`;
    pylsp.stdin.write(payload);
  });

  ws.on('close', () => {
    pylsp.kill();
  });

  let buffer = Buffer.alloc(0);
  pylsp.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }
      const headerText = buffer.slice(0, headerEnd).toString('utf8');
      const match = headerText.match(/Content-Length: (\\d+)/i);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (buffer.length < messageEnd) {
        return;
      }
      const message = buffer.slice(messageStart, messageEnd).toString('utf8');
      ws.send(message);
      buffer = buffer.slice(messageEnd);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Anki IDE server running at http://localhost:${PORT}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
});
