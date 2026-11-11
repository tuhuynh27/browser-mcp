import type { Protocol } from 'devtools-protocol';

import { captureViewport, viewOf } from './capture.js';
import { onEvent, send } from './cdp.js';
import { ToolError } from './errors.js';
import type { OffscreenMessage } from './offscreen.js';
import type { RecordArgs } from './protocol.js';
import { loadSettings } from './settings.js';
import { existingTab } from './tabs.js';
import { type RelayFile, base64ToBlob, uploadFile } from './upload.js';

interface Recording {
  tabId: number;
  fps: number;
  startedAt: number;
  lastFrameAt: number;
  held?: ReturnType<typeof setTimeout>;
  timer: ReturnType<typeof setTimeout>;
}

type Finished = RelayFile & { seconds: number; autoStopped?: true };

const MAX_SECONDS = 300;
const MAX_FRAMES = 20;
const MAX_FRAMES_SPAN_MS = 60_000;

let recording: Recording | null = null;
let finishing: Promise<Finished> | null = null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function toOffscreen<T>(message: OffscreenMessage): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}

async function openOffscreen(): Promise<void> {
  const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });

  if (open.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Encode tab recordings to WebM.',
  });
}

onEvent((target, method, params) => {
  if (method !== 'Page.screencastFrame' || target.sessionId) return;

  const frame = params as Protocol.Page.ScreencastFrameEvent;
  const active = recording;

  send(target, 'Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);

  if (!active || active.tabId !== target.tabId) return;

  // The screencast can outrun the requested frame rate. Hold the newest
  // frame back instead of dropping it, so the last state always lands.
  const wait = active.lastFrameAt + 1000 / active.fps - Date.now();

  clearTimeout(active.held);

  if (wait > 0) {
    active.held = setTimeout(() => forward(active, frame.data), wait);
  } else {
    forward(active, frame.data);
  }
});

function forward(active: Recording, data: string): void {
  if (recording !== active) return;

  active.lastFrameAt = Date.now();
  toOffscreen({ to: 'offscreen', cmd: 'frame', data }).catch(() => undefined);
}

async function finish(autoStopped: boolean): Promise<Finished> {
  const active = recording;

  if (!active) throw new ToolError('NOT_RECORDING', 'No recording in progress. Use record {action:"start"}.');

  recording = null;
  clearTimeout(active.timer);
  clearTimeout(active.held);

  await send({ tabId: active.tabId }, 'Page.stopScreencast').catch(() => undefined);

  const stamp = new Date(active.startedAt).toISOString().replace(/[:.]/g, '-');

  const reply = await toOffscreen<{ ok: boolean; file?: RelayFile; error?: string }>({
    to: 'offscreen',
    cmd: 'stop',
    relay: await loadSettings(),
    name: `recording-${stamp}.webm`,
  });

  await chrome.offscreen.closeDocument().catch(() => undefined);

  if (!reply.ok || !reply.file) {
    throw new ToolError('RECORD_FAILED', reply.error ?? 'Encoding failed.');
  }

  const seconds = Math.round((Date.now() - active.startedAt) / 100) / 10;

  return autoStopped ? { ...reply.file, seconds, autoStopped } : { ...reply.file, seconds };
}

async function start(tabId: number, args: RecordArgs): Promise<unknown> {
  if (recording) {
    throw new ToolError('ALREADY_RECORDING', `Tab ${recording.tabId} is being recorded. Stop it first.`);
  }

  const fps = Math.min(Math.max(args.fps ?? 10, 1), 30);
  const maxSeconds = Math.min(Math.max(args.maxSeconds ?? 60, 1), MAX_SECONDS);

  await existingTab(tabId);

  finishing = null;
  await openOffscreen();
  await toOffscreen({ to: 'offscreen', cmd: 'start', fps });

  recording = {
    tabId,
    fps,
    startedAt: Date.now(),
    lastFrameAt: 0,
    timer: setTimeout(() => {
      finishing = finish(true);
      finishing.catch(() => undefined);
    }, maxSeconds * 1000),
  };

  try {
    const { cssVisualViewport: view } = await send({ tabId }, 'Page.getLayoutMetrics');

    // Cap at CSS size so HiDPI screens do not quadruple the video.
    await send({ tabId }, 'Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: Math.round(view.clientWidth),
      maxHeight: Math.round(view.clientHeight),
    });
  } catch (error) {
    clearTimeout(recording.timer);
    recording = null;
    await chrome.offscreen.closeDocument().catch(() => undefined);

    throw error;
  }

  return { recording: true, tabId, fps, maxSeconds };
}

async function stop(): Promise<Finished> {
  // A recording that hit maxSeconds is already finalized (or doing so).
  if (!recording && finishing) {
    const done = finishing;

    finishing = null;

    return done;
  }

  return finish(false);
}

async function frames(tabId: number, args: RecordArgs): Promise<unknown> {
  const count = Math.min(Math.max(args.count ?? 5, 1), MAX_FRAMES);
  const intervalMs = Math.min(Math.max(args.intervalMs ?? 1_000, 0), MAX_FRAMES_SPAN_MS / count);
  const relay = await loadSettings();
  const stamp = Date.now();
  const shots: RelayFile[] = [];

  for (let index = 0; index < count; index++) {
    const startedAt = Date.now();
    const shot = await captureViewport(tabId, await viewOf(tabId));
    const name = `frame-${stamp}-${String(index + 1).padStart(2, '0')}.jpg`;

    shots.push(await uploadFile(relay, name, base64ToBlob(shot.data, shot.mimeType)));

    if (index < count - 1) await sleep(Math.max(0, intervalMs - (Date.now() - startedAt)));
  }

  return { frames: shots, intervalMs };
}

export async function record(args: RecordArgs, pickTab: (tabId?: number) => Promise<number>): Promise<unknown> {
  if (args.action === 'stop') return stop();

  const tabId = await pickTab(args.tabId);

  if (args.action === 'start') return start(tabId, args);
  if (args.action === 'frames') return frames(tabId, args);

  throw new ToolError('BAD_ARGS', `Unknown action ${String(args.action)}.`);
}
