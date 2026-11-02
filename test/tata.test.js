import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, q as makeQ } from '../server/db.js';
import { createCore } from '../server/core.js';
import { handle, sos } from '../server/brain.js';
import { tickHousehold } from '../server/scheduler.js';

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
import { risky, createVoice } from '../server/voice.js';

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

// ---------- Servicio de voz: VoiceStudio primero, Chatterbox de respaldo (fetch simulado) ----------
function fakeVoz({ studioUp = true, studioFails = false } = {}) {
  const calls = [], profiles = [];
  const ok = (body, type = 'application/json') => new Response(type === 'application/json' ? JSON.stringify(body) : body, { headers: { 'content-type': type } });
  const fetchImpl = async (u, opts = {}) => {
    const { origin, pathname } = new URL(u), method = opts.method || 'GET';
    calls.push({ origin, method, path: pathname, body: opts.body });
    if (origin === 'http://studio') {
      if (!studioUp) throw new Error('ECONNREFUSED');
      if (pathname === '/health') return ok({ status: 'ok' });
      if (pathname === '/profiles' && method === 'GET') return ok(profiles);
      if (pathname === '/profiles' && method === 'POST') { const p = { id: 'p' + (profiles.length + 1), name: opts.body.get('name') }; profiles.push(p); return ok(p); }
      if (pathname.startsWith('/profiles/') && method === 'DELETE') { profiles.splice(profiles.findIndex(p => '/profiles/' + p.id === pathname), 1); return ok({}); }
      if (pathname === '/v1/audio/speech') return studioFails ? new Response('boom', { status: 500 }) : ok('WAV-STUDIO', 'audio/wav');
    }
    if (origin === 'http://chatter') {
      if (pathname === '/health') return ok({ ok: true });
      if (pathname === '/tts') return ok('WAV-CHATTER', 'audio/wav');
    }
    return new Response('', { status: 404 });
  };
  return { voice: createVoice({ engine: 'voicestudio', url: 'http://chatter', studioUrl: 'http://studio', fetchImpl }), calls, profiles };
}
const muestra = Buffer.from('RIFF....WAVEmuestra de Laura');

test('VoiceStudio: crea el perfil del familiar una sola vez y lo reusa', async () => {
  const v = fakeVoz();
  assert.ok(await v.voice.check());
  assert.equal(String(await v.voice.speak('Paso a las 5', muestra)), 'WAV-STUDIO');
  assert.equal(String(await v.voice.speak('Te quiero, ma', muestra)), 'WAV-STUDIO');
  assert.equal(v.profiles.length, 1);
  assert.match(v.profiles[0].name, /^tata-[0-9a-f]{16}$/); // sin el nombre del familiar
  const speech = v.calls.filter(c => c.path === '/v1/audio/speech').map(c => JSON.parse(c.body));
  assert.deepEqual(speech.map(s => [s.voice, s.language, s.response_format]), [['p1', 'es', 'wav'], ['p1', 'es', 'wav']]);
  assert.ok(!v.calls.some(c => c.origin === 'http://chatter' && c.path === '/tts'));
});

test('si VoiceStudio falla o no está, la voz sale por Chatterbox', async () => {
  const orig = console.error; console.error = () => {};
  try {
    assert.equal(String(await fakeVoz({ studioFails: true }).voice.speak('Paso a las 5', muestra)), 'WAV-CHATTER');
    const caido = fakeVoz({ studioUp: false });
    assert.ok(await caido.voice.check());
    assert.equal(String(await caido.voice.speak('Paso a las 5', muestra)), 'WAV-CHATTER');
  } finally { console.error = orig; }
});

test('cuando el familiar borra su voz, también se borra su perfil en VoiceStudio', async () => {
  const v = fakeVoz();
  await v.voice.speak('Paso a las 5', muestra);
  await v.voice.forget(muestra);
  assert.equal(v.profiles.length, 0);
});
