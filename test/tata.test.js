import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, q as makeQ } from '../server/db.js';
import { createCore } from '../server/core.js';
import { handle, sos } from '../server/brain.js';
import { tickHousehold } from '../server/scheduler.js';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Hogar de prueba en memoria, con un reloj que se puede mover a mano.
function setup(start = '2026-10-19T08:55:00-03:00') {
  const q = makeQ(openDb(':memory:'));
  let now = new Date(start);
  const pushed = [];
  const push = { toMember: async (id, p) => { pushed.push({ id, ...p }); } };
  const core = createCore({ q, push, clock: () => now });
  const hid = Number(q.run("INSERT INTO households (elder_name, device_code, device_token, created_at) VALUES ('Elsa', '111111', 'dev', 0)").lastInsertRowid);
  const laura = Number(q.run("INSERT INTO members (household_id, name, relation, token, is_admin, created_at) VALUES (?, 'Laura', 'hija', 'tok', 1, 0)", hid).lastInsertRowid);
  q.run("INSERT INTO contacts (household_id, name, relation, phone, member_id) VALUES (?, 'Laura', 'hija', '+543515551234', ?)", hid, laura);
  q.run("INSERT INTO contacts (household_id, name, relation, phone) VALUES (?, 'Marta', 'vecina', '3515550000')", hid);
  const said = [];
  // simula el dispositivo conectado
  core.attach(hid, { write: s => { const m = /^data: (.*)\n\n$/s.exec(s); if (m) { const j = JSON.parse(m[1]); if (j.type === 'say') said.push(...j.items); } } }, 'device');
  const hh = () => core.household(hid);
  const hear = async text => (await handle(core, hh(), text)).replies.map(r => r.text).join(' ');
  const events = () => q.all('SELECT kind, title FROM events WHERE household_id = ? ORDER BY id', hid);
  return { q, core, hid, laura, hh, hear, said, pushed, events, at: s => { now = new Date(s); }, tick: () => tickHousehold(core, hh()) };
}

test('recordatorio de pastilla: se dice, se confirma y la familia recibe el ✓', async () => {
  const t = setup();
  t.q.run("INSERT INTO reminders (household_id, label, say, at, is_med) VALUES (?, 'Pastilla de la presión', 'la pastilla de la presión', 540, 1)", t.hid);
  t.tick(); assert.equal(t.said.length, 0);
  t.at('2026-10-19T09:00:00-03:00'); t.tick();
  assert.match(t.said[0].text, /Elsa, son las 9 de la mañana\. Te toca la pastilla de la presión/);
  const r = await t.hear('Sí, ya la tomé');
  assert.match(r, /Anotado/);
  assert.deepEqual({ ...t.events().at(-1) }, { kind: 'ok', title: 'Elsa tomó la pastilla' });
  t.at('2026-10-19T10:30:00-03:00'); t.tick();
  assert.equal(t.events().filter(e => e.kind === 'warn').length, 0);
});

test('pastilla sin confirmar: Tata vuelve a preguntar y después avisa a la familia', async () => {
  const t = setup();
  t.q.run("INSERT INTO reminders (household_id, label, say, at, is_med) VALUES (?, 'Pastilla', 'la pastilla', 540, 1)", t.hid);
  t.at('2026-10-19T09:00:00-03:00'); t.tick();
  t.at('2026-10-19T09:31:00-03:00'); t.tick();
  assert.match(t.said.at(-1).text, /¿ya tomaste la pastilla\?/);
  t.at('2026-10-19T10:01:00-03:00'); t.tick();
  assert.equal(t.events().at(-1).title, 'Elsa no confirmó la pastilla');
  assert.ok(t.pushed.some(p => p.title === 'Elsa no confirmó la pastilla'));
});

test('recordatorio muy atrasado (servidor caído) no se dice', () => {
  const t = setup('2026-10-19T12:00:00-03:00');
  t.q.run('UPDATE households SET inactivity_on = 0');
  t.q.run("INSERT INTO reminders (household_id, label, say, at, is_med) VALUES (?, 'Pastilla', 'la pastilla', 540, 1)", t.hid);
  t.tick();
  assert.equal(t.said.length, 0);
});

test('recordatorio que no corresponde a hoy (solo fines de semana) no se dice', () => {
  const t = setup('2026-10-19T09:00:00-03:00'); // lunes
  t.q.run("INSERT INTO reminders (household_id, label, say, at, days) VALUES (?, 'Misa', 'la misa', 540, '06')", t.hid);
  t.tick();
  assert.equal(t.said.length, 0);
});

