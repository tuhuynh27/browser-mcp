import { send } from './cdp.js';
import { ToolError } from './errors.js';
import type { FilesArgs } from './protocol.js';
import { loadSettings } from './settings.js';
import { base64ToBlob, uploadFile } from './upload.js';

type Download = chrome.downloads.DownloadItem;

const DOWNLOAD_TIMEOUT_MS = 80_000;

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function describe(item: Download): Record<string, unknown> {
  const done = item.state === 'complete' && item.exists;

  return {
    id: item.id,
    name: baseName(item.filename),
    size: item.fileSize,
    mime: item.mime || undefined,
    state: item.state,
    error: item.error,
    source: item.url.slice(0, 200),
    // Served by the relay straight from the browser's download folder.
    url: done ? `/files/dl/${item.id}` : undefined,
  };
}

async function findDownload(id: number): Promise<Download> {
  const [item] = await chrome.downloads.search({ id });

  if (!item) throw new ToolError('NOT_FOUND', `No download ${id}.`);

  return item;
}

function waitForDownload(id: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };

    const listener = (delta: chrome.downloads.DownloadDelta): void => {
      const state = delta.state?.current;

      if (delta.id === id && (state === 'complete' || state === 'interrupted')) finish();
    };

    const timer = setTimeout(finish, DOWNLOAD_TIMEOUT_MS);

    chrome.downloads.onChanged.addListener(listener);
  });
}

async function download(url: string | undefined): Promise<unknown> {
  if (!url) throw new ToolError('BAD_ARGS', 'download needs url.');

  let id: number;

  try {
    id = await chrome.downloads.download({ url, saveAs: false, conflictAction: 'uniquify' });
  } catch (error) {
    throw new ToolError('DOWNLOAD_FAILED', error instanceof Error ? error.message : String(error));
  }

  if ((await findDownload(id)).state === 'in_progress') await waitForDownload(id);

  const item = await findDownload(id);

  if (item.state === 'interrupted') {
    throw new ToolError('DOWNLOAD_FAILED', `Download interrupted: ${item.error ?? 'unknown reason'}`);
  }

  return describe(item);
}

async function pdf(tabId: number): Promise<unknown> {
  const { data } = await send({ tabId }, 'Page.printToPDF', { printBackground: true });
  const tab = await chrome.tabs.get(tabId);
  const title = (tab.title || 'page').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'page';

  return uploadFile(await loadSettings(), `${title}.pdf`, base64ToBlob(data, 'application/pdf'));
}

export async function files(args: FilesArgs, pickTab: (tabId?: number) => Promise<number>): Promise<unknown> {
  if (args.action === 'download') return download(args.url);

  if (args.action === 'pdf') return pdf(await pickTab(args.tabId));

  if (args.action === 'downloads_list') {
    const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: args.limit ?? 20 });

    return { downloads: items.map(describe) };
  }

  if (args.action === 'path') {
    const item = await findDownload(args.id ?? -1);

    if (item.state !== 'complete' || !item.exists) {
      throw new ToolError('NOT_FOUND', `Download ${item.id} is not available on disk.`);
    }

    return { path: item.filename, name: baseName(item.filename) };
  }

  throw new ToolError('BAD_ARGS', `Unknown action ${String(args.action)}.`);
}
