/* Automation: webinar nurture, beehiiv ↔ GoHighLevel

   beehiiv sends the 24 nurture emails. GHL is the system of record: every
   status, step and engagement number lands on the GHL contact, and reporting
   is built there. This file is the glue between the two:

     POST /ghl/nurture/enrol       GHL "Webhook" action → subscribe in beehiiv and start the automation
     POST /ghl/nurture/booked      GHL "Webhook" action → set booked_call in beehiiv, so sales CTAs stop
     POST /beehiiv/nurture/step    beehiiv "Send webhook" step after each email → step fields and tag in GHL
     POST /beehiiv/nurture/status  beehiiv publication webhook → unsubscribe and pause state in GHL
     cron (nightly)                beehiiv per-subscriber stats → GHL engagement fields

   As with WebinarGeek, the Worker writes fields and tags, and GHL workflows
   start on "Contact Tag added". Nothing here needs GHL's premium Inbound
   Webhook trigger or Custom Webhook action, and the beehiiv API key never has
   to be stored in GHL. */

import { GhlClient } from '../lib/ghl.js';
import { BeehiivClient, customFieldMap } from '../lib/beehiiv.js';
import { verifySvixSignature } from '../lib/svix.js';
import { json, hasValidKey } from '../lib/http.js';

export const TAGS = {
  enrolled: 'nurture-enrolled',
  booked: 'nurture-booked',
  completed: 'nurture-completed',
  unsubscribed: 'nurture-unsubscribed',
  paused: 'nurture-paused',
  sent: emailId => `nurture-${emailId}-sent`,
};

const UTM = { utm_source: 'gohighlevel', utm_medium: 'webinar', utm_campaign: 'dbx-webinar-nurture-2026' };

const ghlClient = env => new GhlClient(env.GHL_PRIVATE_TOKEN, env.GHL_LOCATION_ID);
const beehiivClient = env => new BeehiivClient(env.BEEHIIV_API_KEY, env.BEEHIIV_PUBLICATION_ID);

/* GHL workflow A. Add a "Webhook" action (the standard one, not Custom
   Webhook) pointing at this route; it posts the whole contact. An optional
   Custom Data row `webinar_date` (YYYY-MM-DD) is passed through to beehiiv. */
export async function handleNurtureEnrol(request, env) {
  if (!await hasValidKey(request, env.NURTURE_WEBHOOK_KEY)) return json({ ok: false, error: 'Invalid key' }, 401);
  const contact = readGhlContact(await readJson(request));
  if (!contact) return json({ ok: true, ignored: 'no email' });
  // GHL retries a webhook that times out; a second journey would send every email twice.
  if (contact.tags.includes(TAGS.enrolled)) return json({ ok: true, ignored: 'already enrolled' });
  if (!env.BEEHIIV_AUTOMATION_ID || env.BEEHIIV_AUTOMATION_ID === 'REPLACE_ME') {
    throw new Error('BEEHIIV_AUTOMATION_ID is not set');
  }

  const beehiiv = beehiivClient(env);
  const ghl = ghlClient(env);
  const fields = {
    // beehiiv's two built-in fields, under the names it gives them.
    'First Name': contact.firstName,
    'Last Name': contact.lastName,
    company: contact.company,
    ghl_contact_id: contact.id,
    webinar_date: contact.webinarDate,
    booked_call: 'false',
  };
  for (const k of Object.keys(fields)) if (!fields[k]) delete fields[k];

  try {
    let subscription = await beehiiv.findByEmail(contact.email);
    if (subscription && subscription.status === 'inactive') {
      // They unsubscribed in beehiiv before. Registering for a webinar does not undo that.
      await saveToGhl(ghl, contact, { nurture_status: 'unsubscribed', beehiiv_subscription_id: subscription.id }, [TAGS.unsubscribed]);
      console.log('Nurture enrol skipped, unsubscribed in beehiiv', contact.email);
      return json({ ok: true, ignored: 'unsubscribed in beehiiv' });
    }

    if (subscription) {
      await beehiiv.setCustomFields(subscription.id, fields);
      await beehiiv.enrol(env.BEEHIIV_AUTOMATION_ID, subscription.id);
    } else {
      subscription = await beehiiv.createSubscription({
        email: contact.email,
        reactivate_existing: false,
        send_welcome_email: false,
        double_opt_override: 'off',
        ...UTM,
        automation_ids: [env.BEEHIIV_AUTOMATION_ID],
        custom_fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
      });
    }

    const contactId = await saveToGhl(
      ghl, contact, { nurture_status: 'enrolled', beehiiv_subscription_id: subscription.id }, [TAGS.enrolled]
    );
    console.log('Nurture enrolled', contact.email, contactId, subscription.id);
    return json({ ok: true, contactId, subscriptionId: subscription.id });
  } catch (err) {
    console.error('Nurture enrol failed', contact.email, err.message);
    return json({ ok: false, error: 'Enrol failed' }, 502);
  }
}

