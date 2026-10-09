import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySvixSignature } from '../src/lib/svix.js';
import {
  TAGS, mapStep, mapStatusEvent, engagementTier, engagementFields,
  handleNurtureEnrol, handleNurtureBooked, handleNurtureStep, handleNurtureStatus, runNurtureSync,
} from '../src/automations/beehiiv-nurture.js';

const ENV = {
  GHL_PRIVATE_TOKEN: 'pit-x', GHL_LOCATION_ID: 'loc1',
  BEEHIIV_API_KEY: 'bh-x', BEEHIIV_PUBLICATION_ID: 'pub_1', BEEHIIV_AUTOMATION_ID: 'aut_1',
  BEEHIIV_WEBHOOK_SECRET: 'whsec_' + btoa('0123456789abcdef0123456789abcdef'),
  NURTURE_WEBHOOK_KEY: 'k3y',
};

const FIELD_KEYS = [
  'nurture_status', 'nurture_step', 'nurture_last_email', 'nurture_last_sent_at', 'beehiiv_subscription_id',
  'bh_emails_received', 'bh_open_rate', 'bh_click_rate', 'bh_engagement_tier', 'booked_call',
];

/* Mocks both APIs. `routes` maps "METHOD url-fragment" to a response body, a
   status number, or a function returning either. GHL custom field ids are the
   field key prefixed with "id_". */
async function withApis(routes, run) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body && JSON.parse(init.body) };
    calls.push(call);
    if (call.url.includes('/customFields')) {
      return Response.json({ customFields: FIELD_KEYS.map(k => ({ id: 'id_' + k, fieldKey: 'contact.' + k })) });
    }
    for (const [key, reply] of Object.entries(routes)) {
      const [method, fragment] = key.split(' ');
      if (method !== call.method || !call.url.includes(fragment)) continue;
      const value = typeof reply === 'function' ? reply(call.body) : reply;
      return typeof value === 'number' ? new Response('{}', { status: value }) : Response.json(value);
    }
    return Response.json({});
  };
  try {
    await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const post = (path, body, headers = {}) => new Request('https://w.example' + path, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', ...headers },
});

// { field_key: value } as sent to GHL in a call.
const sentFields = call => Object.fromEntries(call.body.customFields.map(f => [f.id.replace(/^id_/, ''), f.field_value]));
const find = (calls, method, fragment) => calls.find(c => c.method === method && c.url.includes(fragment));

const GHL_CONTACT = {
  contact_id: 'c1', email: ' Jane@Example.com ', first_name: 'Jane', last_name: 'Doe',
  company_name: 'Acme', tags: 'webinar registrant', customData: { webinar_date: '2026-10-15' },
};

test('routes reject a missing or wrong key', async () => {
  for (const handler of [handleNurtureEnrol, handleNurtureBooked]) {
    assert.equal((await handler(post('/x', GHL_CONTACT), ENV)).status, 401);
    assert.equal((await handler(post('/x?key=nope', GHL_CONTACT), ENV)).status, 401);
  }
});

test('enrol: new subscriber is created with the automation and custom fields', async () => {
  await withApis({
    'GET /subscriptions/by_email/': 404,
    'POST /subscriptions': { data: { id: 'sub_1', status: 'active' } },
  }, async calls => {
    const res = await handleNurtureEnrol(post('/ghl/nurture/enrol?key=k3y', GHL_CONTACT), ENV);
    assert.equal(res.status, 200);

    const create = find(calls, 'POST', '/publications/pub_1/subscriptions');
    assert.equal(create.body.email, 'jane@example.com');
    assert.deepEqual(create.body.automation_ids, ['aut_1']);
    assert.equal(create.body.double_opt_override, 'off');
    assert.equal(create.body.send_welcome_email, false);
    assert.deepEqual(create.body.custom_fields, [
      { name: 'First Name', value: 'Jane' }, { name: 'Last Name', value: 'Doe' },
      { name: 'company', value: 'Acme' }, { name: 'ghl_contact_id', value: 'c1' },
      { name: 'webinar_date', value: '2026-10-15' }, { name: 'booked_call', value: 'false' },
    ]);

    assert.deepEqual(sentFields(find(calls, 'PUT', '/contacts/c1')), {
      nurture_status: 'enrolled', beehiiv_subscription_id: 'sub_1',
    });
    assert.deepEqual(find(calls, 'POST', '/contacts/c1/tags').body, { tags: [TAGS.enrolled] });
  });
});

