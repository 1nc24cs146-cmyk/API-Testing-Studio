import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ApiCollection, ApiRequest, Assertion, Environment, HistoryEntry, HttpResult,
  MockEndpoint, RequestTestResult, TestSuite, buildFinalUrl, buildHeaders,
  evaluateAssertions, findMock, generateAssertionsFromResponse, newId,
  parseImportedCollections, prettyPrint, redactHeaders, seedCollections,
  seedEnvironments, sendHttp,
} from './api';

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
  constructor(private readonly context: vscode.ExtensionContext, private state: State) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    const nonce = randomNonce();
    const htmlPath = path.join(this.context.extensionPath, 'media', 'webview.html');
    view.webview.html = fs.readFileSync(htmlPath, 'utf8').replace(/__NONCE__/g, nonce);
    view.webview.onDidReceiveMessage((msg) => { void this.handleMessage(msg); });
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
  // to the URL you typed, and the local mock server on your own machine.
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

  private async recordAndSend(method: ApiRequest['method'], url: string, headersText: string, queryText: string, body: string, auth: Pick<ApiRequest, 'authType' | 'authValue' | 'authKeyName'>): Promise<void> {
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

  private async executeRequest(request: ApiRequest): Promise<{ result: HttpResult } | { error: string }> {
    const withAuth = await this.authFor(request);
    const finalUrl = buildFinalUrl(withAuth.url, this.envVars(), withAuth.queryText);
    const headers = buildHeaders(withAuth);
    try {
      const result = await sendHttp(withAuth.method, finalUrl, headers, withAuth.body);
      return { result };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private findRequest(id: string): ApiRequest | undefined {
    for (const col of this.state.collections) {
      const found = col.requests.find((r) => r.id === id);
      if (found) { return found; }
    }
    return undefined;
  }

  public stopMockServer(): void {
    if (this.mockServer) { this.mockServer.close(); this.mockServer = undefined; this.mockPort = 0; }
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
        break;
      case 'sendRequest':
        if (request) {
          await this.recordAndSend(request.method, request.url, request.headersText, request.queryText, request.body, request);
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
          this.view?.webview.postMessage({
            type: 'testResult', requestName: request.name,
            passed: details.filter((d) => d.passed).length, failed: details.filter((d) => !d.passed).length, details,
          });
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
        const results: RequestTestResult[] = [];
        for (const reqId of suite.requestIds) {
          const req = this.findRequest(reqId);
          if (!req) { continue; }
          const outcome = await this.executeRequest(req);
          if ('error' in outcome) {
            results.push({ requestId: req.id, requestName: req.name, status: null, error: outcome.error, passed: 0, failed: 0, details: [] });
          } else {
            const details = evaluateAssertions(outcome.result, req.assertions || []);
            results.push({
              requestId: req.id, requestName: req.name, status: outcome.result.status,
              passed: details.filter((d) => d.passed).length, failed: details.filter((d) => !d.passed).length, details,
            });
          }
        }
        const passed = results.reduce((n, r) => n + r.passed, 0);
        const failed = results.reduce((n, r) => n + r.failed, 0);
        this.state.testRuns.unshift({
          id: newId('run'), suiteName: suite.name, executedAt: new Date().toISOString(), passed, failed, results,
        });
        this.state.testRuns = this.state.testRuns.slice(0, 20);
        await this.save();
        this.view?.webview.postMessage({ type: 'suiteResult', suiteName: suite.name, passed, failed, results });
        this.postState();
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
    { dispose: () => provider.stopMockServer() },
    vscode.window.registerWebviewViewProvider('apiStudio.main', provider),
    vscode.commands.registerCommand('apiStudio.open', async () => {
      await vscode.commands.executeCommand('apiStudio.main.focus');
    }),
  );
}

export function deactivate(): void { /* nothing to clean up */ }
