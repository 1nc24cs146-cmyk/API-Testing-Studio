// Pure logic for API Testing Studio v0.1.
// This file intentionally has NO vscode import, so it can be unit/smoke
// tested with plain Node. No user-supplied script is ever executed here:
// request bodies are sent as data only, never evaluated.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HeaderPair { key: string; value: string; }
export interface ApiRequest {
  id: string; name: string; method: HttpMethod; url: string;
  headersText: string; queryText: string;
  authType: 'none' | 'bearer' | 'apiKey' | 'basic';
  authValue: string; authKeyName: string; body: string;
  collectionId: string;
  assertions?: Assertion[];
  /** Optional JSON Schema (as text) the response body is validated against. */
  jsonSchema?: string;
}
export interface ApiCollection { id: string; name: string; requests: ApiRequest[]; }
export interface Environment { id: string; name: string; variables: Record<string, string>; }
export interface HistoryEntry {
  id: string; method: HttpMethod; url: string; status: number | null;
  durationMs: number; executedAt: string; error?: string;
  // Redacted headers only: secret values are replaced with "***".
  headers: HeaderPair[];
}
export interface HttpResult {
  status: number; statusText: string; timeMs: number; sizeBytes: number;
  headers: HeaderPair[]; bodyText: string;
}

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

/** Replace {{variable}} tokens from the active environment. Unknown tokens are left as-is. */
export function substituteVariables(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : whole;
  });
}

/** Parse "Key: value" lines, one header per line. Lines without a colon are ignored. */
export function parseHeaders(text: string): HeaderPair[] {
  const out: HeaderPair[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    const colon = trimmed.indexOf(':');
    if (colon <= 0) { continue; }
    out.push({ key: trimmed.slice(0, colon).trim(), value: trimmed.slice(colon + 1).trim() });
  }
  return out;
}

/** Parse "key=value" lines, one query parameter per line. */
export function parseQueryParams(text: string): HeaderPair[] {
  const out: HeaderPair[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) { continue; }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) { out.push({ key: trimmed, value: '' }); }
    else { out.push({ key: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() }); }
  }
  return out;
}

/** Substitute variables, then append query parameters to the URL. */
export function buildFinalUrl(rawUrl: string, variables: Record<string, string>, queryText: string): string {
  const substituted = substituteVariables(rawUrl, variables);
  const params = parseQueryParams(substituteVariables(queryText, variables));
  if (params.length === 0) { return substituted; }
  const query = params.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
  return substituted.includes('?') ? `${substituted}&${query}` : `${substituted}?${query}`;
}

const SECRET_HEADER_NAMES = new Set([
  'authorization', 'api-key', 'apikey', 'x-api-key', 'x-auth-token', 'cookie',
]);

/** Mask secret header values. Never store or display a full secret in history. */
export function redactHeaders(headers: HeaderPair[]): HeaderPair[] {
  return headers.map((h) => SECRET_HEADER_NAMES.has(h.key.toLowerCase())
    ? { key: h.key, value: '***' }
    : h);
}

/** Build the final header list for a request, including its auth setting. */
export function buildHeaders(req: ApiRequest): HeaderPair[] {
  const headers = parseHeaders(req.headersText);
  const has = (name: string) => headers.some((h) => h.key.toLowerCase() === name.toLowerCase());
  if (req.authType === 'bearer' && req.authValue && !has('Authorization')) {
    headers.push({ key: 'Authorization', value: `Bearer ${req.authValue}` });
  } else if (req.authType === 'apiKey' && req.authValue && !has(req.authKeyName || 'X-API-Key')) {
    headers.push({ key: req.authKeyName || 'X-API-Key', value: req.authValue });
  } else if (req.authType === 'basic' && req.authValue && !has('Authorization')) {
    // authValue is expected to be "username:password"; encode it, never log it raw.
    headers.push({ key: 'Authorization', value: `Basic ${Buffer.from(req.authValue, 'utf8').toString('base64')}` });
  }
  return headers;
}

/** Pretty-print JSON when possible; otherwise return the text unchanged. */
export function prettyPrint(bodyText: string): string {
  try { return JSON.stringify(JSON.parse(bodyText), null, 2); } catch { return bodyText; }
}

/** Send one HTTP request with a 30 second timeout. Body is data only, never executed. */
export async function sendHttp(
  method: HttpMethod, url: string, headers: HeaderPair[], body: string | undefined,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: headers.map((h) => [h.key, h.value] as [string, string]),
      body: method === 'GET' || method === 'DELETE' ? undefined : body,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const responseHeaders: HeaderPair[] = [];
    response.headers.forEach((value, key) => responseHeaders.push({ key, value }));
    return {
      status: response.status, statusText: response.statusText,
      timeMs: Date.now() - started,
      sizeBytes: Buffer.byteLength(bodyText, 'utf8'),
      headers: responseHeaders, bodyText,
    };
  } finally { clearTimeout(timer); }
}