test('enrol: existing subscriber is updated and added to the automation', async () => {
  await withApis({
    'GET /subscriptions/by_email/': { data: { id: 'sub_9', status: 'active' } },
  }, async calls => {
    const res = await handleNurtureEnrol(post('/ghl/nurture/enrol?key=k3y', GHL_CONTACT), ENV);
    assert.equal(res.status, 200);
    assert.equal(calls.some(c => c.method === 'POST' && c.url.endsWith('/subscriptions')), false);
    assert.ok(find(calls, 'PATCH', '/subscriptions/sub_9'));
    assert.deepEqual(find(calls, 'POST', '/automations/aut_1/journeys').body, {
      subscription_id: 'sub_9', double_opt_override: 'off',
    });
  });
});

test('enrol: someone who unsubscribed in beehiiv is not re-enrolled', async () => {
  await withApis({
    'GET /subscriptions/by_email/': { data: { id: 'sub_9', status: 'inactive' } },
  }, async calls => {
    const res = await handleNurtureEnrol(post('/ghl/nurture/enrol?key=k3y', GHL_CONTACT), ENV);
    assert.equal((await res.json()).ignored, 'unsubscribed in beehiiv');
    assert.equal(calls.some(c => c.url.includes('/journeys') || c.method === 'PATCH'), false);
    assert.equal(sentFields(find(calls, 'PUT', '/contacts/c1')).nurture_status, 'unsubscribed');
  });
});

test('enrol: a retried webhook for an enrolled contact does nothing', async () => {
  await withApis({}, async calls => {
    const body = { ...GHL_CONTACT, tags: 'webinar registrant, Nurture-Enrolled' };
    const res = await handleNurtureEnrol(post('/ghl/nurture/enrol?key=k3y', body), ENV);
    assert.equal((await res.json()).ignored, 'already enrolled');
    assert.equal(calls.length, 0);
  });
});

test('enrol: a beehiiv error is reported as 502 and GHL is left alone', async () => {
  await withApis({ 'GET /subscriptions/by_email/': 500 }, async calls => {
    const res = await handleNurtureEnrol(post('/ghl/nurture/enrol?key=k3y', GHL_CONTACT), ENV);
    assert.equal(res.status, 502);
    assert.equal(calls.some(c => c.url.includes('leadconnectorhq')), false);
  });
});

test('booked: sets booked_call in beehiiv and marks the GHL contact', async () => {
  await withApis({
    'GET /subscriptions/by_email/': { data: { id: 'sub_1', status: 'active' } },
  }, async calls => {
    const res = await handleNurtureBooked(post('/ghl/nurture/booked?key=k3y', GHL_CONTACT), ENV);
    assert.equal(res.status, 200);
    assert.deepEqual(find(calls, 'PATCH', '/subscriptions/sub_1').body, {
      custom_fields: [{ name: 'booked_call', value: 'true' }],
    });
    assert.deepEqual(sentFields(find(calls, 'PUT', '/contacts/c1')), { booked_call: 'true', nurture_status: 'booked' });
    assert.deepEqual(find(calls, 'POST', '/contacts/c1/tags').body, { tags: [TAGS.booked] });
  });
});

test('mapStep: reads the step from the URL and the email from the body', () => {
  const now = new Date('2026-10-18T09:00:00Z');
  const step = mapStep(new URLSearchParams('email_id=e04'), { data: { email: 'Jane@Example.com' } }, now);
  assert.equal(step.email, 'jane@example.com');
  assert.equal(step.tag, 'nurture-e04-sent');
  assert.deepEqual(step.customFields, {
    nurture_status: 'active', nurture_step: 4, nurture_last_email: 'e04', nurture_last_sent_at: '2026-10-18',
  });

  const done = mapStep(new URLSearchParams('event=complete'), { email: 'jane@example.com' }, now);
  assert.equal(done.tag, TAGS.completed);
  assert.deepEqual(done.customFields, { nurture_status: 'completed' });

  // The body beehiiv's "Send webhook" step actually posts.
  const real = { automation_id: 'aut_1', automation_journey_id: 'aj_1', subscriber_email: 'Jane@Example.com', subscriber_id: 'sub_1' };
  assert.equal(mapStep(new URLSearchParams('email_id=e02'), real, now).email, 'jane@example.com');

  // Email in the URL is the fallback when the body has none.
  assert.equal(mapStep(new URLSearchParams('email_id=e01&email=a@b.co'), {}, now).email, 'a@b.co');
  assert.equal(mapStep(new URLSearchParams('email_id=e1'), { email: 'a@b.co' }, now), null);
  assert.equal(mapStep(new URLSearchParams('email_id=e01'), {}, now), null);
});

