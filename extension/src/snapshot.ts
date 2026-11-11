import type { Protocol } from 'devtools-protocol';

import { type Frame, type Target, lookupRef, refFor, resolveFrame, send } from './cdp.js';
import { ToolError } from './errors.js';
import type { ReadPageArgs } from './protocol.js';

type AXNode = Protocol.Accessibility.AXNode;

export const MAX_OUTPUT = 25_000;

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_DEPTH = 15;
const MAX_FRAME_NESTING = 3;
const MAX_MATCHES = 20;
const RELEVANCE_CUTOFF = 0.7;

const SKIP = new Set([
  'none',
  'generic',
  'presentation',
  'InlineTextBox',
  'LineBreak',
  'ListMarker',
  'paragraph',
  'RootWebArea',
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell',
]);

const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
]);

// Shown even without a name: they give the tree its shape.
const STRUCTURAL = new Set(['table', 'row', 'dialog', 'alertdialog', 'form', 'Iframe', 'tree', 'menu', 'list']);

export function cap(text: string, max: number): { text: string; truncated?: true } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text };
}

// ---------------------------------------------------------------- page JS

function jsError(details: Protocol.Runtime.ExceptionDetails): ToolError {
  const message = details.exception?.description ?? details.text;

  return new ToolError('JS_ERROR', message.split('\n    at ')[0]!);
}

export async function evaluate<T>(frame: Frame, expression: string): Promise<T> {
  const { result, exceptionDetails } = await send(frame, 'Runtime.evaluate', {
    expression,
    contextId: frame.contextId,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });

  if (exceptionDetails) throw jsError(exceptionDetails);

  return result.value as T;
}

// Calls `fn` with `this` bound to the remote object. `fn` must be self-contained.
export async function callOn<T>(
  target: Target,
  objectId: string,
  fn: (...args: never[]) => unknown,
  args: unknown[] = [],
): Promise<T> {
  const { result, exceptionDetails } = await send(target, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: fn.toString(),
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });

  if (exceptionDetails) throw jsError(exceptionDetails);

  return result.value as T;
}

// ---------------------------------------------------------------- tree

interface Entry {
  depth: number;
  role: string;
  name: string;
  state: string;
  target: Target;
  backendNodeId?: number;
  isText: boolean;
  // Names of the enclosing elements, for queries like "button in the login form".
  context: string;
}

