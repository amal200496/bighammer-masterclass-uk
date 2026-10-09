/* Automation: WebinarGeek → GoHighLevel

   WebinarGeek posts a webhook for each subscription event (registration,
   viewer, no-show, unsubscribe, ...). We upsert the contact in GHL and set
   state tags. GHL workflows start on "Contact Tag added" — a free trigger —
   instead of the premium Inbound Webhook trigger.

   State is derived from the subscription itself, not from the event name, so
   any event that carries a Subscription brings GHL up to date, and a retried
   or out-of-order webhook converges on the same result. */

import { GhlClient } from '../lib/ghl.js';
import { verifyWebinarGeekSignature } from '../lib/webinargeek.js';
import { formatWebinarDate, formatWebinarTime, formatWebinarBroadcastDate, formatTimestamp } from '../lib/dates.js';
import { json } from '../lib/http.js';

export const TAGS = {
  registered: 'webinar registrant',
  attended: 'webinar attended',      // watched in any form, live or replay
  live: 'live webinar watched',      // watched the live broadcast
  replay: 'watched webinar replay',
  noShow: 'live webinar not watched',
  unsubscribed: 'webinar unsubscribed',
  ctaClicked: 'clicked webinar CTA',
};

// Cleared when someone registers again, so the next webinar's tags are "added"
// afresh and re-fire their GHL workflows.
const POST_WEBINAR_TAGS = [TAGS.attended, TAGS.live, TAGS.replay, TAGS.noShow, TAGS.unsubscribed, TAGS.ctaClicked];

export async function handleWebinarGeekToGhl(request, env) {
  const raw = await request.text();

  const valid = await verifyWebinarGeekSignature(
    raw, request.headers.get('Signature'), env.WEBINARGEEK_WEBHOOK_SECRET
  );
  if (!valid) return json({ ok: false, error: 'Invalid signature' }, 401);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const update = mapSubscription(payload, env.WEBINAR_TIMEZONE || 'America/New_York', broadcastSessions(env));
  if (!update) {
    console.log('Ignored WebinarGeek event', payload.event, payload.entity_type);
    return json({ ok: true, ignored: true });
  }

  const ghl = new GhlClient(env.GHL_PRIVATE_TOKEN, env.GHL_LOCATION_ID);
  try {
    const contactId = await ghl.upsertContact(update.contact);
    if (!contactId) throw new Error('GHL upsert returned no contact id');
    await ghl.removeTags(contactId, update.removeTags);
    await ghl.addTags(contactId, update.addTags);

    console.log('WebinarGeek → GHL', payload.event, update.contact.email, contactId, update.addTags);
    // Field names only, no values: shows what WebinarGeek sends beyond the documented API.
    console.log('WebinarGeek fields', Object.keys(payload.entity).join(','));
    return json({ ok: true, contactId, addTags: update.addTags, removeTags: update.removeTags });
  } catch (err) {
    console.error('WebinarGeek → GHL failed', payload.event, update.contact.email, err.message);
    // Non-2xx so WebinarGeek treats the delivery as failed.
    return json({ ok: false, error: 'GHL sync failed' }, 502);
  }
}

/* BROADCAST_SESSIONS in wrangler.jsonc: per-broadcast settings for sessions
   that have their own landing page, keyed by WebinarGeek broadcast id.
   { "<id>": { timezone, locale } }. A string (as .dev.vars
   gives it) is parsed; anything unreadable counts as no sessions. */
export function broadcastSessions(env) {
  const raw = env.BROADCAST_SESSIONS;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) || {};
  } catch {
    console.warn('BROADCAST_SESSIONS is not valid JSON — ignored');
    return {};
  }
}

/* Pure mapping from a WebinarGeek webhook payload to a GHL update.
   Returns null for payloads we do not act on. `sessions` is the
   BROADCAST_SESSIONS map; a broadcast listed there is written in its own
   timezone and locale. */