test('step: updates the contact and tags it; a booked contact keeps its status', async () => {
  await withApis({
    'GET /contacts/search/duplicate': { contact: { id: 'c1', tags: [] } },
  }, async calls => {
    const res = await handleNurtureStep(post('/beehiiv/nurture/step?key=k3y&email_id=e02', { email: 'jane@example.com' }), ENV);
    assert.equal(res.status, 200);
    const fields = sentFields(find(calls, 'PUT', '/contacts/c1'));
    assert.equal(fields.nurture_status, 'active');
    assert.equal(fields.nurture_step, 2);
    assert.deepEqual(find(calls, 'POST', '/contacts/c1/tags').body, { tags: ['nurture-e02-sent'] });
  });

  await withApis({
    'GET /contacts/search/duplicate': { contact: { id: 'c1', tags: [TAGS.booked] } },
  }, async calls => {
    await handleNurtureStep(post('/beehiiv/nurture/step?key=k3y&email_id=e03', { email: 'jane@example.com' }), ENV);
    const fields = sentFields(find(calls, 'PUT', '/contacts/c1'));
    assert.equal(fields.nurture_status, undefined);
    assert.equal(fields.nurture_step, 3);
  });
});

test('step: without a key, the journey must exist in beehiiv and belong to that subscriber', async () => {
  const journeyId = 'aj_11111111-2222-3333-4444-555555555555';
  const body = { automation_journey_id: journeyId, subscriber_email: 'jane@example.com', subscriber_id: 'sub_1' };
  const routes = {
    'GET /automations/aut_1/journeys/': { data: { id: journeyId, automation_id: 'aut_1', subscription_id: 'sub_1', email: 'Jane@Example.com' } },
    'GET /contacts/search/duplicate': { contact: { id: 'c1', tags: [] } },
  };
  await withApis(routes, async calls => {
    const res = await handleNurtureStep(post('/beehiiv/nurture/step?email_id=e05', body), ENV);
    assert.equal(res.status, 200);
    assert.deepEqual(find(calls, 'POST', '/contacts/c1/tags').body, { tags: ['nurture-e05-sent'] });

    // A real journey id paired with someone else's email is rejected.
    const other = await handleNurtureStep(post('/beehiiv/nurture/step?email_id=e05', { ...body, subscriber_email: 'eve@example.com' }), ENV);
    assert.equal(other.status, 401);
  });
  await withApis({ 'GET /automations/aut_1/journeys/': 404 }, async calls => {
    const res = await handleNurtureStep(post('/beehiiv/nurture/step?email_id=e05', body), ENV);
    assert.equal(res.status, 401);
    assert.equal(calls.some(c => c.url.includes('leadconnectorhq')), false);
  });
});

test('step: a subscriber who is not in GHL is ignored, never created', async () => {
  await withApis({ 'GET /contacts/search/duplicate': { contact: null } }, async calls => {
    const res = await handleNurtureStep(post('/beehiiv/nurture/step?key=k3y&email_id=e02', { email: 'x@y.co' }), ENV);
    assert.equal((await res.json()).ignored, 'not in GHL');
    assert.equal(calls.some(c => c.method !== 'GET'), false);
  });
});

test('mapStatusEvent: unsubscribe sets status, tag and email DND', () => {
  const update = mapStatusEvent({ event_type: 'subscription.deleted', data: { id: 'sub_1', email: 'Jane@Example.com' } });
  assert.equal(update.email, 'jane@example.com');
  assert.deepEqual(update.contact.customFields, { beehiiv_subscription_id: 'sub_1', nurture_status: 'unsubscribed' });
  assert.equal(update.contact.dndSettings.Email.status, 'active');
  assert.deepEqual(update.addTags, [TAGS.unsubscribed]);

  assert.deepEqual(mapStatusEvent({ event_type: 'subscription.paused', data: { id: 's', email: 'a@b.co' } }).addTags, [TAGS.paused]);
  assert.deepEqual(mapStatusEvent({ event_type: 'subscription.resumed', data: { id: 's', email: 'a@b.co' } }).removeTags, [TAGS.paused]);
  assert.equal(mapStatusEvent({ event_type: 'post.sent', data: { id: 'post_1' } }), null);
  assert.equal(mapStatusEvent({ event_type: 'subscription.deleted', data: {} }), null);
});

