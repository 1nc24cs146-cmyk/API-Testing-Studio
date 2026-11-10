// Pure AI helpers for ApiDiya v0.3.1 — local Ollama only.
// This file intentionally has NO vscode import, so it can be unit-tested
// with plain Node. There is no cloud model and no API key anywhere: every
// call goes to the user's own Ollama server on localhost, and nothing the
// model returns is ever eval'd — it is parsed as JSON data and validated
// item by item against ApiDiya's own assertion schema before use.

import {
  ApiRequest, Assertion, AssertionKind, HttpResult, newId, redactHeaders,
  validateResponseAgainstSchema,
} from './api';

export interface OllamaSettings { url: string; model: string; }
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_MODEL = 'llama3.1:8b';

export type AiResult = { ok: true; text: string } | { ok: false; error: string };

const ASSERTION_KINDS: AssertionKind[] = [
  'status', 'timeUnder', 'jsonEquals', 'jsonContains',
  'headerEquals', 'headerContains', 'bodyContains',
];

const MAX_AI_ASSERTIONS = 10;
const MAX_BODY_IN_PROMPT = 4000;
const OLLAMA_TIMEOUT_MS = 60_000;

/** Strip markdown fences and return the first JSON value (array or object) found. */
function extractJson(text: string): string | null {
  const cleaned = text.replace(/```(?:json)?\s*/gi, '```').replace(/```/g, '');
  const start = cleaned.search(/[[{]/);
  if (start < 0) { return null; }
  const open = cleaned[start];
  const close = open === '[' ? ']' : '}';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) { return null; }
  return cleaned.slice(start, end + 1);
}

/** Prompt asking the model for assertions in ApiDiya's own assertion format. */
export function buildTestGenPrompt(request: ApiRequest, response?: HttpResult): string {
  const headers = redactHeaders(
    request.headersText.split(/\r?\n/).filter((l) => l.includes(':')).map((l) => {
      const i = l.indexOf(':');
      return { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    }),
  ).map((h) => `${h.key}: ${h.value}`).join('\n') || '(none)';
  const lines = [
    'You are helping test a REST API. Reply with ONLY a JSON array of test assertions, no other text.',
    'Each assertion is an object with these fields:',
    '- kind: one of "status", "timeUnder", "jsonEquals", "jsonContains", "headerEquals", "headerContains", "bodyContains"',
    '- expected: the expected value as a string (for status, the HTTP status code; for timeUnder, milliseconds)',
    '- path: JSON path like user.name or items[0].id (required for jsonEquals and jsonContains)',
    '- headerName: the header name (required for headerEquals and headerContains)',
    'Example: [{"kind":"status","expected":"200"},{"kind":"jsonEquals","path":"name","expected":"Test User"}]',
    `Request: ${request.method} ${request.url}`,
    `Headers:\n${headers}`,
    request.body ? `Request body:\n${request.body.slice(0, 2000)}` : 'Request body: (none)',
  ];
  if (response) {
    lines.push(
      `Response: HTTP ${response.status} ${response.statusText} in ${response.timeMs}ms`,
      `Response body:\n${response.bodyText.slice(0, MAX_BODY_IN_PROMPT)}`,
    );
    lines.push('Base the assertions on this real response. Return at most 10 assertions.');
  } else {
    lines.push('No response was captured yet, so base the assertions on the request and sensible expectations (status 200, obvious JSON fields). Return at most 10 assertions.');
  }
  return lines.join('\n');
}

export interface ParsedAssertions { assertions: Assertion[]; kept: number; dropped: number; }

/**
 * Parse model output into validated assertions. Tolerates markdown fences.
 * Every item is checked against the known assertion schema; anything that
 * does not fit is dropped and counted, never trusted. Caps at 10.
 */
export function parseGeneratedAssertions(text: string): ParsedAssertions {
  const out: Assertion[] = [];
  let dropped = 0;
  const raw = extractJson(text);
  if (!raw) { return { assertions: [], kept: 0, dropped: 0 }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { assertions: [], kept: 0, dropped: 0 }; }
  if (!Array.isArray(parsed)) { return { assertions: [], kept: 0, dropped: 0 }; }
  for (const item of parsed) {
    if (out.length >= MAX_AI_ASSERTIONS) { dropped += 1; continue; }
    if (!item || typeof item !== 'object') { dropped += 1; continue; }
    const rec = item as Record<string, unknown>;
    const kind = rec.kind;
    if (typeof kind !== 'string' || !(ASSERTION_KINDS as string[]).includes(kind)) { dropped += 1; continue; }
    if (rec.expected === undefined || rec.expected === null || String(rec.expected) === '') { dropped += 1; continue; }
    if ((kind === 'status' || kind === 'timeUnder') && Number.isNaN(Number(rec.expected))) { dropped += 1; continue; }
    if ((kind === 'jsonEquals' || kind === 'jsonContains') && (typeof rec.path !== 'string' || !rec.path.trim())) { dropped += 1; continue; }
    if ((kind === 'headerEquals' || kind === 'headerContains') && (typeof rec.headerName !== 'string' || !rec.headerName.trim())) { dropped += 1; continue; }
    out.push({
      id: newId('as'),
      kind: kind as AssertionKind,
      path: typeof rec.path === 'string' ? rec.path : undefined,
      headerName: typeof rec.headerName === 'string' ? rec.headerName : undefined,
      expected: String(rec.expected),
    });
  }
  return { assertions: out, kept: out.length, dropped };
}

/** Prompt asking the model to explain a failed request in plain words. */
export function buildExplainPrompt(request: ApiRequest, response: HttpResult | null, error?: string): string {
  const lines = [
    'You are helping debug a failed API request. Explain in plain language, in at most 8 short lines: what went wrong, the most likely causes, and what to check next. No code, no JSON, just the explanation.',
    `Request: ${request.method} ${request.url}`,
  ];
  if (response) {
    lines.push(
      `Response: HTTP ${response.status} ${response.statusText} in ${response.timeMs}ms`,
      `Response body:\n${response.bodyText.slice(0, MAX_BODY_IN_PROMPT)}`,
    );
  }
  if (error) { lines.push(`Request failed before a response arrived: ${error}`); }
  return lines.join('\n');
}

function statusMeaning(status: number): string {
  if (status === 400) { return 'the server rejected the request as malformed'; }
  if (status === 401) { return 'the server says the request is not authenticated'; }
  if (status === 403) { return 'the server understood the request but refuses it (forbidden)'; }
  if (status === 404) { return 'the server has no resource at that URL'; }
  if (status === 405) { return 'that HTTP method is not allowed on this URL'; }
  if (status === 409) { return 'the request conflicts with the current state of the resource'; }
  if (status === 422) { return 'the server understood the request but the data failed validation'; }
  if (status === 429) { return 'the server is rate-limiting you — too many requests'; }
  if (status >= 500) { return 'the server itself failed while handling the request'; }
  if (status >= 400) { return 'the server refused the request'; }
  return 'the request succeeded, but its assertions failed';
}

/**
 * Rule-based failure explanation, used when Ollama is unavailable. Pure
 * text from the status code / error only — no model involved.
 */
export function explainFailureRuleBased(request: ApiRequest, response: HttpResult | null, error?: string): string {
  const lines: string[] = [];
  if (error) {
    lines.push(`The request never got a response: ${error}.`);
    if (/timed out|timeout|aborted/i.test(error)) {
      lines.push('Likely causes: the server is slow or not responding, or the network dropped the request.');
      lines.push('Check: is the server running? Try the same URL in a browser or with a longer wait. If it is a local server, check it is still up.');
    } else if (/ECONNREFUSED|connect/i.test(error)) {
      lines.push('Likely causes: nothing is listening on that host and port.');
      lines.push('Check: is the server running on that port? Is the host and port in the URL right (for a local server, is it localhost and the right port)?');
    } else if (/ENOTFOUND|getaddrinfo|DNS|fetch failed/i.test(error)) {
      lines.push('Likely causes: the host name does not resolve, or the machine is offline.');
      lines.push('Check: is the host name spelled right? Are you online? Can you open the base URL in a browser?');
    } else {
      lines.push('Likely causes: the server is down, the URL is wrong, or the network blocked the request.');
      lines.push('Check: the URL, that the server is running, and your network connection.');
    }
    return lines.join('\n');
  }
  if (!response) {
    lines.push('No response was recorded for this request yet — send it first, then ask for an explanation.');
    return lines.join('\n');
  }
  lines.push(`HTTP ${response.status} ${response.statusText} — ${statusMeaning(response.status)}.`);
  if (response.status === 401 || response.status === 403) {
    lines.push('Likely causes: a missing, expired or wrong token/key, or the account lacks permission for this resource.');
    lines.push('Check: the Auth field (re-enter the token — saved tokens are not shown), the header name for API keys, and whether the token has expired.');
  } else if (response.status === 404) {
    lines.push('Likely causes: a wrong path, a wrong id in the URL, or the wrong environment (check {{baseUrl}}).');
    lines.push('Check: the URL path, the id, and that the active environment points at the server you mean.');
  } else if (response.status === 400 || response.status === 422) {
    lines.push('Likely causes: the request body or query does not match what the server expects.');
    lines.push('Check: required fields, field names and types in the body, and the Content-Type header (usually application/json).');
  } else if (response.status === 405) {
    lines.push('Likely causes: the method is wrong for this endpoint (e.g. POST where the server expects GET).');
    lines.push('Check: the method and the API documentation for this endpoint.');
  } else if (response.status === 429) {
    lines.push('Likely causes: too many requests in a short time.');
    lines.push('Check: wait a minute and retry; if it keeps happening, the server may need an API key with a higher limit.');
  } else if (response.status >= 500) {
    lines.push('Likely causes: a bug or outage on the server side, not in this request.');
    lines.push('Check: the server logs if it is yours; otherwise retry in a minute and, if it persists, report it to whoever runs the API.');
  } else {
    lines.push('The request itself succeeded. Look at which assertions failed: a JSON field that changed, a missing field, or a different value than expected.');
    lines.push('Check: the response body against the assertions, and whether the data on the server changed since the assertions were written.');
  }
  if (request.body) { lines.push(`Request sent: ${request.method} ${request.url}.`); }
  return lines.join('\n');
}

/** Prompt asking the model to turn plain words into one API request as JSON. */
export function buildRequestGenPrompt(instruction: string): string {
  return [
    'You are helping build an API request. Reply with ONLY a JSON object, no other text.',
    'The object has these fields:',
    '- method: one of "GET", "POST", "PUT", "PATCH", "DELETE"',
    '- url: the full URL or a {{baseUrl}} URL, as a string',
    '- headers: an object of header name to value (use {} when none are needed)',
    '- body: the request body as a string (use "" when none is needed)',
    'Example: {"method":"GET","url":"{{baseUrl}}/users","headers":{},"body":""}',
    `Instruction: ${instruction}`,
  ].join('\n');
}

export interface GeneratedRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string; headersText: string; body: string;
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Parse model output into one request. Validates the method, URL, headers
 * and body; anything that does not fit is rejected with a readable error.
 * The result is data for the user to review — it is never sent here.
 */
export function parseGeneratedRequest(text: string): GeneratedRequest {
  const raw = extractJson(text);
  if (!raw) { throw new Error('The AI reply did not contain a JSON object.'); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('The AI reply was not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The AI reply was not a JSON object describing a request.');
  }
  const rec = parsed as Record<string, unknown>;
  const method = String(rec.method || '').toUpperCase();
  if (!(METHODS as readonly string[]).includes(method)) {
    throw new Error(`The AI reply used an unknown method (${String(rec.method || '')}). Expected one of GET, POST, PUT, PATCH, DELETE.`);
  }
  if (typeof rec.url !== 'string' || !rec.url.trim()) {
    throw new Error('The AI reply had no URL.');
  }
  let headersText = '';
  if (rec.headers !== undefined && rec.headers !== null) {
    if (typeof rec.headers === 'string') { headersText = rec.headers; }
    else if (typeof rec.headers === 'object') {
      headersText = Object.entries(rec.headers as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
    } else {
      throw new Error('The AI reply had headers in an unexpected format.');
    }
  }
  let body = '';
  if (rec.body !== undefined && rec.body !== null) {
    body = typeof rec.body === 'string' ? rec.body : JSON.stringify(rec.body);
  }
  return { method: method as GeneratedRequest['method'], url: rec.url.trim(), headersText, body };
}

// --- v0.3.1: AI mock responses from an OpenAPI schema --------------------
// A mock tied to an endpoint whose request carries a JSON Schema (from an
// imported OpenAPI spec, or pasted by hand) can have its response body
// generated by the local Ollama model. The prompt carries the schema, the
// generated body is validated against that schema BEFORE anything is
// saved, and a body that does not fit is reported, never stored as a
// broken mock. No auth value is ever put in a prompt: the schema and the
// endpoint are public API surface, the token is not.

/** Prompt asking the model for one realistic response body matching the schema. */
export function buildMockGenPrompt(request: ApiRequest, schemaText: string): string {
  return [
    'You are helping mock a REST API. Reply with ONLY a JSON object (or JSON array, if the schema describes an array), no other text.',
    'The JSON must match this JSON Schema exactly: required properties must be present, types must match, and enum values must be one of the allowed values.',
    'Use realistic values: believable names, emails, dates and numbers that fit the field names.',
    `Endpoint: ${request.method} ${request.url}`,
    `JSON Schema:\n${schemaText}`,
  ].join('\n');
}

export type MockBodyResult =
  | { ok: true; body: string }
  | { ok: false; error: string; validationErrors?: string[] };

/**
 * Parse model output into a mock response body and validate it against
 * the schema before it may be saved. Tolerates markdown fences. Returns
 * the pretty-printed body on success; on any failure a readable error
 * (and the schema mismatches, when that is the cause) — never a body.
 */
export function parseGeneratedMockBody(text: string, schemaText: string): MockBodyResult {
  const raw = extractJson(text);
  if (!raw) { return { ok: false, error: 'The AI reply did not contain a JSON value.' }; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, error: 'The AI reply was not valid JSON.' }; }
  const body = JSON.stringify(parsed, null, 2);
  const checked = validateResponseAgainstSchema(body, schemaText);
  if (checked.parseError) { return { ok: false, error: checked.parseError }; }
  if (!checked.valid) {
    return {
      ok: false,
      error: `The AI-generated body does not match the schema (${checked.errors.length} mismatch${checked.errors.length === 1 ? '' : 'es'}). Nothing was saved — try again, or edit the mock body by hand.`,
      validationErrors: checked.errors,
    };
  }
  return { ok: true, body };
}

export type AiMockResult =
  | { ok: true; body: string }
  | { ok: false; error: string; validationErrors?: string[] };

/**
 * Generate a mock response body for one endpoint with the local Ollama
 * model. Every failure path returns a clear message instead of throwing:
 * no schema, an unparseable schema, Ollama unreachable, or a generated
 * body that fails schema validation. The caller saves the body only when
 * ok is true. Nothing is sent anywhere except the configured Ollama URL.
 */
export async function generateAiMockBody(settings: OllamaSettings, request: ApiRequest, schemaText: string | undefined): Promise<AiMockResult> {
  if (!schemaText || !schemaText.trim()) {
    return {
      ok: false,
      error: `No OpenAPI schema is attached to ${request.method} ${request.url}. Import an OpenAPI 3 spec for this endpoint, or paste a JSON Schema on the matching saved request first — without a schema there is nothing to generate against.`,
    };
  }
  try { JSON.parse(schemaText); } catch {
    return { ok: false, error: 'The schema attached to this endpoint is not valid JSON — fix the schema and try again.' };
  }
  const ai = await callOllama(settings, buildMockGenPrompt(request, schemaText));
  if (!ai.ok) { return { ok: false, error: ai.error }; }
  return parseGeneratedMockBody(ai.text, schemaText);
}

// --- Ollama transport --------------------------------------------------
// Plain fetch against the user's own Ollama server. A failure is returned
// as a clear message (Ollama down, model missing, timeout) — never thrown
// as a crash, and never silently treated as "AI ran".

/** POST a prompt to Ollama's /api/generate (non-streaming). */
export async function callOllama(settings: OllamaSettings, prompt: string, timeoutMs = OLLAMA_TIMEOUT_MS): Promise<AiResult> {
  const base = settings.url.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.model, prompt, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 404) {
        return { ok: false, error: `Ollama answered but the model "${settings.model}" was not found there (HTTP 404). Pull it with: ollama pull ${settings.model}` };
      }
      return { ok: false, error: `Ollama answered with HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}` };
    }
    const data = await res.json() as { response?: unknown };
    if (typeof data.response !== 'string' || !data.response.trim()) {
      return { ok: false, error: 'Ollama answered but returned no text.' };
    }
    return { ok: true, text: data.response };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout|aborted|TimeoutError/i.test(message)) {
      return { ok: false, error: `Ollama took longer than ${Math.round(timeoutMs / 1000)}s to answer. It may be busy, or the model may still be loading.` };
    }
    return { ok: false, error: `Could not reach Ollama at ${settings.url} (${message}). Is Ollama running? Start it with: ollama serve` };
  }
}

export interface OllamaCheck { reachable: boolean; modelFound: boolean; models: string[]; error?: string; }

/** Check whether Ollama answers and whether the configured model is pulled. */
export async function checkOllama(settings: OllamaSettings): Promise<OllamaCheck> {
  const base = settings.url.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      return { reachable: false, modelFound: false, models: [], error: `Ollama answered with HTTP ${res.status}` };
    }
    const data = await res.json() as { models?: Array<{ name?: string }> };
    const models = Array.isArray(data.models)
      ? data.models.map((m) => String(m.name || '')).filter(Boolean)
      : [];
    const modelFound = models.some((m) => m === settings.model || m === `${settings.model}:latest`);
    return { reachable: true, modelFound, models };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { reachable: false, modelFound: false, models: [], error: `Could not reach Ollama at ${settings.url} (${message}). Is Ollama running? Start it with: ollama serve` };
  }
}
