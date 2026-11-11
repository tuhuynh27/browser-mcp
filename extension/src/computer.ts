import { type View, captureRegion, captureViewport, viewOf } from './capture.js';
import { ToolError } from './errors.js';
import {
  type Point,
  centerOf,
  click,
  drag,
  modifierBits,
  moveTo,
  pressChord,
  settle,
  sleep,
  typeText,
  wheel,
} from './input.js';
import type { ComputerArgs, Content } from './protocol.js';
import { loadSettings } from './settings.js';
import { resolveRef } from './snapshot.js';
import { base64ToBlob, uploadFile } from './upload.js';

const WHEEL_TICK_PX = 100;
const RELOAD_KEYS = new Set(['f5', 'shift+f5', 'ctrl+f5', 'cmd+r', 'ctrl+r', 'meta+r', 'cmd+shift+r', 'ctrl+shift+r']);

const CLICKS = {
  left_click: { verb: 'Clicked', button: 'left', count: 1 },
  right_click: { verb: 'Right-clicked', button: 'right', count: 1 },
  double_click: { verb: 'Double-clicked', button: 'left', count: 2 },
  triple_click: { verb: 'Triple-clicked', button: 'left', count: 3 },
} as const;

const text = (value: string): Content[] => [{ type: 'text', text: value }];

function pair(value: unknown, name: string, action: string): [number, number] {
  const isPair = Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === 'number');

  if (!isPair) throw new ToolError('BAD_ARGS', `${action} needs ${name} as [x, y].`);

  return value as [number, number];
}

// Frame coordinates (what the model sees) to CSS viewport pixels.
function toCss(view: View, [x, y]: [number, number]): Point {
  if (x < 0 || y < 0 || x > view.width || y > view.height) {
    throw new ToolError(
      'BAD_ARGS',
      `(${x}, ${y}) is outside the ${view.width}x${view.height} coordinate frame. Take a screenshot.`,
    );
  }

  return { x: x / view.ratio, y: y / view.ratio };
}

// Where an action lands: an element ref, or a coordinate from a screenshot.
async function locate(args: ComputerArgs): Promise<{ point: Point; label: string; onRef: boolean }> {
  if (args.ref) {
    return { point: await centerOf(await resolveRef(args.tabId, args.ref)), label: `element ${args.ref}`, onRef: true };
  }

  const coordinate = pair(args.coordinate, 'coordinate or ref', args.action);
  const view = await viewOf(args.tabId);

  return {
    point: toCss(view, coordinate),
    label: `(${coordinate[0]}, ${coordinate[1]})`,
    onRef: false,
  };
}

async function saved(args: ComputerArgs, data: string, mimeType: string): Promise<string> {
  if (!args.save_to_disk) return '';

  const extension = mimeType === 'image/png' ? 'png' : 'jpg';
  const file = await uploadFile(await loadSettings(), `screenshot-${Date.now()}.${extension}`, base64ToBlob(data, mimeType));

  return `\nSaved to: ${file.url}`;
}

async function screenshot(args: ComputerArgs): Promise<Content[]> {
  const view = await viewOf(args.tabId);
  const scale = Math.min(Math.max(args.scale ?? 1, 0.1), 1);
  const shot = await captureViewport(args.tabId, view, scale);
  const id = `ss_${Math.random().toString(36).slice(2, 11)}`;
  const frame = scale < 1 ? ` - ${scale}-scale view; coordinate frame: ${view.width}x${view.height}.` : '';

  return [
    {
      type: 'text',
      text:
        `Successfully captured screenshot (${shot.width}x${shot.height}, jpeg) - ID: ${id}${frame}` +
        (await saved(args, shot.data, shot.mimeType)),
    },
    { type: 'image', data: shot.data, mimeType: shot.mimeType },
  ];
}

async function zoom(args: ComputerArgs): Promise<Content[]> {
  const region = args.region;

  if (!Array.isArray(region) || region.length !== 4) {
    throw new ToolError('BAD_ARGS', 'zoom needs region as [x0, y0, x1, y1].');
  }

  const scale = Math.min(Math.max(args.scale ?? 1, 0.1), 1);
  const shot = await captureRegion(args.tabId, await viewOf(args.tabId), region, scale);
  const [x0, y0, x1, y1] = region;

  return [
    {
      type: 'text',
      text:
        `Successfully captured zoomed screenshot of region (${x0},${y0}) to (${x1},${y1}) - ` +
        `${shot.width}x${shot.height} pixels` +
        (await saved(args, shot.data, shot.mimeType)),
    },
    { type: 'image', data: shot.data, mimeType: shot.mimeType },
  ];
}

