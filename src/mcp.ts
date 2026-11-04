// Pure MCP (Model Context Protocol) JSON-RPC dispatch for ApiDiya v0.2.3.
// This file intentionally has NO vscode import, so it can be unit-tested
// with plain Node. The extension host (extension.ts) supplies the context:
// live collections from local state, and request execution via sendHttp.
// Transport is Streamable HTTP on localhost (see extension.ts), not stdio:
// a stdio server process could not read the editor's local state, so the
// in-editor server is what keeps the tools honest about saved collections.

export interface McpSendResult {
  status?: number; statusText?: string; bodyText?: string; error?: string;
}

export interface McpCollectionSummary {
  id: string; name: string;
  requests: Array<{ id: string; name: string; method: string; url: string }>;
}

export interface McpContext {
  version: string;
  listCollections(): McpCollectionSummary[];
  sendRequest(requestId: string): Promise<McpSendResult>;
  sendCustom(method: string, url: string, headersText: string, body: string): Promise<McpSendResult>;
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
        return fail(-32602, `Unknown tool: ${name}`);
      }
      default:
        return msg.method.startsWith('notifications/') ? null : fail(-32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    return fail(-32603, err instanceof Error ? err.message : String(err));
  }
}
