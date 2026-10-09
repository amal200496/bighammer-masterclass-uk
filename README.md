# BigHammer Databricks Masterclass: UK session (22 October 2026)

Copy of the US landing page and thank-you page, adapted per the "UK Webinar 22 Oct 2026 - Task Plan".
Files: `index.html`, `thank-you.html`, `og-image.png`, `wrangler.jsonc`, `.assetsignore`.

## Session
Thursday 22 October 2026, 11:00 AM BST (10:00 UTC, 6:00 AM New York, 3:30 PM India). 60 minutes: 45 presentation + 15 live Q&A.

## Needed before going live (search `index.html` / `thank-you.html`)
1. `BROADCAST_ID` in `index.html` is empty on purpose. Paste the UK WebinarGeek broadcast ID. While it is empty (or equals the US ID 6841508) live sign-ups are blocked. There is no "upcoming broadcast" lookup on this page.
2. `LIVE_HOSTS` is `uk.webinar.bighammerai.com`. Change if a different hostname is chosen (also update og/canonical/JSON-LD URLs). On any other host sign-ups are simulated.
3. Tracking IDs (inert until set and the visitor accepts the cookie banner): `GA4_ID`, `LINKEDIN_PARTNER_ID`, `METRICOOL_TRACKER` in both files. GA4 conversion fires on `thank-you.html` (`generate_lead`).
4. `WHATSAPP_NUMBER` in `thank-you.html` is still the US number. Confirm it can message UK numbers.
5. Privacy/Terms links point at bighammer.ai/privacy-policy/ and /terms/. Legal to confirm wording and sender identity.
6. GHL: add custom field `region` and workflow for tags `uk-route`, `web4-uk-22oct`. The page sends `region`, `campaign`, `tags` to n8n and a hidden `region` field to the form. Form id stays `registrationForm`.
7. UTM: `calendar-uk`, `email-uk`, `linkedin-uk`, `newsletter-uk`, `social-uk` as `utm_source`; default `utm_campaign` is `web4-uk-22oct`.

## Changes vs the US page
Date/time/duration everywhere (meta, JSON-LD, hero, agenda, marquee, countdown, calendar files), US-session banner, UK default phone country, WhatsApp opt-out text, privacy notice, consent banner, hardcoded broadcast and expired-session guard, UK spelling. No gift-card offer, "up to 75%" wording only.