/* GHL workflow D. Same "Webhook" action, fired when a call is booked. beehiiv
   reads booked_call in its branches and stops the sales emails. */
export async function handleNurtureBooked(request, env) {
  if (!await hasValidKey(request, env.NURTURE_WEBHOOK_KEY)) return json({ ok: false, error: 'Invalid key' }, 401);
  const contact = readGhlContact(await readJson(request));
  if (!contact) return json({ ok: true, ignored: 'no email' });

  try {
    const beehiiv = beehiivClient(env);
    const subscription = await beehiiv.findByEmail(contact.email);
    if (subscription) await beehiiv.setCustomFields(subscription.id, { booked_call: 'true' });

    const contactId = await saveToGhl(ghlClient(env), contact, { booked_call: 'true', nurture_status: 'booked' }, [TAGS.booked]);
    console.log('Nurture booked', contact.email, contactId, subscription ? subscription.id : 'not in beehiiv');
    return json({ ok: true, contactId, inBeehiiv: !!subscription });
  } catch (err) {
    console.error('Nurture booked failed', contact.email, err.message);
    return json({ ok: false, error: 'Booked sync failed' }, 502);
  }
}

/* beehiiv "Send webhook" step, one after each email. The step is identified
   in the URL (?email_id=e04, or ?event=complete after the last email). No key
   is needed in the URL: see isRealJourney. */
export async function handleNurtureStep(request, env) {
  const params = new URL(request.url).searchParams;
  const body = await readJson(request);
  if (!await hasValidKey(request, env.NURTURE_WEBHOOK_KEY) && !await isRealJourney(body, env)) {
    return json({ ok: false, error: 'Not a known automation journey' }, 401);
  }
  const update = mapStep(params, body);
  if (!update) {
    // Keys only, no values: shows the payload shape without logging personal data.
    console.warn('Nurture step ignored', params.get('email_id'), 'payload keys:', Object.keys(body || {}).join(','));
    return json({ ok: true, ignored: true });
  }

  const ghl = ghlClient(env);
  try {
    const contact = await ghl.findByEmail(update.email);
    if (!contact) {
      console.warn('Nurture step: no GHL contact for', update.email);
      return json({ ok: true, ignored: 'not in GHL' });
    }
    const customFields = { ...update.customFields };
    // A booked or unsubscribed contact keeps that status even if an email already in flight lands.
    const tags = contact.tags || [];
    if (!update.complete && (tags.includes(TAGS.booked) || tags.includes(TAGS.unsubscribed))) {
      delete customFields.nurture_status;
    }
    await ghl.updateContact(contact.id, { customFields });
    await ghl.addTags(contact.id, [update.tag]);
    console.log('Nurture step', update.tag, update.email, contact.id);
    return json({ ok: true, contactId: contact.id, tag: update.tag });
  } catch (err) {
    console.error('Nurture step failed', update.tag, update.email, err.message);
    // Non-2xx so beehiiv records the delivery as failed.
    return json({ ok: false, error: 'GHL sync failed' }, 502);
  }
}

