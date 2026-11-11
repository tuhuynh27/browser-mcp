import type { Protocol } from 'devtools-protocol';

import { type Target, isAttached, onAttach, onEvent, resolveFrame, send } from './cdp.js';
import { ToolError } from './errors.js';
import type { InspectArgs } from './protocol.js';
import { MAX_OUTPUT, cap, evaluate } from './snapshot.js';

interface LogEntry {
  level: string;
  text: string;
  url?: string;
  line?: number;
}

interface NetworkEntry {
  requestId: string;
  method: string;
  url: string;
  type?: string;
  status?: number;
  mime?: string;
  size?: number;
  error?: string;
  declaredSize?: number;
  sessionId?: string;
}

interface Buffers {
  console: LogEntry[];
  errors: LogEntry[];
  network: NetworkEntry[];
}

const BUFFER_SIZE = 500;
const DEFAULT_LIMIT = 50;
const buffers = new Map<number, Buffers>();

function buffersOf(tabId: number): Buffers {
  let found = buffers.get(tabId);

  if (!found) {
    found = { console: [], errors: [], network: [] };
    buffers.set(tabId, found);
  }

  return found;
}

function push<T>(list: T[], entry: T): void {
  list.push(entry);

  if (list.length > BUFFER_SIZE) list.shift();
}

function printable(value: Protocol.Runtime.RemoteObject): string {
  if (value.type === 'string') return String(value.value);
  if ('value' in value) return JSON.stringify(value.value);

  return value.description ?? value.type;
}

function record(target: Target, method: string, params: unknown): void {
  const store = buffersOf(target.tabId);

  if (method === 'Runtime.consoleAPICalled') {
    const event = params as Protocol.Runtime.ConsoleAPICalledEvent;
    const text = event.args.map(printable).join(' ').slice(0, 1_000);
    const entry = { level: event.type, text };

    push(store.console, entry);

    if (event.type === 'error') push(store.errors, entry);
  } else if (method === 'Log.entryAdded') {
    const { entry } = params as Protocol.Log.EntryAddedEvent;
    const logged = { level: entry.level, text: entry.text.slice(0, 1_000), url: entry.url };

    push(store.console, logged);

    if (entry.level === 'error') push(store.errors, logged);
  } else if (method === 'Runtime.exceptionThrown') {
    const { exceptionDetails: details } = params as Protocol.Runtime.ExceptionThrownEvent;

    push(store.errors, {
      level: 'exception',
      text: (details.exception?.description ?? details.text).slice(0, 1_000),
      url: details.url,
      line: details.lineNumber + 1,
    });
  } else if (method === 'Page.javascriptDialogOpening') {
    const dialog = params as Protocol.Page.JavascriptDialogOpeningEvent;

    // An open alert/confirm/prompt freezes the page and every later call, so
    // answer it at once and leave a trace for the model to read.
    send(target, 'Page.handleJavaScriptDialog', { accept: true, promptText: dialog.defaultPrompt }).catch(() => undefined);
    push(store.console, { level: 'dialog', text: `${dialog.type} auto-accepted: ${dialog.message}`.slice(0, 1_000) });
  } else if (method === 'Network.requestWillBeSent') {
    const event = params as Protocol.Network.RequestWillBeSentEvent;

    push(store.network, {
      requestId: event.requestId,
      method: event.request.method,
      url: event.request.url.slice(0, 500),
      type: event.type,
      sessionId: target.sessionId,
    });
  } else if (method === 'Network.responseReceived') {
    const event = params as Protocol.Network.ResponseReceivedEvent;
    const entry = store.network.findLast((candidate) => candidate.requestId === event.requestId);

    if (entry) {
      entry.status = event.response.status;
      entry.mime = event.response.mimeType;
      entry.declaredSize = Number(event.response.headers['content-length'] ?? event.response.headers['Content-Length']) || undefined;
    }
  } else if (method === 'Network.loadingFinished') {
    const event = params as Protocol.Network.LoadingFinishedEvent;
    const entry = store.network.findLast((candidate) => candidate.requestId === event.requestId);

    // Cached responses transfer nothing; fall back to the declared length.
    if (entry) entry.size = event.encodedDataLength || entry.declaredSize || 0;
  } else if (method === 'Network.loadingFailed') {
    const event = params as Protocol.Network.LoadingFailedEvent;
    const entry = store.network.findLast((candidate) => candidate.requestId === event.requestId);

    if (entry) entry.error = event.errorText;
  }
}

onAttach(async (target) => {
  await Promise.all([send(target, 'Network.enable', {}), send(target, 'Log.enable')]);
});

onEvent(record);

chrome.tabs.onRemoved.addListener((tabId) => buffers.delete(tabId));

// ---------------------------------------------------------------- inspect

