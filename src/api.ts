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
