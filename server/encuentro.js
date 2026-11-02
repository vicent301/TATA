// Encuentro: la cartelera de actividades que arma Órbita. Tata le sugiere a ella la que mejor le queda
// (misma ciudad, primero su barrio, después sus intereses, después la más próxima) y, si le interesa,
// la familia se entera. Nunca insiste con una que ya rechazó.

import { norm } from './brain.js';
import { addDays, weekdayOf, relativeDay, fmtMin } from './time.js';

const occursOn = (a, date) => (a.date ? a.date === date : a.days.includes(String(weekdayOf(date))));
const words = s => norm(s).split(/[^a-z0-9ñ]+/).filter(w => w.length > 2);

function candidates(core, hh, days) {
  const city = norm(hh.city).trim();
  if (!city) return [];
  const now = core.now(hh);
  const said = new Set(core.q.all("SELECT activity_id, date FROM activity_answers WHERE household_id = ? AND answer = 'no'", hh.id)
    .map(r => r.activity_id + '|' + r.date));
  const acts = core.q.all('SELECT * FROM activities WHERE active = 1').filter(a => norm(a.city).trim() === city);
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(now.date, i);
    for (const a of acts) {
      if (!occursOn(a, date) || (i === 0 && a.at <= now.min) || said.has(a.id + '|' + date)) continue;
      out.push({ a, date });
    }
  }
  return out;
}

const mine = (hh, a) => !!norm(hh.barrio).trim() && norm(a.barrio).trim() === norm(hh.barrio).trim();
const when = (x, y) => x.date.localeCompare(y.date) || x.a.at - y.a.at;

/** La mejor actividad para sugerirle hoy (más tarde) o mañana, o null. */
export function pickActivity(core, hh) {
  const likes = core.q.all('SELECT text FROM interests WHERE household_id = ?', hh.id).flatMap(i => words(i.text));
  const score = a => words(a.tags + ' ' + a.title).filter(w => likes.includes(w)).length;
  const list = candidates(core, hh, 2);
  list.sort((x, y) => mine(hh, y.a) - mine(hh, x.a) || score(y.a) - score(x.a) || when(x, y));
  return list[0] || null;
}

/** Lo que hay en los próximos `days` días en su ciudad, primero su barrio. Para la app de la familia. */
export function upcoming(core, hh, days = 7) {
  return candidates(core, hh, days).sort((x, y) => mine(hh, y.a) - mine(hh, x.a) || when(x, y));
}

const hourText = m => 'las ' + Math.floor(m / 60) + (m % 60 ? ' y ' + (m % 60) : '');
const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);

export function offerText(hh, a, date, today) {
  return `${cap1(relativeDay(date, today))} a ${hourText(a.at)} hay ${a.title} en ${a.place}. ¿Te interesa?`;
}

export function detailsText(a, date, today) {
  return [`Es en ${a.place}${a.address ? ', ' + a.address : ''}, ${relativeDay(date, today)} a ${hourText(a.at)}.`,
    a.price ? `${a.price}.` : '', a.phone ? `Para consultar: ${a.phone}.` : ''].filter(Boolean).join(' ');
}

/** Guarda lo que contestó. Si le interesa, la familia recibe un aviso con los datos. */
export function answer(core, hh, activityId, date, ans) {
  const a = core.q.get('SELECT * FROM activities WHERE id = ?', activityId);
  if (!a) return;
  core.q.run(`INSERT INTO activity_answers (household_id, activity_id, date, answer, ts) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(household_id, activity_id, date) DO UPDATE SET answer = excluded.answer, ts = excluded.ts`, hh.id, a.id, date, ans, core.ts());
  if (ans !== 'si') return;
  core.activity(hh, `Le interesó ${a.title}`);
  const body = [`${a.title} · ${relativeDay(date, core.now(hh).date)} ${fmtMin(a.at)}`, a.place + (a.address ? ', ' + a.address : ''),
    a.price, a.phone ? 'Tel ' + a.phone : ''].filter(Boolean).join(' · ');
  core.notify(hh, 'info', `A ${hh.elder_name} le interesó una actividad`, body, null, { push: true });
}