test('SOS por voz: alerta push a la familia y pregunta por emergencias', async () => {
  const t = setup();
  const r = await t.hear('Tata, necesito ayuda, me siento mareada');
  assert.match(r, /Ya le avisé a tu familia/);
  assert.match(r, /¿Querés que llame a emergencias\?/);
  assert.equal(t.events().at(-1).kind, 'alert');
  assert.ok(t.pushed.some(p => p.kind === 'alert'));
  const res = await handle(t.core, t.hh(), 'sí');
  assert.equal(res.replies[0].action.phone, '107');
});

test('SOS por botón no se duplica', async () => {
  const t = setup();
  await sos(t.core, t.hh(), 'boton', null);
  await sos(t.core, t.hh(), 'boton', null);
  assert.equal(t.events().filter(e => e.kind === 'alert').length, 1);
});

test('mañana sin actividad: primero pregunta, después avisa; si responde, avisa que está bien', async () => {
  const t = setup('2026-10-19T11:00:00-03:00');
  t.tick();
  assert.match(t.said.at(-1).text, /¿Cómo amaneciste\?/);
  t.at('2026-10-19T11:16:00-03:00'); t.tick();
  assert.equal(t.events().at(-1).title, 'Elsa no habló con Tata esta mañana');
  await t.hear('Bien Tata, recién me levanto');
  assert.equal(t.events().at(-1).title, 'Elsa ya habló con Tata');
});

test('si habló antes de la hora límite no hay pregunta ni aviso', async () => {
  const t = setup('2026-10-19T09:00:00-03:00');
  await t.hear('hola');
  t.at('2026-10-19T11:30:00-03:00'); t.tick();
  assert.equal(t.said.length, 0);
  assert.equal(t.events().filter(e => e.kind === 'warn').length, 0);
});

test('turno: responde con fecha y hora, y lo recuerda la noche anterior', async () => {
  const t = setup('2026-10-19T10:15:00-03:00');
  t.q.run("INSERT INTO appointments (household_id, date, at, what, note, remind_eve) VALUES (?, '2026-10-22', 630, 'el doctor Ferreyra', 'Llevá los análisis.', 0)", t.hid);
  const r = await t.hear('¿A qué hora es el turno del médico?');
  assert.match(r, /el jueves 22 a las 10:30, con el doctor Ferreyra/);
  assert.match(await t.hear('sí, dale'), /La noche anterior te lo recuerdo/);
  t.at('2026-10-21T20:00:00-03:00'); t.tick();
  assert.match(t.said.at(-1).text, /mañana a las 10:30 tenés turno con el doctor Ferreyra/);
});

test('llamar: avisa al familiar y ofrece el botón para marcar', async () => {
  const t = setup();
  const res = await handle(t.core, t.hh(), 'Tata, llamá a mi hija');
  assert.match(res.replies[0].text, /Le avisé a Laura/);
  assert.equal(res.replies[0].action.phone, '+543515551234');
  assert.ok(t.pushed.some(p => p.title === 'Elsa quiere hablar con vos'));
  const m = await handle(t.core, t.hh(), 'llamá a Marta');
  assert.equal(m.replies[0].action.label, 'Llamar a Marta');
});

test('llamar sin decir a quién: pregunta y entiende la respuesta', async () => {
  const t = setup();
  assert.match(await t.hear('quiero llamar'), /¿A quién llamo\?/);
  assert.match(await t.hear('a Marta'), /Para llamar a Marta/);
});

test('mensaje dictado le llega a Laura', async () => {
  const t = setup();
  assert.match(await t.hear('Decile a Laura que ya almorcé'), /Listo, le mandé a Laura: Ya almorce/i);
  assert.equal(t.events().at(-1).kind, 'msg');
  assert.ok(t.pushed.some(p => p.id === t.laura));
});

test('modo paso a paso: avanza, repite y termina', async () => {
  const t = setup();
  assert.match(await t.hear('No me sale la transferencia'), /nunca te voy a pedir tu clave/);
  assert.match(await t.hear('listo'), /Transferir/);
  assert.match(await t.hear('repetí'), /Transferir/);
  for (let i = 0; i < 3; i++) await t.hear('listo');
  assert.match(await t.hear('ya'), /Lo hiciste vos/);
  assert.match(await t.hear('qué hora es'), /^Son las 8 y 55 de la mañana/);
});