function req(collectionId: string, name: string, method: HttpMethod, url: string, body?: string): ApiRequest {
  return {
    id: newId('req'), name, method, url,
    headersText: method === 'GET' || method === 'DELETE' ? '' : 'Content-Type: application/json',
    queryText: '', authType: 'none', authValue: '', authKeyName: 'X-API-Key',
    body: body ?? '', collectionId,
  };
}

/** Seeded collections, exactly as listed in section 2 of the PDF spec. */
export function seedCollections(): ApiCollection[] {
  const collections: ApiCollection[] = [];
  const make = (name: string, build: (id: string) => ApiRequest[]): ApiCollection => {
    const id = newId('col');
    const collection: ApiCollection = { id, name, requests: build(id) };
    collections.push(collection);
    return collection;
  };
  make('Authentication', (id) => [
    req(id, 'Register User', 'POST', '{{baseUrl}}/auth/register', '{\n  "name": "Test User",\n  "email": "test@example.com"\n}'),
    req(id, 'Login User', 'POST', '{{baseUrl}}/auth/login', '{\n  "email": "test@example.com"\n}'),
    req(id, 'Logout User', 'POST', '{{baseUrl}}/auth/logout'),
    req(id, 'Refresh Token', 'POST', '{{baseUrl}}/auth/refresh'),
    req(id, 'Get Current User', 'GET', '{{baseUrl}}/auth/me'),
    req(id, 'Reset Password', 'POST', '{{baseUrl}}/auth/reset-password'),
    req(id, 'Verify Email', 'POST', '{{baseUrl}}/auth/verify-email'),
  ]);
  make('Users', (id) => [
    req(id, 'Get All Users', 'GET', '{{baseUrl}}/users'),
    req(id, 'Get User By ID', 'GET', '{{baseUrl}}/users/1'),
    req(id, 'Create User', 'POST', '{{baseUrl}}/users', '{\n  "name": "Test User",\n  "email": "test@example.com"\n}'),
    req(id, 'Update User', 'PUT', '{{baseUrl}}/users/1', '{\n  "name": "Updated User"\n}'),
    req(id, 'Update User Partially', 'PATCH', '{{baseUrl}}/users/1', '{\n  "name": "Updated User"\n}'),
    req(id, 'Delete User', 'DELETE', '{{baseUrl}}/users/1'),
  ]);
  make('Products', (id) => [
    req(id, 'Get Products', 'GET', '{{baseUrl}}/products'),
    req(id, 'Get Product By ID', 'GET', '{{baseUrl}}/products/1'),
    req(id, 'Create Product', 'POST', '{{baseUrl}}/products', '{\n  "name": "Sample Product"\n}'),
    req(id, 'Update Product', 'PUT', '{{baseUrl}}/products/1', '{\n  "name": "Updated Product"\n}'),
    req(id, 'Delete Product', 'DELETE', '{{baseUrl}}/products/1'),
    req(id, 'Search Products', 'GET', '{{baseUrl}}/products?search=sample'),
  ]);
  make('Orders', (id) => [
    req(id, 'Get All Orders', 'GET', '{{baseUrl}}/orders'),
    req(id, 'Get Order By ID', 'GET', '{{baseUrl}}/orders/1'),
    req(id, 'Create Order', 'POST', '{{baseUrl}}/orders', '{\n  "productId": 1,\n  "quantity": 1\n}'),
    req(id, 'Update Order', 'PUT', '{{baseUrl}}/orders/1', '{\n  "quantity": 2\n}'),
    req(id, 'Cancel Order', 'DELETE', '{{baseUrl}}/orders/1'),
  ]);
  make('Payments', (id) => [
    req(id, 'Create Payment', 'POST', '{{baseUrl}}/payments', '{\n  "orderId": 1,\n  "amount": 100\n}'),
    req(id, 'Get Payment', 'GET', '{{baseUrl}}/payments/1'),
    req(id, 'Verify Payment', 'POST', '{{baseUrl}}/payments/1/verify'),
    req(id, 'Refund Payment', 'POST', '{{baseUrl}}/payments/1/refund'),
  ]);
  make('File Upload', (id) => [
    req(id, 'Upload File', 'POST', '{{baseUrl}}/files'),
    req(id, 'Get Uploaded File', 'GET', '{{baseUrl}}/files/1'),
    req(id, 'Delete File', 'DELETE', '{{baseUrl}}/files/1'),
  ]);
  make('Custom', () => []);
  return collections;
}

/** Seeded environments from the PDF spec. Development uses localhost:3000. */
export function seedEnvironments(): Environment[] {
  return [
    { id: newId('env'), name: 'Development', variables: { baseUrl: 'http://localhost:3000', apiVersion: 'v1' } },
    { id: newId('env'), name: 'Testing', variables: { baseUrl: 'https://test.example.com', apiVersion: 'v1' } },
    { id: newId('env'), name: 'Staging', variables: { baseUrl: 'https://staging.example.com', apiVersion: 'v1' } },
    { id: newId('env'), name: 'Production', variables: { baseUrl: 'https://api.example.com', apiVersion: 'v1' } },
  ];
}

