export interface Settings {
  url: string;
  token: string;
  enabled: boolean;
}

export interface Status {
  state: 'disconnected' | 'connecting' | 'connected' | 'unauthorized' | 'replaced';
  detail?: string;
}

const DEFAULTS: Settings = { url: 'http://127.0.0.1:8787', token: '', enabled: false };

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get('settings');

  return { ...DEFAULTS, ...(stored.settings as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export async function loadStatus(): Promise<Status> {
  const stored = await chrome.storage.session.get('status');

  return (stored.status as Status | undefined) ?? { state: 'disconnected' };
}

export async function saveStatus(status: Status): Promise<void> {
  await chrome.storage.session.set({ status });
}