/* beehiiv's webhook step cannot sign its request, and a key in the URL would
   have to be pasted into every step. Instead the call is checked against
   beehiiv: the journey id in the body must exist in our automation and belong
   to the subscriber the body names. Journey ids are random, so an outsider
   cannot produce a matching pair. */
async function isRealJourney(body, env) {
  const journeyId = body && body.automation_journey_id;
  const email = findEmail(body);
  if (!journeyId || !email || !/^aj_[0-9a-f-]{36}$/.test(journeyId)) return false;
  try {
    const journey = await beehiivClient(env).findJourney(env.BEEHIIV_AUTOMATION_ID, journeyId);
    return !!journey && journey.id === journeyId && cleanEmail(journey.email) === email;
  } catch (err) {
    console.error('Nurture step: journey check failed', err.message);
    return false;
  }
}

/* Pure mapping from a step webhook to a GHL update. Returns null when the
   step or the subscriber cannot be identified. */
export function mapStep(params, body, now = new Date()) {
  const email = findEmail(body) || cleanEmail(params.get('email'));
  if (!email) return null;

  if (params.get('event') === 'complete') {
    return { email, complete: true, tag: TAGS.completed, customFields: { nurture_status: 'completed' } };
  }
  const match = /^e(\d{2})$/.exec(params.get('email_id') || '');
  if (!match) return null;
  return {
    email,
    complete: false,
    tag: TAGS.sent(match[0]),
    customFields: {
      nurture_status: 'active',
      nurture_step: Number(match[1]),
      nurture_last_email: match[0],
      nurture_last_sent_at: now.toISOString().slice(0, 10),
    },
  };
}

/* beehiiv publication webhooks (Settings → Webhooks), signed by Svix. Only
   contacts that already exist in GHL are touched: the publication can have
   subscribers that never came through GHL. */
