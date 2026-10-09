/* Svix webhook signature check. beehiiv delivers its publication webhooks
   through Svix.

   The signed content is `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256
   with the endpoint's signing secret (`whsec_<base64 key>`, shown on the
   endpoint's page in beehiiv → Settings → Webhooks). `svix-signature` holds one
   or more space-separated `v1,<base64>` entries; any match passes. */

const encoder = new TextEncoder();
const TOLERANCE_SECONDS = 5 * 60;

export async function verifySvixSignature(rawBody, headers, secret, nowSeconds = Date.now() / 1000) {
  const id = headers.get('svix-id');
  const timestamp = headers.get('svix-timestamp');
  const signatures = headers.get('svix-signature');
  if (!id || !timestamp || !signatures || !secret) return false;

  // Stale or future-dated deliveries are rejected so a captured request can't be replayed later.
  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || Math.abs(nowSeconds - sent) > TOLERANCE_SECONDS) return false;

  let keyBytes;
  try {
    keyBytes = base64ToBytes(secret.replace(/^whsec_/, ''));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const content = encoder.encode(`${id}.${timestamp}.${rawBody}`);

  for (const entry of signatures.split(' ')) {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) continue;
    let sig;
    try {
      sig = base64ToBytes(value);
    } catch {
      continue;
    }
    // subtle.verify compares in constant time.
    if (await crypto.subtle.verify('HMAC', key, sig, content)) return true;
  }
  return false;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
