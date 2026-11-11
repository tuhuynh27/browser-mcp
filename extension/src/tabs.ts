import { send } from './cdp.js';
import { ToolError } from './errors.js';

type Tab = chrome.tabs.Tab;

const GROUP_TITLE = 'MCP';
const LOAD_TIMEOUT_MS = 30_000;
const SAME_DOCUMENT_GRACE_MS = 1_500;
const MAX_OTHER_TABS = 30;

// ---------------------------------------------------------------- tab group

async function findGroup(): Promise<number | null> {
  const stored = (await chrome.storage.session.get('groupId')).groupId as number | undefined;

  if (stored !== undefined && (await chrome.tabGroups.get(stored).catch(() => null))) return stored;

  // The stored id is lost when the browser restarts; the group itself may survive.
  const [existing] = await chrome.tabGroups.query({ title: GROUP_TITLE });

  if (!existing) return null;

  await chrome.storage.session.set({ groupId: existing.id });

  return existing.id;
}

export async function groupTabs(): Promise<Tab[]> {
  const groupId = await findGroup();

  return groupId === null ? [] : chrome.tabs.query({ groupId });
}

async function createGroup(): Promise<Tab> {
  const created = await chrome.windows.create({ url: 'about:blank', focused: false });
  const tab = created?.tabs?.[0];

  if (!created || tab?.id === undefined) {
    throw new ToolError('NO_TAB', 'Could not open a browser window.');
  }

  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: created.id } });

  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'orange' });
  await chrome.storage.session.set({ groupId });

  return tab;
}

// Returns the group's tabs, creating the group with one blank tab if asked.
export async function ensureGroup(): Promise<Tab[]> {
  const tabs = await groupTabs();

  return tabs.length > 0 ? tabs : [await createGroup()];
}

export async function createTab(): Promise<Tab> {
  const groupId = await findGroup();
  const [first] = groupId === null ? [] : await chrome.tabs.query({ groupId });

  if (groupId === null || !first) return createGroup();

  const tab = await chrome.tabs.create({ windowId: first.windowId, url: 'about:blank', active: true });

  await chrome.tabs.group({ groupId, tabIds: [tab.id!] });

  return tab;
}

export async function closeTab(tabId: number): Promise<void> {
  const tabs = await groupTabs();

  if (!tabs.some((tab) => tab.id === tabId)) {
    throw new ToolError('NOT_IN_GROUP', `Tab ${tabId} is not in the MCP tab group, so it cannot be closed.`);
  }

  await chrome.tabs.remove(tabId);
}

// ---------------------------------------------------------------- context

interface TabInfo {
  tabId: number;
  title: string;
  url: string;
}

function describe(tab: Tab): TabInfo {
  return { tabId: tab.id ?? -1, title: (tab.title ?? '').slice(0, 100), url: (tab.url ?? '').slice(0, 300) };
}

export async function contextJson(): Promise<string> {
  const groupId = await findGroup();
  const inGroup = await groupTabs();
  const all = await chrome.tabs.query({});

  // Not part of Claude in Chrome: lets the model reach tabs the user already has open.
  const others = all.filter((tab) => !inGroup.some((member) => member.id === tab.id)).slice(0, MAX_OTHER_TABS);

  return JSON.stringify({
    availableTabs: inGroup.map(describe),
    tabGroupId: groupId,
    otherTabs: others.map(describe),
  });
}

// Footer appended to every tool result.
export async function tabContext(executedOn?: number): Promise<string> {
  const tabs = (await groupTabs()).map(describe);
  const executed = executedOn === undefined ? null : await chrome.tabs.get(executedOn).catch(() => null);

  if (executed && !tabs.some((tab) => tab.tabId === executedOn)) tabs.push(describe(executed));

  const lines = tabs.map((tab) => `  • tabId ${tab.tabId}: "${tab.title}" ("${tab.url}")`);
  const header = executedOn === undefined ? [] : [`- Executed on tabId: ${executedOn}`];

  return ['\n\nTab Context:', ...header, '- Available tabs:', ...lines].join('\n');
}

// ---------------------------------------------------------------- navigation

export function requireTab(tabId: number | undefined): number {
  if (typeof tabId !== 'number') {
    throw new ToolError('BAD_ARGS', 'tabId is required. Use tabs_context_mcp to get valid tab IDs.');
  }

  return tabId;
}

