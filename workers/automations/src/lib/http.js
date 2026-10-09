export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/* Shared-secret check for callers that can't sign a request (GHL's Webhook
   action, beehiiv's automation webhook step): the secret travels as ?key=. */
export async function hasValidKey(request, secret) {
  const given = new URL(request.url).searchParams.get('key');
  if (!given || !secret) return false;
  // Comparing digests keeps the comparison constant-time whatever the lengths.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(secret)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