function recent<T>(entries: T[], limit: number | undefined, key: string): Record<string, unknown> {
  const count = Math.max(1, limit ?? DEFAULT_LIMIT);
  const result: Record<string, unknown> = { [key]: entries.slice(-count), total: entries.length };

  if (entries.length > count) result.truncated = true;

  return result;
}

async function responseBody(tabId: number, requestId: string): Promise<unknown> {
  const entry = buffersOf(tabId).network.findLast((candidate) => candidate.requestId === requestId);

  if (!entry) throw new ToolError('NOT_FOUND', `No recorded request ${requestId}.`);

  const response = await send({ tabId, sessionId: entry.sessionId }, 'Network.getResponseBody', { requestId });
  const { text, truncated } = cap(response.body, MAX_OUTPUT);

  return {
    requestId,
    url: entry.url,
    status: entry.status,
    mime: entry.mime,
    base64: response.base64Encoded || undefined,
    body: text,
    truncated,
  };
}

function readStorage(): Record<string, Record<string, string>> {
  const dump = (store: Storage): Record<string, string> =>
    Object.fromEntries(Object.entries(store).map(([key, value]) => [key, String(value).slice(0, 500)]));

  return { local: dump(localStorage), session: dump(sessionStorage) };
}

export async function inspect(tabId: number, args: InspectArgs): Promise<unknown> {
  const wasAttached = isAttached(tabId);
  const frame = await resolveFrame(tabId);
  const store = buffersOf(tabId);

  if (args.mode === 'cookies') {
    const tab = await chrome.tabs.get(tabId);
    const { cookies } = await send(frame, 'Network.getCookies', { urls: [tab.url ?? ''] });

    return {
      cookies: cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value.slice(0, 200),
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires > 0 ? new Date(cookie.expires * 1000).toISOString() : 'session',
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      })),
    };
  }

  if (args.mode === 'storage') {
    const dump = await evaluate<Record<string, unknown>>(frame, `(${readStorage.toString()})()`);
    const { text, truncated } = cap(JSON.stringify(dump), MAX_OUTPUT);

    return truncated ? { storage: text, truncated } : dump;
  }

  if (args.mode === 'network' && args.bodyOf) return responseBody(tabId, args.bodyOf);

  let result: Record<string, unknown>;

  if (args.mode === 'network') {
    const method = args.method?.toUpperCase();

    const matches = store.network
      .filter((entry) => !args.url || entry.url.includes(args.url))
      .filter((entry) => !method || entry.method === method)
      .filter((entry) => args.status === undefined || entry.status === args.status)
      .map(({ sessionId: _sessionId, declaredSize: _declaredSize, ...entry }) => entry);

    result = recent(matches, args.limit, 'requests');
  } else if (args.mode === 'console' || args.mode === 'errors') {
    result = recent(store[args.mode], args.limit, args.mode);
  } else {
    throw new ToolError('BAD_ARGS', `Unknown mode ${String(args.mode)}.`);
  }

  if (!wasAttached) result.note = 'Recording started with this call. Reload the tab to capture its page load.';

  return result;
}

// ---------------------------------------------------------------- js

const JS_TIMEOUT_MS = 45_000;

// Runs code with REPL semantics and returns the result as text.
export async function runJs(tabId: number, code: string): Promise<string> {
  const frame = await resolveFrame(tabId);

  const run = (expression: string, replMode: boolean) =>
    send(frame, 'Runtime.evaluate', {
      expression,
      replMode,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });

  const evaluation = (async () => {
    // REPL mode gives top-level await and the last expression's value.
    const outcome = await run(code, true);

    // A bare `return` only parses inside a function body.
    if (outcome.exceptionDetails?.exception?.description?.includes('Illegal return')) {
      return run(`(async () => {\n${code}\n})()`, false);
    }

    return outcome;
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const message =
        `JavaScript did not finish within ${JS_TIMEOUT_MS / 1000}s. It may still be running in the page: ` +
        'check its effects before starting another script. For long jobs, start them without awaiting ' +
        'and poll a window variable.';

      reject(new ToolError('JS_TIMEOUT', message));
    }, JS_TIMEOUT_MS);
  });

  // The evaluation keeps running after a timeout; its late failure is not ours to report.
  evaluation.catch(() => undefined);

  const outcome = await Promise.race([evaluation, timeout]).finally(() => clearTimeout(timer));

  if (outcome.exceptionDetails) {
    const details = outcome.exceptionDetails;
    const message = details.exception?.description ?? details.text;

    throw new ToolError('JS_ERROR', message.split('\n    at ').slice(0, 3).join('\n    at '));
  }

  const { type, value } = outcome.result;
  const output = type === 'undefined' ? 'undefined' : typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));

  return output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT)}\n[TRUNCATED]` : output;
}
