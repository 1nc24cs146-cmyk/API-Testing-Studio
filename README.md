# API Testing Studio — v0.1.3 (MVP, for VS Code and Antigravity)

This is the same extension for both editors: it uses only the standard
VS Code extension API (sidebar webview, commands, stored state), with no
Antigravity-only or VS Code-only features, so the same VSIX installs in
either editor.

Original code, built from the PDF spec in the project brief (milestone 1 only).
It is not a copy of Thunder Client, Postman, or any other extension.

## What v0.1.3 does

- Logo: `media/icon.png` (1024x1024 PNG, amber curly braces {} with a white lightning bolt on deep charcoal) is now the extension icon shown in the store and editor. The previous teal plug logo is kept as `media/icon-old-teal.png`.

- Sidebar webview with a dark developer UI.
- Send GET, POST, PUT, PATCH and DELETE requests (Node fetch, 30 second timeout).
- Request builder: URL, headers (one `Key: value` per line), query params
  (one `key=value` per line), auth (None / Bearer token / API key / Basic),
  and a JSON/raw body editor. Bodies are sent as data only — they are never
  executed as code.
- Response viewer: HTTP status, response time in ms, size in bytes, response
  headers, pretty-printed JSON, and Copy response body.
- Environment variable substitution, e.g. `{{baseUrl}}/users`.
  Seeded environments: Development (`http://localhost:3000`), Testing,
  Staging and Production. Edit an environment's variables in the sidebar;
  Testing/Staging/Production URLs are placeholders — replace them with your
  own servers.
- Collections and folders seeded from the spec: Authentication (Register,
  Login, Logout, Refresh Token, Get Current User, Reset Password, Verify
  Email), Users, Products, Orders, Payments, File Upload, plus an empty
  Custom collection. You can create, save, duplicate and delete requests
  and collections.
- Request history (method, URL, status, duration, time) with re-run.
  Authorization and API-key values are masked as `***` in history and are
  not stored there; bodies are not stored in history either. So re-running
  an authenticated request from history sends it without auth — re-enter
  the token in the builder first if it needs one.

## Skills and requirements

- Agent/developer skills: see `plugin/skills/` — request builder, collections, environments, and history are implemented; testing assertions and MCP integration are planned for v0.2 and are marked as planned in their skill files.
- Full requirements (editor, build tools, developer skills, publishing): see `REQUIREMENTS.md`.

## What is NOT in v0.1.3 (planned for later versions)

- No AI features and no MCP server — planned for v0.2.
- No mock server and no OpenAPI/Swagger import — planned for v0.3.
- No script execution from imported collections, by design. There is no
  collection import in v0.1 at all.
- No team sharing, analytics, or test suites yet.

## Install in VS Code or Antigravity

1. Open VS Code or Antigravity.
2. Open Extensions, then `...` (more actions) → **Install from VSIX…**
3. Choose `api-testing-studio-0.1.3.vsix` from this folder.
4. Click the API Testing Studio icon in the activity bar, or run the
   command **API Testing Studio: Open** from the Command Palette.

To publish it later, use this same VSIX for both stores: the VS Code
Marketplace for VS Code users, and Open VSX for Antigravity users
(Antigravity installs from Open VSX, not the VS Code Marketplace).

## Build from source

```bash
npm install
npm run compile
npx vsce package
```

The packaged file is `api-testing-studio-0.1.3.vsix`.
