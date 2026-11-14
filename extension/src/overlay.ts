import { isAttached, onAttach, send } from './cdp.js';

interface Cmd {
  glow?: boolean;
  mute?: boolean;
  x?: number;
  y?: number;
  press?: boolean;
}

const IDLE_MS = 5_000;

// Tabs under control, each with the timer that ends the glow once calls stop.
const active = new Map<number, ReturnType<typeof setTimeout>>();
const scripts = new Map<number, string>();

// Runs inside the page, so it must not reference anything outside itself.
// Everything is built through the DOM and CSSOM: page CSP and Trusted Types
// block inline <style> and innerHTML.
function overlayPage(cmd: Cmd): void {
  if (window !== window.top) return;

  interface Els {
    host: HTMLElement;
    glow: HTMLElement;
    cursor: HTMLElement;
    ripple: HTMLElement;
  }

  interface State {
    glow: boolean;
    mute: boolean;
    x: number | null;
    y: number | null;
    els: Els | null;
  }

  const key = Symbol.for('browser-mcp.overlay');
  const holder = window as unknown as Record<symbol, State | undefined>;
  const state = (holder[key] ??= { glow: false, mute: false, x: null, y: null, els: null });

  if (cmd.glow !== undefined) state.glow = cmd.glow;
  if (cmd.mute !== undefined) state.mute = cmd.mute;

  const moved = cmd.x !== undefined && cmd.y !== undefined;

  if (moved) {
    state.x = cmd.x!;
    state.y = cmd.y!;
  }

  const css = `
    :host { all: initial; }
    .glow { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .35s;
      box-shadow: inset 0 0 0 4px #facc15, inset 0 0 36px 10px rgba(250,204,21,.85);
      animation: blink 1.1s ease-in-out infinite; }
    .glow.on { opacity: 1; }
    .bar { position: absolute; overflow: hidden; }
    .bar i { position: absolute; display: block; }
    .top, .bottom { left: 0; right: 0; height: 5px; }
    .top { top: 0; } .bottom { bottom: 0; }
    .left, .right { top: 0; bottom: 0; width: 5px; }
    .left { left: 0; } .right { right: 0; }
    .top i, .bottom i { top: 0; bottom: 0; width: 30%;
      background: linear-gradient(90deg, transparent, #fef08a, transparent); }
    .left i, .right i { left: 0; right: 0; height: 30%;
      background: linear-gradient(180deg, transparent, #fef08a, transparent); }
    .top i { animation: sweepX 2.6s linear infinite; }
    .right i { animation: sweepY 2.6s linear infinite .65s; }
    .bottom i { animation: sweepX 2.6s linear infinite reverse 1.3s; }
    .left i { animation: sweepY 2.6s linear infinite reverse 1.95s; }
    .cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none; opacity: 0;
      transition: transform .14s ease-out, opacity .2s; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
    .cursor.on { opacity: 1; }
    .ripple { position: absolute; left: -14px; top: -14px; width: 28px; height: 28px; border-radius: 50%;
      border: 2px solid #facc15; opacity: 0; }
    @keyframes blink { 50% { box-shadow: inset 0 0 0 2px rgba(250,204,21,.45), inset 0 0 14px 2px rgba(250,204,21,.2); } }
    @keyframes sweepX { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
    @keyframes sweepY { from { transform: translateY(-100%); } to { transform: translateY(340%); } }
  `;

  const make = (tag: string, className: string, parent?: ParentNode): HTMLElement => {
    const element = document.createElement(tag);

    element.className = className;
    parent?.appendChild(element);

    return element;
  };

  const build = (): Els => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();

    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:none';

    const glow = make('div', 'glow', root);

    for (const side of ['top', 'right', 'bottom', 'left']) {
      make('i', '', make('div', `bar ${side}`, glow));
    }

    const cursor = make('div', 'cursor', root);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');

    svg.setAttribute('viewBox', '0 0 22 22');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    arrow.setAttribute('d', 'M2 1 L2 16 L6 12.2 L8.8 18.6 L11.4 17.5 L8.6 11.2 L14 11.2 Z');
    arrow.setAttribute('fill', '#fff');
    arrow.setAttribute('stroke', '#111');
    arrow.setAttribute('stroke-width', '1.2');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(arrow);
    cursor.appendChild(svg);

    return { host, glow, cursor, ripple: make('div', 'ripple', cursor) };
  };

  const render = (): void => {
    const parent = document.documentElement;

    if (!parent) {
      document.addEventListener('DOMContentLoaded', render, { once: true });
      return;
    }

    if (!state.els) state.els = build();

    const { host, glow, cursor, ripple } = state.els;

    // Pages that rewrite <html> drop the host; put it back.
    if (!host.isConnected) parent.appendChild(host);

    host.style.display = state.mute || !state.glow ? 'none' : 'block';
    glow.classList.toggle('on', state.glow);
    cursor.classList.toggle('on', state.glow && state.x !== null);

    if (moved) {
      const fresh = cursor.style.transform === '';

      // The first placement jumps instead of sliding in from the corner.
      if (fresh) cursor.style.transition = 'none';

      cursor.style.transform = `translate(${state.x}px, ${state.y}px)`;

      if (fresh) {
        void cursor.offsetWidth;
        cursor.style.transition = '';
      }

      if (cmd.press) {
        ripple.animate(
          [
            { transform: 'scale(.3)', opacity: 0.9 },
            { transform: 'scale(1.6)', opacity: 0 },
          ],
          { duration: 450, easing: 'ease-out' },
        );
      }
    }
  };

  render();
}

