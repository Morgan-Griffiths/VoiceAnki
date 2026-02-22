# Anki IDE

A lightweight local web app that combines an editor, an Anki deck sidebar (via AnkiConnect), and a Codex terminal panel.

## Run

```bash
npm install
node server.js
```

Then open `http://localhost:5179`.

## Hot reload

```bash
node dev.js
```

This restarts the server when files change.

## Notes
- Requires Anki running with AnkiConnect enabled on port 8765 to load decks.
- `Codex` mode uses `codex app-server` (so the `codex` CLI must be on your PATH).
- You can tune Codex sandboxing via `CODEX_SANDBOX` (default `workspace-write`) and approvals via `CODEX_APPROVAL_POLICY` (default `never`).
- If Codex reports initialize timeouts, ensure `OPENAI_API_KEY` is exported in the same shell you start the server from.
- Codex seeds each new thread with `anki-card-spec.md` by default. Override with `CODEX_CONTEXT_PATH` or `CODEX_CONTEXT_TEXT`.
- Set `CODEX_DEBUG=1` to log Codex notifications in the server console.
- Override the default Codex system guidance with `CODEX_SYSTEM_MESSAGE`.
- Python LSP requires `pylsp` (install with `python -m pip install python-lsp-server`).
- By default, file reads/writes and commands are restricted to the server workspace directory. Set `ALLOW_OUTSIDE_WORKSPACE=1` to lift the restriction.
- iOS voice-to-Anki app architecture notes: `docs/ios-voice-to-anki-cards-plan.md`.
- Voice Anki POC (mobile web): open `/voice-poc.html` (for example `http://localhost:5179/voice-poc.html`). Requires `OPENAI_API_KEY` on the server and a modern Node runtime with `fetch`/`FormData`/`Blob` globals.
- Native iOS SwiftUI starter (source scaffold): `ios/VoiceAnkiPOC/Resources/README.md`.
