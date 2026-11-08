// Pure MCP (Model Context Protocol) JSON-RPC dispatch for ApiDiya v0.3.0.
// This file intentionally has NO vscode import, so it can be unit-tested
// with plain Node. The extension host (extension.ts) supplies the context:
// live collections from local state, request execution via sendHttp, and
// the local Ollama helpers for the AI tools. Transport is Streamable HTTP
// on localhost (see extension.ts), not stdio: a stdio server process could
// not read the editor's local state, so the in-editor server is what keeps
// the tools honest about saved collections.
//
// The 10 tools from the PDF spec are here (with the apidiya_ prefix), plus
// the 2 earlier extras (list requests, send one-off request): 12 in total.
// Tool results never include secrets: auth tokens/keys are never returned,
// and generated docs describe auth by type only.

import { Assertion } from './api';

export interface McpSendResult {
  status?: number; statusText?: string; bodyText?: string; error?: string;
}

export interface McpCollectionSummary {
  id: string; name: string;
  requests: Array<{ id: string; name: string; method: string; url: string }>;
}

export interface McpLastResponse {
  status: number | null; statusText: string; timeMs: number; bodyText: string; error?: string;
}

export interface McpRequestInput {
  id?: string; collectionId?: string; name?: string; method?: string; url?: string;
  headersText?: string; queryText?: string; authType?: string; authValue?: string;
  authKeyName?: string; body?: string;
}

export interface McpGeneratedTests {
  source: 'ai' | 'rule-based'; kept: number; dropped: number;
  assertions: Assertion[]; note?: string;
}

export interface McpSuiteSummary { id: string; name: string; requestIds: string[]; }

export interface McpSuiteRun {
  suiteName: string; passed: number; failed: number;
  results: Array<{ requestName: string; status: number | null; passed: number; failed: number; error?: string }>;
}

export interface McpContext {
  version: string;
  listCollections(): McpCollectionSummary[];
  sendRequest(requestId: string): Promise<McpSendResult>;
  sendCustom(method: string, url: string, headersText: string, body: string): Promise<McpSendResult>;
  createRequest(collectionId: string, name: string, method: string, url: string, headersText: string, body: string): Promise<{ id: string } | { error: string }>;
  saveRequest(input: McpRequestInput): Promise<{ id: string } | { error: string }>;
  getLastResponse(requestId: string): McpLastResponse | null;
  importOpenApi(text: string): Promise<{ added: number; collections: string[] } | { error: string }>;
  generateTests(requestId: string): Promise<McpGeneratedTests | { error: string }>;
  listSuites(): McpSuiteSummary[];
  runSuite(nameOrId: string): Promise<McpSuiteRun | { error: string }>;
  explainFailure(requestId: string): Promise<{ source: 'ai' | 'rule-based'; text: string } | { error: string }>;
  generateDocs(collectionId: string): { text: string } | { error: string };
}

