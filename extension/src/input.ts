import { type Target, parentOf, send } from './cdp.js';
import { ToolError } from './errors.js';
import { cursor } from './overlay.js';
import { type ElementHandle, callOn } from './snapshot.js';

export interface Point {
  x: number;
  y: number;
}

interface KeyInfo {
  key: string;
  code: string;
  vk: number;
  text?: string;
}

const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

const MODIFIERS: Record<string, number> = {
  alt: ALT,
  option: ALT,
  ctrl: CTRL,
  control: CTRL,
  cmd: META,
  command: META,
  meta: META,
  super: META,
  win: META,
  windows: META,
  shift: SHIFT,
};

const NAMED_KEYS: Record<string, KeyInfo> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  del: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

// Shortcuts sent over CDP skip the OS menu, so name the editing command.
const EDIT_COMMANDS: Record<string, string> = {
  a: 'selectAll',
  c: 'copy',
  v: 'paste',
  x: 'cut',
  z: 'undo',
};

const PAGE_ZOOM_KEYS = new Set(['=', '+', '-', '0']);

// Inputs whose value cannot be typed character by character.
const NATIVE_VALUE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- geometry

// Position of an out-of-process iframe inside the tab's viewport.
export async function frameOffset(target: Target): Promise<Point> {
  if (!target.sessionId) return { x: 0, y: 0 };

  const parent = parentOf(target);
  const { frameTree } = await send(target, 'Page.getFrameTree');
  const owner = await send(parent, 'DOM.getFrameOwner', { frameId: frameTree.frame.id });
  const { quads } = await send(parent, 'DOM.getContentQuads', { backendNodeId: owner.backendNodeId });
  const outer = await frameOffset(parent);
  const quad = quads[0];

  return quad ? { x: quad[0]! + outer.x, y: quad[1]! + outer.y } : outer;
}

// Scrolls the element into view and returns its centre in CSS viewport pixels.
export async function centerOf(element: ElementHandle): Promise<Point> {
  await send(element, 'DOM.scrollIntoViewIfNeeded', { objectId: element.objectId }).catch(() => undefined);

  const { quads } = await send(element, 'DOM.getContentQuads', { objectId: element.objectId }).catch(() => ({
    quads: [],
  }));
  const quad = quads[0];

  if (!quad) {
    throw new ToolError('NOT_VISIBLE', `Element ${element.ref} has no visible box. For <option> use form_input on the select.`);
  }

  const offset = await frameOffset(element);

  return {
    x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4 + offset.x,
    y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4 + offset.y,
  };
}

// ---------------------------------------------------------------- mouse

export function modifierBits(modifiers: string | undefined): number {
  let bits = 0;

  for (const name of (modifiers ?? '').toLowerCase().split('+').filter(Boolean)) {
    const bit = MODIFIERS[name.trim()];

    if (!bit) throw new ToolError('BAD_ARGS', `Unknown modifier "${name}". Use ctrl, shift, alt, cmd.`);

    bits |= bit;
  }

  return bits;
}

async function mouse(
  tabId: number,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  point: Point,
  button: 'none' | 'left' | 'right' = 'none',
  clickCount = 0,
  modifiers = 0,
): Promise<void> {
  const buttons = button === 'left' && type !== 'mouseReleased' ? 1 : 0;

  await send({ tabId }, 'Input.dispatchMouseEvent', {
    type,
    x: point.x,
    y: point.y,
    button,
    buttons,
    clickCount,
    modifiers,
  });

  cursor(tabId, point, type === 'mousePressed');
}

export async function moveTo(tabId: number, point: Point): Promise<void> {
  await mouse(tabId, 'mouseMoved', point);
}

export async function click(
  tabId: number,
  point: Point,
  options: { button?: 'left' | 'right'; count?: number; modifiers?: number } = {},
): Promise<void> {
  const { button = 'left', count = 1, modifiers = 0 } = options;

  await mouse(tabId, 'mouseMoved', point, 'none', 0, modifiers);

  for (let nth = 1; nth <= count; nth++) {
    await mouse(tabId, 'mousePressed', point, button, nth, modifiers);
    await mouse(tabId, 'mouseReleased', point, button, nth, modifiers);
  }
}

export async function drag(tabId: number, from: Point, to: Point): Promise<void> {
  const moves = 12;

  await mouse(tabId, 'mouseMoved', from);
  await mouse(tabId, 'mousePressed', from, 'left', 1);

  for (let i = 1; i <= moves; i++) {
    const point = { x: from.x + ((to.x - from.x) * i) / moves, y: from.y + ((to.y - from.y) * i) / moves };

    await mouse(tabId, 'mouseMoved', point, 'left');
    await sleep(20);
  }

  // Drop targets often need a moment over them before the release counts.
  await sleep(100);
  await mouse(tabId, 'mouseReleased', to, 'left', 1);
}

