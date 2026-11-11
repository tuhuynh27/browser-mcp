// Wire format between relay.ts and the extension. relay.ts imports this file
// directly, so keep it to erasable syntax (no enums, no namespaces).

export type ToolName =
  | 'tabs_context_mcp'
  | 'tabs_create_mcp'
  | 'tabs_close_mcp'
  | 'navigate'
  | 'computer'
  | 'browser_batch'
  | 'read_page'
  | 'find'
  | 'get_page_text'
  | 'javascript_tool'
  | 'form_input'
  | 'file_upload'
  | 'inspect'
  | 'record'
  | 'files';

export interface Hello {
  type: 'hello';
  token: string;
  browser: string;
  version: string;
}

export interface Ready {
  type: 'ready';
}

export interface Call {
  type: 'call';
  id: string;
  tool: ToolName;
  args: Record<string, unknown>;
}

export interface ErrorBody {
  code: string;
  message: string;
  [extra: string]: unknown;
}

export type Result =
  | { type: 'result'; id: string; ok: true; data: unknown }
  | { type: 'result'; id: string; ok: false; error: ErrorBody };

export interface Ping {
  type: 'ping';
}

export interface Pong {
  type: 'pong';
}

export type ToRelay = Hello | Result | Ping | Pong;
export type ToExtension = Ready | Call | Ping | Pong;

// WebSocket close codes
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_REPLACED = 4409;

// What a tool sends back. Tools mirrored from Claude in Chrome answer with
// ready-made MCP content; inspect, record and files answer with plain JSON.

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ContentResult {
  content: Content[];
  isError?: boolean;
}

// Tool arguments. Field names follow schemas.ts.

export interface TabsContextArgs {
  createIfEmpty?: boolean;
}

export interface TabArgs {
  tabId: number;
}

export interface NavigateArgs {
  url: string;
  tabId?: number;
}

export type ComputerAction =
  | 'left_click'
  | 'right_click'
  | 'double_click'
  | 'triple_click'
  | 'type'
  | 'screenshot'
  | 'wait'
  | 'scroll'
  | 'key'
  | 'left_click_drag'
  | 'zoom'
  | 'scroll_to'
  | 'hover';

export interface ComputerArgs {
  action: ComputerAction;
  tabId: number;
  coordinate?: [number, number];
  text?: string;
  duration?: number;
  scroll_direction?: 'up' | 'down' | 'left' | 'right';
  scroll_amount?: number;
  start_coordinate?: [number, number];
  region?: [number, number, number, number];
  scale?: number;
  repeat?: number;
  ref?: string;
  modifiers?: string;
  save_to_disk?: boolean;
  action_summary?: string;
}

export interface BatchArgs {
  actions: Array<{ name: string; input: Record<string, unknown> }>;
}

export interface ReadPageArgs {
  tabId: number;
  filter?: 'interactive' | 'all';
  depth?: number;
  ref_id?: string;
  max_chars?: number;
}

export interface FindArgs {
  query: string;
  tabId: number;
}

export interface JavascriptArgs {
  action: string;
  text: string;
  tabId: number;
}

export interface FormInputArgs {
  ref: string;
  value: string | boolean | number;
  tabId: number;
}

export interface FileUploadArgs {
  paths: string[];
  ref: string;
  tabId: number;
}

export interface RecordArgs {
  action: 'start' | 'stop' | 'frames';
  tabId?: number;
  fps?: number;
  maxSeconds?: number;
  count?: number;
  intervalMs?: number;
}

export interface InspectArgs {
  mode: 'console' | 'network' | 'errors' | 'cookies' | 'storage';
  tabId: number;
  url?: string;
  method?: string;
  status?: number;
  bodyOf?: string;
  limit?: number;
}

export interface FilesArgs {
  // `path` is relay-internal: resolves a download id to its path on disk.
  action: 'download' | 'downloads_list' | 'pdf' | 'path';
  tabId?: number;
  url?: string;
  id?: number;
  limit?: number;
}
