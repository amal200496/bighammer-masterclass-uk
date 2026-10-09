/* WebinarGeek webhook signature check.

   WebinarGeek signs the raw body with HMAC-SHA256 using the webhook's secret and
   sends it as `Signature: sha256=<hex>`. The body must be verified exactly as
   received, before JSON parsing. */

const encoder = new TextEncoder();

export async function verifyWebinarGeekSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;

  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  // subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', key, hexToBytes(match[1]), encoder.encode(rawBody));
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}