export function emptyRequest(collectionId: string): ApiRequest {
  return req(collectionId, 'Untitled Request', 'GET', '{{baseUrl}}/users');
}

// ---------------------------------------------------------------------------
// v0.2: assertions, test suites, import/export, mock matching.
// All pure: no vscode import, no user script is ever executed. Assertion
// "expected" values are compared as data only, never evaluated as code.
// ---------------------------------------------------------------------------

export type AssertionKind =
  | 'status' | 'timeUnder' | 'jsonEquals' | 'jsonContains'
  | 'headerEquals' | 'headerContains' | 'bodyContains' | 'schema';

export interface Assertion {
  id: string;
  kind: AssertionKind;
  /** JSON path for json kinds (dot notation, e.g. user.name or items[0].id). */
  path?: string;
  /** Header name for header kinds. */
  headerName?: string;
  /** Expected value, compared as a string (numbers compared by their text). */
  expected: string;
}

export interface AssertionResult { assertion: Assertion; passed: boolean; message: string; }

export interface TestSuite { id: string; name: string; requestIds: string[]; }

export interface RequestTestResult {
  requestId: string; requestName: string;
  status: number | null; error?: string;
  passed: number; failed: number; details: AssertionResult[];
}

export interface MockEndpoint {
  id: string; method: HttpMethod; path: string; status: number; body: string;
}

