import { loadSettings, loadStatus, saveSettings, type Settings, type Status } from './settings.js';

const urlInput = document.getElementById('url') as HTMLInputElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const generate = document.getElementById('generate') as HTMLButtonElement;
const toggle = document.getElementById('toggle') as HTMLButtonElement;
const statusLine = document.getElementById('status') as HTMLDivElement;
const hintLine = document.getElementById('hint') as HTMLParagraphElement;
const setup = document.getElementById('setup') as HTMLOListElement;
const client = document.getElementById('client') as HTMLElement;
const relayCmd = document.getElementById('relay-cmd') as HTMLPreElement;
const clientCmd = document.getElementById('client-cmd') as HTMLPreElement;
const clientHint = document.getElementById('client-hint') as HTMLParagraphElement;
const tabs = document.querySelectorAll<HTMLButtonElement>('[data-tab]');

type Client = 'claude' | 'cursor';

const CLIENT_HINTS: Record<Client, string> = {
  claude: 'User scope: available in every project. Run in any terminal.',
  cursor: 'Add to ~/.cursor/mcp.json (user scope), merging with existing servers. Used by Cursor CLI and the editor.',
};

const LABELS: Record<Status['state'], string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting...',
  connected: 'Connected',
  unauthorized: 'Wrong token',
  replaced: 'Replaced by another browser',
};

const HINTS: Partial<Record<Status['state'], string>> = {
  unauthorized: 'The relay runs with a different token. Restart it with the command below, or paste its token.',
  replaced: 'Another browser took over this relay. Press Reconnect to take it back.',
};

const RETRY_HINT = 'No relay found at this URL. Start it below, this popup connects on its own.';
const DEFAULT_PORT = '8787';
const SAFE = /^[\w@%+=:,./-]+$/;

let saved: Settings;
let enabled = false;
let status: Status = { state: 'disconnected' };
let picked: Client = 'claude';

function quote(value: string): string {
  return SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function relayPort(url: string): string {
  try {
    return new URL(url).port;
  } catch {
    return '';
  }
}

function clientSnippet(url: string, token: string): string {
  const endpoint = `${url}/mcp`;

  if (picked === 'cursor') {
    const config = { mcpServers: { browser: { url: endpoint, headers: { Authorization: `Bearer ${token}` } } } };

    return JSON.stringify(config, null, 2);
  }

  return (
    `claude mcp add --scope user --transport http browser ${quote(endpoint)} ` +
    `--header ${quote(`Authorization: Bearer ${token}`)}`
  );
}

function hintFor(current: Status): string {
  if (current.state === 'disconnected' && current.detail === 'retrying') return RETRY_HINT;

  return HINTS[current.state] ?? '';
}

function render(): void {
  const token = tokenInput.value.trim();
  const url = urlInput.value.trim().replace(/\/+$/, '');
  const port = relayPort(url);
  const connected = status.state === 'connected';
  const dirty = token !== saved.token || url !== saved.url;
  const detail = status.detail && status.detail !== 'retrying' ? ` - ${status.detail}` : '';
  const portEnv = port && port !== DEFAULT_PORT ? ` PORT=${port}` : '';

  document.body.dataset.state = status.state;
  statusLine.textContent = LABELS[status.state] + detail;
  hintLine.textContent = hintFor(status);

  setup.hidden = connected;
  client.hidden = !connected;

  relayCmd.textContent = `RELAY_TOKEN=${quote(token || '<token>')}${portEnv} npm run relay`;
  clientCmd.textContent = clientSnippet(url, token);
  clientHint.textContent = CLIENT_HINTS[picked];

  for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === picked));

  toggle.textContent = enabled ? (dirty || status.state === 'replaced' ? 'Reconnect' : 'Disconnect') : 'Connect';
  toggle.classList.toggle('off', toggle.textContent === 'Disconnect');
}

async function refresh(): Promise<void> {
  status = await loadStatus();
  render();
}

async function init(): Promise<void> {
  saved = await loadSettings();

  if (!saved.token) {
    saved = { ...saved, token: newToken() };
    await saveSettings(saved);
  }

  urlInput.value = saved.url;
  tokenInput.value = saved.token;
  enabled = saved.enabled;

  await refresh();
}

toggle.addEventListener('click', async () => {
  const reconnect = toggle.textContent === 'Reconnect';

  enabled = reconnect ? true : !enabled;

  // The service worker reacts to the storage change.
  saved = {
    url: urlInput.value.trim().replace(/\/+$/, ''),
    token: tokenInput.value.trim(),
    enabled,
  };

  await saveSettings(saved);
  await refresh();
});

generate.addEventListener('click', async () => {
  tokenInput.value = newToken();

  // While enabled, saving would drop the live connection. Wait for Reconnect.
  if (!enabled) {
    saved = { ...saved, token: tokenInput.value };
    await saveSettings(saved);
  }

  render();
});

for (const input of [urlInput, tokenInput]) input.addEventListener('input', render);

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    picked = tab.dataset.tab as Client;
    render();
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.addEventListener('click', async () => {
    const source = document.getElementById(button.dataset.copy ?? '');

    await navigator.clipboard.writeText(source?.textContent ?? '');

    button.textContent = 'Copied';
    button.classList.add('done');

    setTimeout(() => {
      button.textContent = 'Copy';
      button.classList.remove('done');
    }, 1500);
  });
}

chrome.storage.session.onChanged.addListener(() => void refresh());

void init();
