import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebinarGeekSignature } from '../src/lib/webinargeek.js';
import { mapSubscription, broadcastSessions, TAGS, handleWebinarGeekToGhl } from '../src/automations/webinargeek-to-ghl.js';

const TZ = 'America/New_York';

// en-US puts a narrow no-break space before AM/PM on newer ICU versions.
const spaces = s => s.replace(/\s/g, ' ');

// Test vector published in WebinarGeek's webhook docs.
test('signature: accepts the documented test vector', async () => {
  const ok = await verifyWebinarGeekSignature(
    '"Hello World!"', // the quotes are part of the body
    'sha256=a6353e505082e0614d4f1760c1d25e523ee34141bd2d2e5ef1e4648fc1ed128b',
    "It's a secret"
  );
  assert.equal(ok, true);
});

test('signature: rejects tampered body, wrong secret and missing header', async () => {
  const sig = 'sha256=a6353e505082e0614d4f1760c1d25e523ee34141bd2d2e5ef1e4648fc1ed128b';
  assert.equal(await verifyWebinarGeekSignature('Hello World?', sig, "It's a secret"), false);
  assert.equal(await verifyWebinarGeekSignature('Hello World!', sig, 'nope'), false);
  assert.equal(await verifyWebinarGeekSignature('Hello World!', null, "It's a secret"), false);
  assert.equal(await verifyWebinarGeekSignature('Hello World!', 'garbage', "It's a secret"), false);
});

function payload(event, overrides = {}, broadcast = {}) {
  return {
    id: '1', event, timestamp: 1790000000000, entity_type: 'Subscription',
    entity: {
      firstname: 'Jane', surname: 'Doe', email: ' Jane@Example.com ', phone: '',
      watch_link: 'https://webinars.webinargeek.com/watch/abc/',
      watched_live: false, watched_replay: false, unsubscribed: false,
      watch_duration: null, watch_duration_replay: null,
      broadcast: { id: 12, date: 1792080000, has_ended: false, ...broadcast },
      webinar: { id: 1, title: 'BigHammer Live' },
      ...overrides,
    },
  };
}

test('registration: registered tag, clears last webinar\'s tags, fills fields', () => {
  const u = mapSubscription(payload('webinar_subscribed'), TZ);
  assert.deepEqual(u.addTags, [TAGS.registered]);
  assert.deepEqual(u.removeTags, [TAGS.attended, TAGS.live, TAGS.replay, TAGS.noShow, TAGS.unsubscribed, TAGS.ctaClicked]);
  assert.equal(u.contact.email, 'jane@example.com');
  assert.equal(u.contact.phone, undefined);
  assert.equal(u.contact.customFields.watch_link_webinargeek, 'https://webinars.webinargeek.com/watch/abc/');
  // 1792080000 = 2026-10-15 16:00 UTC = 12:00 EDT — same output as index.html
  assert.equal(u.contact.customFields.readable_webinar_date, 'Thursday, October 15, 2026');
  assert.equal(spaces(u.contact.customFields.readable_webinar_time), '12:00 PM EDT');
  assert.equal(u.contact.customFields.webinar_broadcast_date, '2026-10-15 12:00:00');
  assert.equal(u.contact.customFields.minutes_viewing_time_webinargeek, undefined);
});

test('WebinarGeek fields: ids, booleans and moments in the stored formats', () => {
  const u = mapSubscription(payload('webinar_subscribed', {
    created_at: 1789575419, email_verified: true, email_verified_at: 1789575419,
    registration_source: 'api', time_zone: 'America/New_York', unsubscribed_at: null,
  }), TZ);
  const cf = u.contact.customFields;
  assert.equal(cf.broadcast_id_webinargeek, '12');
  assert.equal(cf.webinar_id_webinargeek, '1');
  assert.equal(cf.broadcast_date_webinargeek, '15-10-2026 12:00:00 -0400');
  assert.equal(cf.created_at_webinargeek, '16-09-2026 12:16:59 -0400');
  assert.equal(cf.email_verified_webinargeek, 'true');
  assert.equal(cf.watched_live_webinargeek, 'false');
  assert.equal(cf.unsubscribed_webinargeek, 'false');
  assert.equal(cf.registration_source_webinargeek, 'api');
  // Not ended yet → no-show flag not written; null values not written.
  assert.equal(cf.not_watched_live_webinargeek, undefined);
  assert.equal(cf.unsubscribed_at_webinargeek, '');
});