async function scroll(args: ComputerArgs): Promise<Content[]> {
  const direction = args.scroll_direction;

  if (!direction) throw new ToolError('BAD_ARGS', 'scroll needs scroll_direction.');

  const view = await viewOf(args.tabId);
  const coordinate = args.coordinate ?? [Math.round(view.width / 2), Math.round(view.height / 2)];
  const ticks = Math.min(Math.max(args.scroll_amount ?? 3, 1), 10);
  const distance = ticks * WHEEL_TICK_PX;
  const deltaX = direction === 'left' ? -distance : direction === 'right' ? distance : 0;
  const deltaY = direction === 'up' ? -distance : direction === 'down' ? distance : 0;

  await wheel(args.tabId, toCss(view, pair(coordinate, 'coordinate', 'scroll')), deltaX, deltaY);

  return text(`Scrolled ${direction} by ${ticks} ticks at (${coordinate[0]}, ${coordinate[1]})`);
}

async function key(args: ComputerArgs): Promise<Content[]> {
  const keys = (args.text ?? '').trim().split(/\s+/).filter(Boolean);
  const repeat = Math.min(Math.max(Math.floor(args.repeat ?? 1), 1), 100);

  if (keys.length === 0) throw new ToolError('BAD_ARGS', 'key needs text, e.g. "Enter" or "cmd+a".');

  for (let round = 0; round < repeat; round++) {
    for (const chord of keys) {
      // Reload is handled by the browser, not the page, so key events never trigger it.
      if (RELOAD_KEYS.has(chord.toLowerCase())) await chrome.tabs.reload(args.tabId);
      else await pressChord(args.tabId, chord);
    }
  }

  await settle(args.tabId);

  const total = keys.length * repeat;
  const times = repeat > 1 ? ` (x${repeat})` : '';

  return text(`Pressed ${total} key${total === 1 ? '' : 's'}: ${keys.join(' ')}${times}`);
}

export async function computer(args: ComputerArgs): Promise<Content[]> {
  const { action, tabId } = args;

  switch (action) {
    case 'screenshot':
      return screenshot(args);

    case 'zoom':
      return zoom(args);

    case 'scroll':
      return scroll(args);

    case 'key':
      return key(args);

    case 'left_click':
    case 'right_click':
    case 'double_click':
    case 'triple_click': {
      const { verb, button, count } = CLICKS[action];
      const { point, label, onRef } = await locate(args);

      await click(tabId, point, { button, count, modifiers: modifierBits(args.modifiers) });
      await settle(tabId);

      return text(`${verb} ${onRef ? 'on' : 'at'} ${label}`);
    }

    case 'hover': {
      const { point, label, onRef } = await locate(args);

      await moveTo(tabId, point);

      return text(`Hovered ${onRef ? 'over' : 'at'} ${label}`);
    }

    case 'left_click_drag': {
      const view = await viewOf(tabId);
      const from = pair(args.start_coordinate, 'start_coordinate', action);
      const to = pair(args.coordinate, 'coordinate', action);

      await drag(tabId, toCss(view, from), toCss(view, to));
      await settle(tabId);

      return text(`Dragged from (${from[0]}, ${from[1]}) to (${to[0]}, ${to[1]})`);
    }

    case 'type':
      if (typeof args.text !== 'string') throw new ToolError('BAD_ARGS', 'type needs text.');

      await typeText(tabId, args.text);
      await settle(tabId);

      return text(`Typed "${args.text}"`);

    case 'wait': {
      const seconds = Math.min(Math.max(args.duration ?? 1, 0), 10);

      await sleep(seconds * 1000);

      return text(`Waited for ${seconds} second${seconds === 1 ? '' : 's'}`);
    }

    case 'scroll_to': {
      if (!args.ref) throw new ToolError('BAD_ARGS', 'scroll_to needs ref.');

      await centerOf(await resolveRef(tabId, args.ref));

      return text(`Scrolled to element ${args.ref}`);
    }

    default:
      throw new ToolError('BAD_ARGS', `Unknown action "${String(action)}".`);
  }
}