async function svixHeaders(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const keyBytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`msg_1.${timestamp}.${body}`)));
  return {
    'svix-id': 'msg_1', 'svix-timestamp': String(timestamp),
    'svix-signature': 'v1,bm90LXRoZS1zaWduYXR1cmU= v1,' + btoa(String.fromCharCode(...mac)),
  };
}

// Test vector published in Svix's docs for manual verification.
test('svix: accepts the documented test vector', async () => {
  const headers = new Headers({
    'svix-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    'svix-timestamp': '1614265330',
    'svix-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  });
  const body = '{"test": 2432232314}';
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  assert.equal(await verifySvixSignature(body, headers, secret, 1614265330), true);
  // Outside the five-minute window the same request is a replay.
  assert.equal(await verifySvixSignature(body, headers, secret, 1614265330 + 301), false);
  assert.equal(await verifySvixSignature(body + ' ', headers, secret, 1614265330), false);
  assert.equal(await verifySvixSignature(body, headers, 'whsec_' + btoa('wrong'), 1614265330), false);
  assert.equal(await verifySvixSignature(body, new Headers(), secret, 1614265330), false);
});

test('status: a signed unsubscribe updates GHL; unsigned is rejected', async () => {
  const body = JSON.stringify({ event_type: 'subscription.deleted', data: { id: 'sub_1', email: 'jane@example.com' } });
  await withApis({
    'GET /contacts/search/duplicate': { contact: { id: 'c1', tags: [] } },
  }, async calls => {
    const headers = await svixHeaders(body, ENV.BEEHIIV_WEBHOOK_SECRET);
    const res = await handleNurtureStatus(post('/beehiiv/nurture/status', body, headers), ENV);
    assert.equal(res.status, 200);
    const put = find(calls, 'PUT', '/contacts/c1');
    assert.equal(sentFields(put).nurture_status, 'unsubscribed');
    assert.equal(put.body.dndSettings.Email.status, 'active');
    assert.deepEqual(find(calls, 'POST', '/contacts/c1/tags').body, { tags: [TAGS.unsubscribed] });

    const unsigned = await handleNurtureStatus(post('/beehiiv/nurture/status', body), ENV);
    assert.equal(unsigned.status, 401);
  });
});

test('engagement tier: a click outranks any open rate', () => {
  assert.equal(engagementTier(0, 10), 'hot');
  assert.equal(engagementTier(95, 9.9), 'warm');
  assert.equal(engagementTier(30, 0), 'warm');
  assert.equal(engagementTier(29.9, 0), 'cold');
  assert.deepEqual(engagementFields({ id: 'sub_1', stats: { emails_received: 0, open_rate: 0, click_through_rate: 0 } }), {
    beehiiv_subscription_id: 'sub_1', bh_emails_received: '0', bh_open_rate: '0', bh_click_rate: '0', bh_engagement_tier: 'cold',
  });
});

test('sync: pages through beehiiv, syncs only GHL-linked subscribers, and fails loudly', async () => {
  const sub = (id, contactId, clickRate) => ({
    id, stats: { emails_received: 5, open_rate: 60.1, click_through_rate: clickRate },
    custom_fields: contactId ? [{ name: 'ghl_contact_id', kind: 'string', value: contactId }] : [],
  });
  let page = 0;
  const pages = () => (page++ === 0
    ? { data: [sub('sub_1', 'c1', 20), sub('sub_2', null, 0)], has_more: true, next_cursor: 'abc' }
    : { data: [sub('sub_3', 'c3', 0)], has_more: false, next_cursor: null });

  await withApis({ 'GET /subscriptions?': pages }, async calls => {
    assert.deepEqual(await runNurtureSync(ENV), { seen: 3, synced: 2, failed: 0 });
    assert.ok(calls.some(c => c.url.includes('cursor=abc')));
    assert.deepEqual(sentFields(find(calls, 'PUT', '/contacts/c1')), {
      beehiiv_subscription_id: 'sub_1', bh_emails_received: '5', bh_open_rate: '60.1', bh_click_rate: '20', bh_engagement_tier: 'hot',
    });
    assert.equal(sentFields(find(calls, 'PUT', '/contacts/c3')).bh_engagement_tier, 'warm');
    assert.equal(calls.some(c => c.url.includes('/contacts/upsert')), false);
  });

  page = 0;
  await withApis({ 'GET /subscriptions?': pages, 'PUT /contacts/c3': 404 }, async () => {
    await assert.rejects(runNurtureSync(ENV), /1 of 2 contacts failed/);
  });
});
