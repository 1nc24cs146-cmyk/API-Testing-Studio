# ApiDiya changelog

## 0.3.1

- **AI mock responses from an OpenAPI schema:** "Generate with AI" on any mock (sidebar, Mock server section) — or the `ApiDiya: Generate mock response with AI` command from the Command Palette — asks your local Ollama server for a realistic response body matching the endpoint's OpenAPI schema, and saves it as the mock's response.
  - The schema comes from the saved request for that endpoint: importing an OpenAPI 3 spec now captures the 2xx response's `application/json` schema onto each request (local `#/components/schemas/*` refs resolved inline), or paste a JSON Schema on the request by hand.
  - The generated body is validated against the schema before anything is saved — a body that does not fit is reported with its mismatches and never stored as a broken mock.
  - Graceful failures, one clear message each: no schema attached (import a spec or paste a schema first), Ollama unreachable, or an unparseable schema. No error popup storm.
  - Fully local only: the only network call is to the configured Ollama URL (`apidiya.ai.ollamaUrl`, default `http://localhost:11434`, model `apidiya.ai.model`, default `llama3.1:8b`). No cloud, no keys, and no auth token is ever put in a prompt.

## 0.3.0

- Data-driven collection runs from CSV/JSON rows, JSON Schema response validation, and import from cURL.

## 0.2.5

- Local AI test generation with Ollama (assertions, failure explanations, request from words), AI settings with a connection test, and the local MCP server with 12 tools.

## 0.2.3

- Code snippets (cURL / fetch / Python), WebSocket + SSE testing, and the local MCP server.

## 0.2.0

- Assertions, test suites, import/export (ApiDiya JSON, Postman v2.1, OpenAPI 3), and the local mock server.

## 0.1.x

- Request builder, collections, environments, history, and the seeded spec collections.
