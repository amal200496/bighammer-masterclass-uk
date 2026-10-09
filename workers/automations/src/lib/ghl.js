/* Minimal GoHighLevel API v2 client, authenticated with a Private Integration
   token (Settings → Private Integrations). Scopes needed:
   contacts.write, contacts.readonly, locations/customFields.readonly. */

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

export class GhlClient {
  constructor(token, locationId) {
    if (!token) throw new Error('GHL_PRIVATE_TOKEN is not set');
    if (!locationId || locationId === 'REPLACE_ME') throw new Error('GHL_LOCATION_ID is not set');
    this.token = token;
    this.locationId = locationId;
  }

  async request(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + this.token,
        Version: VERSION,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GHL ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  /* Maps unique field keys (e.g. "watch_link_webinargeek") to GHL field ids.
     Cached per isolate: custom fields rarely change, and a new one is picked up
     the next time the isolate recycles (minutes, not days). */
  async customFieldIds() {
    if (!this.constructor.fieldCache) {
      const data = await this.request('GET', `/locations/${this.locationId}/customFields?model=contact`);
      const map = {};
      for (const f of data.customFields || []) {
        map[String(f.fieldKey || '').replace(/^contact\./, '')] = f.id;
      }
      this.constructor.fieldCache = map;
    }
    return this.constructor.fieldCache;
  }

  // Turns { field_key: value } into GHL's [{ id, field_value }], leaving out empty values and unknown fields.
  async fieldValues(customFields) {
    const ids = await this.customFieldIds();
    const fields = [];
    for (const [key, value] of Object.entries(customFields)) {
      if (value === undefined || value === null || value === '') continue;
      if (!ids[key]) {
        console.warn(`GHL custom field "${key}" does not exist in this location — skipped`);
        continue;
      }
      fields.push({ id: ids[key], field_value: value });
    }
    return fields;
  }

  /* Creates or updates by email/phone, following the location's duplicate
     settings. Fields left out are not touched, so the landing page's values
     (e.g. phone) survive. Returns the contact as GHL stores it. */
  async upsert({ customFields = {}, ...contact }) {
    const data = await this.request('POST', '/contacts/upsert', {
      locationId: this.locationId,
      ...contact,
      customFields: await this.fieldValues(customFields),
    });
    return data.contact;
  }

  // As upsert, but returns only the contact id.
  async upsertContact(contact) {
    const saved = await this.upsert(contact);
    return saved && saved.id;
  }

  // The contact with this email, or null. Unlike upsert, never creates one.
  async findByEmail(email) {
    const data = await this.request(
      'GET', `/contacts/search/duplicate?locationId=${this.locationId}&email=${encodeURIComponent(email)}`
    );
    return data.contact || null;
  }

  // Updates a contact we already hold the id for. Never creates one.
  async updateContact(contactId, { customFields = {}, ...contact }) {
    return this.request('PUT', `/contacts/${contactId}`, {
      ...contact,
      customFields: await this.fieldValues(customFields),
    });
  }

  // Tags go through their own endpoints: tags sent on upsert replace the contact's existing tags.
  addTags(contactId, tags) {
    if (!tags.length) return;
    return this.request('POST', `/contacts/${contactId}/tags`, { tags });
  }

  removeTags(contactId, tags) {
    if (!tags.length) return;
    return this.request('DELETE', `/contacts/${contactId}/tags`, { tags });
  }
}
