<div align="center">

# 🪔 ApiDiya — API testing workspace for VS Code and Antigravity
### Send requests, save collections, run test suites, and mock APIs locally — with no cloud and no account

**A Postman-style testing workspace for VS Code and Antigravity — send requests, save collections, run test suites, and mock APIs locally, with no cloud and no account.**

[![Open VSX](https://img.shields.io/badge/Open_VSX-apidiya.api--testing--studio-0d9488?style=for-the-badge)](https://open-vsx.org/extension/apidiya/api-testing-studio)
[![Version](https://img.shields.io/badge/Version-v0.2.1-8b5cf6?style=for-the-badge)](https://github.com/1nc24cs146-cmyk/API-Testing-Studio)
[![Downloads](https://img.shields.io/badge/Downloads-180-10b981?style=for-the-badge)](https://open-vsx.org/extension/apidiya/api-testing-studio)
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
| **Version** | 0.2.1 on Open VSX (0.2.2 built, with the sidebar download count) |
| **Downloads** | 180 on Open VSX (4 Nov 2026) |
| **Editors** | VS Code and Antigravity — the same VSIX installs in either |
| **Storage** | Local only. No account, no cloud database, no telemetry, no analytics |
| **Formerly** | API Testing Studio — same extension, new name; existing installs update normally |

This is the same extension for both editors: it uses only the standard VS Code extension API (sidebar webview, commands, stored state), with no Antigravity-only or VS Code-only features.

Original code, built from the PDF spec in the project brief (milestone 1 only). It is not a copy of Thunder Client, Postman, or any other extension.

## ⬇️ Install in VS Code or Antigravity

1. Open VS Code or Antigravity.
2. Open Extensions, then `...` (more actions) → **Install from VSIX…**
3. Choose `apidiya-vscode-0.2.1.vsix / apidiya-antigravity-0.2.1.vsix` from this folder.
4. Click the ApiDiya icon in the activity bar, or run the command **ApiDiya: Open** from the Command Palette.

To publish it later, use this same VSIX for both stores: the VS Code Marketplace for VS Code users, and Open VSX for Antigravity users (Antigravity installs from Open VSX, not the VS Code Marketplace).

## ✨ What it does

### Latest: live download count in the sidebar (v0.2.2)

- ApiDiya shows its Open VSX download count (labelled 'downloads on Antigravity') at the top of the sidebar, fetched from the registry when the sidebar opens. Note: Antigravity's own Installation panel has no Downloads row and cannot be changed by an extension — the count lives in the sidebar instead.

### Assertions, suites, import/export, mock server (v0.2.0)

- Assertions: status, response time, JSON value, header and body checks — evaluated as data, never as a script.
- Test suites: tick requests, save a suite, run it, and keep the last 20 test runs.
- Generate assertions from the last response (status + top-level JSON fields).
- Import collections from ApiDiya JSON, Postman v2.1 JSON, or OpenAPI 3 JSON; export any collection as ApiDiya JSON.
- Local mock server: add method + path + status + body mocks and serve them on http://localhost:3101 (or your chosen port).
- Not yet in v0.2.0: a full MCP server and AI-model generation. Those need editor MCP-host wiring and are planned next, not claimed here.

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
- There is no account, no cloud database, no telemetry and no analytics. The only network traffic is the request you press Send/Run on, sent to the URL you typed, plus the local mock server on your own machine.
- Tip: put secrets in the Auth field, not in environment variables — environment variables are stored locally too, but as plain text in local editor storage, not in the keychain.

## 🔨 Build from source

```bash
npm install
npm run compile
npx vsce package
```

The packaged file is `apidiya-vscode-0.2.1.vsix / apidiya-antigravity-0.2.1.vsix`.

---

*ApiDiya — Developed by NitinKumar Hiremath.*
