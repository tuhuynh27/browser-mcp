import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';

import {
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  type ErrorBody,
  type ToExtension,
  type ToolName,
} from './extension/src/protocol.ts';
import { TOOLS } from './schemas.ts';

const TOKEN = process.env.RELAY_TOKEN ?? '';
const PORT = Number(process.env.PORT ?? 8787);
const HOST = '127.0.0.1';
const FILES_DIR = path.join(import.meta.dirname, 'files');

// Below the 100s idle limit of common tunnels.
const CALL_TIMEOUT_MS = 90_000;
const HELLO_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 60_000;

if (!TOKEN) {
  console.error('RELAY_TOKEN is required. Example: RELAY_TOKEN=$(openssl rand -hex 32) node relay.ts');
  process.exit(1);
}

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`);
}

// ---------------------------------------------------------------- auth

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function tokenOk(candidate: string | null | undefined): boolean {
  return typeof candidate === 'string' && timingSafeEqual(digest(candidate), digest(TOKEN));
}

function bearer(req: IncomingMessage): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');

  return match ? match[1]! : null;
}

// ---------------------------------------------------------------- extension link

class ExtensionError extends Error {
  body: ErrorBody;

  constructor(body: ErrorBody) {
    super(body.message);
    this.body = body;
  }
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: ExtensionError) => void;
  timer: NodeJS.Timeout;
}

const Inbound = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    token: z.string(),
    browser: z.string(),
    version: z.string(),
  }),
  z.object({
    type: z.literal('result'),
    id: z.string(),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.looseObject({ code: z.string(), message: z.string() }).optional(),
  }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('pong') }),
]);

let extension: WebSocket | null = null;
const pending = new Map<string, Pending>();

function sendToExtension(socket: WebSocket, message: ToExtension): void {
  socket.send(JSON.stringify(message));
}

function callExtension(tool: ToolName, args: Record<string, unknown>): Promise<unknown> {
  const socket = extension;

  if (!socket) {
    const message = 'No browser connected. Open the extension popup and press Connect.';

    return Promise.reject(new ExtensionError({ code: 'NO_EXTENSION', message }));
  }

  return new Promise((resolve, reject) => {
    const id = randomUUID();

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new ExtensionError({ code: 'TIMEOUT', message: `${tool} timed out` }));
    }, CALL_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timer });
    sendToExtension(socket, { type: 'call', id, tool, args });
  });
}

function settle(id: string, ok: boolean, data: unknown, error?: ErrorBody): void {
  const call = pending.get(id);

  if (!call) return;

  pending.delete(id);
  clearTimeout(call.timer);

  if (ok) {
    call.resolve(data);
  } else {
    call.reject(new ExtensionError(error ?? { code: 'ERROR', message: 'Unknown error' }));
  }
}

function failAllPending(): void {
  for (const id of [...pending.keys()]) {
    settle(id, false, null, { code: 'NO_EXTENSION', message: 'Browser disconnected mid-call' });
  }
}

function acceptExtension(socket: WebSocket): void {
  let authed = false;
  let idle: NodeJS.Timeout;

  const helloTimer = setTimeout(() => socket.close(CLOSE_UNAUTHORIZED, 'hello timeout'), HELLO_TIMEOUT_MS);

  const touch = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => socket.terminate(), IDLE_TIMEOUT_MS);
  };

  socket.on('message', (raw, isBinary) => {
    if (isBinary) return;

    let parsed;

    try {
      parsed = Inbound.safeParse(JSON.parse(raw.toString()));
    } catch {
      return;
    }

    if (!parsed.success) return;

    const message = parsed.data;

    if (!authed) {
      clearTimeout(helloTimer);

      if (message.type !== 'hello' || !tokenOk(message.token)) {
        log('extension rejected: bad token');
        socket.close(CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }

      authed = true;
      extension?.close(CLOSE_REPLACED, 'replaced');
      extension = socket;
      touch();

      log(`extension connected: ${message.browser} v${message.version}`);
      sendToExtension(socket, { type: 'ready' });
      return;
    }

    touch();

    if (message.type === 'ping') {
      sendToExtension(socket, { type: 'pong' });
    } else if (message.type === 'result') {
      settle(message.id, message.ok, message.data, message.error);
    }
  });

  socket.on('close', () => {
    clearTimeout(helloTimer);
    clearTimeout(idle);

    if (extension === socket) {
      extension = null;
      failAllPending();
      log('extension disconnected');
    }
  });

  socket.on('error', () => socket.terminate());
}

// ---------------------------------------------------------------- tools

type Content = CallToolResult['content'];

// The extension only knows relay paths; make them absolute for the client.
function absolutize(value: unknown, base: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => absolutize(item, base));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => {
      const isFileUrl = key === 'url' && typeof item === 'string' && item.startsWith('/files/');

      return [key, isFileUrl ? base + item : absolutize(item, base)];
    });

    return Object.fromEntries(entries);
  }

  return value;
}

function toResult(data: unknown, base: string): CallToolResult {
  const ready = data as { content?: Content; isError?: boolean } | null;

  // Tools mirrored from Claude in Chrome arrive as finished content.
  if (ready && Array.isArray(ready.content)) {
    const content = ready.content.map((part) =>
      part.type === 'text' ? { ...part, text: part.text.replace(/(^|[\s"])(\/files\/[^\s"]+)/g, `$1${base}$2`) } : part,
    );

    return { content, isError: ready.isError };
  }

  return { content: [{ type: 'text', text: JSON.stringify(absolutize(data, base)) }] };
}

// Audit trail: what the model said each action does.
function logCall(name: string, args: Record<string, unknown>): void {
  const items = name === 'browser_batch' && Array.isArray(args.actions) ? args.actions : [{ name, input: args }];

  for (const item of items as Array<{ name?: string; input?: Record<string, unknown> }>) {
    const action = typeof item.input?.action === 'string' ? `:${item.input.action}` : '';
    const summary = typeof item.input?.action_summary === 'string' ? ` - ${item.input.action_summary}` : '';

    log(`call ${item.name}${action}${summary}`);
  }
}

function buildServer(base: string): Server {
  const server = new Server({ name: 'browser-mcp', version: '0.2.0' }, { capabilities: { tools: {} } });
  const names = new Set(TOOLS.map((tool) => tool.name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = request.params;

    if (!names.has(name)) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }

    logCall(name, args);

    try {
      return toResult(await callExtension(name as ToolName, args), base);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
    }
  });

  return server;
}

// ---------------------------------------------------------------- http

const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'PUT, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
};

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];

  return (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
}

function publicBase(req: IncomingMessage): string {
  const proto = header(req, 'x-forwarded-proto') ?? 'http';
  const host = header(req, 'x-forwarded-host') ?? req.headers.host ?? `${HOST}:${PORT}`;

  return `${proto}://${host}`;
}

