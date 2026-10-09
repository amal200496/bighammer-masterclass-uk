/* Same output as formatWebinarDate / formatWebinarTime in index.html, so a
   contact looks identical in GHL whether it arrived through the landing page
   or through WebinarGeek. Keep the two in step. */

const LOCALE = 'en-US';

// "Thursday, October 15, 2026"; with locale en-GB, "Thursday 22 October 2026"
export function formatWebinarDate(unixSeconds, tz, locale = LOCALE) {
  if (!unixSeconds) return '';
  const text = new Date(unixSeconds * 1000).toLocaleDateString(locale, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz,
  });
  // en-GB has a comma after the weekday on some ICU versions and not on others.
  return locale === LOCALE ? text : text.replace(/,/g, '');
}

// "12:00 PM EDT"; with locale en-GB, "11:00 am BST"
export function formatWebinarTime(unixSeconds, tz, locale = LOCALE) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const clock = d.toLocaleTimeString(locale, {
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  });
  const parts = new Intl.DateTimeFormat(locale, { timeZoneName: 'short', timeZone: tz }).formatToParts(d);
  const zone = (parts.find(part => part.type === 'timeZoneName') || {}).value || '';
  return (clock + ' ' + zone).trim();
}

/* "15-10-2026 12:00:00 -0400" — the format of the *_webinargeek fields
   (broadcast_date, email_verified_at, ...). */
export function formatTimestamp(unixSeconds, tz) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const p = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZone: tz, timeZoneName: 'longOffset',
  }).formatToParts(d).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  // "GMT-04:00" → "-0400"; plain "GMT" → "+0000"
  const m = /([+-])(\d{2}):?(\d{2})/.exec(p.timeZoneName || '');
  const offset = m ? m[1] + m[2] + m[3] : '+0000';
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second} ${offset}`;
}

// "2026-10-15 12:00:00". The landing page does not send this one.
export function formatWebinarBroadcastDate(unixSeconds, tz) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const p = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZone: tz,
  }).formatToParts(d).reduce((acc, part) => { acc[part.type] = part.value; return acc; }, {});
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
}
