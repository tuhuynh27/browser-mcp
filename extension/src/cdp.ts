import type { Protocol } from 'devtools-protocol';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';

import { ToolError } from './errors.js';

type Commands = ProtocolMapping.Commands;

export interface Target {
  tabId: number;
  sessionId?: string;
}

// A frame's default JS context. No frameId means the tab's main frame.
export interface Frame extends Target {
  frameId?: string;
  contextId?: number;
}

export interface RefEntry {
  backendNodeId: number;
  sessionId?: string;
}

interface TabState {
  refs: Map<string, RefEntry>;
  refByNode: Map<string, string>;
  nextRef: number;
  frames: Map<string, { sessionId?: string; contextId: number }>;
  // Out-of-process iframe session -> the session that embeds it.
  sessions: Map<string, string | undefined>;
}

type EventListener = (target: Target, method: string, params: unknown) => void;
type AttachListener = (target: Target) => Promise<void>;

const RESTRICTED = /^(chrome|edge|devtools|chrome-extension|extension|view-source|chrome-search):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/;

const states = new Map<number, TabState>();
const attaching = new Map<number, Promise<void>>();
const eventListeners: EventListener[] = [];
const attachListeners: AttachListener[] = [];

export function onEvent(listener: EventListener): void {
  eventListeners.push(listener);
}

// Runs for the tab and for every out-of-process iframe session.
export function onAttach(listener: AttachListener): void {
  attachListeners.push(listener);
}

function debuggee(target: Target): chrome.debugger.DebuggerSession {
  return target.sessionId ? { tabId: target.tabId, sessionId: target.sessionId } : { tabId: target.tabId };
}

function cdpMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  try {
    return (JSON.parse(raw) as { message?: string }).message ?? raw;
  } catch {
    return raw;
  }
}

async function raw<M extends keyof Commands>(
  target: Target,
  method: M,
  ...params: Commands[M]['paramsType']
): Promise<Commands[M]['returnType']> {
  try {
    const result = await chrome.debugger.sendCommand(debuggee(target), method, params[0] as object | undefined);

    return result as Commands[M]['returnType'];
  } catch (error) {
    throw new ToolError('CDP_ERROR', `${method}: ${cdpMessage(error)}`);
  }
}

export async function send<M extends keyof Commands>(
  target: Target,
  method: M,
  ...params: Commands[M]['paramsType']
): Promise<Commands[M]['returnType']> {
  await attach(target.tabId);

  return raw(target, method, ...params);
}

async function initSession(target: Target): Promise<void> {
  await Promise.all([
    raw(target, 'Page.enable'),
    raw(target, 'Runtime.enable'),
    // Makes the page behave as focused and visible, so a background tab or a
    // covered window paints and takes input without being brought to the front.
    raw(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined),
    raw(target, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }],
    }),
    ...attachListeners.map((listener) => listener(target)),
  ]);
}

async function attachNow(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);

  if (!tab) {
    throw new ToolError('NO_TAB', `No tab with id ${tabId}. Use tabs_context_mcp to get valid tab IDs.`);
  }

  if (RESTRICTED.test(tab.url ?? '')) {
    throw new ToolError('RESTRICTED_PAGE', `The browser does not allow control of ${tab.url}`);
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (error) {
    // Left over from before a service worker restart: take it back.
    if (!/already attached/i.test(cdpMessage(error))) {
      throw new ToolError('ATTACH_FAILED', cdpMessage(error));
    }

    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    await chrome.debugger.attach({ tabId }, '1.3');
  }

  states.set(tabId, {
    refs: new Map(),
    refByNode: new Map(),
    nextRef: 1,
    frames: new Map(),
    sessions: new Map(),
  });

  await initSession({ tabId });

  // The browser's debugging bar appears now and shrinks the viewport; let it
  // settle so the first screenshot reports the frame later clicks will use.
  await new Promise((resolve) => setTimeout(resolve, 400));
}

export function attach(tabId: number): Promise<void> {
  if (states.has(tabId)) return Promise.resolve();

  let pending = attaching.get(tabId);

  if (!pending) {
    pending = attachNow(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, pending);
  }

  return pending;
}

