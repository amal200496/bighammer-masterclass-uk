/* Minimal beehiiv API v2 client. The API key needs read/write on
   subscriptions and automations (Settings → API in beehiiv). */

const BASE = 'https://api.beehiiv.com/v2';

export class BeehiivClient {
  constructor(apiKey, publicationId) {
    if (!apiKey) throw new Error('BEEHIIV_API_KEY is not set');
    if (!publicationId || publicationId === 'REPLACE_ME') throw new Error('BEEHIIV_PUBLICATION_ID is not set');
    this.apiKey = apiKey;
    this.base = `${BASE}/publications/${publicationId}`;
  }

  // Returns the parsed body, or null on a 404 when allowNotFound is set.
  async request(method, path, body, { allowNotFound = false } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + this.apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 404 && allowNotFound) return null;
    if (!res.ok) {
      throw new Error(`beehiiv ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  // The subscription, or null if this email has never subscribed.
  async findByEmail(email) {
    const res = await this.request(
      'GET', `/subscriptions/by_email/${encodeURIComponent(email)}`, undefined, { allowNotFound: true }
    );
    return res && res.data;
  }

  async createSubscription(body) {
    return (await this.request('POST', '/subscriptions', body)).data;
  }

  // Custom fields must already exist in beehiiv: unknown names are dropped without an error.
  async setCustomFields(subscriptionId, fields) {
    const custom_fields = Object.entries(fields).map(([name, value]) => ({ name, value }));
    return (await this.request('PATCH', `/subscriptions/${subscriptionId}`, { custom_fields })).data;
  }

  // Only works for an existing subscriber, and only if the automation has an active "Add by API" trigger.
  enrol(automationId, subscriptionId) {
    return this.request('POST', `/automations/${automationId}/journeys`, {
      subscription_id: subscriptionId,
      double_opt_override: 'off',
    });
  }

  // One subscriber's run through an automation ({ id, automation_id, subscription_id, email, status }), or null.
  async findJourney(automationId, journeyId) {
    const res = await this.request(
      'GET', `/automations/${automationId}/journeys/${encodeURIComponent(journeyId)}`, undefined, { allowNotFound: true }
    );
    return res && res.data;
  }

  // Yields every subscription with its stats and custom fields, 100 per request.
  async *subscriptions() {
    let cursor;
    do {
      const query = 'limit=100&expand[]=stats&expand[]=custom_fields' +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const page = await this.request('GET', '/subscriptions?' + query);
      yield* page.data || [];
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
  }
}

// Custom fields arrive as [{ name, kind, value }]; this flattens them to { name: value }.
export function customFieldMap(subscription) {
  const map = {};
  for (const f of (subscription && subscription.custom_fields) || []) map[f.name] = f.value;
  return map;
}
