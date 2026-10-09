# BigHammer Databricks Masterclass: UK session (22 October 2026)

Copy of the US landing page and thank-you page, adapted per the "UK Webinar 22 Oct 2026 - Task Plan".
Files: `index.html`, `thank-you.html`, `og-image.png`, `wrangler.jsonc`, `.assetsignore`.

## Session
Thursday 22 October 2026, 11:00 AM BST (10:00 UTC, 6:00 AM New York, 3:30 PM India). 60 minutes: 45 presentation + 15 live Q&A.

## Needed before going live (search `index.html` / `thank-you.html`)
1. `BROADCAST_ID` in `index.html` is the UK WebinarGeek broadcast, `6942090`. There is no "upcoming broadcast" lookup on this page. The same ID is in `workers/automations/wrangler.jsonc` (`BROADCAST_SESSIONS`); redeploy the Worker so it takes effect.
2. `LIVE_HOSTS` is `uk.webinar.bighammerai.com`. Change if a different hostname is chosen (also update og/canonical/JSON-LD URLs). On any other host sign-ups are simulated.
3. Tracking IDs (inert until set and the visitor accepts the cookie banner): `GA4_ID`, `LINKEDIN_PARTNER_ID`, `METRICOOL_TRACKER` in both files. GA4 conversion fires on `thank-you.html` (`generate_lead`).
4. `WHATSAPP_NUMBER` in `thank-you.html` is still the US number. Confirm it can message UK numbers.
5. Privacy/Terms links point at bighammer.ai/privacy-policy/ and /terms/. Legal to confirm wording and sender identity.
6. GHL: nothing new to set up. The form id stays `registrationForm` and the form sends the same fields as the US page, so the existing workflows run as usual. No UK-specific tags or fields are added; filter UK registrants by webinar date. The n8n payload is the US one plus UTM fields.
7. UTM: `calendar-uk`, `email-uk`, `linkedin-uk`, `newsletter-uk`, `social-uk` as `utm_source`; default `utm_campaign` is `web4-uk-22oct`.

## Integrations (same as the US page)
On submit, on `LIVE_HOSTS` only: n8n webhook, WebinarGeek registration through `broadcast.growthclub.org`, then one GoHighLevel external-tracking form submit (form id `registrationForm`, same tracking id as the US page) that carries name, phone, `readable_webinar_date`, `readable_webinar_time` and `watch_link_webinargeek`, and drives the WhatsApp workflow. `thank-you.html` shows the join link, the WhatsApp link and calendar files.

`workers/automations/` is the shared Cloudflare Worker (`bighammer-automations`) that turns WebinarGeek webhooks into GHL fields and tags, plus the beehiiv nurture routes. It is one deployed Worker for every landing page; this copy adds `BROADCAST_SESSIONS` so UK registrants keep UK date and time. Deploy it from here (`npm install && npm run deploy`); secrets are already on the deployed Worker and `.dev.vars` is not in this repo. It is not part of the static site (`.assetsignore`).

## Changes vs the US page
Date/time/duration everywhere (meta, JSON-LD, hero, agenda, marquee, countdown, calendar files), US-session banner, UK default phone country, WhatsApp opt-out text, privacy notice, consent banner, hardcoded broadcast and expired-session guard, UK spelling. No gift-card offer, "up to 75%" wording only.
