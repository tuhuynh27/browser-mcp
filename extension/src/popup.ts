import { loadSettings, loadStatus, saveSettings, type Status } from './settings.js';

const urlInput = document.getElementById('url') as HTMLInputElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const toggle = document.getElementById('toggle') as HTMLButtonElement;
const statusLine = document.getElementById('status') as HTMLDivElement;

const LABELS: Record<Status['state'], string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting...',
  connected: 'Connected',
  unauthorized: 'Wrong token',
  replaced: 'Replaced by another browser',
};

let enabled = false;

function render(status: Status): void {
  const detail = status.detail ? ` - ${status.detail}` : '';

  statusLine.textContent = LABELS[status.state] + detail;
  toggle.textContent = enabled ? 'Disconnect' : 'Connect';
}

async function init(): Promise<void> {
  const settings = await loadSettings();

  urlInput.value = settings.url;
  tokenInput.value = settings.token;
  enabled = settings.enabled;

  render(await loadStatus());
}

toggle.addEventListener('click', async () => {
  enabled = !enabled;

  // The service worker reacts to the storage change.
  await saveSettings({
    url: urlInput.value.trim().replace(/\/+$/, ''),
    token: tokenInput.value.trim(),
    enabled,
  });

  render(await loadStatus());
});

chrome.storage.session.onChanged.addListener(async () => render(await loadStatus()));

void init();