/** Read a value from parsed JSON by dot path, supporting items[0].id style segments. */
export function getJsonValue(parsed: unknown, path: string): unknown {
  let current: unknown = parsed;
  const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (current === null || typeof current !== 'object') { return undefined; }
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

function asText(value: unknown): string {
  if (value === undefined) { return '<missing>'; }
  if (typeof value === 'string') { return value; }
  try { return JSON.stringify(value); } catch { return String(value); }
}

function headerValue(headers: HeaderPair[], name: string): string | undefined {
  const found = headers.find((h) => h.key.toLowerCase() === name.toLowerCase());
  return found ? found.value : undefined;
}

/** Evaluate one assertion against a finished HTTP result. Never throws. */
export function evaluateAssertion(result: HttpResult, assertion: Assertion): AssertionResult {
  try {
    switch (assertion.kind) {
      case 'status': {
        const passed = result.status === Number(assertion.expected);
        return { assertion, passed, message: passed ? `status is ${result.status}` : `expected status ${assertion.expected}, got ${result.status}` };
      }
      case 'timeUnder': {
        const passed = result.timeMs < Number(assertion.expected);
        return { assertion, passed, message: passed ? `${result.timeMs}ms < ${assertion.expected}ms` : `${result.timeMs}ms is not under ${assertion.expected}ms` };
      }
      case 'jsonEquals':
      case 'jsonContains': {
        let parsed: unknown;
        try { parsed = JSON.parse(result.bodyText); } catch { return { assertion, passed: false, message: 'response body is not valid JSON' }; }
        const value = getJsonValue(parsed, assertion.path || '');
        if (value === undefined) { return { assertion, passed: false, message: `JSON path '${assertion.path || ''}' not found` }; }
        const text = asText(value);
        const passed = assertion.kind === 'jsonEquals' ? text === assertion.expected : text.includes(assertion.expected);
        return { assertion, passed, message: passed ? `${assertion.path || ''} = ${text}` : `${assertion.path || ''} is ${text}, expected ${assertion.kind === 'jsonEquals' ? 'exactly' : 'containing'} '${assertion.expected}'` };
      }
      case 'headerEquals':
      case 'headerContains': {
        const value = headerValue(result.headers, assertion.headerName || '');
        if (value === undefined) { return { assertion, passed: false, message: `header '${assertion.headerName || ''}' not present` }; }
        const passed = assertion.kind === 'headerEquals' ? value === assertion.expected : value.includes(assertion.expected);
        return { assertion, passed, message: passed ? `${assertion.headerName}: ${value}` : `${assertion.headerName} is '${value}', expected ${assertion.kind === 'headerEquals' ? 'exactly' : 'containing'} '${assertion.expected}'` };
      }
      case 'bodyContains': {
        const passed = result.bodyText.includes(assertion.expected);
        return { assertion, passed, message: passed ? `body contains '${assertion.expected}'` : `body does not contain '${assertion.expected}'` };
      }
      case 'schema': {
        const checked = validateResponseAgainstSchema(result.bodyText, assertion.expected);
        if (checked.parseError) { return { assertion, passed: false, message: checked.parseError }; }
        return {
          assertion, passed: checked.valid,
          message: checked.valid ? 'response matches the JSON Schema' : `schema mismatches: ${checked.errors.join('; ')}`,
        };
      }
      default:
        return { assertion, passed: false, message: 'unknown assertion kind' };
    }
  } catch (err) {
    return { assertion, passed: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function evaluateAssertions(result: HttpResult, assertions: Assertion[]): AssertionResult[] {
  return assertions.map((a) => evaluateAssertion(result, a));
}

/** Build starter assertions from a real response: status + primitive top-level JSON fields (max 5). */
export function generateAssertionsFromResponse(result: HttpResult): Assertion[] {
  const out: Assertion[] = [{ id: newId('as'), kind: 'status', expected: String(result.status) }];
  try {
    const parsed = JSON.parse(result.bodyText) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of Object.keys(parsed).slice(0, 5)) {
        const value = parsed[key];
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          out.push({ id: newId('as'), kind: 'jsonEquals', path: key, expected: asText(value) });
        }
      }
    }
  } catch { /* non-JSON body: status assertion alone is still useful */ }
  return out;
}

/** Find a mock for a method + path (query string ignored, trailing slash ignored). */
export function findMock(mocks: MockEndpoint[], method: string, rawPath: string): MockEndpoint | undefined {
  const norm = (s: string) => {
    const noQuery = s.split('?')[0];
    return noQuery.length > 1 && noQuery.endsWith('/') ? noQuery.slice(0, -1) : noQuery;
  };
  const path = norm(rawPath);
  return mocks.find((m) => m.method === method && norm(m.path) === path);
}

// --- Import: ApiDiya native JSON, Postman v2.1 JSON, OpenAPI 3 JSON ---

function toMethod(value: unknown): HttpMethod {
  const m = String(value || 'GET').toUpperCase();
  return (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).includes(m as HttpMethod) ? (m as HttpMethod) : 'GET';
}

function importRequestFromPostman(item: Record<string, unknown>, collectionId: string): ApiRequest | null {
  const req = item.request as Record<string, unknown> | string | undefined;
  if (!req || typeof req === 'string') { return null; }
  const urlRaw = req.url;
  const url = typeof urlRaw === 'string' ? urlRaw : ((urlRaw as Record<string, unknown> | undefined)?.raw as string | undefined) || '';
  if (!url) { return null; }
  const headers = Array.isArray(req.header)
    ? (req.header as Array<Record<string, unknown>>).filter((h) => h.key).map((h) => `${h.key}: ${h.value ?? ''}`).join('\n')
    : '';
  const bodyRaw = (req.body as Record<string, unknown> | undefined)?.raw;
  return {
    id: newId('req'), name: String(item.name || 'Imported Request'),
    method: toMethod(req.method), url, headersText: headers, queryText: '',
    authType: 'none', authValue: '', authKeyName: 'X-API-Key',
    body: typeof bodyRaw === 'string' ? bodyRaw : '', collectionId,
  };
}

function collectPostmanItems(items: unknown[], out: ApiRequest[], collectionId: string): void {
  for (const item of items as Array<Record<string, unknown>>) {
    if (Array.isArray(item.item)) { collectPostmanItems(item.item, out, collectionId); }
    else {
      const r = importRequestFromPostman(item, collectionId);
      if (r) { out.push(r); }
    }
  }
}

/**
 * Parse pasted JSON into collections. Accepts:
 *  - ApiDiya native: { apidiya: 1, collections: [...] }
 *  - Postman v2.1: { info: { schema: ...postman... }, item: [...] }
 *  - OpenAPI 3 JSON: { openapi: '3.x', paths: {...} }
 * Throws a plain Error with a readable message on bad input.
 */
export function parseImportedCollections(text: string): ApiCollection[] {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error('That text is not valid JSON. Paste a full JSON document.'); }
  if (!json || typeof json !== 'object') { throw new Error('Expected a JSON object at the top level.'); }
  const obj = json as Record<string, unknown>;

  if (Array.isArray(obj.collections)) {
    // ApiDiya native export (or a plain { collections: [...] } document).
    const collections: ApiCollection[] = [];
    for (const raw of obj.collections as Array<Record<string, unknown>>) {
      const id = newId('col');
      const requests: ApiRequest[] = [];
      for (const r of (Array.isArray(raw.requests) ? raw.requests : []) as Array<Record<string, unknown>>) {
        if (typeof r.url !== 'string' || !r.url) { continue; }
        requests.push({
          id: newId('req'), name: String(r.name || 'Imported Request'), method: toMethod(r.method),
          url: r.url, headersText: String(r.headersText || ''), queryText: String(r.queryText || ''),
          authType: 'none', authValue: '', authKeyName: 'X-API-Key',
          body: String(r.body || ''), collectionId: id,
          assertions: Array.isArray(r.assertions) ? (r.assertions as Assertion[]) : undefined,
          jsonSchema: typeof r.jsonSchema === 'string' && r.jsonSchema.trim() ? r.jsonSchema : undefined,
        });
      }
      collections.push({ id, name: String(raw.name || 'Imported Collection'), requests });
    }
    if (collections.length === 0) { throw new Error('No collections found in that JSON.'); }
    return collections;
  }

  if (Array.isArray(obj.item)) {
    // Postman collection (single collection document).
    const id = newId('col');
    const requests: ApiRequest[] = [];
    collectPostmanItems(obj.item, requests, id);
    return [{ id, name: String((obj.info as Record<string, unknown> | undefined)?.name || 'Imported Collection'), requests }];
  }

  if (typeof obj.openapi === 'string' && obj.paths && typeof obj.paths === 'object') {
    // OpenAPI 3: one collection per tag (first tag wins), untagged go to "OpenAPI".
    const byTag = new Map<string, ApiRequest[]>();
    const colIdByTag = new Map<string, string>();
    const ensureTag = (tag: string): string => {
      if (!colIdByTag.has(tag)) { colIdByTag.set(tag, newId('col')); byTag.set(tag, []); }
      return colIdByTag.get(tag) as string;
    };
    for (const [pathName, pathItem] of Object.entries(obj.paths as Record<string, Record<string, unknown>>)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) { continue; }
        const op = (operation || {}) as Record<string, unknown>;
        const tag = Array.isArray(op.tags) && op.tags.length > 0 ? String(op.tags[0]) : 'OpenAPI';
        const colId = ensureTag(tag);
        (byTag.get(tag) as ApiRequest[]).push({
          id: newId('req'), name: String(op.operationId || op.summary || `${method.toUpperCase()} ${pathName}`),
          method: toMethod(method), url: `{{baseUrl}}${pathName}`, headersText: 'Content-Type: application/json',
          queryText: '', authType: 'none', authValue: '', authKeyName: 'X-API-Key', body: '', collectionId: colId,
        });
      }
    }
    return [...colIdByTag.entries()].map(([tag, id]) => ({ id, name: tag, requests: byTag.get(tag) as ApiRequest[] }));
  }

  throw new Error('Unrecognised format. Export from ApiDiya, or paste a Postman v2.1 collection or an OpenAPI 3 JSON document.');
}

