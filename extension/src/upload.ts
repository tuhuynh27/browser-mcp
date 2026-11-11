export interface RelayFile {
  url: string;
  name: string;
  size: number;
}

export interface RelayAccess {
  url: string;
  token: string;
}

// Stores a file on the relay and returns its relay path (`/files/...`).
export async function uploadFile(relay: RelayAccess, name: string, body: Blob): Promise<RelayFile> {
  const response = await fetch(`${relay.url}/upload/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${relay.token}` },
    body,
  });

  if (!response.ok) {
    throw new Error(`Relay refused the upload (${response.status}).`);
  }

  return (await response.json()) as RelayFile;
}

export function base64ToBlob(data: string, type: string): Blob {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));

  return new Blob([bytes], { type });
}
