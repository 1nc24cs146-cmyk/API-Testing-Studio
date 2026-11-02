# Skill: API Environments

Status: Implemented in ApiDiya v0.1.2 (sidebar webview).

## When to use
When the same request must run against different servers (local, testing, staging, production) without editing every URL.

## Seeded environments
- Development: `baseUrl` = `http://localhost:3000`
- Testing, Staging, Production: placeholder URLs — the developer must replace them with their own servers before use.

## How it works
1. Pick an environment from the selector.
2. Edit that environment's variables in the sidebar and save them.
3. Write URLs with variables, for example `{{baseUrl}}/users` or `{{baseUrl}}/{{apiVersion}}/users`.
4. When sending, variables are replaced from the active environment. Unknown variables are left as-is, so a typo shows up in the final URL instead of silently becoming empty.

## Rules
- Store secret variables as secrets, not as plain text to be pasted into chat or logs. In the UI they are masked, and in history they are redacted to `***`.
- Never switch a developer to Production without them explicitly choosing it.
- Never send a production secret to a test server, or vice versa.