const TOOLS = [
  {
    name: 'apidiya_list_collections',
    description: 'List ApiDiya collections with their saved requests (ids, names, methods, URLs). No secrets are ever returned.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'apidiya_list_requests',
    description: 'List the requests in one collection by collectionId.',
    inputSchema: { type: 'object', properties: { collectionId: { type: 'string' } }, required: ['collectionId'] },
  },
  {
    name: 'apidiya_send_request',
    description: 'Send a saved ApiDiya request by requestId, exactly as stored, and return its status and body.',
    inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] },
  },
  {
    name: 'apidiya_send_custom',
    description: 'Send a one-off HTTP request (method, url, headers as "Key: value" lines, body). Nothing is executed; the body is sent as data only.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string' }, url: { type: 'string' },
        headers: { type: 'string' }, body: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'apidiya_create_request',
    description: 'Create a request in a collection (by collection id or name): method, url, headers as "Key: value" lines, body. Returns the new request id. Does NOT send the request.',
    inputSchema: {
      type: 'object',
      properties: {
        collectionId: { type: 'string' }, name: { type: 'string' },
        method: { type: 'string' }, url: { type: 'string' },
        headers: { type: 'string' }, body: { type: 'string' },
      },
      required: ['collectionId', 'url'],
    },
  },
  {
    name: 'apidiya_save_request',
    description: 'Save (upsert) a request: update it when the id exists, create it when it does not. Pass id, collectionId (id or name), name, method, url, headers as "Key: value" lines, body. Returns the request id. Does NOT send the request.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }, collectionId: { type: 'string' }, name: { type: 'string' },
        method: { type: 'string' }, url: { type: 'string' },
        headers: { type: 'string' }, body: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'apidiya_get_response',
    description: 'Return the last stored response for a saved request by requestId (status, time in ms, body). If the request was never sent, it says so.',
    inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] },
  },
  {
    name: 'apidiya_import_openapi',
    description: 'Import an OpenAPI 3 JSON document (passed as the openapi text argument) into ApiDiya as new collections. Reports how many requests were added. Rejects anything that is not OpenAPI 3 JSON.',
    inputSchema: { type: 'object', properties: { openapi: { type: 'string' } }, required: ['openapi'] },
  },
  {
    name: 'apidiya_generate_tests',
    description: 'Generate test assertions for a saved request by requestId. Uses local AI (Ollama) when it is running, otherwise the rule-based starter assertions. The result says which source was used, and the assertions are saved on the request.',
    inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] },
  },
  {
    name: 'apidiya_run_tests',
    description: 'Run a saved test suite by suite id or name. Returns passed/failed counts and per-request results.',
    inputSchema: { type: 'object', properties: { suite: { type: 'string' } }, required: ['suite'] },
  },
  {
    name: 'apidiya_explain_failure',
    description: 'Explain the last failure of a saved request by requestId in plain words. Uses local AI (Ollama) when it is running, otherwise a rule-based explanation. The result says which source was used.',
    inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] },
  },
  {
    name: 'apidiya_generate_docs',
    description: 'Generate Markdown documentation for a collection (by collection id or name): requests, methods, URLs, auth type. Returns the Markdown as text. No secrets are included.',
    inputSchema: { type: 'object', properties: { collectionId: { type: 'string' } }, required: ['collectionId'] },
  },
];

function textResult(text: string, isError?: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (isError) { out.isError = true; }
  return out;
}

/**
 * Handle one JSON-RPC message. Returns a response object, or null for a
 * notification (no reply) or a request without an id. Never throws: a
 * handler failure becomes a -32603 error response when an id is present.
 */