function clean(value: unknown, max: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();

  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function describeState(node: AXNode, name: string): string {
  let out = '';
  const value = clean(node.value?.value, 100);

  if (value && value !== name) out += ` value="${value}"`;

  for (const property of node.properties ?? []) {
    const flag = property.value.value as unknown;

    if (property.name === 'level') out += ` level=${flag}`;
    else if (property.name === 'url') out += ` href="${clean(flag, 150)}"`;
    else if (property.name === 'checked' && flag !== 'false') out += flag === 'mixed' ? ' mixed' : ' checked';
    else if (property.name === 'expanded') out += flag ? ' expanded' : ' collapsed';
    else if (['disabled', 'selected', 'focused', 'required'].includes(property.name) && flag === true) {
      out += ` ${property.name}`;
    }
  }

  return out;
}

async function axTree(frame: Frame): Promise<AXNode[]> {
  const { nodes } = await send(frame, 'Accessibility.getFullAXTree', frame.frameId ? { frameId: frame.frameId } : {});

  return nodes;
}

// Flattens the accessibility tree of the page, iframes included, in document order.
async function collect(tabId: number): Promise<Entry[]> {
  const entries: Entry[] = [];

  const walkFrame = async (frame: Frame, baseDepth: number, nesting: number, outer: string): Promise<void> => {
    const nodes = await axTree(frame);
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const target: Target = { tabId, sessionId: frame.sessionId };

    const walk = async (node: AXNode, depth: number, parentName: string, context: string): Promise<void> => {
      const role = String(node.role?.value ?? '');
      let childDepth = depth;
      let childParent = parentName;
      let childContext = context;

      if (!node.ignored && role === 'StaticText') {
        const text = clean(node.name?.value, 300);

        // Skip text that only repeats the name of the enclosing button, link, etc.
        if (text && !parentName.includes(text.replace(/\.\.\.$/, ''))) {
          entries.push({ depth, role: 'text', name: text, state: '', target, backendNodeId: node.backendDOMNodeId, isText: true, context });
        }

        return;
      }

      if (!node.ignored && !SKIP.has(role)) {
        // Row names just concatenate their cells.
        const name = role === 'row' ? '' : clean(node.name?.value, 120);

        if (name || INTERACTIVE.has(role) || STRUCTURAL.has(role)) {
          entries.push({
            depth,
            role,
            name,
            state: describeState(node, name),
            target,
            backendNodeId: node.backendDOMNodeId,
            isText: false,
            context,
          });
          childDepth = depth + 1;
          childParent = name;
          childContext = `${context} ${role} ${name}`.toLowerCase().slice(-300);
        }

        if (role === 'Iframe' && node.backendDOMNodeId && nesting < MAX_FRAME_NESTING) {
          try {
            const owner = await send(target, 'DOM.describeNode', { backendNodeId: node.backendDOMNodeId });

            if (owner.node.frameId) {
              await walkFrame(await resolveFrame(tabId, owner.node.frameId), childDepth, nesting + 1, childContext);
            }
          } catch {
            // The frame is gone or still loading: show the iframe without content.
          }
        }
      }

      for (const id of node.childIds ?? []) {
        const child = byId.get(id);

        if (child) await walk(child, childDepth, childParent, childContext);
      }
    };

    const root = nodes.find((node) => !node.parentId) ?? nodes[0];

    if (root) await walk(root, baseDepth, '', outer);
  };

  await walkFrame(await resolveFrame(tabId), 0, 0, '');

  return entries;
}

function refOf(entry: Entry): string | null {
  return entry.backendNodeId ? refFor(entry.target, entry.backendNodeId) : null;
}

function line(entry: Entry, baseDepth: number): string {
  const indent = ' '.repeat(Math.max(0, entry.depth - baseDepth));

  if (entry.isText) return `${indent}text "${entry.name}"`;

  const ref = refOf(entry);
  const label = entry.name ? ` "${entry.name}"` : '';

  return `${indent}${entry.role}${label}${ref ? ` [${ref}]` : ''}${entry.state}`;
}

function subtree(entries: Entry[], tabId: number, ref: string): Entry[] {
  const wanted = lookupRef(tabId, ref);

  const start = entries.findIndex(
    (entry) =>
      !entry.isText && entry.backendNodeId === wanted?.backendNodeId && entry.target.sessionId === wanted?.sessionId,
  );

  if (!wanted || start < 0) throw staleRef(ref);

  let end = start + 1;

  while (end < entries.length && entries[end]!.depth > entries[start]!.depth) end++;

  return entries.slice(start, end);
}

export async function readPage(args: ReadPageArgs): Promise<string> {
  const all = await collect(args.tabId);
  const scoped = args.ref_id ? subtree(all, args.tabId, args.ref_id) : all;
  const baseDepth = scoped[0]?.depth ?? 0;
  const maxDepth = baseDepth + (args.depth ?? DEFAULT_DEPTH);
  const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS;

  const lines = scoped
    .filter((entry) => entry.depth <= maxDepth)
    .filter((entry) => args.filter !== 'interactive' || INTERACTIVE.has(entry.role))
    .map((entry) => line(entry, args.filter === 'interactive' ? entry.depth : baseDepth));

  let output = lines.join('\n');

  if (output.length > maxChars) {
    const kept = output.slice(0, output.lastIndexOf('\n', maxChars));

    output =
      `${kept}\n\n[Output truncated: showing ${kept.length} of ${output.length} characters. ` +
      'Pass a larger max_chars, or use depth/ref_id to focus on part of the page.]';
  }

  const [width, height] = await evaluate<[number, number]>(
    await resolveFrame(args.tabId),
    '[window.innerWidth, window.innerHeight]',
  );

  return `${output || '(no accessible elements)'}\n\nViewport: ${width}x${height}`;
}

// ---------------------------------------------------------------- find

const STOPWORDS = new Set(
  ('a an the in on of for to with and or at by from that which is are element elements item section area ' +
    'containing contains labeled labelled named called inside within').split(' '),
);

// Words people use for a kind of control, mapped to accessibility roles.
const ROLE_WORDS: Record<string, string[]> = {
  button: ['button'],
  btn: ['button'],
  link: ['link'],
  input: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  field: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  box: ['textbox', 'searchbox', 'combobox', 'checkbox'],
  bar: ['textbox', 'searchbox', 'combobox', 'toolbar', 'navigation'],
  textbox: ['textbox', 'searchbox'],
  search: ['searchbox', 'search'],
  dropdown: ['combobox', 'listbox', 'menu'],
  select: ['combobox', 'listbox'],
  menu: ['menu', 'menubar', 'menuitem', 'combobox'],
  option: ['option', 'menuitem'],
  checkbox: ['checkbox', 'switch'],
  toggle: ['switch', 'checkbox', 'button'],
  radio: ['radio'],
  tab: ['tab'],
  image: ['img', 'image'],
  icon: ['img', 'image', 'button'],
  logo: ['img', 'image'],
  heading: ['heading'],
  header: ['heading', 'banner', 'columnheader'],
  title: ['heading'],
  table: ['table', 'grid'],
  row: ['row'],
  list: ['list', 'listbox', 'tree'],
  tree: ['tree', 'treeitem'],
  dialog: ['dialog', 'alertdialog'],
  modal: ['dialog', 'alertdialog'],
  form: ['form'],
  nav: ['navigation'],
  navigation: ['navigation'],
  slider: ['slider'],
};

// Words that say where something is. They sharpen the ranking but are never required.
const POSITION_WORDS = new Set('first last top bottom left right upper lower main primary'.split(' '));

function forms(token: string): string[] {
  const isPlural = token.length > 3 && token.endsWith('s') && !token.endsWith('ss');

  return isPlural ? [token, token.slice(0, -1)] : [token];
}

interface Query {
  // What is wanted, and where it sits ("password" | "login form").
  subject: string[];
  container: string[];
  phrases: string[];
}

function matchToken(entry: Entry, token: string): { gain: number; isKind: boolean } {
  const haystack = `${entry.name} ${entry.state}`.toLowerCase();
  const role = entry.role.toLowerCase();
  const variants = forms(token);

  if (variants.some((form) => ROLE_WORDS[form]?.includes(role) || form === role)) return { gain: 2, isKind: true };

  if (variants.some((form) => new RegExp(`(^|[^a-z0-9])${form}([^a-z0-9]|$)`).test(haystack))) {
    return { gain: 2, isKind: false };
  }

  if (variants.some((form) => haystack.includes(form))) return { gain: 1, isKind: false };

  // Found on an enclosing element: counts, but ranks below a direct match.
  if (variants.some((form) => entry.context.includes(form))) return { gain: 0.5, isKind: false };

  return { gain: 0, isKind: false };
}

function score(entry: Entry, query: Query): number {
  const tokens = [...query.subject, ...query.container];
  const haystack = `${entry.name} ${entry.state}`.toLowerCase();
  let total = 0;
  let needed = 0;
  let hits = 0;
  let subjectHits = 0;
  let named = 0;
  let queryNamesKind = false;
  let isThatKind = false;

  for (const token of query.subject) {
    const optional = POSITION_WORDS.has(token);
    const { gain, isKind } = matchToken(entry, token);

    const isRoleWord = forms(token).some((form) => ROLE_WORDS[form]);

    if (isRoleWord) queryNamesKind = true;

    // "checkbox" in an element's own name is as good as the role.
    if (isKind || (isRoleWord && gain >= 1)) isThatKind = true;
    if (gain > 0 && !isKind) named++;
    if (!optional) needed++;
    if (gain > 0 && !optional) hits++;
    if (gain > 0) subjectHits++;

    total += gain;
  }

  for (const token of query.container) {
    needed++;

    // The container is where the element sits, so it should match an ancestor.
    if (forms(token).some((form) => entry.context.includes(form))) {
      total += 1;
      hits++;
      named++;
    }
  }

  for (const phrase of query.phrases) {
    if (haystack.includes(phrase)) {
      total += 5;
      named++;
      subjectHits++;
    }
  }

  const describesKindOnly = tokens.every((token) => POSITION_WORDS.has(token) || forms(token).some((form) => ROLE_WORDS[form]));

  if (hits < Math.ceil(needed * 0.5) || (named === 0 && !describesKindOnly)) return 0;

  // "X in Y": something that matches only Y is the container, not the thing asked for.
  if (query.subject.length > 0 && subjectHits === 0) return 0;

  // The query asks for a kind of control and this is another kind.
  if (queryNamesKind && !isThatKind) total *= 0.6;

  return total + (INTERACTIVE.has(entry.role) ? 1 : 0);
}

function parseQuery(text: string): Query {
  const lower = text.toLowerCase();
  const words = (part: string): string[] => (part.match(/[a-z0-9]+/g) ?? []).filter((word) => !STOPWORDS.has(word));
  const split = /^(.+?)\s(?:in|inside|within|under)\s(?:the\s)?(.+)$/.exec(lower);

  return {
    subject: words(split ? split[1]! : lower),
    container: split ? words(split[2]!) : [],
    phrases: [...lower.matchAll(/"([^"]+)"/g)].map((match) => match[1]!.trim()).filter(Boolean),
  };
}

// Keyword match over roles and accessible names. No language model involved.
export async function find(tabId: number, text: string): Promise<string> {
  const query = parseQuery(text);

  if (query.subject.length + query.container.length + query.phrases.length === 0) {
    throw new ToolError('BAD_ARGS', 'The query has no searchable words.');
  }

  const scored = (await collect(tabId))
    .map((entry, order) => ({ entry, order, points: entry.backendNodeId ? score(entry, query) : 0 }))
    .filter((match) => match.points > 0);

  const best = Math.max(0, ...scored.map((match) => match.points));

  // Clear winners push the also-rans out; ties keep page order.
  const ranked = scored
    .filter((match) => match.points >= best * RELEVANCE_CUTOFF)
    .sort((a, b) => b.points - a.points || a.order - b.order);

  if (ranked.length === 0) {
    return 'No matching elements found. Try other words, read_page for the full tree, or a screenshot.';
  }

  const shown = ranked.slice(0, MAX_MATCHES);
  const lines = shown.map(({ entry }) => `- ${refOf(entry)}: ${entry.role} "${entry.name}"${entry.state}`);
  const more = ranked.length > MAX_MATCHES ? `\n\n${ranked.length} elements matched. Use a more specific query.` : '';

  return `Found ${shown.length} matching element${shown.length === 1 ? '' : 's'}\n\n${lines.join('\n')}${more}`;
}

// ---------------------------------------------------------------- elements

export interface ElementHandle extends Target {
  objectId: string;
  ref: string;
}

function staleRef(ref: string): ToolError {
  return new ToolError(
    'STALE_REF',
    `Element ${ref} not found. The page has changed or navigated; get fresh refs with read_page or find.`,
  );
}

export async function resolveRef(tabId: number, ref: string): Promise<ElementHandle> {
  await resolveFrame(tabId);

  const entry = lookupRef(tabId, ref);

  if (!entry) throw staleRef(ref);

  const target: Target = { tabId, sessionId: entry.sessionId };

  try {
    const { object } = await send(target, 'DOM.resolveNode', { backendNodeId: entry.backendNodeId });

    return { ...target, objectId: object.objectId!, ref };
  } catch {
    throw staleRef(ref);
  }
}
