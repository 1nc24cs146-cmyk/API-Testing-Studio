import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ApiCollection, ApiRequest, Assertion, Environment, HistoryEntry, HttpResult,
  MockEndpoint, RequestTestResult, SseParser, TestSuite, buildFinalUrl,
  buildHeaders, evaluateAssertions, evaluateJsonSchemaAssertion, findMock,
  generateAssertionsFromResponse,
  generateCollectionDocs, generateSnippet, newId, parseCurlCommand,
  parseDataRows, parseHeaders, parseImportedCollections, prettyPrint,
  redactHeaders, seedCollections, seedEnvironments, sendHttp, substituteVariables,
  validateResponseAgainstSchema,
} from './api';
import {
  DEFAULT_MODEL, DEFAULT_OLLAMA_URL, OllamaSettings,
  buildExplainPrompt, buildRequestGenPrompt, buildTestGenPrompt, callOllama,
  checkOllama, explainFailureRuleBased, generateAiMockBody, parseGeneratedAssertions, parseGeneratedRequest,
} from './ai';
import { McpContext, handleMcpMessage } from './mcp';

interface TestRun {
  id: string; suiteName: string; executedAt: string;
  passed: number; failed: number; results: RequestTestResult[];
}

interface State {
  collections: ApiCollection[];
  environments: Environment[];
  activeEnvId: string;
  history: HistoryEntry[];
  suites: TestSuite[];
  testRuns: TestRun[];
  mocks: MockEndpoint[];
}

const MAX_HISTORY = 100;

function randomNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) { out += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return out;
}

class ApiStudioProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private mockServer: http.Server | undefined;
  private mockPort = 0;
  // v0.2.3: local MCP server (Streamable HTTP, localhost only) + SSE stream.
  private mcpServer: http.Server | undefined;
  private mcpPort = 0;
  private sseController: AbortController | undefined;
  // v0.2.5: last response per saved request id (in memory only), for the
  // MCP apidiya_get_response / apidiya_generate_tests / apidiya_explain_failure
  // tools. Bodies are stored as received; tool output truncates them.
  private lastResponses = new Map<string, { result?: HttpResult; error?: string }>();
  constructor(private readonly context: vscode.ExtensionContext, private state: State) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    const nonce = randomNonce();
    const htmlPath = path.join(this.context.extensionPath, 'media', 'webview.html');
    view.webview.html = fs.readFileSync(htmlPath, 'utf8').replace(/__NONCE__/g, nonce);
    view.webview.onDidReceiveMessage((msg) => { void this.handleMessage(msg); });
    void this.fetchDownloadCount();
  }

  // Live download count for the sidebar, shown inside Antigravity/VS Code.
  // The editor's own Installation panel has no Downloads row and cannot be
  // changed by an extension, so the count lives here instead. It is read
  // from the Open VSX registry for this build's own publisher/name (so the
  // apidiya build shows the live apidiya listing count), and only this one
  // registry call is made — nothing else about the user is sent anywhere.
  private async fetchDownloadCount(): Promise<void> {
    const pkg = this.context.extension.packageJSON as { publisher?: string; name?: string };
    if (!pkg.publisher || !pkg.name) { return; }
    try {
      const res = await fetch(`https://open-vsx.org/api/${pkg.publisher}/${pkg.name}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) { return; }
      const data = await res.json() as { downloadCount?: number };
      if (typeof data.downloadCount === 'number') {
        this.view?.webview.postMessage({ type: 'downloadCount', count: data.downloadCount });
      }
    } catch { /* offline or registry unreachable: sidebar keeps its fallback text */ }
  }

  private async save(): Promise<void> {
    await this.context.globalState.update('apiStudio.state', this.state);
  }

  private postState(): void {
    this.view?.webview.postMessage({ type: 'state', state: this.state });
  }

  private envVars(): Record<string, string> {
    const env = this.state.environments.find((e) => e.id === this.state.activeEnvId);
    return env ? env.variables : {};
  }

  // v0.2.5: local AI settings (Ollama). Read from workspace configuration;
  // the sidebar edits them. Defaults: localhost Ollama, llama3.1:8b.
  private aiSettings(): OllamaSettings {
    const cfg = vscode.workspace.getConfiguration('apidiya.ai');
    return {
      url: String(cfg.get('ollamaUrl') || DEFAULT_OLLAMA_URL),
      model: String(cfg.get('model') || DEFAULT_MODEL),
    };
  }

  private recordLastResponse(id: string | undefined, entry: { result?: HttpResult; error?: string }): void {
    if (!id) { return; }
    if (this.lastResponses.size >= 200) {
      const first = this.lastResponses.keys().next().value;
      if (first) { this.lastResponses.delete(first); }
    }
    this.lastResponses.set(id, entry);
  }

  private static validMethod(m: string): ApiRequest['method'] {
    const upper = m.toUpperCase();
    return (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const).includes(upper as ApiRequest['method'])
      ? (upper as ApiRequest['method']) : 'GET';
  }

  private findCollection(idOrName: string): ApiCollection | undefined {
    return this.state.collections.find((c) => c.id === idOrName)
      || this.state.collections.find((c) => c.name.toLowerCase() === idOrName.toLowerCase());
  }

  // --- Local-only storage -----------------------------------------------
  // Everything ApiDiya stores lives on this device only:
  //  - collections, environments, suites, test runs, mocks, history:
  //    VS Code/Antigravity local globalState. We never call
  //    no sync keys are ever marked, so Settings Sync never uploads it to a cloud.
  //  - saved auth tokens/keys: the operating system's keychain via
  //    vscode SecretStorage (also on-device, encrypted by the OS), never
  //    in globalState and never in history.
  // There is no account, no cloud database, no telemetry and no analytics.
  // The only network traffic is the request you press Send/Run on, sent
  // to the URL you typed, the local mock server on your own machine, the
  // one Open VSX registry call for the sidebar download count, and (v0.2.5)
  // AI calls to the user's own Ollama server on localhost — never a cloud
  // model, and no API key anywhere.
  private secretKey(id: string): string { return `apidiya.auth.${id}`; }

  private async authFor(request: ApiRequest): Promise<ApiRequest> {
    if (request.authValue) { return request; }
    if (!request.id) { return request; }
    try {
      const secret = await this.context.secrets.get(this.secretKey(request.id));
      return secret ? { ...request, authValue: secret } : request;
    } catch { return request; }
  }

  private async saveAuthSecret(id: string, value: string): Promise<void> {
    // A blank auth field in the builder (the UI blanks it on load) must
    // NOT wipe a previously saved secret: only a non-blank value replaces it.
    if (!value) { return; }
    try { await this.context.secrets.store(this.secretKey(id), value); } catch { /* keychain unavailable: send still works from the builder value */ }
  }

  private async recordAndSend(method: ApiRequest['method'], url: string, headersText: string, queryText: string, body: string, auth: Pick<ApiRequest, 'authType' | 'authValue' | 'authKeyName'>, storeAsId?: string): Promise<void> {
    const request: ApiRequest = {
      id: newId('tmp'), name: '', method, url, headersText, queryText,
      authType: auth.authType, authValue: auth.authValue, authKeyName: auth.authKeyName,
      body, collectionId: '',
    };
    const finalUrl = buildFinalUrl(url, this.envVars(), queryText);
    const headers = buildHeaders(request);
    const started = Date.now();
    try {
      const result = await sendHttp(method, finalUrl, headers, body);
      this.recordLastResponse(storeAsId, { result });
      this.state.history.push({
        id: newId('hist'), method, url: finalUrl, status: result.status,
        durationMs: Date.now() - started, executedAt: new Date().toISOString(),
        headers: redactHeaders(headers),
      });
      this.trimHistory();
      await this.save();
      this.view?.webview.postMessage({ type: 'response', result, prettyBody: prettyPrint(result.bodyText) });
      this.postState();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.recordLastResponse(storeAsId, { error: message });
      this.state.history.push({
        id: newId('hist'), method, url: finalUrl, status: null,
        durationMs: Date.now() - started, executedAt: new Date().toISOString(),
        error: message, headers: redactHeaders(headers),
      });
      this.trimHistory();
      await this.save();
      this.view?.webview.postMessage({ type: 'response', error: message });
      this.postState();
    }
  }

  private async executeRequest(request: ApiRequest, extraVars: Record<string, string> = {}): Promise<{ result: HttpResult } | { error: string }> {
    const withAuth = await this.authFor(request);
    // v0.3.0: data-driven rows substitute {{variables}} into the URL,
    // headers, query params and body, on top of the active environment.
    const vars = { ...this.envVars(), ...extraVars };
    const substituted: ApiRequest = {
      ...withAuth,
      url: substituteVariables(withAuth.url, vars),
      headersText: substituteVariables(withAuth.headersText, vars),
      queryText: substituteVariables(withAuth.queryText, vars),
      body: substituteVariables(withAuth.body, vars),
    };
    const finalUrl = buildFinalUrl(substituted.url, vars, substituted.queryText);
    const headers = buildHeaders(substituted);
    try {
      const result = await sendHttp(substituted.method, finalUrl, headers, substituted.body);
      this.recordLastResponse(request.id, { result });
      return { result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.recordLastResponse(request.id, { error: message });
      return { error: message };
    }
  }

  // Run one suite and record the run (last 20 kept). Shared by the sidebar
  // handler and the MCP apidiya_run_tests tool. v0.3.0: extraVars lets a
  // data-driven run substitute one row's values per run; runLabel names
  // the recorded run (e.g. "Smoke — row 2"). A request's attached JSON
  // Schema, when set, is checked as an extra assertion on every run.
  private async runSuiteInternal(suite: TestSuite, extraVars: Record<string, string> = {}, runLabel?: string): Promise<{ suiteName: string; passed: number; failed: number; results: RequestTestResult[] }> {
    const results: RequestTestResult[] = [];
    for (const reqId of suite.requestIds) {
      const req = this.findRequest(reqId);
      if (!req) { continue; }
      const outcome = await this.executeRequest(req, extraVars);
      if ('error' in outcome) {
        results.push({ requestId: req.id, requestName: req.name, status: null, error: outcome.error, passed: 0, failed: 0, details: [] });
      } else {
        const details = evaluateAssertions(outcome.result, req.assertions || []);
        const schemaDetail = evaluateJsonSchemaAssertion(outcome.result, req.jsonSchema);
        if (schemaDetail) { details.push(schemaDetail); }
        results.push({
          requestId: req.id, requestName: req.name, status: outcome.result.status,
          passed: details.filter((d) => d.passed).length, failed: details.filter((d) => !d.passed).length, details,
        });
      }
    }
    const passed = results.reduce((n, r) => n + r.passed, 0);
    const failed = results.reduce((n, r) => n + r.failed, 0);
    this.state.testRuns.unshift({
      id: newId('run'), suiteName: runLabel || suite.name, executedAt: new Date().toISOString(), passed, failed, results,
    });
    this.state.testRuns = this.state.testRuns.slice(0, 20);
    await this.save();
    this.postState();
    return { suiteName: runLabel || suite.name, passed, failed, results };
  }

  private findRequest(id: string): ApiRequest | undefined {
    for (const col of this.state.collections) {
      const found = col.requests.find((r) => r.id === id);
      if (found) { return found; }
    }
    return undefined;
  }

  // --- v0.3.1: AI mock responses ----------------------------------------
  // A mock is tied to an endpoint by method + path. Its schema comes from
  // the saved request for that endpoint (jsonSchema, set by an OpenAPI
  // import or pasted by hand); an explicit request id wins when given.
  // The generated body is validated against the schema before it is
  // saved, so a broken mock is never stored. One clear message reports
  // the outcome — no error popup storm.
  private static normalisePath(raw: string): string {
    let s = raw.split('?')[0];
    s = s.replace(/^\{\{[^}]+\}\}/, ''); // strip a {{baseUrl}} prefix
    s = s.replace(/^https?:\/\/[^/]+/i, ''); // strip an origin
    if (s.length > 1 && s.endsWith('/')) { s = s.slice(0, -1); }
    return s || '/';
  }

  private findRequestForMock(mock: MockEndpoint): ApiRequest | undefined {
    const path = ApiStudioProvider.normalisePath(mock.path);
    const matches = this.state.collections.flatMap((c) => c.requests)
      .filter((r) => r.method === mock.method && ApiStudioProvider.normalisePath(r.url) === path);
    return matches.find((r) => r.jsonSchema && r.jsonSchema.trim()) || matches[0];
  }

  /** Generate + validate an AI mock body and save it on the mock. Only saves when the body is valid. */
  public async generateAiMockBodyFor(mock: MockEndpoint, requestId?: string): Promise<{ ok: boolean; body?: string; error?: string }> {
    const request = (requestId ? this.findRequest(requestId) : undefined)
      || this.findRequestForMock(mock);
    if (!request) {
      return { ok: false, error: `No saved request matches ${mock.method} ${mock.path}. Save a request for this endpoint (or import its OpenAPI spec) first, so the mock has a schema to generate against.` };
    }
    const result = await generateAiMockBody(this.aiSettings(), request, request.jsonSchema);
    if (!result.ok) { return { ok: false, error: result.error }; }
    mock.body = result.body;
    await this.save();
    this.postState();
    return { ok: true, body: result.body };
  }

  public stopMockServer(): void {
    if (this.mockServer) { this.mockServer.close(); this.mockServer = undefined; this.mockPort = 0; }
  }

  public stopMcpServer(): void {
    if (this.mcpServer) { this.mcpServer.close(); this.mcpServer = undefined; this.mcpPort = 0; }
  }

  public stopSse(): void {
    if (this.sseController) { this.sseController.abort(); this.sseController = undefined; }
  }

  private postMcpStatus(error?: string): void {
    this.view?.webview.postMessage({
      type: 'mcpStatus', running: !!this.mcpServer, port: this.mcpPort, error,
      config: this.mcpServer
        ? JSON.stringify({ mcpServers: { apidiya: { url: `http://localhost:${this.mcpPort}/mcp` } } }, null, 2)
        : '',
    });
  }

  // MCP context: live local state only. Tool results never include secrets:
  // list tools return ids/names/methods/URLs, and send uses the keychain
  // token exactly as a manual Send would — the tool output is status + body.
  // v0.2.5: all 12 tools (the spec's 10 + the 2 earlier extras). The AI
  // tools call the same local Ollama helpers as the sidebar; when Ollama
  // is down they fall back to the rule-based versions and say so.
  private mcpContext(): McpContext {
    return {
      version: '0.3.1',
      listCollections: () => this.state.collections.map((c) => ({
        id: c.id, name: c.name,
        requests: c.requests.map((r) => ({ id: r.id, name: r.name, method: r.method, url: r.url })),
      })),
      sendRequest: async (requestId: string) => {
        const req = this.findRequest(requestId);
        if (!req) { return { error: 'No saved request with that id' }; }
        const outcome = await this.executeRequest(req);
        return 'error' in outcome
          ? { error: outcome.error }
          : { status: outcome.result.status, statusText: outcome.result.statusText, bodyText: outcome.result.bodyText };
      },
      sendCustom: async (method: string, url: string, headersText: string, body: string) => {
        const m = ApiStudioProvider.validMethod(method);
        const request: ApiRequest = {
          id: newId('tmp'), name: '', method: m, url, headersText, queryText: '',
          authType: 'none', authValue: '', authKeyName: 'X-API-Key', body, collectionId: '',
        };
        const finalUrl = buildFinalUrl(url, this.envVars(), '');
        const headers = buildHeaders(request);
        try {
          const result = await sendHttp(m, finalUrl, headers, body);
          return { status: result.status, statusText: result.statusText, bodyText: result.bodyText };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
      createRequest: async (collectionId, name, method, url, headersText, body) => {
        const col = this.findCollection(collectionId);
        if (!col) { return { error: 'Unknown collection — pass a collection id or name' }; }
        if (!url.trim()) { return { error: 'url is required' }; }
        const req: ApiRequest = {
          id: newId('req'), name: name.trim() || 'Untitled Request',
          method: ApiStudioProvider.validMethod(method), url,
          headersText: headersText || '', queryText: '',
          authType: 'none', authValue: '', authKeyName: 'X-API-Key',
          body: body || '', collectionId: col.id,
        };
        col.requests.push(req);
        await this.save(); this.postState();
        return { id: req.id };
      },
      saveRequest: async (input) => {
        if (!input.url || !input.url.trim()) { return { error: 'url is required' }; }
        const method = ApiStudioProvider.validMethod(input.method || 'GET');
        const target = input.collectionId ? this.findCollection(input.collectionId) : undefined;
        if (input.collectionId && !target) { return { error: 'Unknown collection — pass a collection id or name' }; }
        if (input.id) {
          const existing = this.findRequest(input.id);
          if (existing) {
            existing.name = input.name ?? existing.name;
            existing.method = method;
            existing.url = input.url;
            existing.headersText = input.headersText ?? existing.headersText;
            existing.queryText = input.queryText ?? existing.queryText;
            existing.body = input.body ?? existing.body;
            if (input.authType && ['none', 'bearer', 'apiKey', 'basic'].includes(input.authType)) {
              existing.authType = input.authType as ApiRequest['authType'];
            }
            if (input.authKeyName) { existing.authKeyName = input.authKeyName; }
            if (input.authValue) { await this.saveAuthSecret(existing.id, input.authValue); }
            if (target && target.id !== existing.collectionId) {
              for (const col of this.state.collections) {
                col.requests = col.requests.filter((r) => r.id !== existing.id);
              }
              existing.collectionId = target.id;
              target.requests.push(existing);
            }
            await this.save(); this.postState();
            return { id: existing.id };
          }
        }
        const col = target || this.state.collections[0];
        if (!col) { return { error: 'No collection exists yet' }; }
        const req: ApiRequest = {
          id: input.id || newId('req'), name: input.name || 'Untitled Request', method,
          url: input.url, headersText: input.headersText || '', queryText: input.queryText || '',
          authType: (['none', 'bearer', 'apiKey', 'basic'].includes(input.authType || '') ? input.authType : 'none') as ApiRequest['authType'],
          authValue: '', authKeyName: input.authKeyName || 'X-API-Key',
          body: input.body || '', collectionId: col.id,
        };
        if (input.authValue) { await this.saveAuthSecret(req.id, input.authValue); }
        col.requests.push(req);
        await this.save(); this.postState();
        return { id: req.id };
      },
      getLastResponse: (requestId) => {
        const last = this.lastResponses.get(requestId);
        if (!last) { return null; }
        return last.result
          ? { status: last.result.status, statusText: last.result.statusText, timeMs: last.result.timeMs, bodyText: last.result.bodyText }
          : { status: null, statusText: '', timeMs: 0, bodyText: '', error: last.error };
      },
      importOpenApi: async (text) => {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { return { error: 'That text is not valid JSON. Paste a full OpenAPI 3 JSON document.' }; }
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).openapi !== 'string') {
          return { error: 'That JSON is not an OpenAPI 3 document (no "openapi" field).' };
        }
        try {
          const imported = parseImportedCollections(text);
          this.state.collections.push(...imported);
          await this.save(); this.postState();
          return { added: imported.reduce((n, c) => n + c.requests.length, 0), collections: imported.map((c) => c.name) };
        } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
      },
      generateTests: async (requestId) => {
        const req = this.findRequest(requestId);
        if (!req) { return { error: 'No saved request with that id' }; }
        const last = this.lastResponses.get(requestId);
        const settings = this.aiSettings();
        const ai = await callOllama(settings, buildTestGenPrompt(req, last?.result));
        if (ai.ok) {
          const parsed = parseGeneratedAssertions(ai.text);
          if (parsed.assertions.length > 0) {
            req.assertions = parsed.assertions;
            await this.save(); this.postState();
            return { source: 'ai' as const, kept: parsed.kept, dropped: parsed.dropped, assertions: parsed.assertions };
          }
          // AI answered but produced nothing usable — fall through to rule-based.
        }
        if (last?.result) {
          const assertions = generateAssertionsFromResponse(last.result);
          req.assertions = assertions;
          await this.save(); this.postState();
          return {
            source: 'rule-based' as const, kept: assertions.length, dropped: 0, assertions,
            note: ai.ok
              ? 'AI answered but produced no usable assertions, so rule-based starters were used.'
              : `AI unavailable (${ai.error}), so rule-based starters were used.`,
          };
        }
        return { error: 'No response yet for this request — send it first, or start Ollama for AI generation.' };
      },
      listSuites: () => this.state.suites.map((s) => ({ id: s.id, name: s.name, requestIds: s.requestIds.slice() })),
      runSuite: async (nameOrId) => {
        const suite = this.state.suites.find((s) => s.id === nameOrId)
          || this.state.suites.find((s) => s.name.toLowerCase() === nameOrId.toLowerCase());
        if (!suite) { return { error: 'No test suite with that id or name' }; }
        const summary = await this.runSuiteInternal(suite);
        return {
          suiteName: summary.suiteName, passed: summary.passed, failed: summary.failed,
          results: summary.results.map((r) => ({ requestName: r.requestName, status: r.status, passed: r.passed, failed: r.failed, error: r.error })),
        };
      },
      explainFailure: async (requestId) => {
        const req = this.findRequest(requestId);
        if (!req) { return { error: 'No saved request with that id' }; }
        const last = this.lastResponses.get(requestId);
        if (!last) { return { error: 'No response recorded for this request yet — send it first.' }; }
        const settings = this.aiSettings();
        const ai = await callOllama(settings, buildExplainPrompt(req, last.result ?? null, last.error));
        if (ai.ok && ai.text.trim()) { return { source: 'ai' as const, text: ai.text.trim() }; }
        return { source: 'rule-based' as const, text: explainFailureRuleBased(req, last.result ?? null, last.error) };
      },
      generateDocs: (collectionId) => {
        const col = this.findCollection(collectionId);
        if (!col) { return { error: 'Unknown collection — pass a collection id or name' }; }
        return { text: generateCollectionDocs(col) };
      },
    };
  }

  // SSE streaming on the host (not the webview) so the webview CSP stays
  // tight: only ws:/wss: are opened there, for WebSocket testing.
  private async startSse(url: string, headersText: string): Promise<void> {
    this.stopSse();
    const controller = new AbortController();
    this.sseController = controller;
    const finalUrl = buildFinalUrl(url, this.envVars(), '');
    const headers = parseHeaders(headersText);
    try {
      const res = await fetch(finalUrl, {
        headers: headers.map((h) => [h.key, h.value] as [string, string]),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        this.view?.webview.postMessage({ type: 'sseStatus', text: `SSE error: HTTP ${res.status}` });
        return;
      }
      this.view?.webview.postMessage({ type: 'sseStatus', text: `SSE connected: ${finalUrl}` });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { break; }
        for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
          this.view?.webview.postMessage({ type: 'sseEvent', event: ev });
        }
      }
      this.view?.webview.postMessage({ type: 'sseStatus', text: 'SSE stream ended.' });
    } catch (err) {
      this.view?.webview.postMessage({
        type: 'sseStatus',
        text: controller.signal.aborted ? 'SSE stopped.' : `SSE error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private postMockStatus(error?: string): void {
    this.view?.webview.postMessage({
      type: 'mockStatus', running: !!this.mockServer, port: this.mockPort, error,
    });
  }

  private trimHistory(): void {
    if (this.state.history.length > MAX_HISTORY) {
      this.state.history = this.state.history.slice(this.state.history.length - MAX_HISTORY);
    }
  }

  private async handleMessage(msg: { type: string; [key: string]: unknown }): Promise<void> {
    const request = msg.request as ApiRequest | undefined;
    switch (msg.type) {
      case 'ready':
        this.postState();
        this.view?.webview.postMessage({ type: 'aiSettings', settings: this.aiSettings() });
        break;
      case 'sendRequest':
        if (request) {
          await this.recordAndSend(request.method, request.url, request.headersText, request.queryText, request.body, request, request.id);
        }
        break;
      case 'saveRequest': {
        if (!request) { break; }
        if (!request.id) { request.id = newId('req'); }
        await this.saveAuthSecret(request.id, request.authValue);
        request.authValue = '';
        const targetId = request.collectionId || this.state.collections[0]?.id;
        if (!targetId) { break; }
        const target = this.state.collections.find((c) => c.id === targetId);
        if (!target) { break; }
        if (request.id) {
          for (const col of this.state.collections) {
            const existing = col.requests.find((r) => r.id === request.id);
            if (existing) {
              Object.assign(existing, request, { collectionId: targetId });
              col.requests = col.requests.filter((r) => r.id !== request.id || col === target);
              if (col !== target) { target.requests.push(existing); }
              break;
            }
          }
          const stillMissing = !this.state.collections.some((c) => c.requests.some((r) => r.id === request.id));
          if (stillMissing) { target.requests.push({ ...request, id: request.id, collectionId: targetId }); }
        } else {
          target.requests.push({ ...request, id: newId('req'), collectionId: targetId });
        }
        await this.save();
        this.postState();
        break;
      }
      case 'duplicateRequest': {
        if (!request) { break; }
        const target = this.state.collections.find((c) => c.id === (request.collectionId || this.state.collections[0]?.id));
        if (target) {
          const copyId = newId('req');
          try {
            const secret = request.id ? await this.context.secrets.get(this.secretKey(request.id)) : undefined;
            if (secret) { await this.context.secrets.store(this.secretKey(copyId), secret); }
          } catch { /* keychain unavailable: copy keeps no secret */ }
          target.requests.push({ ...request, id: copyId, authValue: '', name: `${request.name} (copy)`, collectionId: target.id });
          await this.save();
          this.postState();
        }
        break;
      }
      case 'deleteRequest': {
        if (!request?.id) { break; }
        try { await this.context.secrets.delete(this.secretKey(request.id)); } catch { /* ignore */ }
        for (const col of this.state.collections) {
          col.requests = col.requests.filter((r) => r.id !== request.id);
        }
        await this.save();
        this.postState();
        break;
      }
      case 'newCollection': {
        const name = String(msg.name || '').trim();
        if (name) {
          this.state.collections.push({ id: newId('col'), name, requests: [] });
          await this.save();
          this.postState();
        }
        break;
      }
      case 'deleteCollection':
        this.state.collections = this.state.collections.filter((c) => c.id !== msg.id);
        await this.save();
        this.postState();
        break;
      case 'setActiveEnv':
        this.state.activeEnvId = String(msg.envId);
        await this.save();
        this.postState();
        break;
      case 'saveEnvVars': {
        const env = this.state.environments.find((e) => e.id === msg.envId);
        if (env) {
          const vars: Record<string, string> = {};
          for (const line of String(msg.varsText || '').split(/\r?\n/)) {
            const eq = line.indexOf('=');
            if (eq > 0) { vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim(); }
          }
          env.variables = vars;
          await this.save();
          this.postState();
        }
        break;
      }
      case 'rerunHistory': {
        // Re-run uses only the stored method + URL. Bodies and secrets are
        // deliberately NOT stored in history, so authenticated requests need
        // their auth re-entered in the builder before sending.
        const entry = this.state.history.find((h) => h.id === msg.id);
        if (entry) {
          await this.recordAndSend(entry.method, entry.url, '', '', '', { authType: 'none', authValue: '', authKeyName: 'X-API-Key' });
        }
        break;
      }
      case 'clearHistory':
        this.state.history = [];
        await this.save();
        this.postState();
        break;
      case 'saveAssertions': {
        const req = request as (ApiRequest & { assertions?: Assertion[] }) | undefined;
        if (req?.id) {
          const existing = this.findRequest(req.id);
          if (existing) { existing.assertions = req.assertions || []; await this.save(); this.postState(); }
        }
        break;
      }
      case 'runTest': {
        if (!request) { break; }
        const outcome = await this.executeRequest(request);
        if ('error' in outcome) {
          this.view?.webview.postMessage({ type: 'testResult', requestName: request.name, error: outcome.error, passed: 0, failed: 0, details: [] });
        } else {
          const details = evaluateAssertions(outcome.result, (request as ApiRequest & { assertions?: Assertion[] }).assertions || []);
          const schemaDetail = evaluateJsonSchemaAssertion(outcome.result, request.jsonSchema);
          if (schemaDetail) { details.push(schemaDetail); }
          this.view?.webview.postMessage({
            type: 'testResult', requestName: request.name,
            passed: details.filter((d) => d.passed).length, failed: details.filter((d) => !d.passed).length, details,
          });
        }
        break;
      }
      // --- v0.3.0: JSON Schema, data-driven runs, cURL import -----------
      // Schema text and data rows are data only: the schema is stored on
      // the request like an assertion, rows live only for the run, and a
      // -u user:password from cURL goes to the OS keychain like any auth.
      case 'validateSchema': {
        const result = msg.result as HttpResult | undefined;
        const schema = String(msg.schema || '');
        if (!result) {
          this.view?.webview.postMessage({ type: 'schemaResult', ok: false, error: 'No response yet — send the request first, then validate.' });
          break;
        }
        if (!schema.trim()) {
          this.view?.webview.postMessage({ type: 'schemaResult', ok: false, error: 'Paste a JSON Schema first.' });
          break;
        }
        const checked = validateResponseAgainstSchema(result.bodyText, schema);
        this.view?.webview.postMessage({ type: 'schemaResult', ok: true, valid: checked.valid, errors: checked.errors, parseError: checked.parseError });
        break;
      }
      case 'runDataDriven': {
        const suite = this.state.suites.find((s) => s.id === msg.suiteId);
        if (!suite) {
          this.view?.webview.postMessage({ type: 'dataDrivenResult', ok: false, error: 'Pick a test suite first.' });
          break;
        }
        let rows: Array<Record<string, string>>;
        try {
          rows = parseDataRows(String(msg.dataText || ''));
        } catch (err) {
          this.view?.webview.postMessage({ type: 'dataDrivenResult', ok: false, error: err instanceof Error ? err.message : String(err) });
          break;
        }
        const perRow: Array<{ rowIndex: number; row: Record<string, string>; passed: number; failed: number; results: Array<{ requestName: string; status: number | null; passed: number; failed: number; error?: string }> }> = [];
        for (let i = 0; i < rows.length; i++) {
          const summary = await this.runSuiteInternal(suite, rows[i], `${suite.name} — row ${i + 1}`);
          perRow.push({
            rowIndex: i + 1, row: rows[i], passed: summary.passed, failed: summary.failed,
            results: summary.results.map((r) => ({ requestName: r.requestName, status: r.status, passed: r.passed, failed: r.failed, error: r.error })),
          });
        }
        this.view?.webview.postMessage({
          type: 'dataDrivenResult', ok: true, suiteName: suite.name, rowCount: rows.length,
          totalPassed: perRow.reduce((n, r) => n + r.passed, 0),
          totalFailed: perRow.reduce((n, r) => n + r.failed, 0),
          perRow,
        });
        break;
      }
      case 'importCurl': {
        try {
          const parsed = parseCurlCommand(String(msg.text || ''));
          const target = this.state.collections.find((c) => c.id === msg.collectionId) || this.state.collections[0];
          if (!target) { break; }
          const req: ApiRequest = {
            id: newId('req'), name: `${parsed.method} ${parsed.url}`,
            method: parsed.method, url: parsed.url,
            headersText: parsed.headersText, queryText: '',
            authType: parsed.authType, authValue: '', authKeyName: 'X-API-Key',
            body: parsed.body, collectionId: target.id,
          };
          if (parsed.authValue) { await this.saveAuthSecret(req.id, parsed.authValue); }
          target.requests.push(req);
          await this.save();
          this.postState();
          this.view?.webview.postMessage({ type: 'curlImportResult', ok: true, request: req, collectionName: target.name });
        } catch (err) {
          this.view?.webview.postMessage({ type: 'curlImportResult', ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case 'generateAssertions': {
        const result = msg.result as HttpResult | undefined;
        if (result) {
          this.view?.webview.postMessage({ type: 'generatedAssertions', assertions: generateAssertionsFromResponse(result) });
        }
        break;
      }
      // --- v0.2.5: local AI (Ollama) -------------------------------------
      // Every AI call goes to the user's own Ollama server. A failure is
      // reported as a clear message in the sidebar — never a crash, and
      // never a silent fallback that pretends AI ran.
      case 'getAiSettings':
        this.view?.webview.postMessage({ type: 'aiSettings', settings: this.aiSettings() });
        break;
      case 'saveAiSettings': {
        const cfg = vscode.workspace.getConfiguration('apidiya.ai');
        const url = String(msg.url || '').trim();
        const model = String(msg.model || '').trim();
        if (url) { await cfg.update('ollamaUrl', url, vscode.ConfigurationTarget.Global); }
        if (model) { await cfg.update('model', model, vscode.ConfigurationTarget.Global); }
        this.view?.webview.postMessage({ type: 'aiSettings', settings: this.aiSettings() });
        break;
      }
      case 'aiTestConnection': {
        const check = await checkOllama(this.aiSettings());
        this.view?.webview.postMessage({ type: 'aiConnection', ...check, settings: this.aiSettings() });
        break;
      }
      case 'aiGenerateTests': {
        if (!request) { break; }
        const result = msg.result as HttpResult | undefined;
        const ai = await callOllama(this.aiSettings(), buildTestGenPrompt(request, result));
        if (!ai.ok) {
          this.view?.webview.postMessage({ type: 'aiGeneratedAssertions', source: 'none', assertions: [], kept: 0, dropped: 0, error: `AI unavailable: ${ai.error}` });
          break;
        }
        const parsed = parseGeneratedAssertions(ai.text);
        if (parsed.assertions.length === 0) {
          this.view?.webview.postMessage({ type: 'aiGeneratedAssertions', source: 'ai', assertions: [], kept: 0, dropped: parsed.dropped, error: 'AI answered but produced no usable assertions. Try again, or use "Generate from last response" for rule-based starters.' });
          break;
        }
        if (request.id) {
          const existing = this.findRequest(request.id);
          if (existing) { existing.assertions = parsed.assertions; await this.save(); }
        }
        this.view?.webview.postMessage({ type: 'aiGeneratedAssertions', source: 'ai', assertions: parsed.assertions, kept: parsed.kept, dropped: parsed.dropped });
        this.postState();
        break;
      }
      case 'aiExplainFailure': {
        if (!request) { break; }
        const result = msg.result as HttpResult | undefined;
        const error = typeof msg.error === 'string' ? msg.error : undefined;
        const ai = await callOllama(this.aiSettings(), buildExplainPrompt(request, result ?? null, error));
        if (ai.ok && ai.text.trim()) {
          this.view?.webview.postMessage({ type: 'aiExplanation', source: 'ai', text: ai.text.trim() });
        } else {
          // Labelled fallback: the sidebar shows this came from the
          // rule-based explainer, not from AI.
          this.view?.webview.postMessage({ type: 'aiExplanation', source: 'rule-based', text: explainFailureRuleBased(request, result ?? null, error) });
        }
        break;
      }
      case 'aiGenerateRequest': {
        const instruction = String(msg.instruction || '').trim();
        if (!instruction) { break; }
        const ai = await callOllama(this.aiSettings(), buildRequestGenPrompt(instruction));
        if (!ai.ok) {
          this.view?.webview.postMessage({ type: 'aiProposedRequest', error: `AI unavailable: ${ai.error}` });
          break;
        }
        try {
          const generated = parseGeneratedRequest(ai.text);
          // Proposed only — the sidebar shows it for review; nothing is
          // sent until the user presses Use.
          this.view?.webview.postMessage({ type: 'aiProposedRequest', request: generated });
        } catch (err) {
          this.view?.webview.postMessage({ type: 'aiProposedRequest', error: `AI returned a request that could not be validated: ${err instanceof Error ? err.message : String(err)}` });
        }
        break;
      }
      // --- v0.3.1: AI mock responses --------------------------------------
      // One message back to the sidebar (aiMockResult) reports the outcome.
      // A mock with no matching request or no schema gets a clear message
      // instead of generated garbage; an invalid generated body is never saved.
      case 'aiGenerateMock': {
        const mock = this.state.mocks.find((m) => m.id === msg.mockId);
        if (!mock) {
          this.view?.webview.postMessage({ type: 'aiMockResult', ok: false, error: 'That mock no longer exists.' });
          break;
        }
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : undefined;
        const result = await this.generateAiMockBodyFor(mock, requestId);
        this.view?.webview.postMessage({ type: 'aiMockResult', ok: result.ok, mockId: mock.id, body: result.body, error: result.error });
        break;
      }
      case 'createSuite': {
        const name = String(msg.name || '').trim();
        const requestIds = Array.isArray(msg.requestIds) ? (msg.requestIds as string[]) : [];
        if (name && requestIds.length > 0) {
          this.state.suites.push({ id: newId('suite'), name, requestIds });
          await this.save(); this.postState();
        }
        break;
      }
      case 'deleteSuite':
        this.state.suites = this.state.suites.filter((s) => s.id !== msg.id);
        await this.save(); this.postState();
        break;
      case 'runSuite': {
        const suite = this.state.suites.find((s) => s.id === msg.id);
        if (!suite) { break; }
        const summary = await this.runSuiteInternal(suite);
        this.view?.webview.postMessage({ type: 'suiteResult', ...summary });
        break;
      }
      case 'exportCollection': {
        const col = this.state.collections.find((c) => c.id === msg.id);
        if (col) {
          this.view?.webview.postMessage({ type: 'exportResult', json: JSON.stringify({ apidiya: 1, collections: [col] }, null, 2) });
        }
        break;
      }
      case 'importCollection': {
        try {
          const imported = parseImportedCollections(String(msg.text || ''));
          this.state.collections.push(...imported);
          await this.save();
          this.view?.webview.postMessage({ type: 'importResult', ok: true, count: imported.length, names: imported.map((c) => c.name) });
          this.postState();
        } catch (err) {
          this.view?.webview.postMessage({ type: 'importResult', ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case 'addMock': {
        const mock = msg.mock as Partial<MockEndpoint> | undefined;
        if (mock && mock.method && mock.path) {
          this.state.mocks.push({
            id: newId('mock'), method: mock.method, path: String(mock.path),
            status: Number(mock.status) || 200, body: String(mock.body || ''),
          });
          await this.save(); this.postState();
        }
        break;
      }
      case 'deleteMock':
        this.state.mocks = this.state.mocks.filter((m) => m.id !== msg.id);
        await this.save(); this.postState();
        break;
      case 'startMock': {
        const port = Number(msg.port) || 3101;
        if (this.mockServer) { this.stopMockServer(); }
        const server = http.createServer((reqMsg, res) => {
          const urlPath = (reqMsg.url || '/').split('?')[0];
          const mock = findMock(this.state.mocks, reqMsg.method || 'GET', urlPath);
          if (!mock) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'No mock for this method and path' })); return; }
          let body = mock.body;
          let contentType = 'application/json';
          try { JSON.parse(body); } catch { contentType = 'text/plain'; }
          res.writeHead(mock.status, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
          res.end(body);
        });
        server.on('error', (err) => {
          this.mockServer = undefined; this.mockPort = 0;
          this.postMockStatus(err instanceof Error ? err.message : String(err));
        });
        server.listen(port, () => { this.mockServer = server; this.mockPort = port; this.postMockStatus(); });
        break;
      }
      case 'stopMock':
        this.stopMockServer(); this.postMockStatus();
        break;
      case 'generateSnippet': {
        // Snippets are generated from the request as the user sees it in
        // the builder. For a saved request the builder blanks auth, so the
        // keychain secret is used — meaning the snippet WILL contain the
        // token, and the sidebar warns to treat it like a password.
        if (!request) { break; }
        const withAuth = await this.authFor(request);
        const finalUrl = buildFinalUrl(withAuth.url, this.envVars(), withAuth.queryText);
        const headers = buildHeaders(withAuth);
        const kind = (msg.kind === 'fetch' || msg.kind === 'python') ? msg.kind : 'curl';
        const code = generateSnippet(kind, withAuth.method, finalUrl, headers, withAuth.body);
        this.view?.webview.postMessage({ type: 'snippetResult', kind, code });
        break;
      }
      case 'startSse':
        void this.startSse(String(msg.url || ''), String(msg.headersText || ''));
        break;
      case 'stopSse':
        this.stopSse();
        this.view?.webview.postMessage({ type: 'sseStatus', text: 'SSE stopped.' });
        break;
      case 'startMcp': {
        const port = Number(msg.port) || 3102;
        if (this.mcpServer) { this.stopMcpServer(); }
        const ctx = this.mcpContext();
        const server = http.createServer((reqMsg, res) => {
          if (reqMsg.method !== 'POST' || (reqMsg.url || '/').split('?')[0] !== '/mcp') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ApiDiya MCP server: POST to /mcp only' }));
            return;
          }
          const chunks: Buffer[] = [];
          let tooBig = false;
          reqMsg.on('data', (chunk: Buffer) => {
            if (chunks.reduce((n, c) => n + c.length, 0) + chunk.length > 1_000_000) { tooBig = true; }
            else { chunks.push(chunk); }
          });
          reqMsg.on('end', () => {
            void (async () => {
              if (tooBig) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Request too large' } }));
                return;
              }
              let parsed: unknown;
              try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
                return;
              }
              const reply = await handleMcpMessage(parsed as Record<string, unknown>, ctx);
              if (reply === null) { res.writeHead(202); res.end(); return; }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(reply));
            })();
          });
        });
        server.on('error', (err) => {
          this.mcpServer = undefined; this.mcpPort = 0;
          this.postMcpStatus(err instanceof Error ? err.message : String(err));
        });
        // Localhost only: this server is for the user's own MCP hosts.
        server.listen(port, '127.0.0.1', () => { this.mcpServer = server; this.mcpPort = port; this.postMcpStatus(); });
        break;
      }
      case 'stopMcp':
        this.stopMcpServer(); this.postMcpStatus();
        break;
      default:
        break;
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const stored = context.globalState.get<State>('apiStudio.state');
  let state: State;
  if (stored && Array.isArray(stored.collections) && Array.isArray(stored.environments)) {
    state = stored;
  } else {
    const environments = seedEnvironments();
    state = {
      collections: seedCollections(),
      environments,
      activeEnvId: environments[0].id,
      history: [],
      suites: [], testRuns: [], mocks: [],
    };
  }
  // Ensure the Custom collection exists even for states seeded earlier.
  if (!state.collections.some((c) => c.name === 'Custom')) {
    state.collections.push({ id: newId('col'), name: 'Custom', requests: [] });
  }
  // v0.2 fields for states saved by earlier versions.
  if (!Array.isArray(state.suites)) { state.suites = []; }
  if (!Array.isArray(state.testRuns)) { state.testRuns = []; }
  if (!Array.isArray(state.mocks)) { state.mocks = []; }
  const provider = new ApiStudioProvider(context, state);
  context.subscriptions.push(
    { dispose: () => { provider.stopMockServer(); provider.stopMcpServer(); provider.stopSse(); } },
    vscode.window.registerWebviewViewProvider('apiStudio.main', provider),
    vscode.commands.registerCommand('apiStudio.open', async () => {
      await vscode.commands.executeCommand('apiStudio.main.focus');
    }),
    // v0.3.1: generate an AI mock response body from the Command Palette.
    // Pick a mock; the endpoint's OpenAPI schema (from an imported spec or
    // a pasted JSON Schema) drives generation, and the body is validated
    // before it is saved. One information message reports the outcome.
    vscode.commands.registerCommand('apiStudio.aiGenerateMock', async () => {
      if (state.mocks.length === 0) {
        void vscode.window.showInformationMessage('ApiDiya: no mocks yet — add one in the Mock server section first.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        state.mocks.map((m) => ({ label: `${m.method} ${m.path}`, description: `→ ${m.status}`, mock: m })),
        { placeHolder: 'Pick a mock to generate an AI response body for' },
      );
      if (!picked) { return; }
      const result = await provider.generateAiMockBodyFor(picked.mock);
      void vscode.window.showInformationMessage(result.ok
        ? `ApiDiya: AI generated a mock body for ${picked.mock.method} ${picked.mock.path} that matches its OpenAPI schema.`
        : `ApiDiya: could not generate a mock body — ${result.error || 'unknown error'}`);
    }),
  );
}

export function deactivate(): void { /* nothing to clean up */ }