test('resumen de la noche con lo que hizo en el día', async () => {
  const t = setup('2026-10-19T09:00:00-03:00');
  await t.hear('Decile a Laura que ya almorcé');
  t.at('2026-10-19T21:00:00-03:00'); t.tick();
  const ev = t.q.get("SELECT * FROM events WHERE title LIKE 'Resumen%'");
  assert.match(ev.body, /Ningún aviso/);
  assert.match(ev.list, /Le mandó un mensaje a Laura/);
});

// ---------- Claude como respaldo (cliente simulado: no llama a la API) ----------
import { createAi } from '../server/ai.js';
import { risky } from '../server/voice.js';

function fakeClaude(script) {
  const calls = [];
  const client = { beta: { messages: { create: async p => { calls.push(structuredClone(p)); return script.shift(); } } } };
  return { ai: createAi({ client }), calls };
}
const text = t => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const use = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_' + name, name, input }] });

test('lo que las reglas no entienden lo charla Claude, con contexto y sin romper las reglas', async () => {
  const t = setup();
  const { ai, calls } = fakeClaude([text('Para un flan necesitás huevos, leche y azúcar, Elsa.')]);
  t.core.ai = ai;
  assert.match(await t.hear('Hola Tata, ¿cómo se hace un flan casero?'), /huevos, leche y azúcar/);
  assert.match(calls[0].messages.at(-1).content, /\[Contexto\] Hoy es/);
  assert.match(calls[0].messages.at(-1).content, /Elsa dice: Hola Tata/);
  assert.equal(calls[0].fallbacks, 'default');
  // las reglas siguen primero: la hora no pasa por Claude
  assert.match(await t.hear('qué hora es'), /^Son las/);
  assert.equal(calls.length, 1);
});

test('Claude puede avisarle a un familiar y la charla sigue en la misma sesión', async () => {
  const t = setup();
  const { ai, calls } = fakeClaude([use('avisar_familiar', { nombre: 'Laura', mensaje: 'Hoy hice tu torta preferida' }), text('Listo, ya le avisé a Laura.'), text('¡Qué lindo!')]);
  t.core.ai = ai;
  assert.match(await t.hear('quiero que Laura sepa que hoy hice su torta preferida de chocolate'), /ya le avisé a Laura/);
  assert.ok(t.pushed.some(p => p.id === t.laura && p.title === 'Mensaje de Elsa para Laura'));
  assert.equal(calls[1].messages.at(-1).content[0].type, 'tool_result');
  await t.hear('y también me salió muy rica la masa de las empanadas');
  assert.equal(calls[2].messages.length, 5); // charla anterior completa + lo nuevo
});

test('si Claude detecta una urgencia, se dispara el SOS de siempre', async () => {
  const t = setup();
  const { ai } = fakeClaude([use('pedir_ayuda', { motivo: 'le duele mucho el pecho' })]);
  t.core.ai = ai;
  const r = await t.hear('tengo una presión rara en el pecho que no se me va');
  assert.match(r, /Ya le avisé a tu familia/);
  assert.equal(t.events().at(-1).kind, 'alert');
});

test('si Claude falla, Tata contesta como antes', async () => {
  const t = setup();
  t.core.ai = createAi({ client: { beta: { messages: { create: async () => { throw new Error('sin red'); } } } } });
  const orig = console.error; console.error = () => {};
  try { assert.match(await t.hear('contame algo de la historia de Córdoba por favor'), /no te entendí/); }
  finally { console.error = orig; }
});

test('la voz clonada nunca se usa para plata, bancos o claves', () => {
  assert.ok(risky('Ma, transferime 20 mil al alias que te paso'));
  assert.ok(risky('pasame el código que te llegó'));
  assert.ok(risky('Necesito tu clave del banco'));
  assert.ok(!risky('Paso a las 5 a tomar unos mates'));
  assert.ok(!risky('Acordate de la pastilla de la presión'));
});