export async function detachAll(): Promise<void> {
  const tabIds = [...states.keys()];

  states.clear();
  await Promise.all(tabIds.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => undefined)));
}

export function isAttached(tabId: number): boolean {
  return states.has(tabId);
}

// ---------------------------------------------------------------- refs

export function refFor(target: Target, backendNodeId: number): string {
  const state = states.get(target.tabId);

  if (!state) throw new ToolError('DETACHED', 'Debugger was detached from the tab. Retry.');

  const key = `${target.sessionId ?? ''}:${backendNodeId}`;
  let ref = state.refByNode.get(key);

  if (!ref) {
    ref = `ref_${state.nextRef++}`;
    state.refByNode.set(key, ref);
    state.refs.set(ref, { backendNodeId, sessionId: target.sessionId });
  }

  return ref;
}

export function lookupRef(tabId: number, ref: string): RefEntry | undefined {
  return states.get(tabId)?.refs.get(ref);
}

// ---------------------------------------------------------------- frames

export async function resolveFrame(tabId: number, frameId?: string): Promise<Frame> {
  await attach(tabId);

  if (!frameId) return { tabId };

  const found = states.get(tabId)?.frames.get(frameId);

  if (!found) {
    throw new ToolError('NO_FRAME', `No frame ${frameId}. Take a snapshot to list frames.`);
  }

  return { tabId, frameId, sessionId: found.sessionId, contextId: found.contextId };
}

export function sessionsOf(tabId: number): string[] {
  return [...(states.get(tabId)?.sessions.keys() ?? [])];
}

export function parentOf(target: Target): Target {
  return { tabId: target.tabId, sessionId: states.get(target.tabId)?.sessions.get(target.sessionId ?? '') };
}

// ---------------------------------------------------------------- events

function dropSession(state: TabState, sessionId: string | undefined): void {
  for (const [frameId, frame] of state.frames) {
    if (frame.sessionId === sessionId) state.frames.delete(frameId);
  }
}

function track(target: Target, state: TabState, method: string, params: unknown): void {
  const { sessionId } = target;

  if (method === 'Runtime.executionContextCreated') {
    const { context } = params as Protocol.Runtime.ExecutionContextCreatedEvent;
    const aux = context.auxData as { isDefault?: boolean; frameId?: string } | undefined;

    if (aux?.isDefault && aux.frameId) {
      state.frames.set(aux.frameId, { sessionId, contextId: context.id });
    }
  } else if (method === 'Runtime.executionContextDestroyed') {
    const { executionContextId } = params as Protocol.Runtime.ExecutionContextDestroyedEvent;

    for (const [frameId, frame] of state.frames) {
      if (frame.sessionId === sessionId && frame.contextId === executionContextId) {
        state.frames.delete(frameId);
      }
    }
  } else if (method === 'Runtime.executionContextsCleared') {
    dropSession(state, sessionId);
  } else if (method === 'Target.attachedToTarget') {
    const child = (params as Protocol.Target.AttachedToTargetEvent).sessionId;

    state.sessions.set(child, sessionId);
    initSession({ tabId: target.tabId, sessionId: child }).catch(() => undefined);
  } else if (method === 'Target.detachedFromTarget') {
    const child = (params as Protocol.Target.DetachedFromTargetEvent).sessionId;

    state.sessions.delete(child);
    dropSession(state, child);
  } else if (method === 'Page.frameNavigated' && !sessionId) {
    const { frame } = params as Protocol.Page.FrameNavigatedEvent;

    // A new main document invalidates every ref handed out so far.
    if (!frame.parentId) {
      state.refs.clear();
      state.refByNode.clear();
    }
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return;

  const state = states.get(source.tabId);

  if (!state) return;

  const target: Target = { tabId: source.tabId, sessionId: (source as Target).sessionId };

  track(target, state, method, params);

  for (const listener of eventListeners) listener(target, method, params);
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined && !(source as Target).sessionId) {
    states.delete(source.tabId);
  }
});
