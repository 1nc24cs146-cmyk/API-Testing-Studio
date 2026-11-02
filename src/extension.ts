import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ApiCollection, ApiRequest, Environment, HistoryEntry, buildFinalUrl, buildHeaders,
  newId, prettyPrint, redactHeaders, seedCollections, seedEnvironments, sendHttp,
} from './api';

interface State {
  collections: ApiCollection[];
  environments: Environment[];
  activeEnvId: string;
  history: HistoryEntry[];
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
          if (stillMissing) { target.requests.push({ ...request, id: newId('req'), collectionId: targetId }); }
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
          target.requests.push({ ...request, id: newId('req'), name: `${request.name} (copy)`, collectionId: target.id });
          await this.save();
          this.postState();
        }
        break;
      }
      case 'deleteRequest': {
        if (!request?.id) { break; }
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
    };
  }
  // Ensure the Custom collection exists even for states seeded earlier.
  if (!state.collections.some((c) => c.name === 'Custom')) {
    state.collections.push({ id: newId('col'), name: 'Custom', requests: [] });
  }
  const provider = new ApiStudioProvider(context, state);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('apiStudio.main', provider),
    vscode.commands.registerCommand('apiStudio.open', async () => {
      await vscode.commands.executeCommand('apiStudio.main.focus');
    }),
  );
}

export function deactivate(): void { /* nothing to clean up */ }
