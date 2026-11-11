// Encodes screencast frames from the service worker into a WebM file.
// Runs in an offscreen document because MediaRecorder needs a DOM.

import { type RelayAccess, type RelayFile, base64ToBlob, uploadFile } from './upload.js';

export type OffscreenMessage =
  | { to: 'offscreen'; cmd: 'start'; fps: number }
  | { to: 'offscreen'; cmd: 'frame'; data: string }
  | { to: 'offscreen'; cmd: 'stop'; relay: RelayAccess; name: string };

// Chrome-only API, missing from lib.dom.
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'video' });
  readonly writable: WritableStream<VideoFrame>;
}

interface Session {
  track: MediaStreamTrackGenerator;
  writer: WritableStreamDefaultWriter<VideoFrame>;
  recorder: MediaRecorder | null;
  canvas: OffscreenCanvas | null;
  chunks: Blob[];
  startedAt: number;
  fps: number;
  keepalive: ReturnType<typeof setInterval>;
}

let session: Session | null = null;

// Frames are queued so async decoding cannot reorder them.
let queue: Promise<unknown> = Promise.resolve();

async function writeFrame(active: Session): Promise<void> {
  if (!active.canvas) return;

  const frame = new VideoFrame(active.canvas, { timestamp: (performance.now() - active.startedAt) * 1000 });

  await active.writer.write(frame);
  frame.close();
}

async function addFrame(active: Session, data: string): Promise<void> {
  const bitmap = await createImageBitmap(base64ToBlob(data, 'image/jpeg'));

  if (!active.canvas) {
    // The first frame fixes the video size; encoders want even dimensions.
    active.canvas = new OffscreenCanvas(bitmap.width & ~1, bitmap.height & ~1);
    active.startedAt = performance.now();
  }

  active.canvas.getContext('2d')!.drawImage(bitmap, 0, 0, active.canvas.width, active.canvas.height);
  bitmap.close();

  await writeFrame(active);

  if (!active.recorder) {
    const recorder = new MediaRecorder(new MediaStream([active.track]), {
      mimeType: 'video/webm;codecs=vp8',
      videoBitsPerSecond: 2_500_000,
    });

    recorder.ondataavailable = (event) => active.chunks.push(event.data);
    recorder.start(1_000);
    active.recorder = recorder;
  }
}

function start(fps: number): void {
  const track = new MediaStreamTrackGenerator({ kind: 'video' });

  const active: Session = {
    track,
    writer: track.writable.getWriter(),
    recorder: null,
    canvas: null,
    chunks: [],
    startedAt: 0,
    fps,
    // The screencast is silent while the page is still; repeat the last
    // frame so the video keeps its real duration.
    keepalive: setInterval(() => {
      queue = queue.then(() => writeFrame(active)).catch(() => undefined);
    }, 1_000),
  };

  session = active;
}

async function stop(relay: RelayAccess, name: string): Promise<RelayFile> {
  const active = session;

  if (!active) throw new Error('No recording in progress.');

  session = null;
  clearInterval(active.keepalive);

  await queue;
  await writeFrame(active).catch(() => undefined);

  if (!active.recorder) throw new Error('The tab produced no frames. Is it visible?');

  // Give the encoder time to take in the closing frame.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const recorder = active.recorder;
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));

  recorder.stop();
  await stopped;
  active.track.stop();

  return uploadFile(relay, name, new Blob(active.chunks, { type: 'video/webm' }));
}

chrome.runtime.onMessage.addListener((message: OffscreenMessage, _sender, respond) => {
  if (message?.to !== 'offscreen') return false;

  if (message.cmd === 'start') {
    start(message.fps);
    respond({ ok: true });
  } else if (message.cmd === 'frame') {
    const active = session;

    if (active) queue = queue.then(() => addFrame(active, message.data)).catch(() => undefined);

    respond({ ok: true });
  } else {
    stop(message.relay, message.name).then(
      (file) => respond({ ok: true, file }),
      (error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  }

  // Keeps the channel open for the async stop reply.
  return true;
});
