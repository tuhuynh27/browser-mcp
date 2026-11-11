import { ToolError, toErrorBody } from './errors.js';
import {
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  type Call,
  type ToExtension,
  type ToRelay,
} from './protocol.js';
import { loadSettings, loadStatus, saveStatus } from './settings.js';
import { releaseAll, runTool } from './tools.js';

const PING_MS = 20_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const ALARM = 'reconnect';
const CALL_BUDGET_MS = 85_000;

let socket: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let backoff = MIN_BACKOFF_MS;

// Calls run one at a time: mouse and key sequences from parallel calls would interleave.
let queue: Promise<void> = Promise.resolve();

function send(message: ToRelay): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function parse(raw: unknown): ToExtension | null {
  if (typeof raw !== 'string') return null;

  try {
    const message = JSON.parse(raw) as Partial<Omit<Call, 'type'>> & { type?: string };

    if (message.type === 'ready' || message.type === 'ping' || message.type === 'pong') {
      return { type: message.type };
    }

    const isCall =
      message.type === 'call' &&
      typeof message.id === 'string' &&
      typeof message.tool === 'string' &&
      typeof message.args === 'object' &&
      message.args !== null;

    return isCall ? (message as Call) : null;
  } catch {
    return null;
  }
}

// Answers every call before the relay gives up on it (90s), so a call that
// hangs cannot hold up the ones queued behind it.
async function handleCall(call: Call, receivedAt: number): Promise<void> {
  const left = receivedAt + CALL_BUDGET_MS - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    if (left <= 0) {
      throw new ToolError('BUSY', 'The browser was busy with earlier calls for too long. This call was not run; retry it.');
    }

    const expired = new Promise<never>((_resolve, reject) => {
      const message = `${call.tool} did not finish in time and was abandoned. Its effects may still land in the page.`;

      timer = setTimeout(() => reject(new ToolError('TIMEOUT', message)), left);
    });

    const work = runTool(call.tool, call.args);

    // Abandoned work may fail later; that failure has nowhere to go.
    work.catch(() => undefined);

    const data = await Promise.race([work, expired]);

    send({ type: 'result', id: call.id, ok: true, data });
  } catch (error) {
    send({ type: 'result', id: call.id, ok: false, error: toErrorBody(error) });
  } finally {
    clearTimeout(timer);
  }
}

// Lookups that touch no page skip the queue.
function isLookup(call: Call): boolean {
  return call.tool === 'tabs_context_mcp' || (call.tool === 'files' && call.args.action === 'path');
}

function onMessage(message: ToExtension | null): void {
  if (!message) return;

  if (message.type === 'ready') {
    backoff = MIN_BACKOFF_MS;
    void saveStatus({ state: 'connected' });
  } else if (message.type === 'ping') {
    send({ type: 'pong' });
  } else if (message.type === 'call') {
    const receivedAt = Date.now();

    if (isLookup(message)) void handleCall(message, receivedAt);
    else queue = queue.then(() => handleCall(message, receivedAt));
  }
}

function onClose(closed: WebSocket, code: number): void {
  if (socket !== closed) return;

  socket = null;
  clearInterval(pingTimer);

  if (code === CLOSE_UNAUTHORIZED) {
    void saveStatus({ state: 'unauthorized' });
  } else if (code === CLOSE_REPLACED) {
    void saveStatus({ state: 'replaced' });
  } else {
    void saveStatus({ state: 'disconnected', detail: 'retrying' });

    retryTimer = setTimeout(() => void connect(), backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}

function relaySocketUrl(base: string): string | null {
  try {
    const url = new URL(base);

    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ext';

    return url.href;
  } catch {
    return null;
  }
}

async function connect(): Promise<void> {
  const settings = await loadSettings();
  const target = relaySocketUrl(settings.url);

  if (!settings.enabled || socket) return;

  if (!target) {
    await saveStatus({ state: 'disconnected', detail: 'invalid relay URL' });
    return;
  }

  const opened = new WebSocket(target);
  socket = opened;
  void saveStatus({ state: 'connecting' });

  opened.onopen = () => {
    send({
      type: 'hello',
      token: settings.token,
      browser: navigator.userAgent.includes('Edg/') ? 'Edge' : 'Chrome',
      version: chrome.runtime.getManifest().version,
    });

    // Socket traffic resets the MV3 idle timer, keeping the worker alive.
    pingTimer = setInterval(() => send({ type: 'ping' }), PING_MS);
  };

  opened.onmessage = (event) => onMessage(parse(event.data));
  opened.onclose = (event) => onClose(opened, event.code);
}

async function disconnect(): Promise<void> {
  const closing = socket;

  socket = null;
  clearInterval(pingTimer);
  clearTimeout(retryTimer);
  closing?.close(1000);

  await releaseAll();
  await saveStatus({ state: 'disconnected' });
}

// Runs on every worker start and alarm tick. A rejected token or a takeover
// by another browser stays down until the settings change.
async function resume(): Promise<void> {
  const { state } = await loadStatus();

  if (state === 'unauthorized' || state === 'replaced') return;

  await connect();
}

chrome.storage.local.onChanged.addListener(async (changes) => {
  if (!changes.settings) return;

  await disconnect();
  backoff = MIN_BACKOFF_MS;
  await connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void resume();
});

// Registering the listener is what starts the worker at browser launch.
chrome.runtime.onStartup.addListener(() => void resume());

// Wakes the worker if the browser killed it despite the pings.
void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
void resume();
