# ApiDiya — Requirements

## What it is
A sidebar API testing workspace for VS Code and Antigravity, built from the project spec (MVP first, then AI/MCP features). Version in this folder: check `package.json`.

## Requirements to USE it (no code needed)
- An editor: VS Code 1.85 or newer, or Google Antigravity (which uses the same extension API).
- No account, no cloud service, and no API key are required to install or open it.
- An internet connection only when you actually send a request to a remote API. Local requests (for example `http://localhost:3000`) work offline.
- For the seeded examples to do anything real, you need your own API server, or a public test API such as `https://jsonplaceholder.typicode.com`. The seeded Testing/Staging/Production environment URLs are placeholders — replace them with your own servers.
- For Payments examples: use mock or sandbox payment endpoints only. Never test against real payment systems without authorisation.

## Requirements to BUILD it from source
- Node.js 20 or newer, and npm (comes with Node).
- TypeScript (installed as a dev dependency with `npm install`).
- The VS Code extension packager `@vscode/vsce` (also a dev dependency).
- No other runtime dependencies. The extension host provides Node fetch for sending requests.

Build commands:

```bash
npm install
npm run compile
npx vsce package
```

The packaged file is named `api-testing-studio-<version>.vsix`.

## Developer skills required to build / extend it
- TypeScript — the whole extension is TypeScript, strict mode.
- VS Code Extension API — sidebar webviews (`WebviewViewProvider`), commands, activity-bar containers, and editor stored state (`globalState`). No Antigravity-only or VS Code-only APIs are used, which is why the same VSIX works in both editors.
- Node fetch and HTTP — methods, headers, query params, auth (Bearer, API key, Basic), JSON bodies, timeouts, and response handling.
- HTML/CSS/JavaScript for the webview UI (`media/webview.html`).
- JSON and REST API basics — status codes, headers, collections, and environments.
- Security basics — masking secrets in history, never executing request bodies or imported scripts as code, confirming destructive requests, and keeping secrets out of logs and chat.

## What is NOT required
- No Ollama, Gemini, or other AI model — v0.1.2 has no AI features. AI features are planned for v0.2.
- No database server — collections, environments, and history are stored locally in editor storage. SQLite/PostgreSQL migration is a future option, not a requirement now.
- No Docker, Java, Python, or backend server to run the extension itself.

## Skills included with this extension
See `plugin/skills/`:
- `api-request-builder` — implemented in v0.1.2
- `api-collections` — implemented in v0.1.2
- `api-environments` — implemented in v0.1.2
- `api-history` — implemented in v0.1.2
- `api-testing-assertions` — planned for v0.2, not yet implemented
- `api-mcp-integration` — planned for v0.2, not yet implemented

## Publishing requirements (separate from using it)
- Open VSX (for Antigravity users): an Eclipse account, a signed Publisher Agreement, and an Open VSX access token. The publisher in `package.json` must match the namespace you publish under.
- VS Code Marketplace (for VS Code users): a separate Microsoft publisher account and token. An Open VSX upload alone never appears in VS Code.
- A new version number for every republish — a published version cannot be published again.