function safeName(raw: string): string {
  const name = path.basename(decodeURIComponent(raw)).replace(/[^\w.\- ]/g, '_');

  return name.replace(/^\.+/, '') || 'file';
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    return;
  }

  // Stateless: one server and transport per request.
  const server = buildServer(publicBase(req));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

async function handleUpload(req: IncomingMessage, res: ServerResponse, rawName: string): Promise<void> {
  const id = randomBytes(8).toString('hex');
  const name = safeName(rawName);
  const dir = path.join(FILES_DIR, id);

  await mkdir(dir, { recursive: true });
  await pipeline(req, createWriteStream(path.join(dir, name)));

  const { size } = await stat(path.join(dir, name));

  json(res, 200, { url: `/files/${id}/${encodeURIComponent(name)}`, name, size }, CORS);
}

async function sendFile(res: ServerResponse, filePath: string, name: string): Promise<void> {
  const info = await stat(filePath).catch(() => null);

  if (!info?.isFile()) {
    json(res, 404, { error: 'Not found' });
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
  });

  await pipeline(createReadStream(filePath), res);
}

async function handleFile(res: ServerResponse, segments: string[]): Promise<void> {
  const [first, second] = segments;

  // Browser downloads are read from where the browser saved them.
  if (first === 'dl' && second && /^\d+$/.test(second)) {
    const found = (await callExtension('files', { action: 'path', id: Number(second) })) as {
      path: string;
      name: string;
    };

    await sendFile(res, found.path, found.name);
    return;
  }

  if (!first || !second || !/^[a-f0-9]{16}$/.test(first)) {
    json(res, 404, { error: 'Not found' });
    return;
  }

  const name = safeName(second);

  await sendFile(res, path.join(FILES_DIR, first, name), name);
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://relay');
  const [root, ...rest] = url.pathname.split('/').filter(Boolean);

  if (root === 'upload' && req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }

  // Query tokens are accepted for file links only, so they can be opened directly.
  const token = bearer(req) ?? (root === 'files' ? url.searchParams.get('token') : null);

  if (!tokenOk(token)) {
    json(res, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer', ...CORS });
    return;
  }

  if (root === 'mcp' && rest.length === 0) {
    await handleMcp(req, res);
  } else if (root === 'upload' && req.method === 'PUT' && rest.length === 1) {
    await handleUpload(req, res, rest[0]!);
  } else if (root === 'files' && req.method === 'GET') {
    await handleFile(res, rest);
  } else {
    json(res, 404, { error: 'Not found' });
  }
}

const httpServer = http.createServer((req, res) => {
  route(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);

    log(`request failed: ${req.method} ${req.url?.split('?')[0]} - ${message}`);

    if (res.headersSent) {
      res.destroy();
    } else {
      const notFound = error instanceof ExtensionError && error.body.code === 'NOT_FOUND';

      json(res, notFound ? 404 : error instanceof ExtensionError ? 502 : 500, { error: message });
    }
  });
});

const sockets = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://relay').pathname !== '/ext') {
    socket.destroy();
    return;
  }

  sockets.handleUpgrade(req, socket, head, acceptExtension);
});

httpServer.listen(PORT, HOST, () => {
  log(`relay listening on http://${HOST}:${PORT} (MCP endpoint: /mcp)`);
});