export async function handleNurtureStatus(request, env) {
  const raw = await request.text();
  if (!await verifySvixSignature(raw, request.headers, env.BEEHIIV_WEBHOOK_SECRET)) {
    return json({ ok: false, error: 'Invalid signature' }, 401);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const update = mapStatusEvent(payload);
  if (!update) {
    console.log('Ignored beehiiv event', payload.event_type);
    return json({ ok: true, ignored: true });
  }

  const ghl = ghlClient(env);
  try {
    const contact = await ghl.findByEmail(update.email);
    if (!contact) return json({ ok: true, ignored: 'not in GHL' });

    await ghl.updateContact(contact.id, update.contact);
    await ghl.removeTags(contact.id, update.removeTags);
    await ghl.addTags(contact.id, update.addTags);
    console.log('beehiiv → GHL', payload.event_type, update.email, contact.id);
    return json({ ok: true, contactId: contact.id });
  } catch (err) {
    console.error('beehiiv → GHL failed', payload.event_type, update.email, err.message);
    return json({ ok: false, error: 'GHL sync failed' }, 502);
  }
}

// Pure mapping from a beehiiv publication webhook to a GHL update, or null for events we do not act on.
export function mapStatusEvent(payload) {
  const data = (payload && payload.data) || {};
  const email = cleanEmail(data.email);
  if (!email) return null;
  const customFields = { beehiiv_subscription_id: data.subscription_id || data.id };

  switch (payload.event_type) {
    case 'subscription.deleted':
    case 'newsletter_list_subscription.unsubscribed':
      return {
        email,
        contact: {
          customFields: { ...customFields, nurture_status: 'unsubscribed' },
          // They opted out of email, so GHL must not email them either.
          dndSettings: { Email: { status: 'active', message: 'Unsubscribed in beehiiv' } },
        },
        addTags: [TAGS.unsubscribed],
        removeTags: [],
      };
    case 'subscription.paused':
    case 'newsletter_list_subscription.paused':
      return { email, contact: { customFields }, addTags: [TAGS.paused], removeTags: [] };
    case 'subscription.resumed':
    case 'newsletter_list_subscription.resumed':
      return { email, contact: { customFields }, addTags: [], removeTags: [TAGS.paused] };
    case 'subscription.confirmed':
      return { email, contact: { customFields }, addTags: [], removeTags: [] };
    default:
      return null;
  }
}

/* Nightly: copy each subscriber's beehiiv stats onto their GHL contact.
   beehiiv has no per-subscriber open or click webhooks, so this is the only
   source of per-contact engagement. Only subscribers that carry a
   ghl_contact_id are synced. */
export async function runNurtureSync(env) {
  const beehiiv = beehiivClient(env);
  const ghl = ghlClient(env);
  let seen = 0, synced = 0, failed = 0;

  for await (const sub of beehiiv.subscriptions()) {
    seen++;
    const contactId = customFieldMap(sub).ghl_contact_id;
    if (!contactId) continue;
    try {
      await ghl.updateContact(contactId, { customFields: engagementFields(sub) });
      synced++;
    } catch (err) {
      failed++;
      console.error('Nurture sync failed for', contactId, err.message);
    }
  }

  console.log('Nurture sync', JSON.stringify({ seen, synced, failed }));
  // Throwing marks the cron run as failed in Cloudflare, which is what its alerting watches.
  if (failed) throw new Error(`Nurture sync: ${failed} of ${synced + failed} contacts failed`);
  return { seen, synced, failed };
}

// beehiiv reports rates as percentages (60.1 means 60.1%).
export function engagementFields(sub) {
  const stats = sub.stats || {};
  const openRate = Number(stats.open_rate) || 0;
  const clickRate = Number(stats.click_through_rate) || 0;
  return {
    beehiiv_subscription_id: sub.id,
    // Strings, because a numeric 0 would be dropped as an empty value.
    bh_emails_received: String(stats.emails_received || 0),
    bh_open_rate: String(openRate),
    bh_click_rate: String(clickRate),
    bh_engagement_tier: engagementTier(openRate, clickRate),
  };
}

/* Opens are inflated by Apple Mail Privacy Protection, so a click outranks any
   open rate. Thresholds are a starting point; revisit after the first month. */
export function engagementTier(openRate, clickRate) {
  if (clickRate >= 10) return 'hot';
  if (openRate >= 30) return 'warm';
  return 'cold';
}

/* The fields we use from GHL's standard "Webhook" action payload, which posts
   the contact with flat snake_case keys. Returns null without an email. */
function readGhlContact(body) {
  const email = cleanEmail(body && body.email);
  if (!email) return null;
  const tags = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',');
  return {
    id: body.contact_id || body.id,
    email,
    firstName: body.first_name,
    lastName: body.last_name,
    company: body.company_name,
    webinarDate: body.customData && body.customData.webinar_date,
    tags: tags.map(t => String(t).trim().toLowerCase()).filter(Boolean),
  };
}

// Writes by contact id when GHL sent one, otherwise matches on email. Returns the contact id.
async function saveToGhl(ghl, contact, customFields, tags) {
  let contactId = contact.id;
  if (contactId) await ghl.updateContact(contactId, { customFields });
  else contactId = await ghl.upsertContact({ email: contact.email, customFields });
  await ghl.addTags(contactId, tags);
  return contactId;
}

/* beehiiv's "Send webhook" step posts a fixed body:
   { automation_id, automation_journey_id, automation_journey_step_started_at,
     subscriber_email, subscriber_id, test }.
   The other shapes are kept in case beehiiv changes it. */
function findEmail(body) {
  if (!body || typeof body !== 'object') return '';
  const direct = cleanEmail(body.subscriber_email);
  if (direct) return direct;
  for (const holder of [body, body.data, body.subscriber, body.subscription]) {
    const email = cleanEmail(holder && holder.email);
    if (email) return email;
  }
  return '';
}

function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '';
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
