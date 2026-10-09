/* One-off setup for the webinar nurture: creates the custom fields in beehiiv
   and GHL, and registers the beehiiv publication webhook. Safe to re-run:
   anything that already exists is left alone.

     node --env-file=.dev.vars scripts/setup-nurture.mjs            # dry run, prints the plan
     node --env-file=.dev.vars scripts/setup-nurture.mjs --apply    # makes the changes

   Reads GHL_PRIVATE_TOKEN and BEEHIIV_API_KEY from .dev.vars, and the ids from
   wrangler.jsonc. The GHL token also needs the locations/customFields.write
   scope for this script (the Worker itself does not). Pass
   --worker-url=https://... to register the beehiiv webhook as well. */

import { readFileSync } from 'node:fs';

const apply = process.argv.includes('--apply');
const workerUrl = (process.argv.find(a => a.startsWith('--worker-url=')) || '').split('=')[1];

const wrangler = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const configVar = name => (new RegExp(`"${name}":\\s*"([^"]+)"`).exec(wrangler) || [])[1];
const locationId = configVar('GHL_LOCATION_ID');
const publicationId = configVar('BEEHIIV_PUBLICATION_ID');

// The Worker and the emails refer to these names exactly. beehiiv ships "First Name" and
// "Last Name" itself and treats first_name / last_name as the same names, so those are not listed.
const BEEHIIV_FIELDS = [
  ['company', 'string'], ['role', 'string'],
  ['ghl_contact_id', 'string'], ['webinar_date', 'date'], ['attended_live', 'boolean'],
  ['renewal_month', 'string'], ['booked_call', 'boolean'],
];

// The field key GHL derives from each name (contact.<name>) is what the Worker writes to.
const GHL_FIELDS = [
  { name: 'nurture_status', dataType: 'SINGLE_OPTIONS', options: ['enrolled', 'active', 'booked', 'completed', 'unsubscribed', 'bounced'] },
  { name: 'nurture_step', dataType: 'NUMERICAL' },
  { name: 'nurture_last_email', dataType: 'TEXT' },
  { name: 'nurture_last_sent_at', dataType: 'DATE' },
  { name: 'beehiiv_subscription_id', dataType: 'TEXT' },
  { name: 'bh_emails_received', dataType: 'NUMERICAL' },
  { name: 'bh_open_rate', dataType: 'NUMERICAL' },
  { name: 'bh_click_rate', dataType: 'NUMERICAL' },
  { name: 'bh_engagement_tier', dataType: 'SINGLE_OPTIONS', options: ['hot', 'warm', 'cold'] },
  // Text "true"/"false", like the other boolean fields in this location.
  { name: 'booked_call', dataType: 'TEXT' },
  { name: 'first_touch_utm_content', dataType: 'TEXT' },
  { name: 'last_touch_utm_content', dataType: 'TEXT' },
];

const WEBHOOK_EVENTS = [
  'subscription.confirmed', 'subscription.deleted', 'subscription.paused', 'subscription.resumed',
  'newsletter_list_subscription.unsubscribed',
];

async function call(label, url, { method = 'GET', headers, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function setupBeehiiv() {
  const key = process.env.BEEHIIV_API_KEY;
  if (!key || !publicationId || publicationId === 'REPLACE_ME') {
    console.log('beehiiv: skipped (set BEEHIIV_API_KEY in .dev.vars and BEEHIIV_PUBLICATION_ID in wrangler.jsonc)');
    return;
  }
  const base = `https://api.beehiiv.com/v2/publications/${publicationId}`;
  const headers = { Authorization: 'Bearer ' + key };

  const existing = await call('beehiiv list custom fields', `${base}/custom_fields?limit=100`, { headers });
  const have = new Set((existing.data || []).map(f => f.display));
  for (const [display, kind] of BEEHIIV_FIELDS) {
    if (have.has(display)) { console.log(`beehiiv field  ${display}: exists`); continue; }
    console.log(`beehiiv field  ${display} (${kind}): ${apply ? 'creating' : 'would create'}`);
    if (apply) await call(`beehiiv create ${display}`, `${base}/custom_fields`, { method: 'POST', headers, body: { kind, display } });
  }

  if (!workerUrl) {
    console.log('beehiiv webhook: skipped (pass --worker-url=https://<worker> once it is deployed)');
    return;
  }
  const url = workerUrl.replace(/\/+$/, '') + '/beehiiv/nurture/status';
  const hooks = await call('beehiiv list webhooks', `${base}/webhooks`, { headers });
  if ((hooks.data || []).some(h => h.url === url)) { console.log('beehiiv webhook: exists'); return; }
  console.log(`beehiiv webhook → ${url}: ${apply ? 'creating' : 'would create'}`);
  if (apply) {
    await call('beehiiv create webhook', `${base}/webhooks`, {
      method: 'POST', headers, body: { url, event_types: WEBHOOK_EVENTS, description: 'Nurture status sync to GoHighLevel' },
    });
    console.log('  Copy its signing secret (Settings → Webhooks → the endpoint) into BEEHIIV_WEBHOOK_SECRET.');
  }
}

async function setupGhl() {
  const token = process.env.GHL_PRIVATE_TOKEN;
  if (!token || /REPLACE_ME/.test(token) || !locationId || locationId === 'REPLACE_ME') {
    console.log('GHL: skipped (set GHL_PRIVATE_TOKEN in .dev.vars and GHL_LOCATION_ID in wrangler.jsonc)');
    return;
  }
  const base = `https://services.leadconnectorhq.com/locations/${locationId}/customFields`;
  const headers = { Authorization: 'Bearer ' + token, Version: '2021-07-28' };

  const existing = await call('GHL list custom fields', `${base}?model=contact`, { headers });
  const have = new Set((existing.customFields || []).map(f => String(f.fieldKey || '').replace(/^contact\./, '')));
  for (const field of GHL_FIELDS) {
    if (have.has(field.name)) { console.log(`GHL field      ${field.name}: exists`); continue; }
    console.log(`GHL field      ${field.name} (${field.dataType}): ${apply ? 'creating' : 'would create'}`);
    if (apply) await call(`GHL create ${field.name}`, base, { method: 'POST', headers, body: { ...field, model: 'contact' } });
  }
}

if (!apply) console.log('Dry run. Nothing is changed without --apply.\n');
await setupBeehiiv();
await setupGhl();