export function mapSubscription(payload, defaultTz, sessions = {}) {
  if (!payload || payload.entity_type !== 'Subscription' || !payload.entity) return null;
  const sub = payload.entity;
  const email = String(sub.email || '').trim().toLowerCase();
  if (!email) return null;

  const broadcast = sub.broadcast || {};
  const webinar = sub.webinar || {};
  const episode = sub.episode || {};
  const session = sessions[String(broadcast.id)] || {};
  const tz = session.timezone || defaultTz;
  const noShow = !sub.unsubscribed && !!broadcast.has_ended && !sub.watched_live;
  const time = unix => formatTimestamp(unix, tz);
  const ctaClickedAt = lastCtaClick(payload);

  const contact = {
    email,
    ...cleanName(sub.firstname, sub.surname),
    phone: normalisePhone(sub.phone),
    source: 'WebinarGeek',
    // Keys are GHL custom field keys. Formats follow what is already stored:
    // booleans as "true"/"false", moments as "15-10-2026 12:00:00 -0400".
    customFields: {
      // Webinar and join link
      watch_link_webinargeek: sub.watch_link,
      confirmation_link_webinargeek: sub.confirmation_link,
      readable_webinar_date: formatWebinarDate(broadcast.date, tz, session.locale),
      readable_webinar_time: formatWebinarTime(broadcast.date, tz, session.locale),
      webinar_broadcast_date: formatWebinarBroadcastDate(broadcast.date, tz),
      webinar_title_webinargeek: webinar.title || episode.title,
      webinar_id_webinargeek: str(webinar.id),
      episode_id_webinargeek: str(episode.id),
      broadcast_id_webinargeek: str(broadcast.id),
      broadcast_date_webinargeek: time(broadcast.date),
      active_jit_webinargeek: bool(broadcast.active_jit),
      active_yesterdays_replay_webinargeek: bool(broadcast.active_yesterdays_replay),

      // Registrant
      company: sub.company,
      job_title: sub.job_title,
      time_zone_webinargeek: sub.time_zone,
      captions_language_webinargeek: sub.captions_language,
      external_id_webinargeek: sub.external_id,
      registration_source_webinargeek: sub.registration_source,
      registration_ip_webinargeek: sub.registration_ip,
      created_at_webinargeek: time(sub.created_at),
      email_verified_webinargeek: bool(sub.email_verified),
      email_verified_at_webinargeek: time(sub.email_verified_at),
      email_updated_at_webinargeek: time(sub.email_updated_at),
      entity_type_webinargeek: payload.entity_type,

      // Access
      eligible_to_watch_webinargeek: bool(sub.eligible_to_watch),
      paid_to_watch_webinargeek: bool(sub.payment_to_watch_completed),
      given_access_after_viewer_limit_webinargeek: bool(sub.given_access_after_viewer_limit),
      viewer_limit_hit_reason_webinargeek: sub.viewer_limit_hit_reason,

      // Viewing
      watched_webinargeek: bool(sub.watched),
      watched_live_webinargeek: bool(sub.watched_live),
      watched_replay_webinargeek: bool(sub.watched_replay),
      watched_yesterdays_replay_webinargeek: bool(sub.watched_yesterdays_replay),
      not_watched_live_webinargeek: broadcast.has_ended ? String(noShow) : undefined,
      start_time_webinargeek: time(sub.watch_start),
      end_time_webinargeek: time(sub.watch_end),
      start_time_replay_webinargeek: time(sub.watch_start_replay),
      end_time_replay_webinargeek: time(sub.watch_end_replay),
      minutes_viewing_time_webinargeek: sub.watched_live ? toMinutes(sub.watch_duration) : undefined,
      minutes_viewing_time_replay_webinargeek: sub.watched_replay ? toMinutes(sub.watch_duration_replay) : undefined,
      viewing_country_webinargeek: sub.viewing_country,
      viewing_device_webinargeek: sub.viewing_device,
      cta_clicked: ctaClickedAt ? 'yes' : undefined,
      cta_clicked_time: time(ctaClickedAt),
      voted_poll_webinargeek: Array.isArray(sub.poll_votes) && sub.poll_votes.length ? 'Yes' : undefined,

      // Unsubscribe
      unsubscribed_webinargeek: bool(sub.unsubscribed),
      unsubscribed_at_webinargeek: time(sub.unsubscribed_at),
      unsubscription_source_webinargeek: sub.unsubscription_source,
    },
  };
  // Leave undefined keys out so the upsert never blanks an existing value.
  for (const k of Object.keys(contact)) if (contact[k] === undefined) delete contact[k];

  const addTags = [];
  const removeTags = [];

  if (sub.unsubscribed) {
    addTags.push(TAGS.unsubscribed);
    removeTags.push(TAGS.registered);
  } else {
    if (payload.event === 'webinar_subscribed') removeTags.push(...POST_WEBINAR_TAGS);
    addTags.push(TAGS.registered);
    if (sub.watched || sub.watched_live || sub.watched_replay) addTags.push(TAGS.attended);
    if (sub.watched_live) addTags.push(TAGS.live);
    if (sub.watched_replay) addTags.push(TAGS.replay);
    if (noShow) addTags.push(TAGS.noShow);
    if (ctaClickedAt) addTags.push(TAGS.ctaClicked);
  }

  return { contact, addTags, removeTags };
}

/* WebinarGeek often holds the surname twice: repeated inside the surname
   ("Doe Doe"), or also appended to the first name ("Jane Doe" + "Doe").
   Both come out as Jane / Doe. */
function cleanName(firstname, surname) {
  const words = value => String(value || '').trim().split(/\s+/).filter(Boolean);
  const same = (a, b) => a.join(' ').toLowerCase() === b.join(' ').toLowerCase();
  let first = words(firstname);
  let last = words(surname);

  const half = last.length / 2;
  if (last.length && last.length % 2 === 0 && same(last.slice(0, half), last.slice(half))) {
    last = last.slice(0, half);
  }
  if (last.length && first.length > last.length && same(first.slice(-last.length), last)) {
    first = first.slice(0, -last.length);
  }
  return { firstName: first.join(' ') || undefined, lastName: last.join(' ') || undefined };
}

// GHL rejects the whole upsert on an unparseable phone, so only send E.164.
// The landing page already sends a clean one via form tracking.
function normalisePhone(phone) {
  const cleaned = String(phone || '').replace(/[\s().-]/g, '').replace(/^00/, '+');
  return /^\+[1-9]\d{6,14}$/.test(cleaned) ? cleaned : undefined;
}

function toMinutes(seconds) {
  return seconds ? String(Math.round(seconds / 60)) : '0';
}

/* Unix seconds of the latest CTA click, or undefined. Clicks are listed in
   calls_to_action; if a "New call to action" webhook arrives without that
   list, the webhook's own timestamp (milliseconds) is the click time. */
function lastCtaClick(payload) {
  const clicks = payload.entity.calls_to_action;
  if (Array.isArray(clicks) && clicks.length) {
    return Math.max(...clicks.map(c => c.created_at || 0)) || undefined;
  }
  if (/call_to_action|cta/i.test(payload.event || '') && payload.timestamp) {
    return Math.floor(payload.timestamp / 1000);
  }
  return undefined;
}

// undefined/null stay undefined so the field is left untouched.
function bool(value) {
  return value === undefined || value === null ? undefined : String(!!value);
}

function str(value) {
  return value === undefined || value === null ? undefined : String(value);
}