// ---------------------------------------------------------------------------
// v0.2.3: code snippets (curl / fetch / Python) and SSE parsing.
// Pure: no vscode import. Snippets are generated as text only — nothing is
// executed. A snippet for a request with auth set WILL contain its token,
// exactly as Postman's code generation does; the sidebar warns about that.
// ---------------------------------------------------------------------------

export type SnippetKind = 'curl' | 'fetch' | 'python';

/** Wrap a string in POSIX single quotes, escaping embedded single quotes. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A JSON string literal doubles as a valid JS and Python string literal. */
function quoted(s: string): string { return JSON.stringify(s); }

/**
 * Generate a code snippet for a request. `url` must already be final
 * (variables substituted, query params appended) and `headers` already
 * built (auth included). Bodies are included only for non-GET/DELETE.
 */
export function generateSnippet(kind: SnippetKind, method: HttpMethod, url: string, headers: HeaderPair[], body: string): string {
  const hasBody = method !== 'GET' && method !== 'DELETE' && body !== '';
  if (kind === 'curl') {
    const parts = [`curl -X ${method} ${shellQuote(url)}`];
    for (const h of headers) { parts.push(`  -H ${shellQuote(`${h.key}: ${h.value}`)}`); }
    if (hasBody) { parts.push(`  --data ${shellQuote(body)}`); }
    return parts.join(' \\\n');
  }
  if (kind === 'fetch') {
    const lines = [`const response = await fetch(${quoted(url)}, {`, `  method: ${quoted(method)},`];
    if (headers.length > 0) {
      lines.push(`  headers: {${headers.map((h) => `\n    ${quoted(h.key)}: ${quoted(h.value)}`).join(',')}\n  },`);
    }
    if (hasBody) { lines.push(`  body: ${quoted(body)},`); }
    lines.push('});');
    return lines.join('\n');
  }
  // python (requests library)
  const lines = ['import requests', '', `url = ${quoted(url)}`];
  if (headers.length > 0) {
    lines.push(`headers = {${headers.map((h) => `\n    ${quoted(h.key)}: ${quoted(h.value)}`).join(',')}\n}`);
  } else {
    lines.push('headers = {}');
  }
  lines.push(`response = requests.request(${quoted(method)}, url, headers=headers${hasBody ? `, data=${quoted(body)}` : ''})`);
  lines.push('print(response.status_code)');
  lines.push('print(response.text)');
  return lines.join('\n');
}

// --- SSE parsing ---------------------------------------------------------
// Parses a Server-Sent Events stream incrementally: feed() accepts arbitrary
// chunks (a chunk may split an event) and returns only complete events.
// Per the SSE spec: lines are field:value (leading space after ':' stripped),
// ':' lines are comments, a blank line dispatches the event, and data lines
// join with '\n'.

export interface SseEvent { event: string; data: string; id?: string; }

export class SseParser {
  private buffer = '';
  private dataLines: string[] = [];
  private eventName = 'message';
  private lastId: string | undefined;

