# Skill: API Request History

Status: Implemented in API Testing Studio v0.1.2 (sidebar webview).

## When to use
When a developer wants to re-run, check, or debug a request they already sent.

## How it works
1. Every sent request adds a history entry: method, URL, status, duration in ms, and time sent.
2. Click Re-run on an entry to load it back into the request builder and send it again.
3. Clear history from the sidebar when it is no longer needed.

## Rules
- History stores redacted headers only. Authorization and API-key values are shown as `***`, and request/response bodies are not stored in history.
- Because of that, re-running an authenticated request from history sends it without auth — the developer must re-enter the token in the builder first if it needs one.
- Never store sensitive request or response data in history by default. Use redaction and keep retention configurable in future versions.
