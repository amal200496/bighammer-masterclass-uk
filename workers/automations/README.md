# Automations Worker

A single Cloudflare Worker, in BigHammer's Cloudflare account, that hosts all our automations. Each automation is one
route, registered in [src/index.js](src/index.js).

| Route | Automation | Source |
|---|---|---|
| `POST /webinargeek/ghl` | WebinarGeek → GoHighLevel | [src/automations/webinargeek-to-ghl.js](src/automations/webinargeek-to-ghl.js) |
| `POST /ghl/nurture/enrol` | Nurture: GHL enrols a contact in beehiiv | [src/automations/beehiiv-nurture.js](src/automations/beehiiv-nurture.js) |
| `POST /ghl/nurture/booked` | Nurture: GHL tells beehiiv a call is booked | same file |
| `POST /beehiiv/nurture/step` | Nurture: beehiiv reports each email sent | same file |
| `POST /beehiiv/nurture/status` | Nurture: beehiiv reports unsubscribes and pauses | same file |
| cron `0 2 * * *` | Nurture: nightly engagement sync, beehiiv to GHL | same file |
| `GET /health` | Lists the routes | — |

---

## Automation 1 — WebinarGeek → GHL

WebinarGeek sends a webhook for each registration, viewer, no-show and
unsubscribe. The Worker checks the signature, upserts the contact in GHL
(matched on email), fills the webinar custom fields and sets **state tags**.
GHL workflows start on **Contact Tag added**, which is a free trigger. The
premium Inbound Webhook trigger isn't needed.

The Worker reads the state from the subscription data, not from the event
name. Any event brings GHL fully up to date, and a retried webhook produces
the same result.

### Tags

| Tag | Added when | Removed when |
|---|---|---|
| `webinar registrant` | Any event for an active registrant | They unsubscribe |
| `webinar attended` | They watched in any form, live or replay | They register for a new webinar |
| `live webinar watched` | They watched the live broadcast | They register for a new webinar |
| `watched webinar replay` | They watched the replay | They register for a new webinar |
| `live webinar not watched` | The broadcast has ended and they did not watch live | They register for a new webinar |
| `webinar unsubscribed` | They unsubscribe | They register for a new webinar |
| `clicked webinar CTA` | They click a call-to-action during the webinar | They register for a new webinar |

When someone registers again, the post-webinar tags are cleared. The next
webinar then adds them again, and their workflows fire again. GHL only fires
"tag added" when the tag was not already on the contact.

A no-show who later watches the replay gets `webinar attended` and
`watched webinar replay` while keeping `live webinar not watched`. Use that in the A4
follow-up to stop the no-show sequence.

### Sessions with their own landing page

`BROADCAST_SESSIONS` in `wrangler.jsonc` lists broadcasts that are not the
default US session, keyed by WebinarGeek broadcast id:

```jsonc
"BROADCAST_SESSIONS": {
  "6942090": { "timezone": "Europe/London", "locale": "en-GB" }
}
```

For a broadcast listed there the Worker writes `readable_webinar_date` and
`readable_webinar_time` in that timezone and locale (`Thursday 22 October 2026`,
`11:00 am BST`, the same as the UK `index.html`). Tags are the same as for any
other broadcast. Without the entry a UK
registrant's date and time are overwritten in US Eastern time (`6:00 AM EDT`)
as soon as WebinarGeek's registration webhook arrives.

### Custom fields written

Existing fields, which the landing page already fills:
`watch_link_webinargeek`, `readable_webinar_date`, `readable_webinar_time`.
They use the same format as `index.html` (America/New_York, en-US), for
example `Thursday, October 15, 2026` and `12:00 PM EDT`.
People who register directly on WebinarGeek get the same fields too.

Fields filled only by the Worker (Contact object, type **Text**):

| Field key | Holds |
|---|---|
| `webinar_title_webinargeek` | Webinar title |
| `webinar_broadcast_date` | Broadcast start, e.g. `2026-10-15 12:00:00` |
| `minutes_viewing_time_webinargeek` | Minutes watched live |
| `cta_clicked` | `yes` once they click a call-to-action |
| `cta_clicked_time` | Time of their latest click, e.g. `15-10-2026 12:30:00 -0400` |
| `minutes_viewing_time_replay_webinargeek` | Minutes of the replay watched |

If a field is missing in GHL, the Worker skips it and logs a warning. It does
not fail. Phone numbers are only sent when they are valid E.164, because GHL
rejects the whole upsert on a bad number. The number that the landing page
captured is never overwritten or blanked.

---

## Automation 2: webinar nurture (beehiiv and GHL)

beehiiv sends the 24 nurture emails. GHL is the system of record. The Worker
sits between them, so GHL needs no premium Inbound Webhook trigger or Custom
Webhook action, and the beehiiv API key is never stored in GHL.