  feed(chunk: string): SseEvent[] {
    const out: SseEvent[] = [];
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) { line = line.slice(0, -1); }
      if (line === '') {
        if (this.dataLines.length > 0) {
          out.push({ event: this.eventName, data: this.dataLines.join('\n'), id: this.lastId });
        }
        this.dataLines = [];
        this.eventName = 'message';
        continue;
      }
      if (line.startsWith(':')) { continue; }
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) { value = value.slice(1); }
      if (field === 'data') { this.dataLines.push(value); }
      else if (field === 'event') { this.eventName = value; }
      else if (field === 'id' && !value.includes('\0')) { this.lastId = value; }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// v0.2.5: Markdown documentation for a collection (used by the MCP
// apidiya_generate_docs tool). Pure: data in, Markdown text out. Auth is
// described by type only — no token or key value is ever included.
// ---------------------------------------------------------------------------

/** Generate Markdown docs for one collection: requests, methods, URLs, auth type. */
export function generateCollectionDocs(collection: ApiCollection): string {
  const lines = [`# ${collection.name}`, ''];
  if (collection.requests.length === 0) {
    lines.push('_This collection has no requests yet._');
    return lines.join('\n');
  }
  lines.push('| Request | Method | URL | Auth |');
  lines.push('|---|---|---|---|');
  for (const r of collection.requests) {
    lines.push(`| ${r.name} | ${r.method} | \`${r.url}\` | ${r.authType} |`);
  }
  lines.push('');
  for (const r of collection.requests) {
    lines.push(`## ${r.name}`);
    lines.push('');
    lines.push(`- **Method:** ${r.method}`);
    lines.push(`- **URL:** \`${r.url}\``);
    lines.push(`- **Auth:** ${r.authType}`);
    // Redact secret header values: a token pasted into the headers box
    // must never end up in generated docs.
    const headers = redactHeaders(parseHeaders(r.headersText));
    if (headers.length > 0) {
      lines.push(`- **Headers:** ${headers.map((h) => `${h.key}: ${h.value}`).join(', ')}`);
    }
    if (r.queryText.trim()) {
      lines.push(`- **Query params:** ${r.queryText.split(/\r?\n/).filter(Boolean).join(', ')}`);
    }
    if (r.body.trim()) {
      lines.push('- **Body:**');
      lines.push('```json');
      lines.push(r.body);
      lines.push('```');
    }
    if (r.assertions && r.assertions.length > 0) {
      lines.push(`- **Assertions:** ${r.assertions.length} (${r.assertions.map((a) => a.kind).join(', ')})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// v0.3.0: JSON Schema response validation, data-driven collection runs,
// and import from cURL. All pure: no vscode import, nothing executed.
// Schemas and data files are treated as data only. A data row's values are
// substituted into {{variables}} exactly like environment variables, and
// never stored anywhere — rows live only for the duration of the run.
// ---------------------------------------------------------------------------

// --- JSON Schema validation ----------------------------------------------
// A small, dependency-free validator for the subset of JSON Schema most
// APIs actually use: type, required, properties, items, enum, minimum /
// maximum, minLength / maxLength, pattern, minItems / maxItems, and
// additionalProperties: false. Unsupported keywords ($ref, allOf/anyOf/
// oneOf, format) are reported as a mismatch rather than silently ignored,
// so a schema that looks validated is never quietly half-checked.

function schemaTypeOf(value: unknown): string {
  if (value === null) { return 'null'; }
  if (Array.isArray(value)) { return 'array'; }
  if (typeof value === 'number') { return Number.isInteger(value) ? 'integer' : 'number'; }
  return typeof value;
}

function typeMatches(value: unknown, expected: string): boolean {
  if (expected === 'number') { return typeof value === 'number'; }
  if (expected === 'integer') { return typeof value === 'number' && Number.isInteger(value); }
  return schemaTypeOf(value) === expected;
}

/** Validate a parsed JSON value against a parsed schema. Returns mismatch messages (empty = valid). */
export function validateJsonSchema(value: unknown, schema: unknown, path = '$'): string[] {
  const errors: string[] = [];
  if (schema === true) { return errors; }
  if (schema === false) { return [`${path}: value is not allowed by this schema`]; }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return [`${path}: schema is not a valid JSON Schema object`];
  }
  const s = schema as Record<string, unknown>;

  if (s.$ref !== undefined) { errors.push(`${path}: $ref is not supported — inline the schema instead`); }
  for (const kw of ['allOf', 'anyOf', 'oneOf', 'not']) {
    if (s[kw] !== undefined) { errors.push(`${path}: ${kw} is not supported by this validator`); }
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${path}: expected type ${types.join(' or ')}, got ${schemaTypeOf(value)}`);
      return errors; // Further keyword checks would be misleading on the wrong type.
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    errors.push(`${path}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`);
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) { errors.push(`${path}: ${value} is below minimum ${s.minimum}`); }
    if (typeof s.maximum === 'number' && value > s.maximum) { errors.push(`${path}: ${value} is above maximum ${s.maximum}`); }
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) { errors.push(`${path}: ${value} is not above exclusiveMinimum ${s.exclusiveMinimum}`); }
    if (s.exclusiveMinimum === true && typeof s.minimum === 'number' && value <= s.minimum) { errors.push(`${path}: ${value} is not above minimum ${s.minimum}`); }
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) { errors.push(`${path}: ${value} is not below exclusiveMaximum ${s.exclusiveMaximum}`); }
    if (s.exclusiveMaximum === true && typeof s.maximum === 'number' && value >= s.maximum) { errors.push(`${path}: ${value} is not below maximum ${s.maximum}`); }
  }
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) { errors.push(`${path}: string length ${value.length} is below minLength ${s.minLength}`); }
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) { errors.push(`${path}: string length ${value.length} exceeds maxLength ${s.maxLength}`); }
    if (typeof s.pattern === 'string') {
      try {
        if (!new RegExp(s.pattern).test(value)) { errors.push(`${path}: "${value}" does not match pattern ${s.pattern}`); }
      } catch { errors.push(`${path}: schema pattern ${s.pattern} is not a valid regular expression`); }
    }
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) { errors.push(`${path}: array has ${value.length} item(s), below minItems ${s.minItems}`); }
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) { errors.push(`${path}: array has ${value.length} item(s), above maxItems ${s.maxItems}`); }
    if (s.items && typeof s.items === 'object') {
      value.forEach((item, i) => errors.push(...validateJsonSchema(item, s.items, `${path}[${i}]`)));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(s.required)) {
      for (const key of s.required as string[]) {
        if (!(key in obj) || obj[key] === undefined) { errors.push(`${path}: missing required property '${key}'`); }
      }
    }
    const props = (s.properties && typeof s.properties === 'object' ? s.properties : {}) as Record<string, unknown>;
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) { errors.push(...validateJsonSchema(obj[key], sub, `${path}.${key}`)); }
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) { errors.push(`${path}: additional property '${key}' is not allowed`); }
      }
    }
  }
  return errors;
}