// ---------- Esquema: una base vieja suma lo nuevo ----------
test('una base vieja suma las columnas nuevas sin perder datos', () => {
  const file = join(tmpdir(), `tata-mig-${process.pid}-${Date.now()}.db`);
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE households (id INTEGER PRIMARY KEY, elder_name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'America/Argentina/Cordoba', device_code TEXT UNIQUE, device_token TEXT UNIQUE, device_phone TEXT, inactivity_on INTEGER NOT NULL DEFAULT 1, inactivity_at INTEGER NOT NULL DEFAULT 660, summary_on INTEGER NOT NULL DEFAULT 1, summary_at INTEGER NOT NULL DEFAULT 1260, emergency_phone TEXT NOT NULL DEFAULT '107', last_seen INTEGER, offline_alerted INTEGER NOT NULL DEFAULT 0, convo TEXT NOT NULL DEFAULT '{}', sos TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE days (household_id INTEGER NOT NULL, date TEXT NOT NULL, first_activity INTEGER, check_asked INTEGER, inact_alerted INTEGER NOT NULL DEFAULT 0, summary_sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (household_id, date));
    INSERT INTO households (elder_name, created_at) VALUES ('Elsa', 0);`);
  old.close();
  const db = openDb(file);
  const q = makeQ(db);
  try {
    assert.deepEqual({ ...q.get('SELECT elder_name, city, barrio FROM households') }, { elder_name: 'Elsa', city: '', barrio: '' });
    q.run("INSERT INTO days (household_id, date, briefed, prepared, news, weather) VALUES (1, '2026-11-02', 1, 1, 'x', 'y')");
    q.run("INSERT INTO activities (title, place, city, at, created_at) VALUES ('Tejido', 'Centro', 'Córdoba', 1020, 0)");
    q.run("INSERT INTO interests (household_id, text) VALUES (1, 'tango')");
    q.run("INSERT INTO activity_answers (household_id, activity_id, date, answer, ts) VALUES (1, 1, '2026-11-02', 'si', 0)");
    openDb(file).close(); // reabrir no rompe: la migración es idempotente
  } finally { db.close(); rmSync(file, { force: true }); rmSync(file + '-wal', { force: true }); rmSync(file + '-shm', { force: true }); }
});

// ---------- Encuentro: qué actividad sugerir ----------
import { pickActivity, upcoming, offerText, detailsText, answer, seedActivities, ensureActivities } from '../server/encuentro.js';

function act(t, f = {}) {
  const a = { title: 'Taller de tejido', place: 'Centro vecinal', address: '', city: 'Córdoba', barrio: '', at: 1020, days: '0123456', date: null, price: '', phone: '', tags: '', ...f };
  return Number(t.q.run(`INSERT INTO activities (title, place, address, city, barrio, at, days, date, price, phone, tags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, a.title, a.place, a.address, a.city, a.barrio, a.at, a.days, a.date, a.price, a.phone, a.tags).lastInsertRowid);
}
const live = (t, city = 'Córdoba', barrio = '') => t.q.run('UPDATE households SET city = ?, barrio = ? WHERE id = ?', city, barrio, t.hid);

test('pickActivity: misma ciudad, sin importar tildes ni mayúsculas', () => {
  const t = setup('2026-10-19T09:00:00-03:00');
  live(t, 'cordoba ');
  act(t, { title: 'Tango en Rosario', city: 'Rosario', at: 600 });
  const id = act(t, { title: 'Tejido' });
  assert.equal(pickActivity(t.core, t.hh())?.a.id, id);
});

test('pickActivity: primero su barrio, después sus intereses, después la más próxima', () => {
  const t = setup('2026-10-19T09:00:00-03:00');
  live(t, 'Córdoba', 'Alta Córdoba');
  const A = act(t, { title: 'A', barrio: 'Centro', tags: 'tango,baile', at: 1080 });
  act(t, { title: 'B', barrio: 'Centro', at: 960 });
  const C = act(t, { title: 'C', barrio: 'alta cordoba', at: 1140 });
  assert.equal(pickActivity(t.core, t.hh()).a.id, C);
  t.q.run('DELETE FROM activities WHERE id = ?', C);
  assert.equal(pickActivity(t.core, t.hh()).a.title, 'B'); // sin intereses: la más próxima
  t.q.run("INSERT INTO interests (household_id, text) VALUES (?, 'Tango')", t.hid);
  assert.equal(pickActivity(t.core, t.hh()).a.id, A);
});

test('pickActivity: la de hoy que ya pasó no, la de mañana sí', () => {
  const t = setup('2026-10-19T18:00:00-03:00'); // lunes
  live(t);
  act(t, { at: 1020, days: '1' }); // lunes 17:00: ya pasó, y mañana es martes
  assert.equal(pickActivity(t.core, t.hh()), null);
  act(t, { title: 'Caminata', at: 600 });
  assert.deepEqual([pickActivity(t.core, t.hh()).a.title, pickActivity(t.core, t.hh()).date], ['Caminata', '2026-10-20']);
});

test('pickActivity: respeta el no, y sin ciudad no sugiere nada', () => {
  const t = setup('2026-10-19T09:00:00-03:00');
  const id = act(t);
  assert.equal(pickActivity(t.core, t.hh()), null); // sin ciudad
  live(t);
  answer(t.core, t.hh(), id, '2026-10-19', 'no');
  assert.equal(pickActivity(t.core, t.hh()).date, '2026-10-20'); // hoy no, mañana sí
});

test('Encuentro: cómo lo dice Tata, y la familia se entera si le interesa', () => {
  const t = setup('2026-10-19T09:00:00-03:00');
  live(t);
  const id = act(t, { place: 'Centro vecinal Alta Córdoba', address: 'Av. Juan B. Justo 2000', price: 'Gratis', phone: '351 555 0000' });
  const p = pickActivity(t.core, t.hh());
  assert.equal(offerText(t.hh(), p.a, p.date, '2026-10-19'), 'Hoy a las 17 hay Taller de tejido en Centro vecinal Alta Córdoba. ¿Te interesa?');
  assert.match(detailsText(p.a, p.date, '2026-10-19'), /Av\. Juan B\. Justo 2000.*hoy a las 17.*Gratis/);
  answer(t.core, t.hh(), id, '2026-10-19', 'si');
  assert.equal(t.events().at(-1).title, 'A Elsa le interesó una actividad');
  assert.ok(t.pushed.some(p => p.title === 'A Elsa le interesó una actividad'));
  assert.equal(upcoming(t.core, t.hh(), 7).length, 7);
});

test('actividades de ejemplo: 5 por ciudad al arrancar, nuevas cada vez, sin tocar las de Órbita', () => {
  const t = setup('2026-10-19T20:00:00-03:00'); // lunes de noche: las de hoy ya pasaron
  const auto = () => t.q.all('SELECT * FROM activities WHERE auto = 1');
  seedActivities(t.core);
  assert.equal(auto().length, 0); // sin ciudad no arma nada
  live(t, 'Córdoba', 'Alta Córdoba');
  const mine = act(t, { title: 'Tango de Órbita' });
  seedActivities(t.core);
  const first = auto();
  assert.equal(first.length, 5);
  assert.ok(first.every(a => a.city === 'Córdoba' && a.days.includes('1') && a.days.includes('2')));
  assert.equal(first.filter(a => a.barrio === 'Alta Córdoba').length, 2);
  assert.ok(pickActivity(t.core, t.hh())); // mañana hay algo para sugerir
  seedActivities(t.core);
  assert.equal(auto().length, 5); // las anteriores se borran: no se acumulan
  assert.ok(t.q.get('SELECT 1 FROM activities WHERE id = ?', mine));
  ensureActivities(t.core, t.hh());
  assert.equal(auto().length, 5); // ya hay en su ciudad: no duplica
  live(t, 'Rosario');
  ensureActivities(t.core, t.hh());
  assert.equal(auto().filter(a => a.city === 'Rosario').length, 5);
});

// ---------- Servidor HTTP de prueba ----------
import { createApp } from '../server/index.js';
async function serve(opts = {}) {
  const app = createApp({ dbFile: ':memory:', withPush: false, ai: null, voice: null, ...opts });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const call = (method, path, body, token) => fetch(url + path, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  return { ...app, url, call, close: () => new Promise(r => app.server.close(r)) };
}

// ---------- Panel de Órbita ----------
test('panel de Órbita: apagado sin clave y protegido con clave', async () => {
  const off = await serve({ orbitaKey: '' });
  try { assert.equal((await off.call('GET', '/api/orbita/activities', null, 'x')).status, 404); } finally { await off.close(); }
  const on = await serve({ orbitaKey: 'k' });
  try {
    assert.equal((await on.call('GET', '/api/orbita/activities', null, 'x')).status, 401);
    assert.equal((await on.call('GET', '/api/orbita/activities')).status, 401);
  } finally { await on.close(); }
});

test('panel de Órbita: crea, lista, pausa y borra', async () => {
  const s = await serve({ orbitaKey: 'k' });
  try {
    const a = { title: 'Taller de tejido', place: 'Centro vecinal', city: 'Córdoba', barrio: 'Alta Córdoba', at: '17:00', days: '24', tags: 'tejido' };
    const c = await s.call('POST', '/api/orbita/activities', a, 'k');
    assert.equal(c.status, 201);
    const list = (await s.call('GET', '/api/orbita/activities', null, 'k')).body.activities;
    assert.deepEqual([list.length, list[0].title, list[0].at, list[0].days], [1, 'Taller de tejido', 1020, '24']);
    assert.equal((await s.call('PATCH', `/api/orbita/activities/${c.body.id}`, { active: false }, 'k')).status, 200);
    assert.equal(s.q.get('SELECT active FROM activities WHERE id = ?', c.body.id).active, 0);
    assert.equal((await s.call('DELETE', `/api/orbita/activities/${c.body.id}`, null, 'k')).status, 200);
    assert.equal((await s.call('GET', '/api/orbita/activities', null, 'k')).body.activities.length, 0);
    assert.equal((await s.call('POST', '/api/orbita/activities', { ...a, city: '' }, 'k')).status, 400);
    assert.equal((await s.call('POST', '/api/orbita/activities', { ...a, days: '', date: '' }, 'k')).status, 400);
    assert.equal((await s.call('POST', '/api/orbita/activities', { ...a, at: '25:00' }, 'k')).status, 400);
  } finally { await s.close(); }
});

// ---------- Familia: dónde vive e intereses ----------
const fakeGeo = async u => {
  if (String(u).includes('geocoding-api.open-meteo.com')) return new Response(JSON.stringify({ results: [{ latitude: -31.4, longitude: -64.18 }] }));
  return new Response('', { status: 404 });
};
async function family(s) {
  const r = await s.call('POST', '/api/households', { memberName: 'Laura', elderName: 'Elsa' });
  return r.body.token;
}

test('familia: guarda ciudad y barrio, y la ciudad se geolocaliza', async () => {
  const s = await serve({ fetchImpl: fakeGeo });
  try {
    const tk = await family(s);
    assert.equal((await s.call('PATCH', '/api/familia/household', { city: 'Córdoba', barrio: 'Alta Córdoba' }, tk)).status, 200);
    const hh = s.q.get('SELECT city, barrio, lat, lon FROM households');
    assert.deepEqual({ ...hh }, { city: 'Córdoba', barrio: 'Alta Córdoba', lat: -31.4, lon: -64.18 });
    const me = (await s.call('GET', '/api/familia/me', null, tk)).body;
    assert.deepEqual([me.household.city, me.household.barrio], ['Córdoba', 'Alta Córdoba']);
  } finally { await s.close(); }
});

test('familia: intereses, hasta 12, y solo los propios se pueden borrar', async () => {
  const s = await serve({ fetchImpl: fakeGeo });
  try {
    const tk = await family(s), other = await family(s);
    for (let i = 0; i < 12; i++) assert.equal((await s.call('POST', '/api/familia/interests', { text: 'tema ' + i }, tk)).status, 201);
    assert.equal((await s.call('POST', '/api/familia/interests', { text: 'uno más' }, tk)).status, 400);
    assert.equal((await s.call('POST', '/api/familia/interests', { text: '  ' }, other)).status, 400);
    const me = (await s.call('GET', '/api/familia/me', null, tk)).body;
    assert.equal(me.interests.length, 12);
    assert.equal((await s.call('DELETE', `/api/familia/interests/${me.interests[0].id}`, null, other)).status, 404);
    assert.equal((await s.call('DELETE', `/api/familia/interests/${me.interests[0].id}`, null, tk)).status, 200);
    assert.equal((await s.call('GET', '/api/familia/me', null, tk)).body.interests.length, 11);
  } finally { await s.close(); }
});

test('familia: ve lo que hay cerca y lo que le interesó', async () => {
  const s = await serve({ fetchImpl: fakeGeo });
  try {
    const tk = await family(s);
    await s.call('PATCH', '/api/familia/household', { city: 'Córdoba' }, tk);
    s.q.run("INSERT INTO activities (title, place, city, at, days, created_at) VALUES ('Tejido', 'Centro', 'Córdoba', 1439, '0123456', 0)");
    const me = (await s.call('GET', '/api/familia/me', null, tk)).body;
    assert.ok(me.encuentro.upcoming.some(u => u.title === 'Tejido'));
    assert.equal(s.q.get('SELECT COUNT(*) AS n FROM activities WHERE auto = 1').n, 5); // cargar la ciudad arma las de ejemplo
    assert.deepEqual(me.encuentro.liked, []);
  } finally { await s.close(); }
});

// ---------- Noticias y clima ----------
import { weatherLine, parseRss, prepareDay } from '../server/news.js';

test('weatherLine: soleado, redondea, y la lluvia se dice', () => {
  assert.equal(weatherLine({ code: 0, max: 24.4, min: 12 }), 'Hoy va a estar soleado, con una máxima de 24 grados.');
  assert.match(weatherLine({ code: 61, max: 18.6, min: 10 }), /lluvia.*19 grados/);
});

test('parseRss: limpia CDATA, entidades y la fuente del título', () => {
  const xml = `<rss><channel><item><title><![CDATA[Talleres gan&oacute; &quot;el clásico&quot; - La Voz]]></title><source url="x">La Voz</source></item>
    <item><title>Receta de &amp;alfajores - Clarín</title><source url="y">Clarín</source></item></channel></rss>`;
  assert.deepEqual(parseRss(xml), [{ title: 'Talleres ganó "el clásico"', source: 'La Voz' }, { title: 'Receta de &alfajores', source: 'Clarín' }]);
});

test('pickNews: una frase válida, o null si no hay, si no es JSON o si es muy larga', async () => {
  const long = Array(30).fill('palabra').join(' ');
  const { ai, calls } = fakeClaude([text('{"frase":"Talleres ganó el clásico, Elsa."}'), text('{"frase":null}'), text('no sé'), text(JSON.stringify({ frase: long }))]);
  const h = [{ title: 'Talleres ganó el clásico', source: 'La Voz' }];
  assert.equal(await ai.pickNews(['Talleres'], h), 'Talleres ganó el clásico, Elsa.');
  assert.equal(await ai.pickNews(['Talleres'], h), null);
  assert.equal(await ai.pickNews(['Talleres'], h), null);
  assert.equal(await ai.pickNews(['Talleres'], h), null);
  assert.equal(calls[0].tools, undefined);
  assert.equal(calls[0].output_config.format.type, 'json_schema');
  assert.match(calls[0].messages[0].content, /Talleres ganó el clásico/);
});

const fakeWeb = (u) => {
  u = String(u);
  if (u.includes('api.open-meteo.com')) return new Response(JSON.stringify({ daily: { weathercode: [0], temperature_2m_max: [24.4], temperature_2m_min: [12] } }));
  if (u.includes('news.google.com')) return new Response('<rss><item><title>Talleres ganó el clásico - La Voz</title><source url="x">La Voz</source></item></rss>');
  return new Response('', { status: 404 });
};

test('prepareDay: guarda clima y noticia; sin Claude, solo el clima', async () => {
  const t = setup('2026-10-19T05:10:00-03:00');
  t.q.run("UPDATE households SET city = 'Córdoba', lat = -31.4, lon = -64.18 WHERE id = ?", t.hid);
  t.q.run("INSERT INTO interests (household_id, text) VALUES (?, 'Talleres')", t.hid);
  t.core.ai = fakeClaude([text('{"frase":"Talleres ganó el clásico, Elsa."}')]).ai;
  await prepareDay(t.core, t.hh(), { fetchImpl: async u => fakeWeb(u) });
  let d = t.q.get("SELECT * FROM days WHERE household_id = ? AND date = '2026-10-19'", t.hid);
  assert.deepEqual([d.news, d.weather, d.prepared], ['Talleres ganó el clásico, Elsa.', 'Hoy va a estar soleado, con una máxima de 24 grados.', 1]);

  t.q.run('DELETE FROM days');
  t.core.ai = null;
  await prepareDay(t.core, t.hh(), { fetchImpl: async u => fakeWeb(u) });
  d = t.q.get("SELECT * FROM days WHERE household_id = ? AND date = '2026-10-19'", t.hid);
  assert.deepEqual([d.news, d.weather, d.prepared], ['', 'Hoy va a estar soleado, con una máxima de 24 grados.', 1]);

  t.q.run('DELETE FROM days');
  await prepareDay(t.core, t.hh(), { fetchImpl: async () => { throw new Error('sin red'); } });
  d = t.q.get("SELECT * FROM days WHERE household_id = ? AND date = '2026-10-19'", t.hid);
  assert.deepEqual([d.news, d.weather, d.prepared], ['', '', 1]);
});

// ---------- La mañana: el resumen va después de que ella habla ----------
function morningSetup(at = '2026-10-19T09:00:00-03:00') {
  const t = setup(at);
  live(t);
  act(t, { title: 'Tejido', place: 'Centro vecinal', address: 'Av. Siempreviva 742' });
  t.q.run("INSERT INTO reminders (household_id, label, say, at, is_med) VALUES (?, 'Pastilla de la presión', 'la pastilla de la presión', 510, 1)", t.hid);
  t.core.day(t.hh(), '2026-10-19');
  t.q.run("UPDATE days SET weather = 'Hoy va a estar soleado, con una máxima de 24 grados.', news = '', prepared = 1 WHERE household_id = ?", t.hid);
  return t;
}
const briefed = t => t.q.get("SELECT briefed FROM days WHERE household_id = ? AND date = '2026-10-19'", t.hid).briefed;

test('mañana: después de la primera respuesta suma pastilla, clima y actividad, una sola vez', async () => {
  const t = morningSetup();
  assert.match(await t.hear('qué hora es'),
    /^Son las .* Buen día, Elsa\. Te toca la pastilla de la presión\. Hoy va a estar soleado.* Hoy a las 17 hay Tejido en Centro vecinal\. ¿Te interesa\?$/);
  assert.ok(briefed(t));
  await t.hear('no');
  assert.doesNotMatch(await t.hear('qué hora es'), /Buen día/);
});

test('mañana: fuera de la ventana de 6 a 13 no hay resumen', async () => {
  const t = morningSetup('2026-10-19T14:00:00-03:00');
  assert.doesNotMatch(await t.hear('qué hora es'), /Te toca|Tejido/);
  assert.equal(briefed(t), null);
});

test('mañana: si lo primero es un pedido de ayuda, no hay resumen y el SOS sale igual', async () => {
  const t = morningSetup();
  const r = await t.hear('me caí, ayuda');
  assert.match(r, /Ya le avisé a tu familia/);
  assert.doesNotMatch(r, /Tejido|Buen día/);
  assert.equal(briefed(t), null);
});

test('actividad: con sí, Tata da los datos y la familia se entera', async () => {
  const t = morningSetup();
  await t.hear('qué hora es');
  assert.match(await t.hear('sí'), /Av\. Siempreviva 742/);
  assert.equal(t.events().at(-1).title, 'A Elsa le interesó una actividad');
  assert.match(await t.hear('dónde es'), /Av\. Siempreviva 742/);
});

test('actividad: con no, no se la vuelve a ofrecer para ese día', async () => {
  const t = morningSetup();
  await t.hear('qué hora es');
  await t.hear('no');
  assert.match(await t.hear('qué hay para hacer'), /^Mañana a las 17 hay Tejido/);
});

test('noticias a pedido: la del día, o el clima, o que no hay', async () => {
  const t = morningSetup('2026-10-19T14:00:00-03:00');
  assert.equal(await t.hear('contame una noticia'), 'Hoy va a estar soleado, con una máxima de 24 grados.');
  t.q.run("UPDATE days SET news = 'Talleres ganó el clásico, Elsa.'");
  assert.equal(await t.hear('contame una noticia'), 'Talleres ganó el clásico, Elsa.');
  t.q.run("UPDATE days SET news = '', weather = ''");
  assert.equal(await t.hear('qué hay de nuevo'), 'Hoy no tengo novedades para contarte.');
});

test('Claude recibe los intereses, las actividades cerca y la novedad del día', async () => {
  const t = morningSetup('2026-10-19T14:00:00-03:00');
  t.q.run("INSERT INTO interests (household_id, text) VALUES (?, 'Tango')", t.hid);
  t.q.run("UPDATE days SET news = 'Talleres ganó el clásico, Elsa.'");
  const { ai, calls } = fakeClaude([text('Qué lindo, Elsa.')]);
  t.core.ai = ai;
  await t.hear('estuve pensando en mi juventud cuando bailaba en el club');
  const ctx = calls[0].messages.at(-1).content;
  assert.match(ctx, /\[Contexto\] Le interesa: Tango\./);
  assert.match(ctx, /\[Contexto\] Actividades cerca: hoy 17:00 Tejido en Centro vecinal/);
  assert.match(ctx, /\[Contexto\] Novedad de hoy: Talleres ganó el clásico/);
  assert.match(calls[0].system, /nunca inventes otras/);
});

test('con Claude, una frase larga que nombra "actividades" o "el clima" sigue siendo charla', async () => {
  const t = morningSetup('2026-10-19T14:00:00-03:00');
  const { ai, calls } = fakeClaude([text('Te entiendo, Elsa.'), text('Sí, está pesado.')]);
  t.core.ai = ai;
  assert.equal(await t.hear('hoy la verdad que no tengo ganas de hacer ninguna de esas actividades'), 'Te entiendo, Elsa.');
  assert.equal(await t.hear('me tiene cansada el clima de estos días tan húmedos'), 'Sí, está pesado.');
  assert.equal(calls.length, 2);
  assert.match(await t.hear('qué hay para hacer'), /Tejido/); // las frases cortas siguen yendo a la regla
  assert.match(await t.hear('cómo va a estar el día'), /soleado/);
});
