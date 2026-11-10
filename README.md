<div align="center">

# 🪔 ApiDiya — API testing workspace for VS Code and Antigravity
### Send requests, save collections, run test suites, and mock APIs locally — with no cloud and no account

**A Postman-style testing workspace for VS Code and Antigravity — send requests, save collections, run test suites, and mock APIs locally, with no cloud and no account.**

[![Open VSX](https://img.shields.io/badge/Open_VSX-apidiya.api--testing--studio-0d9488?style=for-the-badge)](https://open-vsx.org/extension/apidiya/api-testing-studio)
[![Version](https://img.shields.io/badge/Version-v0.3.1-8b5cf6?style=for-the-badge)](https://github.com/1nc24cs146-cmyk/API-Testing-Studio)
[![Downloads](https://img.shields.io/badge/Downloads-596-10b981?style=for-the-badge)](https://open-vsx.org/extension/apidiya/api-testing-studio)
[![Privacy](https://img.shields.io/badge/Storage-Local_only-0f172a?style=for-the-badge)](#-privacy--stored-on-your-device-only)

[⬇️ Install](#-install-in-vs-code-or-antigravity) •
[✨ What it does](#-what-it-does) •
[🔒 Privacy](#-privacy--stored-on-your-device-only) •
[🔨 Build](#-build-from-source)

</div>

---

## 📊 At a glance

| | |
|---|---|
| **Extension** | `nitinkumarhiremath.api-testing-studio` (this build) — live on Open VSX as `apidiya.api-testing-studio` |
| **Version** | 0.3.1 (0.2.5 on Open VSX — the user publishes the VSIX) |
| **Downloads** | 596 on Open VSX (6 Nov 2026) |
| **Editors** | VS Code and Antigravity — the same VSIX installs in either |
| **Storage** | Local only. No account, no cloud database, no telemetry, no analytics |
| **Formerly** | API Testing Studio — same extension, new name; existing installs update normally |

This is the same extension for both editors: it uses only the standard VS Code extension API (sidebar webview, commands, stored state), with no Antigravity-only or VS Code-only features.

Original code, built from the PDF spec in the project brief (milestone 1 only). It is not a copy of Thunder Client, Postman, or any other extension.

## ⬇️ Install in VS Code or Antigravity

1. Open VS Code or Antigravity.
2. Open Extensions, then `...` (more actions) → **Install from VSIX…**
3. Choose `apidiya-vscode-0.3.1.vsix / apidiya-antigravity-0.3.1.vsix` from this folder.
4. Click the ApiDiya icon in the activity bar, or run the command **ApiDiya: Open** from the Command Palette.

To publish it later, use this same VSIX for both stores: the VS Code Marketplace for VS Code users, and Open VSX for Antigravity users (Antigravity installs from Open VSX, not the VS Code Marketplace).

## ✨ What it does

### Latest: AI mock responses from an OpenAPI schema (v0.3.1)

- **AI mock responses:** "Generate with AI" on any mock in the Mock server section — or the `ApiDiya: Generate mock response with AI` command from the Command Palette — asks your local Ollama server for a realistic response body for that endpoint and saves it as the mock's response. The schema comes from the endpoint's saved request: importing an OpenAPI 3 spec now captures the 2xx response's `application/json` schema onto each request (local `#/components/schemas/*` refs resolved inline), or you can paste a JSON Schema on the request by hand. The generated body is validated against the schema before it is saved — a body that does not fit is reported with its mismatches and never stored as a broken mock. No schema, an unparseable schema, or Ollama being down each get one clear message instead of generated garbage or an error popup storm. Fully local only: the only network call is to your configured Ollama URL, no cloud, no keys, and no auth token is ever put in a prompt.

### Data-driven runs, JSON Schema validation, cURL import (v0.3.0)

- **Data-driven collection runs:** paste CSV (first line = column names) or a JSON array of objects into the "Data-driven runs" section, pick a saved suite, and ApiDiya runs the suite once per row, substituting each row's values into `{{variables}}` in the URL, headers, query params and body. Row values win over the active environment's variables. Every row gets its own per-row pass/fail result (which requests passed/failed in that row) plus a totals line, and each row is recorded as its own test run. Rows are used only for the run and are never stored.
- **JSON Schema response validation:** paste a JSON Schema into the "JSON Schema" box under Assertions for any request and it is saved with the request. On every test run (single request or suite) the response body is checked against it as an extra assertion, and "Validate last response against schema" checks it on demand. Mismatches are reported plainly, e.g. `$.id: expected type integer, got string` or `missing required property 'email'`. The validator covers type, required, properties, items, enum, minimum/maximum, minLength/maxLength, pattern, minItems/maxItems and `additionalProperties: false`; `$ref` and `allOf`/`anyOf`/`oneOf` are reported as unsupported rather than silently half-checked, and a non-JSON body or a malformed schema gives a clear error instead of a pass.
- **Import from cURL:** paste a cURL command (multi-line pastes work) into the "Import from cURL" box and ApiDiya creates the request from it — the reverse of the code-snippet export. It understands `-X`/`--request`, `-H`/`--header` (including `--header=value`), `-d`/`--data`/`--data-raw` (which implies POST, as curl does), `--json`, `-A`/`--user-agent`, `-b`/`--cookie` and `--url`; `-u`/`--user` becomes Basic auth and the password goes to the OS keychain, never into the request. Unknown flags (`-k`, `-L`, `--compressed`, …) are skipped. Honest limit: `--data @file` is pasted literally, not read from disk.

### AI test generation + 12 MCP tools (v0.2.5)

- **AI test generation, local only:** "Generate tests with AI" in the sidebar asks your own Ollama server for assertions in ApiDiya's format, using the last response when there is one. Every suggestion is validated against the assertion schema before use — invalid ones are dropped and counted, and the report says how many were kept vs dropped. No cloud model, no API key: AI runs on your machine via Ollama, and nothing leaves the device.
- **Explain last failure:** asks Ollama for a plain-words explanation of the last failure; when Ollama is not available, a rule-based explanation is shown instead, clearly labelled as such.
- **Create a request from words:** type what you want ("GET the list of users") and AI proposes one request — shown for review with Use / Discard buttons. It is never sent until you press Use.
- **AI settings:** Ollama URL (default `http://localhost:11434`) and model (default `llama3.1:8b`) are settings (`apidiya.ai.ollamaUrl`, `apidiya.ai.model`), editable from the sidebar, with a "Test connection" button that reports whether Ollama answers and whether the model is pulled.
- **Ollama setup:** install Ollama, run `ollama pull llama3.1:8b` (or set another model), then start it with `ollama serve`. Honest limit: AI needs Ollama running locally with a model pulled — without that, the AI buttons report it clearly instead of failing silently.
- **MCP server now has 12 tools** (the spec's 10, plus the 2 earlier extras): list collections, list requests, send a saved request, send a one-off request, create a request, save (upsert) a request, get the last response, import OpenAPI 3, generate tests, run a test suite, explain a failure, generate Markdown docs for a collection. The AI tools use local Ollama when it answers and fall back to the rule-based versions (labelled) otherwise. Tool results never include secrets.

### Snippets, WebSocket + SSE, MCP server (v0.2.3)

- Code snippets: one click copies the current request as cURL, JavaScript fetch, or Python (requests). Snippets are generated as text only and include your auth token if one is set — treat a pasted snippet like a password.
- WebSocket testing: connect to a ws:// or wss:// URL in the sidebar, send messages, and watch replies in the log. SSE testing: start a stream from an http(s) URL and watch events arrive (streamed through the extension host, so the sidebar's content policy stays tight).
- MCP server: a local Streamable HTTP server on 127.0.0.1 (default port 3102, started from the sidebar) exposing four tools at the time — list collections, list requests, send a saved request, send a one-off request (now 12 tools in v0.2.5, see above). Point an MCP host at `http://localhost:3102/mcp`; tool results never include secrets. Installing ApiDiya does not auto-connect it to any other extension: the host's MCP config must point at this URL, and the server must be running in the editor.

### Live download count in the sidebar (v0.2.2)

- ApiDiya shows its Open VSX download count (labelled 'downloads on Antigravity') at the top of the sidebar, fetched from the registry when the sidebar opens. Note: Antigravity's own Installation panel has no Downloads row and cannot be changed by an extension — the count lives in the sidebar instead.

### Assertions, suites, import/export, mock server (v0.2.0)

- Assertions: status, response time, JSON value, header and body checks — evaluated as data, never as a script.
- Test suites: tick requests, save a suite, run it, and keep the last 20 test runs.
- Generate assertions from the last response (status + top-level JSON fields).
- Import collections from ApiDiya JSON, Postman v2.1 JSON, or OpenAPI 3 JSON; export any collection as ApiDiya JSON.
- Local mock server: add method + path + status + body mocks and serve them on http://localhost:3101 (or your chosen port).
- AI-model generation arrived in v0.2.5 (above) — local Ollama only. The MCP server in v0.2.3 is the local HTTP server described above, not a stdio server — a separate stdio process could not read the editor's local state.

### Request builder, collections, history (v0.1.6)

- Logo: `media/icon.png` (1024x1024 PNG, amber curly braces {} with a white lightning bolt on deep charcoal) is now the extension icon shown in the store and editor. The previous teal plug logo is kept as `media/icon-old-teal.png`.
- Sidebar webview with a dark developer UI.
- Send GET, POST, PUT, PATCH and DELETE requests (Node fetch, 30 second timeout).
- Request builder: URL, headers (one `Key: value` per line), query params (one `key=value` per line), auth (None / Bearer token / API key / Basic), and a JSON/raw body editor. Bodies are sent as data only — they are never executed as code.
- Response viewer: HTTP status, response time in ms, size in bytes, response headers, pretty-printed JSON, and Copy response body.
- Environment variable substitution, e.g. `{{baseUrl}}/users`. Seeded environments: Development (`http://localhost:3000`), Testing, Staging and Production. Edit an environment's variables in the sidebar; Testing/Staging/Production URLs are placeholders — replace them with your own servers.
- Collections and folders seeded from the spec: Authentication (Register, Login, Logout, Refresh Token, Get Current User, Reset Password, Verify Email), Users, Products, Orders, Payments, File Upload, plus an empty Custom collection. You can create, save, duplicate and delete requests and collections.
- Request history (method, URL, status, duration, time) with re-run. Authorization and API-key values are masked as `***` in history and are not stored there; bodies are not stored in history either. So re-running an authenticated request from history sends it without auth — re-enter the token in the builder first if it needs one.

### Skills and requirements

- Agent/developer skills: see `plugin/skills/` — request builder, collections, environments, and history are implemented; testing assertions and MCP integration are planned for v0.2 and are marked as planned in their skill files.
- Full requirements (editor, build tools, developer skills, publishing): see `REQUIREMENTS.md`.

### What v0.1.6 did not have

- No AI features and no MCP server — planned for v0.2.
- No mock server and no OpenAPI/Swagger import — planned for v0.3 (both arrived in v0.2.0, above).
- No script execution from imported collections, by design. There is no collection import in v0.1 at all.
- No team sharing, analytics, or test suites yet (suites arrived in v0.2.0, above).

## 🔒 Privacy — stored on your device only

- Collections, environments, test suites, test runs, mocks and history are stored in the editor's local storage on your device only. ApiDiya never calls setKeysForSync, so VS Code/Antigravity Settings Sync never uploads this data to a cloud.
- Saved auth tokens and API keys are stored in your operating system's keychain (VS Code SecretStorage), not in the extension's stored data and never in history (history shows only `***`).
- There is no account, no cloud database, no telemetry and no analytics. The only network traffic is the request you press Send/Run on, sent to the URL you typed, plus the local mock server on your own machine — and, when you use the AI buttons, calls to your own Ollama server on localhost (never a cloud model, no API key).
- Tip: put secrets in the Auth field, not in environment variables — environment variables are stored locally too, but as plain text in local editor storage, not in the keychain.

## 🔨 Build from source

```bash
npm install
npm run compile
npx vsce package
```

The packaged file is `apidiya-vscode-0.3.1.vsix / apidiya-antigravity-0.3.1.vsix`.

---

*ApiDiya — Developed by NitinKumar Hiremath.*