export async function wheel(tabId: number, point: Point, deltaX: number, deltaY: number): Promise<void> {
  await send({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY });
  cursor(tabId, point);
  await sleep(150);
}

// ---------------------------------------------------------------- keyboard

function keyInfo(name: string): KeyInfo {
  const named = NAMED_KEYS[name.toLowerCase().replace(/_/g, '')];

  if (named) return named;

  if (/^F\d{1,2}$/i.test(name)) {
    const n = Number(name.slice(1));

    return { key: `F${n}`, code: `F${n}`, vk: 111 + n };
  }

  if ([...name].length !== 1) {
    throw new ToolError('BAD_ARGS', `Unknown key "${name}". Use names like Enter, Tab, Escape, ArrowDown, or one character.`);
  }

  const upper = name.toUpperCase();
  const isLetter = /^[A-Z]$/.test(upper);
  const isDigit = /^[0-9]$/.test(name);
  const code = isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : '';

  return { key: name, code, vk: isLetter || isDigit ? upper.charCodeAt(0) : 0, text: name };
}

async function pressKey(tabId: number, name: string, bits = 0): Promise<void> {
  const info = keyInfo(name);
  const isShortcut = (bits & ~SHIFT) !== 0;
  const shifted = (bits & SHIFT) !== 0 && info.key.length === 1;
  const key = shifted ? info.key.toUpperCase() : info.key;
  const text = isShortcut ? undefined : shifted ? info.text?.toUpperCase() : info.text;
  const command = bits & (CTRL | META) ? EDIT_COMMANDS[info.key.toLowerCase()] : undefined;

  const base = {
    key,
    code: info.code,
    windowsVirtualKeyCode: info.vk,
    nativeVirtualKeyCode: info.vk,
    modifiers: bits,
  };

  await send({ tabId }, 'Input.dispatchKeyEvent', {
    ...base,
    type: text ? 'keyDown' : 'rawKeyDown',
    text,
    unmodifiedText: text,
    commands: command ? [command] : undefined,
  });
  await send({ tabId }, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

// Presses one chord such as "Enter", "cmd+a" or "alt+shift+ArrowUp".
export async function pressChord(tabId: number, chord: string): Promise<void> {
  const parts = chord.split('+');
  let key = parts.pop() ?? '';

  // "cmd++" means the plus key itself.
  if (key === '') {
    key = '+';

    if (parts.at(-1) === '') parts.pop();
  }

  const bits = modifierBits(parts.join('+'));

  if (bits & (CTRL | META) && PAGE_ZOOM_KEYS.has(key)) {
    throw new ToolError('BAD_ARGS', `Page zoom shortcut "${chord}" is not supported. Use the zoom action instead.`);
  }

  await pressKey(tabId, key, bits);
}

export async function typeText(tabId: number, text: string): Promise<void> {
  for (const char of text) {
    if (char === '\n') await pressKey(tabId, 'Enter');
    else if (char === '\t') await pressKey(tabId, 'Tab');
    else if (char.length === 1) await pressKey(tabId, char);
    // Outside the BMP there is no single key event to send.
    else await send({ tabId }, 'Input.insertText', { text: char });
  }
}

// ---------------------------------------------------------------- form controls

function controlKind(this: Element): string {
  if (this instanceof HTMLSelectElement) return 'select';
  if (this instanceof HTMLInputElement) return this.type === 'checkbox' || this.type === 'radio' ? 'check' : this.type;
  if (this.getAttribute('role') === 'checkbox' || this.getAttribute('role') === 'switch') return 'check';

  const editable = this instanceof HTMLTextAreaElement || (this instanceof HTMLElement && this.isContentEditable);

  return editable ? 'text' : 'none';
}

function isChecked(this: Element): boolean {
  return this instanceof HTMLInputElement ? this.checked : this.getAttribute('aria-checked') === 'true';
}

function chooseOption(this: Element, wanted: string): string | null {
  if (!(this instanceof HTMLSelectElement)) return null;

  const needle = wanted.trim().toLowerCase();
  const option = [...this.options].find(
    (candidate) => candidate.value === wanted || candidate.text.trim().toLowerCase() === needle,
  );

  if (!option) return null;

  this.value = option.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));

  return option.text.trim();
}

function setNativeValue(this: Element, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  // Frameworks that wrap the value property only notice the prototype setter.
  setter?.call(this, value);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
}

// Refs can point at a text node; the control is the element around it.
function owningElement(this: Node): Element | null {
  const element = this instanceof Element ? this : this.parentElement;
  const isControl = element?.matches('input, select, textarea, [contenteditable], [role=checkbox], [role=switch]');

  // Text inside a <label> stands for the control it labels.
  return isControl ? element : (element?.closest('label')?.control ?? element);
}

// Null for elements without a value property (contenteditable).
function currentValue(this: Element): string | null {
  return 'value' in this ? String(this.value) : null;
}

// A user's edit is committed with a change event when they leave the field.
function commit(this: Element): void {
  this.dispatchEvent(new Event('change', { bubbles: true }));
}

