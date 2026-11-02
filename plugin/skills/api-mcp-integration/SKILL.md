# Skill: Antigravity MCP Integration

Status: Planned for v0.2 — NOT implemented in v0.1.2. Do not claim these MCP tools exist yet.

## Planned MCP tools
- `api_send_request` — execute an HTTP request
- `api_save_request` — save a request
- `api_list_collections` — list collections
- `api_import_openapi` — import an API specification
- `api_generate_tests` — generate test cases
- `api_run_tests` — execute test suites
- `api_explain_failure` — explain a failed request
- `api_compare_schema` — compare API schemas

## Rules for the future MCP server
- The dashboard and the MCP tools must share one backend and one data model, so a request created by the agent appears in the dashboard immediately, and vice versa.
- Never expose stored API keys to the model unnecessarily. Mask credentials in history.
- Require user confirmation for destructive or sensitive requests.
- Restrict access to private network destinations unless explicitly authorised.
- Never execute arbitrary scripts from imported API collections.

## Until it ships
In v0.1.2, the agent workflow is the sidebar itself: the developer builds, sends, saves, and re-runs requests by hand. The skills in this folder describe that workflow, not MCP calls.