// The UK landing page (22 Oct 2026, 11:00 BST) writes these fields in en-GB / Europe/London.
const UK_SESSIONS = { 77: { timezone: 'Europe/London', locale: 'en-GB' } };

test('UK session: its own timezone and locale, same tags as any other', () => {
  const u = mapSubscription(payload('webinar_subscribed', {}, { id: 77, date: 1792663200 }), TZ, UK_SESSIONS);
  const cf = u.contact.customFields;
  // 1792663200 = 2026-10-22 10:00 UTC = 11:00 BST — same output as the UK index.html
  assert.equal(cf.readable_webinar_date, 'Thursday 22 October 2026');
  assert.equal(spaces(cf.readable_webinar_time), '11:00 am BST');
  assert.equal(cf.webinar_broadcast_date, '2026-10-22 11:00:00');
  assert.equal(cf.broadcast_date_webinargeek, '22-10-2026 11:00:00 +0100');
  assert.deepEqual(u.addTags, [TAGS.registered]);
});

test('UK session settings do not touch other broadcasts', () => {
  const us = mapSubscription(payload('webinar_subscribed'), TZ, UK_SESSIONS);
  assert.equal(us.contact.customFields.readable_webinar_date, 'Thursday, October 15, 2026');
  assert.deepEqual(us.addTags, [TAGS.registered]);
});

test('BROADCAST_SESSIONS: object, JSON string, or unreadable', () => {
  assert.deepEqual(broadcastSessions({ BROADCAST_SESSIONS: UK_SESSIONS }), UK_SESSIONS);
  assert.deepEqual(broadcastSessions({ BROADCAST_SESSIONS: JSON.stringify(UK_SESSIONS) }), UK_SESSIONS);
  assert.deepEqual(broadcastSessions({ BROADCAST_SESSIONS: '{oops' }), {});
  assert.deepEqual(broadcastSessions({}), {});
});

test('moments in winter use -0500', () => {
  const u = mapSubscription(payload('x', {}, { date: 1797872400 }), TZ); // 2026-12-21 17:00 UTC = 12:00 EST
  assert.equal(u.contact.customFields.broadcast_date_webinargeek, '21-12-2026 12:00:00 -0500');
});

test('no-show flag is written once the broadcast has ended', () => {
  assert.equal(mapSubscription(payload('no_show', {}, { has_ended: true }), TZ).contact.customFields.not_watched_live_webinargeek, 'true');
  assert.equal(mapSubscription(payload('x', { watched_live: true }, { has_ended: true }), TZ).contact.customFields.not_watched_live_webinargeek, 'false');
});

test('CTA click: tag, yes and the latest click time', () => {
  const u = mapSubscription(payload('webinar_call_to_action', {
    watched_live: true, watch_duration: 600,
    calls_to_action: [
      { title: 'Apply', type: 'url', created_at: 1792080600 },
      { title: 'Book', type: 'url', created_at: 1792081800 }, // 2026-10-15 12:30:00 EDT
    ],
  }, { has_ended: false }), TZ);
  assert.ok(u.addTags.includes(TAGS.ctaClicked));
  assert.equal(u.contact.customFields.cta_clicked, 'yes');
  assert.equal(u.contact.customFields.cta_clicked_time, '15-10-2026 12:30:00 -0400');
});

test('CTA click without the clicks list falls back to the webhook time', () => {
  const p = payload('new_call_to_action');
  p.timestamp = 1792081800123;
  const u = mapSubscription(p, TZ);
  assert.equal(u.contact.customFields.cta_clicked_time, '15-10-2026 12:30:00 -0400');
  assert.ok(u.addTags.includes(TAGS.ctaClicked));
});

test('no CTA click: CTA fields and tag left alone', () => {
  const u = mapSubscription(payload('webinar_watched', { calls_to_action: [] }), TZ);
  assert.equal(u.contact.customFields.cta_clicked, undefined);
  assert.ok(!u.addTags.includes(TAGS.ctaClicked));
});

test('live viewer: attended tag and minutes watched', () => {
  const u = mapSubscription(payload('new_live_viewer', { watched_live: true, watch_duration: 2710 }, { has_ended: true }), TZ);
  assert.deepEqual(u.addTags, [TAGS.registered, TAGS.attended, TAGS.live]);
  assert.deepEqual(u.removeTags, []);
  assert.equal(u.contact.customFields.minutes_viewing_time_webinargeek, '45');
});