export async function existingTab(tabId: number): Promise<Tab> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);

  if (!tab) {
    throw new ToolError('NO_TAB', `No tab with id ${tabId}. Use tabs_context_mcp to get valid tab IDs.`);
  }

  return tab;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Follows a tab's load state. Create it before triggering the navigation.
function watchLoad(tabId: number): { finished: (newDocument: boolean) => Promise<boolean>; stop: () => void } {
  let loading = false;
  let complete = false;

  const listener = (id: number, change: { status?: string }): void => {
    if (id !== tabId) return;

    if (change.status === 'loading') {
      loading = true;
      complete = false;
    } else if (change.status === 'complete' && loading) {
      complete = true;
    }
  };

  chrome.tabs.onUpdated.addListener(listener);

  return {
    stop: () => chrome.tabs.onUpdated.removeListener(listener),

    async finished(newDocument: boolean): Promise<boolean> {
      const started = Date.now();

      while (Date.now() - started < LOAD_TIMEOUT_MS) {
        if (complete) return true;

        // Same-document moves (hash, pushState, some history steps) never report "loading".
        if (!newDocument && !loading && Date.now() - started >= SAME_DOCUMENT_GRACE_MS) return true;

        await sleep(50);
      }

      return false;
    },
  };
}

function withScheme(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data|blob|file|view-source):/i.test(url)) return url;

  // Local servers rarely speak TLS.
  const isLocal = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(url);

  return `${isLocal ? 'http' : 'https'}://${url}`;
}

// History moves go through the debugger: chrome.tabs.goBack skips entries the
// user never interacted with, which is every page a model opens.
async function moveInHistory(tabId: number, step: -1 | 1): Promise<void> {
  const nothing = new ToolError('NAVIGATE_FAILED', `No ${step < 0 ? 'previous' : 'next'} page in this tab's history.`);

  try {
    const { currentIndex, entries } = await send({ tabId }, 'Page.getNavigationHistory');
    const entry = entries[currentIndex + step];

    if (!entry) throw nothing;

    await send({ tabId }, 'Page.navigateToHistoryEntry', { entryId: entry.id });
  } catch (error) {
    if (error === nothing) throw error;

    // Landing on a browser-internal page drops the debugger mid-command: the move worked.
    if (error instanceof Error && /detached/i.test(error.message)) return;

    // On a browser-internal page the debugger cannot attach at all.
    await (step < 0 ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId)).catch(() => {
      throw nothing;
    });
  }
}

// Returns whether a new document is loading, or null if the server has not answered yet.
async function open(tabId: number, url: string): Promise<boolean | null> {
  let outcome: { errorText?: string; loaderId?: string } | null;

  try {
    outcome = await Promise.race([send({ tabId }, 'Page.navigate', { url }), sleep(LOAD_TIMEOUT_MS).then(() => null)]);
  } catch {
    // Pages the debugger may not touch (chrome://, the web store) still navigate this way.
    await chrome.tabs.update(tabId, { url });

    return true;
  }

  if (!outcome) return null;

  // ERR_ABORTED is what a URL that turns into a download reports.
  if (outcome.errorText && outcome.errorText !== 'net::ERR_ABORTED') {
    throw new ToolError('NAVIGATE_FAILED', `Could not load ${url}: ${outcome.errorText}`);
  }

  return Boolean(outcome.loaderId) && !outcome.errorText;
}

export async function navigate(tabId: number, target: string): Promise<string> {
  await existingTab(tabId);

  const watch = watchLoad(tabId);

  try {
    let newDocument: boolean | null = false;

    if (target === 'back') await moveInHistory(tabId, -1);
    else if (target === 'forward') await moveInHistory(tabId, 1);
    else newDocument = await open(tabId, withScheme(target));

    if (newDocument === null) return `Navigating to ${withScheme(target)} (still loading: the server has not answered yet)`;

    const finished = await watch.finished(newDocument);
    const tab = await chrome.tabs.get(tabId);
    const direction = target === 'back' || target === 'forward' ? `${target} to` : 'to';

    return `Navigated ${direction} ${tab.url}${finished ? '' : ' (still loading)'}`;
  } finally {
    watch.stop();
  }
}