export interface SchemaCheckResult { valid: boolean; errors: string[]; parseError?: string; }

/** Validate a response body against a JSON Schema given as text. Never throws. */
export function validateResponseAgainstSchema(bodyText: string, schemaText: string): SchemaCheckResult {
  let parsedBody: unknown;
  try { parsedBody = JSON.parse(bodyText); } catch { return { valid: false, errors: [], parseError: 'response body is not valid JSON, so it cannot be checked against a JSON Schema' }; }
  let schema: unknown;
  try { schema = JSON.parse(schemaText); } catch { return { valid: false, errors: [], parseError: 'the JSON Schema itself is not valid JSON — fix the schema and try again' }; }
  const errors = validateJsonSchema(parsedBody, schema);
  return { valid: errors.length === 0, errors };
}

/** Evaluate the request's attached JSON Schema (if any) against a response. Returns null when no schema is set. */
export function evaluateJsonSchemaAssertion(result: HttpResult, jsonSchema: string | undefined): AssertionResult | null {
  if (!jsonSchema || !jsonSchema.trim()) { return null; }
  const schemaAssertion: Assertion = { id: 'as_schema', kind: 'schema', expected: jsonSchema };
  return evaluateAssertion(result, schemaAssertion);
}

// --- Data-driven runs ------------------------------------------------------
// Parse a data file into rows: CSV (first line = headers) or JSON (an array
// of objects, { "rows": [...] }, or a single object = one row). All values
// become strings, because they are substituted into {{variables}} as text.
// Throws a plain Error with a readable message on bad input.

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else { cur += ch; }
    } else if (ch === '"') { inQuotes = true; }
    else if (ch === ',') { out.push(cur); cur = ''; }
    else { cur += ch; }
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

export function parseDataRows(text: string): Array<Record<string, string>> {
  const trimmed = text.trim();
  if (!trimmed) { throw new Error('The data file is empty. Paste CSV (first line = column names) or a JSON array of objects.'); }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let json: unknown;
    try { json = JSON.parse(trimmed); } catch { throw new Error('That text starts like JSON but is not valid JSON.'); }
    let arr: unknown = json;
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const obj = json as Record<string, unknown>;
      if (Array.isArray(obj.rows)) { arr = obj.rows; }
      else { arr = [json]; }
    }
    if (!Array.isArray(arr)) { throw new Error('JSON data must be an array of objects, or an object with a "rows" array.'); }
    if (arr.length === 0) { throw new Error('The JSON data has no rows.'); }
    return arr.map((row, i) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`Row ${i + 1} is not an object — every row must be an object of column names to values.`);
      }
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        out[k] = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      }
      return out;
    });
  }
  // CSV
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) { throw new Error('CSV data needs a header line and at least one data row.'); }
  const headers = parseCsvLine(lines[0]);
  if (headers.some((h) => !h)) { throw new Error('CSV header line has an empty column name.'); }
  return lines.slice(1).map((line, i) => {
    const cells = parseCsvLine(line);
    if (cells.length !== headers.length) {
      throw new Error(`CSV row ${i + 2} has ${cells.length} value(s) but the header has ${headers.length} column(s).`);
    }
    const row: Record<string, string> = {};
    headers.forEach((h, j) => { row[h] = cells[j]; });
    return row;
  });
}