const source = (cmd: Cmd): string => `(${overlayPage.toString()})(${JSON.stringify(cmd)})`;

async function run(tabId: number, cmd: Cmd): Promise<void> {
  if (!isAttached(tabId)) return;

  await send({ tabId }, 'Runtime.evaluate', { expression: source(cmd) }).catch(() => undefined);
}

// Registers the glow for every document the tab loads from now on, and
// applies it to the current one.
async function show(tabId: number): Promise<void> {
  if (!isAttached(tabId)) return;

  const { identifier } = await send({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', {
    source: source({ glow: true }),
  }).catch(() => ({ identifier: undefined }));

  if (identifier) scripts.set(tabId, identifier);

  await run(tabId, { glow: true });
}

async function hide(tabId: number): Promise<void> {
  if (!isAttached(tabId)) return;

  const identifier = scripts.get(tabId);

  scripts.delete(tabId);

  if (identifier) {
    await send({ tabId }, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => undefined);
  }

  await run(tabId, { glow: false });
}

// Marks the tab as being driven; the glow fades IDLE_MS after the last call.
export function activate(tabId: number): void {
  const wasActive = active.has(tabId);

  clearTimeout(active.get(tabId));

  active.set(
    tabId,
    setTimeout(() => {
      active.delete(tabId);
      void hide(tabId);
    }, IDLE_MS),
  );

  // A tab that is not attached yet gets it from the attach listener.
  if (!wasActive) void show(tabId);
}

export function cursor(tabId: number, point: { x: number; y: number }, press = false): void {
  if (active.has(tabId)) void run(tabId, { x: point.x, y: point.y, press });
}

// Keeps the overlay out of screenshots.
export async function hidden<T>(tabId: number, work: () => Promise<T>): Promise<T> {
  if (!active.has(tabId)) return work();

  await run(tabId, { mute: true });

  try {
    return await work();
  } finally {
    await run(tabId, { mute: false });
  }
}

export async function clearAll(): Promise<void> {
  const tabIds = [...active.keys()];

  for (const timer of active.values()) clearTimeout(timer);

  active.clear();
  await Promise.all(tabIds.map(hide));
}

onAttach(async (target) => {
  if (target.sessionId) return;

  // Registered scripts do not survive a detach.
  scripts.delete(target.tabId);

  if (active.has(target.tabId)) await show(target.tabId);
});
