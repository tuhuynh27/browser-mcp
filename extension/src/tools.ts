import { detachAll, resolveFrame } from './cdp.js';
import { computer } from './computer.js';
import { ToolError, toErrorBody } from './errors.js';
import { files } from './files.js';
import { setValue, settle, uploadFiles } from './input.js';
import { inspect, runJs } from './inspect.js';
import type {
  BatchArgs,
  ComputerArgs,
  Content,
  ContentResult,
  FileUploadArgs,
  FilesArgs,
  FindArgs,
  FormInputArgs,
  InspectArgs,
  JavascriptArgs,
  NavigateArgs,
  ReadPageArgs,
  RecordArgs,
  TabArgs,
  TabsContextArgs,
  ToolName,
} from './protocol.js';
import { record } from './record.js';
import { evaluate, find, readPage, resolveRef } from './snapshot.js';
import { closeTab, contextJson, createTab, ensureGroup, navigate, requireTab, tabContext } from './tabs.js';

// Mirrored tools answer with content; inspect, record and files with JSON.
type Output = Content[] | object;
type Handler = (args: never, inBatch: boolean) => Promise<Output>;

const MAX_PAGE_TEXT = 50_000;

const text = (value: string): Content[] => [{ type: 'text', text: value }];
const pickTab = async (tabId?: number): Promise<number> => requireTab(tabId);

// ---------------------------------------------------------------- tabs

async function tabsContext(args: TabsContextArgs): Promise<Content[]> {
  if (args.createIfEmpty) await ensureGroup();

  return text(await contextJson());
}

async function tabsCreate(): Promise<Content[]> {
  const tab = await createTab();

  return text(`Created new tab. Tab ID: ${tab.id}`);
}

async function tabsClose(args: TabArgs): Promise<Content[]> {
  await closeTab(requireTab(args.tabId));

  return text(`Closed tab ${args.tabId}`);
}

async function navigateTool(args: NavigateArgs, inBatch: boolean): Promise<Content[]> {
  if (typeof args.url !== 'string' || !args.url) throw new ToolError('BAD_ARGS', 'navigate needs url.');

  if (args.tabId !== undefined) return text(await navigate(args.tabId, args.url));

  if (inBatch || args.url === 'back' || args.url === 'forward') {
    throw new ToolError('BAD_ARGS', 'tabId is required for back/forward and inside browser_batch.');
  }

  const [first] = await ensureGroup();

  // Lets the caller report which tab was used.
  args.tabId = requireTab(first?.id);

  return text(`${await navigate(args.tabId, args.url)}\n\n${await contextJson()}`);
}

// ---------------------------------------------------------------- page content

function pageText(): { title: string; url: string; source: string; text: string } {
  const source = document.querySelector('article') ?? document.querySelector('main, [role="main"]') ?? document.body;

  return {
    title: document.title,
    url: location.href,
    source: source?.tagName.toLowerCase() ?? 'none',
    text: source instanceof HTMLElement ? source.innerText : '',
  };
}

async function getPageText(args: TabArgs): Promise<Content[]> {
  const frame = await resolveFrame(requireTab(args.tabId));
  const page = await evaluate<ReturnType<typeof pageText>>(frame, `(${pageText.toString()})()`);
  const header = `Title: ${page.title}\nURL: ${page.url}\nSource element: <${page.source}>\n---\n`;

  if (page.text.length <= MAX_PAGE_TEXT) return text(header + page.text);

  return text(
    `${header}${page.text.slice(0, MAX_PAGE_TEXT)}\n\n` +
      `[Output truncated: showing ${MAX_PAGE_TEXT} of ${page.text.length} characters.]`,
  );
}

async function readPageTool(args: ReadPageArgs): Promise<Content[]> {
  requireTab(args.tabId);

  return text(await readPage(args));
}

async function findTool(args: FindArgs): Promise<Content[]> {
  if (typeof args.query !== 'string') throw new ToolError('BAD_ARGS', 'find needs query.');

  return text(await find(requireTab(args.tabId), args.query));
}

async function javascriptTool(args: JavascriptArgs): Promise<Content[]> {
  if (typeof args.text !== 'string') throw new ToolError('BAD_ARGS', 'javascript_tool needs text.');

  return text(await runJs(requireTab(args.tabId), args.text));
}