// --- Import from cURL ------------------------------------------------------
// Parse a cURL command into a request. This is the reverse of the code
// snippet export: paste what Postman / a browser / a doc gave you and get
// the request back. Tokenising honours single quotes, double quotes,
// backslash escapes and line continuations, so pasted multi-line commands
// work as-is. Auth from -u/--user becomes Basic auth; --data without -X
// implies POST, as curl does. Unknown flags are skipped, never executed.

function tokenizeCurl(text: string): string[] {
  const tokens: string[] = [];
  let cur = '', inSingle = false, inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && !inSingle) {
      const next = text[i + 1];
      if (next === '\n' || next === '\r') { i++; continue; } // line continuation
      if (next !== undefined) { cur += next; i++; continue; }
      continue;
    }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
      if (cur !== '') { tokens.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur !== '') { tokens.push(cur); }
  return tokens;
}

export interface ParsedCurl {
  method: HttpMethod; url: string; headersText: string;
  body: string; authType: 'none' | 'basic'; authValue: string;
}

export function parseCurlCommand(text: string): ParsedCurl {
  const trimmed = text.trim();
  if (!trimmed) { throw new Error('Paste a cURL command first.'); }
  const tokens = tokenizeCurl(trimmed);
  const start = tokens[0] === 'curl' ? 1 : 0;
  if (tokens.length <= start) { throw new Error('That does not look like a cURL command — it should start with curl and include a URL.'); }
  // Flags that take a separate value argument (curl -X POST style).
  const valueFlags = new Set(['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--json', '-u', '--user', '-A', '--user-agent', '-b', '--cookie', '--url', '-o', '--output', '--max-time', '--connect-timeout']);
  let method: HttpMethod | undefined;
  let url = '';
  const headers: HeaderPair[] = [];
  const dataParts: string[] = [];
  let authValue = '';
  const skipValueFlags = new Set(['-o', '--output', '--max-time', '--connect-timeout']);
  for (let i = start; i < tokens.length; i++) {
    const tok = tokens[i];
    let flag = tok, inlineValue: string | undefined;
    const eq = tok.indexOf('=');
    if (tok.startsWith('--') && eq > 2) { flag = tok.slice(0, eq); inlineValue = tok.slice(eq + 1); }
    const takeValue = (): string => {
      if (inlineValue !== undefined) { return inlineValue; }
      i++;
      if (i >= tokens.length) { throw new Error(`cURL flag ${flag} needs a value.`); }
      return tokens[i];
    };
    if (flag === '-X' || flag === '--request') {
      const m = takeValue().toUpperCase();
      method = (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).includes(m as HttpMethod) ? (m as HttpMethod) : undefined;
      if (!method) { throw new Error(`Unsupported HTTP method in the cURL command: ${m}. ApiDiya supports GET, POST, PUT, PATCH and DELETE.`); }
    } else if (flag === '-H' || flag === '--header') {
      const h = takeValue();
      const colon = h.indexOf(':');
      if (colon > 0) { headers.push({ key: h.slice(0, colon).trim(), value: h.slice(colon + 1).trim() }); }
    } else if (flag === '-d' || flag === '--data' || flag === '--data-raw' || flag === '--data-binary' || flag === '--data-ascii') {
      dataParts.push(takeValue());
    } else if (flag === '--json') {
      dataParts.push(takeValue());
      if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) {
        headers.push({ key: 'Content-Type', value: 'application/json' });
      }
    } else if (flag === '-u' || flag === '--user') {
      authValue = takeValue();
    } else if (flag === '-A' || flag === '--user-agent') {
      headers.push({ key: 'User-Agent', value: takeValue() });
    } else if (flag === '-b' || flag === '--cookie') {
      headers.push({ key: 'Cookie', value: takeValue() });
    } else if (flag === '--url') {
      url = takeValue();
    } else if (skipValueFlags.has(flag) || valueFlags.has(flag)) {
      takeValue(); // known flag whose value we do not need (output file, timeouts)
    } else if (flag.startsWith('-') && flag !== '-') {
      // Unknown flag (e.g. -k, -L, --compressed, -s, -i): skipped, never executed.
      continue;
    } else if (!url) {
      url = tok;
    }
    // Any further bare token after the URL is ignored (e.g. a trailing comment token).
  }
  if (!url) { throw new Error('No URL found in that cURL command.'); }
  if (!/^https?:\/\//i.test(url) && !url.startsWith('{{')) {
    throw new Error(`The URL "${url}" does not look like an http(s) URL.`);
  }
  return {
    method: method || (dataParts.length > 0 ? 'POST' : 'GET'),
    url,
    headersText: headers.map((h) => `${h.key}: ${h.value}`).join('\n'),
    body: dataParts.join('&'),
    authType: authValue ? 'basic' : 'none',
    authValue,
  };
}