test('no-show: broadcast ended and never watched live', () => {
  const u = mapSubscription(payload('no_show', {}, { has_ended: true }), TZ);
  assert.deepEqual(u.addTags, [TAGS.registered, TAGS.noShow]);
});

test('no-show who later watches the replay keeps both tags', () => {
  const u = mapSubscription(payload('new_replay_viewer', { watched_replay: true, watch_duration_replay: 600 }, { has_ended: true }), TZ);
  assert.deepEqual(u.addTags, [TAGS.registered, TAGS.attended, TAGS.replay, TAGS.noShow]);
  assert.equal(u.contact.customFields.minutes_viewing_time_replay_webinargeek, '10');
});

test('unsubscribe: swaps registered for unsubscribed', () => {
  const u = mapSubscription(payload('unsubscribed', { unsubscribed: true }), TZ);
  assert.deepEqual(u.addTags, [TAGS.unsubscribed]);
  assert.deepEqual(u.removeTags, [TAGS.registered]);
});

test('name: a surname held twice in WebinarGeek is written once', () => {
  const name = (firstname, surname) => {
    const c = mapSubscription(payload('x', { firstname, surname }), TZ).contact;
    return [c.firstName, c.lastName];
  };
  assert.deepEqual(name('Jane', 'Doe'), ['Jane', 'Doe']);
  assert.deepEqual(name('Jane', 'Doe Doe'), ['Jane', 'Doe']);
  assert.deepEqual(name('Jane', 'van Dyke Van Dyke'), ['Jane', 'van Dyke']);
  assert.deepEqual(name('Jane Doe', 'Doe'), ['Jane', 'Doe']);
  assert.deepEqual(name('Jane Doe', 'doe  Doe'), ['Jane', 'doe']);
  // Untouched: compound names, a first name equal to the surname, no surname.
  assert.deepEqual(name('Mary Ann', 'Doe Smith'), ['Mary Ann', 'Doe Smith']);
  assert.deepEqual(name('Doe', 'Doe'), ['Doe', 'Doe']);
  assert.deepEqual(name('Jane', ''), ['Jane', undefined]);
});

test('phone: only E.164 is passed through', () => {
  assert.equal(mapSubscription(payload('x', { phone: '+44 7700 900123' }), TZ).contact.phone, '+447700900123');
  assert.equal(mapSubscription(payload('x', { phone: '0044 7700 900123' }), TZ).contact.phone, '+447700900123');
  assert.equal(mapSubscription(payload('x', { phone: '07700900123' }), TZ).contact.phone, undefined);
});

test('ignores non-subscription payloads and missing email', () => {
  assert.equal(mapSubscription({ event: 'x', entity_type: 'Broadcast', entity: {} }, TZ), null);
  assert.equal(mapSubscription(payload('webinar_subscribed', { email: '' }), TZ), null);
});

// End-to-end through the handler with GHL's API mocked.
async function signedRequest(body, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://w.example/webinargeek/ghl', {
    method: 'POST', body, headers: { 'Content-Type': 'application/json', Signature: 'sha256=' + hex },
  });
}

test('handler: upserts contact, then removes and adds tags', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
    if (String(url).includes('/customFields')) {
      return Response.json({ customFields: [{ id: 'cf1', fieldKey: 'contact.watch_link_webinargeek' }] });
    }
    if (String(url).endsWith('/contacts/upsert')) return Response.json({ contact: { id: 'c123' } });
    return Response.json({});
  };
  try {
    const env = { WEBINARGEEK_WEBHOOK_SECRET: 's3cret', GHL_PRIVATE_TOKEN: 'pit-x', GHL_LOCATION_ID: 'loc1' };
    const res = await handleWebinarGeekToGhl(await signedRequest(JSON.stringify(payload('webinar_subscribed')), 's3cret'), env);
    assert.equal(res.status, 200);

    const upsert = calls.find(c => c.url.endsWith('/contacts/upsert'));
    assert.equal(upsert.body.locationId, 'loc1');
    // Only fields that exist in GHL are sent.
    assert.deepEqual(upsert.body.customFields, [{ id: 'cf1', field_value: 'https://webinars.webinargeek.com/watch/abc/' }]);

    const tagCalls = calls.filter(c => c.url.endsWith('/contacts/c123/tags'));
    assert.deepEqual(tagCalls.map(c => c.method), ['DELETE', 'POST']);
    assert.deepEqual(tagCalls[1].body, { tags: [TAGS.registered] });

    const bad = await handleWebinarGeekToGhl(await signedRequest('{}', 'wrong'), env);
    assert.equal(bad.status, 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});