// ---------------------------------------------------------------- forms

async function formInput(args: FormInputArgs): Promise<Content[]> {
  const element = await resolveRef(requireTab(args.tabId), args.ref);
  const outcome = await setValue(element, args.value);

  await settle(args.tabId);

  return text(outcome);
}

async function fileUpload(args: FileUploadArgs): Promise<Content[]> {
  if (!Array.isArray(args.paths) || args.paths.length === 0) {
    throw new ToolError('BAD_ARGS', 'file_upload needs paths.');
  }

  return text(await uploadFiles(await resolveRef(requireTab(args.tabId), args.ref), args.paths));
}

// ---------------------------------------------------------------- dispatch

const handlers: Record<Exclude<ToolName, 'browser_batch'>, Handler> = {
  tabs_context_mcp: tabsContext,
  tabs_create_mcp: tabsCreate,
  tabs_close_mcp: tabsClose,
  navigate: navigateTool,
  computer: (args: ComputerArgs) => computer({ ...args, tabId: requireTab(args.tabId) }),
  read_page: readPageTool,
  find: findTool,
  get_page_text: getPageText,
  javascript_tool: javascriptTool,
  form_input: formInput,
  file_upload: fileUpload,
  inspect: (args: InspectArgs) => inspect(requireTab(args.tabId), args) as Promise<object>,
  record: (args: RecordArgs) => record(args, pickTab) as Promise<object>,
  files: (args: FilesArgs) => files(args, pickTab) as Promise<object>,
};

function runOne(tool: string, args: Record<string, unknown>, inBatch: boolean): Promise<Output> {
  const handler = (handlers as Record<string, Handler | undefined>)[tool] as
    | ((args: Record<string, unknown>, inBatch: boolean) => Promise<Output>)
    | undefined;

  if (!handler) {
    throw new ToolError('UNKNOWN_TOOL', `Unknown tool "${tool}".`);
  }

  return handler(args, inBatch);
}

function executedOn(args: Record<string, unknown>): number | undefined {
  return typeof args.tabId === 'number' ? args.tabId : undefined;
}

async function batch(args: BatchArgs): Promise<ContentResult> {
  if (!Array.isArray(args.actions) || args.actions.length === 0) {
    throw new ToolError('BAD_ARGS', 'actions must be a non-empty array of {name, input}.');
  }

  const content: Content[] = [];
  let lastTab: number | undefined;
  let isError = false;

  for (const [index, item] of args.actions.entries()) {
    // Tolerates fully qualified names such as mcp__server__computer.
    const name = String(item?.name ?? '').split('__').pop()!;
    const input = item?.input ?? {};
    const label = `[${name}${typeof input.action === 'string' ? `:${input.action}` : ''}]`;

    try {
      if (name === 'browser_batch') throw new ToolError('BAD_ARGS', 'browser_batch cannot be nested.');

      const output = await runOne(name, input, true);

      if (!Array.isArray(output)) {
        content.push({ type: 'text', text: `${label} ${JSON.stringify(output)}` });
      } else {
        for (const part of output as Content[]) {
          content.push(part.type === 'text' ? { type: 'text', text: `${label} ${part.text}` } : part);
        }
      }

      lastTab = executedOn(input) ?? lastTab;
    } catch (error) {
      const left = args.actions.length - index - 1;
      const skipped = left > 0 ? ` Batch stopped: ${left} remaining action${left === 1 ? ' was' : 's were'} not executed.` : '';

      content.push({ type: 'text', text: `${label} Error: ${toErrorBody(error).message}${skipped}` });
      isError = true;
      break;
    }
  }

  content.push({ type: 'text', text: await tabContext(lastTab) });

  return isError ? { content, isError } : { content };
}

export async function runTool(tool: ToolName, args: Record<string, unknown>): Promise<unknown> {
  if (tool === 'browser_batch') return batch(args as unknown as BatchArgs);

  const output = await runOne(tool, args, false);

  if (!Array.isArray(output)) return output;

  const result: ContentResult = {
    content: [...(output as Content[]), { type: 'text', text: await tabContext(executedOn(args)) }],
  };

  return result;
}

// Called when the relay connection is dropped on purpose.
export async function releaseAll(): Promise<void> {
  await detachAll();
}