| Direction | What happens |
|---|---|
| GHL to Worker, `/ghl/nurture/enrol` | Subscribes the contact in beehiiv with the automation and custom fields. Sets `nurture_status=enrolled`, `beehiiv_subscription_id`, tag `nurture-enrolled`. An existing subscriber is added to the automation. Someone who unsubscribed in beehiiv is not re-enrolled. |
| beehiiv to Worker, `/beehiiv/nurture/step` | Sets `nurture_step`, `nurture_last_email`, `nurture_last_sent_at`, `nurture_status=active`, tag `nurture-eNN-sent`. With `event=complete`: status `completed`, tag `nurture-completed`. |
| beehiiv to Worker, `/beehiiv/nurture/status` | Unsubscribe: status `unsubscribed`, tag `nurture-unsubscribed`, email DND on. Pause and resume: tag `nurture-paused` added and removed. |
| GHL to Worker, `/ghl/nurture/booked` | Sets `booked_call=true` in beehiiv and GHL, status `booked`, tag `nurture-booked`. |
| Nightly cron | Copies each subscriber's `emails_received`, `open_rate` and `click_through_rate` to `bh_*` fields and sets `bh_engagement_tier` (hot: click rate 10 or more; warm: open rate 30 or more; cold otherwise). |

The step and status routes only update contacts that already exist in GHL.
Pipeline moves and sales notifications stay in GHL workflows, started by the
tags above.

### Setup

1. **Secrets and ids.** Put `BEEHIIV_PUBLICATION_ID` and `BEEHIIV_AUTOMATION_ID`
   in `wrangler.jsonc`. Then:
   ```sh
   npx wrangler secret put BEEHIIV_API_KEY
   npx wrangler secret put NURTURE_WEBHOOK_KEY      # our own long random string
   npx wrangler secret put BEEHIIV_WEBHOOK_SECRET   # whsec_..., from step 3
   ```
2. **Custom fields.** With the same values in `.dev.vars`:
   ```sh
   node --env-file=.dev.vars scripts/setup-nurture.mjs           # dry run
   node --env-file=.dev.vars scripts/setup-nurture.mjs --apply
   ```
   For this script the GHL token also needs `locations/customFields.write`.
3. **beehiiv publication webhook.** Re-run the script with
   `--worker-url=https://<worker-url> --apply`, or add the endpoint by hand in
   Settings → Webhooks, pointing at `/beehiiv/nurture/status`. Copy the
   endpoint's signing secret into `BEEHIIV_WEBHOOK_SECRET`.
4. **beehiiv automation.** After every Send email step add a **Send webhook**
   step: POST, JSON, to `https://<worker-url>/beehiiv/nurture/step?email_id=e01`
   (`e02` and so on). After the last one use `...step?event=complete`. No key
   goes in the URL: the Worker checks the journey id in the body against beehiiv.
5. **GHL workflows.** Use the standard **Webhook** action:
   - Enrol: `https://<worker-url>/ghl/nurture/enrol?key=<NURTURE_WEBHOOK_KEY>`,
     with a Custom Data row `webinar_date` = `2026-10-15`.
   - Call booked: `https://<worker-url>/ghl/nurture/booked?key=<NURTURE_WEBHOOK_KEY>`.

### Not yet checked against the live accounts

- The step route's journey check has only been tested against mocks. Confirm
  it with the first seed contact: a rejected call shows as a 401 in the logs.
- The nightly sync makes one GHL call per subscriber. The Workers free plan
  allows 50 outbound calls per run, so more than about 45 enrolled contacts
  needs the Workers Paid plan.
- "Replied" is not part of the hot tier yet, because beehiiv does not report
  replies.

---

## Setup

### 1. GHL: Private Integration token
Settings → **Private Integrations** → Create. Scopes:
`contacts.write`, `contacts.readonly`, `locations/customFields.readonly`.
Copy the token (`pit-...`). Also copy the **Location ID** (Settings → Business Profile).

### 2. Deploy the Worker
```sh
cd workers/automations
npm install
npx wrangler login          # log in to the BigHammer Cloudflare account
# put the account ID into wrangler.jsonc → account_id
# put the Location ID into wrangler.jsonc → vars.GHL_LOCATION_ID
npx wrangler secret put GHL_PRIVATE_TOKEN
npx wrangler secret put WEBINARGEEK_WEBHOOK_SECRET   # from step 3
npm run deploy
```
The deploy prints the URL, for example `https://bighammer-automations.<account>.workers.dev`.
To use a custom domain such as `automations.bighammer.ai`, add it under
Workers → Settings → Domains & Routes.

### 3. WebinarGeek: webhook
Settings → Integrations → **Webhooks** → New webhook:
- URL: `https://<worker-url>/webinargeek/ghl`
- Events: New registration, Unsubscribed, New viewer, New live viewer,
  New replay viewer, No show
- **Secret**: WebinarGeek doesn't generate one. Enter your own long random
  string here, and use the same value for `WEBINARGEEK_WEBHOOK_SECRET`.

### 4. GHL: workflows
Start each workflow with a **Contact Tag added** trigger that uses one of the
tags above. For example, `live webinar not watched` starts the replay-link sequence.

---

## Develop and test

```sh
npm test            # unit tests, no network
cp .dev.vars.example .dev.vars && npm run dev   # local server on :8787
npm run tail        # live logs from production
```

In production, every run logs a line to **Workers → Logs**, with the event, the
email, the GHL contact ID and the tags.

Response codes:
- `200`: synced, or ignored because the payload is not a subscription or has no email.
- `401`: bad signature.
- `502`: GHL rejected the call. The log has GHL's error text.

## Adding the next automation
1. Create `src/automations/<name>.js` and export a `(request, env, ctx) => Response` handler.
2. Register it in `ROUTES` in `src/index.js`.
3. Add any secrets with `wrangler secret put` and list them in `.dev.vars.example`.
