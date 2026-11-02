// Carga datos de ejemplo para probar Tata de punta a punta: un hogar de demo (Elsa, en Alta Córdoba)
// con familia, remedios, un turno e intereses, y una cartelera de Encuentro en Córdoba.
// Se puede correr varias veces: no duplica nada.
//
//   npm run demo
//
// Usa la misma base que el servidor (DB_FILE o data/tata.db). Conviene correrlo con el servidor apagado.

import { openDb, q as makeQ, token } from '../server/db.js';

const DEMO_CODE = '123456';
const q = makeQ(openDb(process.env.DB_FILE || 'data/tata.db'));
const now = Date.now();
const hhmm = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const isoIn = days => { const d = new Date(now + days * 86_400_000); return d.toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Cordoba' }); };

// ---------- cartelera de Encuentro (días: 0 domingo ... 6 sábado) ----------
const ACTIVITIES = [
  { title: 'Taller de tejido', place: 'Centro vecinal Alta Córdoba', address: 'Av. Juan B. Justo 2000', barrio: 'Alta Córdoba', at: '17:00', days: '135', price: 'Gratis', phone: '351 555 0101', tags: 'tejido, manualidades' },
  { title: 'Tango para principiantes', place: 'Club Social Alta Córdoba', address: 'Jerónimo Luis de Cabrera 1200', barrio: 'Alta Córdoba', at: '18:30', days: '24', price: '$2000 la clase', phone: '351 555 0102', tags: 'tango, baile, música' },
  { title: 'Gimnasia suave para mayores', place: 'Plaza Rivadavia', address: 'Rivadavia y Fragueiro', barrio: 'Alta Córdoba', at: '09:30', days: '0123456', price: 'Gratis', phone: '', tags: 'gimnasia, salud, aire libre' },
  { title: 'Cocina de siempre: recetas de la abuela', place: 'Biblioteca Popular General Paz', address: '25 de Mayo 1500', barrio: 'General Paz', at: '16:00', days: '3', price: 'Gratis', phone: '351 555 0103', tags: 'recetas, cocina' },
  { title: 'Ver el partido de Talleres en el club', place: 'Club Atlético Talleres (sede social)', address: 'Jerónimo Luis de Cabrera 801', barrio: 'Alta Córdoba', at: '20:00', days: '', date: isoIn(1), price: 'Gratis para socios', phone: '', tags: 'Talleres, fútbol' },
  { title: 'Taller de memoria', place: 'Centro de Jubilados Barrio Jardín', address: 'Av. Richieri 3200', barrio: 'Jardín', at: '10:00', days: '25', price: 'Gratis', phone: '351 555 0104', tags: 'memoria, salud' },
  { title: 'Coro de la ciudad para mayores', place: 'Cabildo de Córdoba', address: 'Independencia 30', barrio: 'Centro', at: '15:00', days: '6', price: 'Gratis', phone: '', tags: 'música, canto' }
];
let added = 0;
for (const a of ACTIVITIES) {
  if (q.get('SELECT 1 FROM activities WHERE title = ? AND place = ?', a.title, a.place)) continue;
  q.run(`INSERT INTO activities (title, place, address, city, barrio, at, days, date, price, phone, tags, note, created_at)
    VALUES (?, ?, ?, 'Córdoba', ?, ?, ?, ?, ?, ?, ?, '', ?)`,
    a.title, a.place, a.address, a.barrio, hhmm(a.at), a.days, a.date || null, a.price, a.phone, a.tags, now);
  added++;
}

// ---------- hogar de demo ----------
let hh = q.get("SELECT * FROM households WHERE elder_name = 'Elsa (demo)'");
if (!hh) {
  const code = q.get('SELECT 1 FROM households WHERE device_code = ?', DEMO_CODE) ? String(100000 + Math.floor(Math.random() * 900000)) : DEMO_CODE;
  q.run(`INSERT INTO households (elder_name, timezone, device_code, city, barrio, created_at)
    VALUES ('Elsa (demo)', 'America/Argentina/Cordoba', ?, 'Córdoba', 'Alta Córdoba', ?)`, code, now);
  hh = q.get("SELECT * FROM households WHERE elder_name = 'Elsa (demo)'");
  const laura = Number(q.run(`INSERT INTO members (household_id, name, relation, phone, token, is_admin, created_at)
    VALUES (?, 'Laura', 'hija', '+54 9 351 555 1234', ?, 1, ?)`, hh.id, token(), now).lastInsertRowid);
  q.run("INSERT INTO contacts (household_id, name, relation, phone, member_id) VALUES (?, 'Laura', 'hija', '+54 9 351 555 1234', ?)", hh.id, laura);
  q.run("INSERT INTO contacts (household_id, name, relation, phone) VALUES (?, 'Marta', 'vecina', '351 555 0000')", hh.id);
  q.run("INSERT INTO reminders (household_id, label, say, at, is_med) VALUES (?, 'Pastilla de la presión', 'la pastilla de la presión', ?, 1)", hh.id, hhmm('09:00'));
  q.run("INSERT INTO reminders (household_id, label, say, at, is_med) VALUES (?, 'Vitamina D', 'la vitamina D, con el almuerzo', ?, 1)", hh.id, hhmm('13:00'));
  q.run("INSERT INTO appointments (household_id, date, at, what, note) VALUES (?, ?, ?, 'la cardióloga', 'Llevar los estudios')", hh.id, isoIn(2), hhmm('10:30'));
  for (const i of ['tejido', 'tango', 'Talleres', 'recetas']) q.run('INSERT INTO interests (household_id, text) VALUES (?, ?)', hh.id, i);
}
const admin = q.get('SELECT token FROM members WHERE household_id = ? AND is_admin = 1 ORDER BY id LIMIT 1', hh.id);
const port = process.env.PORT || 3000;

console.log(`
Datos de ejemplo listos (${added} actividades nuevas en la cartelera).

  App de la familia (Laura):  http://localhost:${port}/familia/#t=${admin.token}
  Casa de Elsa (tablet):      http://localhost:${port}/casa/   código ${hh.device_code}${hh.device_token ? '  (ya hay una tablet vinculada)' : ''}
  Panel de Órbita:            http://localhost:${port}/orbita/  con la clave de ORBITA_KEY del .env
`);
