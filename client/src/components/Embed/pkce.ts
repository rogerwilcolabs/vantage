const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** A 43-character RFC 7636 verifier the frame keeps in memory for the length of one sign-in. */
export function createCodeVerifier(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Hex SHA-256, the challenge format the server's exchange helper verifies. */
export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toHex(new Uint8Array(digest));
}