function fileSizes(this: Element): Array<{ name: string; size: number }> {
  return this instanceof HTMLInputElement ? [...(this.files ?? [])].map((file) => ({ name: file.name, size: file.size })) : [];
}

function fileInputWithin(this: Element): Element | null {
  const isFileInput = (node: Element): boolean => node instanceof HTMLInputElement && node.type === 'file';

  if (isFileInput(this)) return this;
  if (this instanceof HTMLLabelElement && this.control && isFileInput(this.control)) return this.control;

  return this.querySelector('input[type=file]');
}

// `visible` is what the user would click when the control itself is hidden (a styled label).
async function check(element: ElementHandle, wanted: boolean, visible: ElementHandle): Promise<void> {
  if ((await callOn<boolean>(element, element.objectId, isChecked)) === wanted) return;

  const point = await centerOf(element).catch(() => centerOf(visible));

  await click(element.tabId, point);

  if ((await callOn<boolean>(element, element.objectId, isChecked)) !== wanted) {
    throw new ToolError('CHECK_FAILED', `Clicked ${element.ref}, but it is still ${wanted ? 'unchecked' : 'checked'}.`);
  }
}

async function replaceText(element: ElementHandle, text: string): Promise<void> {
  try {
    await send(element, 'DOM.focus', { objectId: element.objectId });
  } catch {
    await click(element.tabId, await centerOf(element));
  }

  await pressChord(element.tabId, navigator.userAgent.includes('Mac') ? 'cmd+a' : 'ctrl+a');
  await pressChord(element.tabId, 'Backspace');
  await typeText(element.tabId, text);
}

// Sets a form control the way a user would, and says what happened.
export async function setValue(handle: ElementHandle, value: string | boolean | number): Promise<string> {
  const owner = await send(handle, 'Runtime.callFunctionOn', {
    objectId: handle.objectId,
    functionDeclaration: owningElement.toString(),
  });

  if (!owner.result.objectId) throw new ToolError('BAD_ARGS', `${handle.ref} is not a form control that takes a value.`);

  const element: ElementHandle = { ...handle, objectId: owner.result.objectId };
  const kind = await callOn<string>(element, element.objectId, controlKind);

  if (kind === 'select') {
    const chosen = await callOn<string | null>(element, element.objectId, chooseOption, [String(value)]);

    if (chosen === null) throw new ToolError('NO_OPTION', `${element.ref} has no option "${value}".`);

    return `Selected "${chosen}" in ${element.ref}`;
  }

  if (kind === 'check') {
    const wanted = value === true || value === 'true' || value === 1;

    await check(element, wanted, handle);

    return `${element.ref} is now ${wanted ? 'checked' : 'unchecked'}`;
  }

  if (kind === 'file') {
    throw new ToolError('BAD_ARGS', `${element.ref} is a file input. Use file_upload.`);
  }

  if (kind === 'none' || ['button', 'submit', 'reset', 'image', 'hidden'].includes(kind)) {
    throw new ToolError('BAD_ARGS', `${element.ref} is not a form control that takes a value.`);
  }

  if (NATIVE_VALUE_TYPES.has(kind)) {
    await callOn(element, element.objectId, setNativeValue, [String(value)]);
  } else {
    await replaceText(element, String(value));
    await callOn(element, element.objectId, commit);
  }

  const actual = await callOn<string | null>(element, element.objectId, currentValue);

  if (actual !== null && actual !== String(value)) {
    throw new ToolError(
      'NOT_SET',
      `${element.ref} did not take "${value}": its value is now "${actual}". ` +
        'It may be readonly, disabled, or limit what it accepts (format, range, length).',
    );
  }

  return `Set ${element.ref} to "${value}"`;
}

export async function uploadFiles(element: ElementHandle, paths: string[]): Promise<string> {
  const { result } = await send(element, 'Runtime.callFunctionOn', {
    objectId: element.objectId,
    functionDeclaration: fileInputWithin.toString(),
  });

  if (!result.objectId) {
    throw new ToolError('NOT_FILE_INPUT', `No <input type=file> at ${element.ref}.`);
  }

  await send(element, 'DOM.setFileInputFiles', { files: paths, objectId: result.objectId });

  const set = await callOn<Array<{ name: string; size: number }>>(element, result.objectId, fileSizes);
  const listed = set.map((file) => `${file.name} (${file.size} bytes)`).join(', ');

  // The browser accepts a path that does not exist and hands the page an empty file.
  const warning = set.some((file) => file.size === 0) ? ' Warning: 0 bytes usually means the path does not exist.' : '';

  return `Uploaded to ${element.ref}: ${listed}.${warning}`;
}

// Lets a navigation triggered by the last action finish before the next one.
export async function settle(tabId: number): Promise<void> {
  const deadline = Date.now() + 10_000;

  await sleep(100);

  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);

    if (tab?.status !== 'loading') return;

    await sleep(100);
  }
}
