/* Automation Worker.

   Every automation is one or more routes. To add the next one, write a handler
   in src/automations/ and register it here. Handlers receive (request, env, ctx)
   and return a Response. */

import { handleWebinarGeekToGhl } from './automations/webinargeek-to-ghl.js';
import {
  handleNurtureEnrol, handleNurtureBooked, handleNurtureStep, handleNurtureStatus, runNurtureSync,
} from './automations/beehiiv-nurture.js';
import { json } from './lib/http.js';

const ROUTES = {
  'POST /webinargeek/ghl': handleWebinarGeekToGhl,
  'POST /ghl/nurture/enrol': handleNurtureEnrol,
  'POST /ghl/nurture/booked': handleNurtureBooked,
  'POST /beehiiv/nurture/step': handleNurtureStep,
  'POST /beehiiv/nurture/status': handleNurtureStatus,
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const key = request.method + ' ' + pathname.replace(/\/+$/, '');

    if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      return json({ ok: true, routes: Object.keys(ROUTES) });
    }

    const handler = ROUTES[key];
    if (!handler) return json({ ok: false, error: 'Not found' }, 404);

    try {
      return await handler(request, env, ctx);
    } catch (err) {
      console.error(key, 'failed:', (err && err.stack) || err);
      return json({ ok: false, error: 'Internal error' }, 500);
    }
  },

  // Cron triggers are listed in wrangler.jsonc. The only one is the nightly nurture sync.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runNurtureSync(env));
  },
};
