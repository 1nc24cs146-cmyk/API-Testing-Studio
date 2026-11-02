# Skill: API Request Builder

Status: Implemented in ApiDiya v0.1.2 (sidebar webview).

## When to use
When a developer wants to send a single HTTP request and inspect the response, without leaving VS Code or Antigravity.

## How it works
1. Choose a method: GET, POST, PUT, PATCH, or DELETE.
2. Enter the URL. Environment variables in `{{name}}` form are replaced first (see the api-environments skill).
3. Add headers, one `Key: value` per line, and query params, one `key=value` per line.
4. Choose auth: None, Bearer token, API key, or Basic (username:password).
5. Enter a JSON or raw body for POST, PUT, and PATCH.
6. Press Send. The extension host sends the request with Node fetch and a 30-second timeout.
7. Read the response: HTTP status, time in ms, size in bytes, response headers, and pretty-printed JSON, with Copy response body.

## Rules
- Bodies are sent as data only. Never execute a body, script, or imported file as code.
- Never log a full Bearer token, API key, or Basic credential. History stores redacted headers only.
- Confirm with the user before sending a destructive request (DELETE, or a POST/PUT that changes live data) to a non-test server.
- If the request fails, show the status or error in the response area — never fail silently.
