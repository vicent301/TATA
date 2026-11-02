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

// Cartelera de ejemplo: cada vez que arranca Tata se arman 5 actividades nuevas por ciudad, para que siempre
// haya algo para sugerir aunque Órbita todavía no haya cargado nada. No son reales: no llevan dirección ni teléfono.
const IDEAS = [
  ['taller de tejido', 'el centro vecinal', 'tejido, manualidades, talleres'],
  ['milonga para mayores', 'el club del barrio', 'tango, baile, música'],
  ['caminata en grupo', 'la plaza principal', 'caminata, aire libre, salud'],
  ['clase de cocina casera', 'la biblioteca popular', 'cocina, recetas'],
  ['taller de memoria', 'el centro de jubilados', 'memoria, juegos, talleres'],
  ['coro de adultos mayores', 'la parroquia', 'música, canto, coro'],
  ['yoga suave', 'el polideportivo', 'yoga, salud, gimnasia'],
  ['tarde de cartas y mate', 'el centro de jubilados', 'juegos, cartas, charla'],
  ['taller de celular', 'la biblioteca popular', 'tecnología, celular, whatsapp, talleres'],
  ['huerta comunitaria', 'el centro vecinal', 'huerta, plantas, jardinería, aire libre'],
  ['cine debate', 'el centro cultural', 'cine, películas, charla'],
  ['gimnasia para mayores', 'el polideportivo', 'gimnasia, salud, ejercicio']
];
const HOURS = [570, 600, 660, 900, 960, 1020, 1080, 1110];

/** Borra las actividades de ejemplo y arma 5 nuevas para cada ciudad donde vive alguien. */
export function seedActivities(core, rand = Math.random) {
  core.q.run('DELETE FROM activities WHERE auto = 1');
  const homes = core.q.all("SELECT * FROM households WHERE TRIM(city) != ''");
  const done = new Set();
  for (const hh of homes) {
    if (done.has(norm(hh.city).trim())) continue;
    done.add(norm(hh.city).trim());
    seedCity(core, hh, rand);
  }
}

/** Si en su ciudad no hay actividades de ejemplo (recién cargó la ciudad), las arma. */
export function ensureActivities(core, hh, rand = Math.random) {
  const city = norm(hh.city).trim();
  if (!city) return;
  if (core.q.all('SELECT city FROM activities WHERE auto = 1').some(a => norm(a.city).trim() === city)) return;
  seedCity(core, hh, rand);
}

function seedCity(core, hh, rand) {
  const pick = list => list.splice(Math.floor(rand() * list.length), 1)[0];
  const ideas = [...IDEAS];
  const { wd } = core.now(hh);
  for (let i = 0; i < 5; i++) {
    const [title, place, tags] = pick(ideas);
    // Unos días al azar, pero siempre hoy y mañana: así hay algo para sugerir desde el primer momento.
    const days = new Set([wd, (wd + 1) % 7]);
    for (let d = 0; d < 7; d++) if (rand() < 0.4) days.add(d);
    core.q.run(`INSERT INTO activities (title, place, city, barrio, at, days, price, tags, note, auto, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, title, place, hh.city.trim(), i < 2 ? (hh.barrio || '').trim() : '',
      HOURS[Math.floor(rand() * HOURS.length)], [...days].sort().join(''), rand() < 0.6 ? 'Gratis' : '',
      tags, 'Actividad de ejemplo, armada sola por Tata', core.ts());
  }
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