export async function handleMcpMessage(
  msg: Record<string, unknown>, ctx: McpContext,
): Promise<Record<string, unknown> | null> {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    return msg && typeof msg.id !== 'undefined'
      ? { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid Request' } }
      : null;
  }
  const id = msg.id;
  const respond = (result: unknown): Record<string, unknown> | null =>
    id === undefined ? null : { jsonrpc: '2.0', id, result };
  const fail = (code: number, message: string): Record<string, unknown> | null =>
    id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } };
  const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
  const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;

  try {
    switch (msg.method) {
      case 'initialize':
        return respond({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'apidiya', version: ctx.version },
        });
      case 'ping':
        return respond({});
      case 'tools/list':
        return respond({ tools: TOOLS });
      case 'tools/call': {
        const name = String(params.name || '');
        if (name === 'apidiya_list_collections') {
          return respond(textResult(JSON.stringify(ctx.listCollections(), null, 2)));
        }
        if (name === 'apidiya_list_requests') {
          const col = ctx.listCollections().find((c) => c.id === args.collectionId);
          if (!col) { return fail(-32602, 'Unknown collectionId'); }
          return respond(textResult(JSON.stringify(col.requests, null, 2)));
        }
        if (name === 'apidiya_send_request') {
          const r = await ctx.sendRequest(String(args.requestId || ''));
          if (r.error) { return respond(textResult(`Error: ${r.error}`, true)); }
          return respond(textResult(`Status: ${r.status} ${r.statusText || ''}\n\n${r.bodyText || ''}`));
        }
        if (name === 'apidiya_send_custom') {
          const url = String(args.url || '');
          if (!url) { return fail(-32602, 'url is required'); }
          const r = await ctx.sendCustom(String(args.method || 'GET'), url, String(args.headers || ''), String(args.body || ''));
          if (r.error) { return respond(textResult(`Error: ${r.error}`, true)); }
          return respond(textResult(`Status: ${r.status} ${r.statusText || ''}\n\n${r.bodyText || ''}`));
        }
        if (name === 'apidiya_create_request') {
          const r = await ctx.createRequest(
            String(args.collectionId || ''), String(args.name || ''),
            String(args.method || 'GET'), String(args.url || ''),
            String(args.headers || ''), String(args.body || ''),
          );
          if ('error' in r) { return respond(textResult(`Error: ${r.error}`, true)); }
          return respond(textResult(`Created request ${r.id}. It was not sent.`));
        }
        if (name === 'apidiya_save_request') {
          const r = await ctx.saveRequest({
            id: args.id !== undefined ? String(args.id) : undefined,
            collectionId: args.collectionId !== undefined ? String(args.collectionId) : undefined,
            name: args.name !== undefined ? String(args.name) : undefined,
            method: args.method !== undefined ? String(args.method) : undefined,
            url: args.url !== undefined ? String(args.url) : undefined,
            headersText: args.headers !== undefined ? String(args.headers) : undefined,
            body: args.body !== undefined ? String(args.body) : undefined,
          });
          if ('error' in r) { return respond(textResult(`Error: ${r.error}`, true)); }
          return respond(textResult(`Saved request ${r.id}. It was not sent.`));
        }
        if (name === 'apidiya_get_response') {
          const r = ctx.getLastResponse(String(args.requestId || ''));
          if (!r) { return respond(textResult('No response recorded for that request yet — it has never been sent.')); }
          const body = (r.bodyText || '').slice(0, 4000);
          const tail = (r.bodyText || '').length > 4000 ? '\n…(body truncated to 4000 characters)' : '';
          if (r.error) { return respond(textResult(`Last send failed before a response arrived: ${r.error}`)); }
          return respond(textResult(`Status: ${r.status} ${r.statusText || ''}\nTime: ${r.timeMs}ms\n\n${body}${tail}`));
        }
        if (name === 'apidiya_import_openapi') {
          const r = await ctx.importOpenApi(String(args.openapi || ''));
          if ('error' in r) { return respond(textResult(`Import failed: ${r.error}`, true)); }
          return respond(textResult(`Imported ${r.added} request(s) into ${r.collections.length} collection(s): ${r.collections.join(', ')}`));
        }
        if (name === 'apidiya_generate_tests') {
          const r = await ctx.generateTests(String(args.requestId || ''));
          if ('error' in r) { return respond(textResult(`Error: ${r.error}`, true)); }
          const lines = [
            `Generated ${r.kept} assertion(s) from ${r.source === 'ai' ? 'local AI (Ollama)' : 'rule-based starters'}${r.dropped ? ` (${r.dropped} invalid suggestion(s) dropped)` : ''}.`,
            ...(r.note ? [r.note] : []),
            '',
            JSON.stringify(r.assertions, null, 2),
          ];
          return respond(textResult(lines.join('\n')));
        }
        if (name === 'apidiya_run_tests') {
          const r = await ctx.runSuite(String(args.suite || ''));
          if ('error' in r) { return respond(textResult(`Error: ${r.error}`, true)); }
          const lines = [
            `Suite "${r.suiteName}": ${r.passed} passed, ${r.failed} failed.`,
            ...r.results.map((x) => `- ${x.requestName}: ${x.passed} passed, ${x.failed} failed${x.status !== null ? ` (HTTP ${x.status})` : ''}${x.error ? ` — error: ${x.error}` : ''}`),
          ];
          return respond(textResult(lines.join('\n')));
        }
        if (name === 'apidiya_explain_failure') {
          const r = await ctx.explainFailure(String(args.requestId || ''));
          if ('error' in r) { return respond(textResult(`Error: ${r.error}`, true)); }
          return respond(textResult(`[${r.source === 'ai' ? 'Local AI (Ollama)' : 'Rule-based'} explanation]\n\n${r.text}`));
        }
        if (name === 'apidiya_generate_docs') {
          const r = ctx.generateDocs(String(args.collectionId || ''));
          if ('error' in r) { return respond(textResult(`Error: ${r.error}`, true)); }
          return respond(textResult(r.text));
        }
        return fail(-32602, `Unknown tool: ${name}`);
      }
      default:
        return msg.method.startsWith('notifications/') ? null : fail(-32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    return fail(-32603, err instanceof Error ? err.message : String(err));
  }
}
