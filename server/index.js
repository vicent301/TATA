import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, q as makeQ, token, deviceCode } from './db.js';
import { createCore } from './core.js';
import { createPush } from './push.js';
import { handle, sos, uiState } from './brain.js';
import { startScheduler } from './scheduler.js';
import { parseHHMM, fmtMin } from './time.js';
import { createAi } from './ai.js';
import { createVoice, risky } from './voice.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => { throw new HttpError(400, msg); };
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const bool = v => (v ? 1 : 0);

export function createApp({ dbFile = process.env.DB_FILE || 'data/tata.db', clock, withPush = true, ai = createAi(), voice = createVoice() } = {}) {
  const db = openDb(dbFile);
  const q = makeQ(db);
  const push = withPush ? createPush(q) : null;
  const core = createCore({ q, push, clock });
  core.ai = ai;

  // ---------- ayudantes ----------
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req, limit = 64 * 1024) => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Demasiado grande')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const readJson = async req => {
    const buf = await readBody(req);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString('utf8')); } catch { bad('JSON inválido'); }
  };
  const bearer = (req, url) => (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('t') || '';

  const authMember = (req, url) => {
    const m = q.get('SELECT * FROM members WHERE token = ?', bearer(req, url));
    if (!m) throw new HttpError(401, 'No autorizado');
    return { member: m, hh: core.household(m.household_id) };
  };
  const authDevice = (req, url) => {
    const t = bearer(req, url);
    const hh = t && q.get('SELECT * FROM households WHERE device_token = ?', t);
    if (!hh) throw new HttpError(401, 'Dispositivo no vinculado');
    return hh;
  };
  const freeCode = () => { let c; do c = deviceCode(); while (q.get('SELECT 1 FROM households WHERE device_code = ?', c)); return c; };

  function openStream(req, res, hhId, role, memberId) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    const detach = core.attach(hhId, res, role, memberId);
    req.on('close', () => {
      detach();
      if (role === 'device' && !core.deviceOnline(hhId)) {
        q.run('UPDATE households SET last_seen = ? WHERE id = ?', core.ts(), hhId);
        core.send(hhId, 'family', { type: 'refresh' });
      }
    });
  }

  function familyView(member, hh) {
    const now = core.now(hh);
    return {
      me: { id: member.id, name: member.name, relation: member.relation, phone: member.phone, is_admin: !!member.is_admin, gets_alerts: !!member.gets_alerts,
        has_voice: !!q.get('SELECT 1 FROM voices WHERE member_id = ?', member.id) },
      features: { ai: !!core.ai, voice: !!voice?.ready },
      household: {
        elder_name: hh.elder_name, timezone: hh.timezone, device_code: hh.device_code, paired: !!hh.device_token,
        device_phone: hh.device_phone, emergency_phone: hh.emergency_phone,
        inactivity_on: !!hh.inactivity_on, inactivity_at: fmtMin(hh.inactivity_at),
        summary_on: !!hh.summary_on, summary_at: fmtMin(hh.summary_at),
        online: core.deviceOnline(hh.id), last_seen: hh.last_seen
      },
      now: { date: now.date, time: fmtMin(now.min) },
      sos: core.sos(hh),
      today: uiState(core, hh).today,
      lastActivity: q.get('SELECT ts, text FROM activity WHERE household_id = ? ORDER BY ts DESC LIMIT 1', hh.id) || null,
      firstActivityToday: core.day(hh, now.date).first_activity,
      members: q.all('SELECT id, name, relation, phone, is_admin, gets_alerts FROM members WHERE household_id = ? ORDER BY id', hh.id),
      contacts: q.all('SELECT id, name, relation, phone, member_id FROM contacts WHERE household_id = ? ORDER BY id', hh.id),
      reminders: q.all(`SELECT r.id, r.label, r.say, r.at, r.days, r.date, r.is_med, r.audio_id, r.active, rr.fired_at, rr.done_at, rr.missed
        FROM reminders r LEFT JOIN reminder_runs rr ON rr.reminder_id = r.id AND rr.date = ?
        WHERE r.household_id = ? AND (r.date IS NULL OR r.date >= ?) ORDER BY r.at`, now.date, hh.id, now.date)
        .map(r => ({ ...r, at: fmtMin(r.at) })),
      appointments: q.all('SELECT id, date, at, what, note, remind_eve FROM appointments WHERE household_id = ? AND date >= ? ORDER BY date, at', hh.id, now.date)
        .map(a => ({ ...a, at: fmtMin(a.at) })),
      events: q.all('SELECT id, ts, kind, title, body, list FROM events WHERE household_id = ? ORDER BY ts DESC LIMIT 60', hh.id)
        .map(e => ({ ...e, list: e.list ? JSON.parse(e.list) : null })),
      vapidPublicKey: push?.publicKey || null
    };
  }
  const deviceView = hh => ({
    elder_name: hh.elder_name, timezone: hh.timezone, emergency_phone: hh.emergency_phone,
    contacts: q.all('SELECT name, relation, phone FROM contacts WHERE household_id = ? ORDER BY id', hh.id),
    ui: uiState(core, hh)
  });
  const changed = hh => core.send(hh.id, 'all', { type: 'refresh' });

  function reminderFields(b) {
    const label = str(b.label, 80); if (!label) bad('Falta qué es');
    const at = parseHHMM(b.at); if (at == null) bad('Hora inválida');
    const date = b.date ? str(b.date, 10) : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) bad('Fecha inválida');
    const days = date ? '' : (str(b.days, 7).replace(/[^0-6]/g, '') || '0123456');
    return { label, say: str(b.say, 200) || label.toLowerCase(), at, date, days, is_med: bool(b.is_med) };
  }
  /** Genera `text` con la voz clonada del familiar. Devuelve { id } del audio o { reason } si no corresponde. */
  async function inVoice(member, hh, text) {
    const v = q.get('SELECT wav FROM voices WHERE member_id = ?', member.id);
    if (!v || !voice) return { reason: 'Todavía no grabaste tu voz (Ajustes).' };
    if (risky(text)) return { reason: 'Habla de plata, bancos o claves: por seguridad Tata lo dice con su propia voz.' };
    if (!(await voice.check())) return { reason: 'El servicio de voz no está andando: lo dijo Tata.' };
    try {
      const wav = await voice.speak(text, v.wav);
      return { id: Number(q.run('INSERT INTO audio (household_id, mime, data, created_at) VALUES (?, ?, ?, ?)', hh.id, 'audio/wav', wav, core.ts()).lastInsertRowid) };
    } catch (e) {
      console.error('voz', e.message);
      return { reason: 'No se pudo generar tu voz: lo dijo Tata.' };
    }
  }
  function audioOf(hh, id) {
    if (id == null || id === '') return null;
    const a = q.get('SELECT id FROM audio WHERE id = ? AND household_id = ?', Number(id), hh.id);
    if (!a) bad('Audio inválido');
    return a.id;
  }

  // ---------- rutas ----------
  const routes = [
    // Crear un hogar: la persona que lo crea queda como administradora.
    ['POST', '/api/households', async req => {
      const b = await readJson(req);
      const memberName = str(b.memberName, 60), elderName = str(b.elderName, 60);
      if (!memberName || !elderName) bad('Faltan los nombres');
      const tz = str(b.timezone, 60) || 'America/Argentina/Cordoba';
      try { new Intl.DateTimeFormat('es', { timeZone: tz }); } catch { bad('Zona horaria inválida'); }
      const t = token();
      q.tx(() => {
        const hh = q.run('INSERT INTO households (elder_name, timezone, device_code, created_at) VALUES (?, ?, ?, ?)', elderName, tz, freeCode(), core.ts());
        const hid = Number(hh.lastInsertRowid);
        const m = q.run('INSERT INTO members (household_id, name, relation, phone, token, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
          hid, memberName, str(b.relation, 40), str(b.phone, 30) || null, t, core.ts());
        q.run('INSERT INTO contacts (household_id, name, relation, phone, member_id) VALUES (?, ?, ?, ?, ?)',
          hid, memberName, str(b.relation, 40), str(b.phone, 30) || null, Number(m.lastInsertRowid));
      });
      return [201, { token: t }];
    }],

    // ----- familia -----
    ['GET', '/api/familia/me', (req, url) => { const { member, hh } = authMember(req, url); return [200, familyView(member, hh)]; }],
    ['GET', '/api/familia/stream', (req, url, res) => { const { member, hh } = authMember(req, url); openStream(req, res, hh.id, 'family', member.id); }],
    ['PATCH', '/api/familia/me', async (req, url) => {
      const { member, hh } = authMember(req, url); const b = await readJson(req);
      if ('phone' in b) {
        q.run('UPDATE members SET phone = ? WHERE id = ?', str(b.phone, 30) || null, member.id);
        q.run('UPDATE contacts SET phone = ? WHERE member_id = ?', str(b.phone, 30) || null, member.id);
      }
      if ('gets_alerts' in b) q.run('UPDATE members SET gets_alerts = ? WHERE id = ?', bool(b.gets_alerts), member.id);
      changed(hh); return [200, { ok: true }];
    }],
    ['PATCH', '/api/familia/household', async (req, url) => {
      const { hh } = authMember(req, url); const b = await readJson(req);
      const set = (col, v) => q.run(`UPDATE households SET ${col} = ? WHERE id = ?`, v, hh.id);
      if ('elder_name' in b) { const v = str(b.elder_name, 60); if (!v) bad('Falta el nombre'); set('elder_name', v); }
      if ('inactivity_on' in b) set('inactivity_on', bool(b.inactivity_on));
      if ('inactivity_at' in b) { const v = parseHHMM(b.inactivity_at); if (v == null) bad('Hora inválida'); set('inactivity_at', v); }
      if ('summary_on' in b) set('summary_on', bool(b.summary_on));
      if ('summary_at' in b) { const v = parseHHMM(b.summary_at); if (v == null) bad('Hora inválida'); set('summary_at', v); }
      if ('emergency_phone' in b) set('emergency_phone', str(b.emergency_phone, 20) || '107');
      if ('device_phone' in b) set('device_phone', str(b.device_phone, 30) || null);
      if ('timezone' in b) { const tz = str(b.timezone, 60); try { new Intl.DateTimeFormat('es', { timeZone: tz }); } catch { bad('Zona horaria inválida'); } set('timezone', tz); }
      changed(hh); return [200, { ok: true }];
    }],
    ['POST', '/api/familia/device/unpair', (req, url) => {
      const { hh } = authMember(req, url);
      q.run('UPDATE households SET device_token = NULL, device_code = ? WHERE id = ?', freeCode(), hh.id);
      core.send(hh.id, 'device', { type: 'unpaired' });
      changed(hh); return [200, { ok: true }];
    }],

    ['POST', '/api/familia/reminders', async (req, url) => {
      const { member, hh } = authMember(req, url); const b = await readJson(req); const f = reminderFields(b);
      let audioId = audioOf(hh, b.audio_id), voiceNote = null;
      if (!audioId && b.own_voice) {
        const v = await inVoice(member, hh, `${hh.elder_name}, ${f.say.charAt(0).toUpperCase() + f.say.slice(1)}.`);
        audioId = v.id || null; voiceNote = v.reason || null;
      }
      const r = q.run('INSERT INTO reminders (household_id, label, say, at, days, date, is_med, audio_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        hh.id, f.label, f.say, f.at, f.days, f.date, f.is_med, audioId, member.id);
      changed(hh); return [201, { id: Number(r.lastInsertRowid), voiceNote }];
    }],
    ['PATCH', '/api/familia/reminders/:id', async (req, url, res, p) => {
      const { hh } = authMember(req, url); const b = await readJson(req);
      const r = q.get('SELECT * FROM reminders WHERE id = ? AND household_id = ?', Number(p.id), hh.id); if (!r) throw new HttpError(404, 'No existe');
      if ('active' in b && Object.keys(b).length === 1) q.run('UPDATE reminders SET active = ? WHERE id = ?', bool(b.active), r.id);
      else {
        const f = reminderFields({ ...r, at: fmtMin(r.at), ...b });
        q.run('UPDATE reminders SET label = ?, say = ?, at = ?, days = ?, date = ?, is_med = ?, audio_id = ? WHERE id = ?',
          f.label, f.say, f.at, f.days, f.date, f.is_med, 'audio_id' in b ? audioOf(hh, b.audio_id) : r.audio_id, r.id);
      }
      changed(hh); return [200, { ok: true }];
    }],
    ['DELETE', '/api/familia/reminders/:id', (req, url, res, p) => {
      const { hh } = authMember(req, url);
      q.run('DELETE FROM reminders WHERE id = ? AND household_id = ?', Number(p.id), hh.id);
      changed(hh); return [200, { ok: true }];
    }],

    ['POST', '/api/familia/appointments', async (req, url) => {
      const { hh } = authMember(req, url); const b = await readJson(req);
      const date = str(b.date, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) bad('Fecha inválida');
      const at = parseHHMM(b.at); if (at == null) bad('Hora inválida');
      const what = str(b.what, 100); if (!what) bad('Falta con quién es el turno');
      const r = q.run('INSERT INTO appointments (household_id, date, at, what, note, remind_eve) VALUES (?, ?, ?, ?, ?, ?)',
        hh.id, date, at, what, str(b.note, 200), 'remind_eve' in b ? bool(b.remind_eve) : 1);
      changed(hh); return [201, { id: Number(r.lastInsertRowid) }];
    }],
    ['DELETE', '/api/familia/appointments/:id', (req, url, res, p) => {
      const { hh } = authMember(req, url);
      q.run('DELETE FROM appointments WHERE id = ? AND household_id = ?', Number(p.id), hh.id);
      changed(hh); return [200, { ok: true }];
    }],

    ['POST', '/api/familia/contacts', async (req, url) => {
      const { hh } = authMember(req, url); const b = await readJson(req);
      const name = str(b.name, 60); if (!name) bad('Falta el nombre');
      const r = q.run('INSERT INTO contacts (household_id, name, relation, phone) VALUES (?, ?, ?, ?)', hh.id, name, str(b.relation, 40), str(b.phone, 30) || null);
      changed(hh); return [201, { id: Number(r.lastInsertRowid) }];
    }],
    ['DELETE', '/api/familia/contacts/:id', (req, url, res, p) => {
      const { hh } = authMember(req, url);
      q.run('DELETE FROM contacts WHERE id = ? AND household_id = ? AND member_id IS NULL', Number(p.id), hh.id);
      changed(hh); return [200, { ok: true }];
    }],

    // Invitar a otra persona de la familia: recibe su propio link.
    ['POST', '/api/familia/members', async (req, url) => {
      const { member, hh } = authMember(req, url);
      if (!member.is_admin) throw new HttpError(403, 'Solo quien creó el hogar puede invitar');
      const b = await readJson(req);
      const name = str(b.name, 60); if (!name) bad('Falta el nombre');
      const t = token();
      q.tx(() => {
        const m = q.run('INSERT INTO members (household_id, name, relation, phone, token, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          hh.id, name, str(b.relation, 40), str(b.phone, 30) || null, t, core.ts());
        q.run('INSERT INTO contacts (household_id, name, relation, phone, member_id) VALUES (?, ?, ?, ?, ?)',
          hh.id, name, str(b.relation, 40), str(b.phone, 30) || null, Number(m.lastInsertRowid));
      });
      changed(hh); return [201, { token: t }];
    }],
    ['DELETE', '/api/familia/members/:id', (req, url, res, p) => {
      const { member, hh } = authMember(req, url);
      if (!member.is_admin || Number(p.id) === member.id) throw new HttpError(403, 'No permitido');
      q.run('DELETE FROM members WHERE id = ? AND household_id = ?', Number(p.id), hh.id);
      changed(hh); return [200, { ok: true }];
    }],

    ['POST', '/api/familia/push/subscribe', async (req, url) => {
      const { member } = authMember(req, url); const b = await readJson(req);
      if (!push) throw new HttpError(503, 'Push no disponible');
      if (!b.sub?.endpoint || !b.sub?.keys) bad('Suscripción inválida');
      push.subscribe(member.id, b.sub); return [200, { ok: true }];
    }],
    ['POST', '/api/familia/push/test', async (req, url) => {
      const { member, hh } = authMember(req, url);
      await push?.toMember(member.id, { title: 'Tata', body: `Así te van a llegar los avisos de ${hh.elder_name}.`, kind: 'info', url: '/familia/' });
      return [200, { ok: true }];
    }],

    // Audios grabados por la familia (recordatorios con su voz o mensajes de voz).
    ['POST', '/api/familia/audio', async (req, url) => {
      const { hh } = authMember(req, url);
      const mime = String(req.headers['content-type'] || '').split(';')[0];
      if (!/^audio\//.test(mime)) bad('Tiene que ser un audio');
      const data = await readBody(req, 3 * 1024 * 1024);
      if (!data.length) bad('Audio vacío');
      const r = q.run('INSERT INTO audio (household_id, mime, data, created_at) VALUES (?, ?, ?, ?)', hh.id, mime, data, core.ts());
      return [201, { id: Number(r.lastInsertRowid) }];
    }],
    ['GET', '/api/familia/audio/:id', (req, url, res, p) => { const { hh } = authMember(req, url); sendAudio(res, hh, p.id); }],

    // Un mensaje para que Tata le diga ahora (texto o audio grabado).
    ['POST', '/api/familia/say', async (req, url) => {
      const { member, hh } = authMember(req, url); const b = await readJson(req);
      const text = str(b.text, 300); const audioId = audioOf(hh, b.audio_id);
      if (!text && !audioId) bad('El mensaje está vacío');
      const spoken = text ? `${hh.elder_name}, te manda un mensaje ${member.name}: ${text}` : `${hh.elder_name}, te mandó un audio ${member.name}.`;
      let items = audioId ? [{ text: `${hh.elder_name}, te mandó un audio ${member.name}.` }, { text: spoken, audio: `/api/casa/audio/${audioId}` }] : [{ text: spoken }];
      let voiceNote = null;
      if (!audioId && text && b.own_voice) {
        // Tata presenta el mensaje con su voz y después se escucha la voz del familiar.
        const v = await inVoice(member, hh, text);
        if (v.id) items = [{ text: `${hh.elder_name}, ${member.name} te dejó dicho:` }, { text, audio: `/api/casa/audio/${v.id}` }];
        else voiceNote = v.reason;
      }
      const delivered = core.say(hh, items);
      core.notify(hh, 'info', `${member.name} le mandó un mensaje a ${hh.elder_name}`, delivered ? (text || 'Audio') : 'Tata está desconectada: no le llegó.');
      return [200, { delivered, voiceNote }];
    }],

    // Voz del familiar para Tata: una muestra WAV de 10 a 30 segundos, solo con consentimiento explícito.
    ['POST', '/api/familia/voice', async (req, url) => {
      const { member } = authMember(req, url);
      if (url.searchParams.get('consent') !== '1') bad('Falta tu consentimiento');
      const mime = String(req.headers['content-type'] || '').split(';')[0];
      const wav = await readBody(req, 6 * 1024 * 1024);
      if (mime !== 'audio/wav' || wav.subarray(0, 4).toString('latin1') !== 'RIFF') bad('Tiene que ser un WAV');
      const old = q.get('SELECT wav FROM voices WHERE member_id = ?', member.id);
      if (old && !Buffer.from(old.wav).equals(wav)) voice?.forget(old.wav); // la muestra vieja no queda en el motor
      q.run('INSERT INTO voices (member_id, wav, consent_at) VALUES (?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET wav = excluded.wav, consent_at = excluded.consent_at',
        member.id, wav, core.ts());
      return [200, { ok: true }];
    }],
    ['DELETE', '/api/familia/voice', (req, url) => {
      const { member } = authMember(req, url);
      const old = q.get('SELECT wav FROM voices WHERE member_id = ?', member.id);
      q.run('DELETE FROM voices WHERE member_id = ?', member.id);
      if (old) voice?.forget(old.wav);
      return [200, { ok: true }];
    }],
    ['POST', '/api/familia/voice/test', async (req, url, res) => {
      const { member, hh } = authMember(req, url);
      const v = await inVoice(member, hh, `Hola ${hh.elder_name}, soy ${member.name}. Así va a sonar mi voz en Tata.`);
      if (!v.id) throw new HttpError(503, v.reason);
      sendAudio(res, hh, v.id);
      q.run('DELETE FROM audio WHERE id = ?', v.id); // la prueba no se guarda
    }],

    ['POST', '/api/familia/sos/coming', (req, url) => {
      const { member, hh } = authMember(req, url); const s = core.sos(hh); if (!s) return [200, { ok: true }];
      core.setSos(hh, { ...s, state: 'coming', by: member.name });
      core.notify(hh, 'info', `${member.name} va en camino`, `Respondió al pedido de ayuda de ${hh.elder_name}.`);
      core.say(hh, { text: `${hh.elder_name}, ${member.name} ya está yendo para allá. Llega en un ratito.` });
      return [200, { ok: true }];
    }],
    ['POST', '/api/familia/sos/resolve', (req, url) => {
      const { member, hh } = authMember(req, url); if (!core.sos(hh)) return [200, { ok: true }];
      core.setSos(hh, null); core.setConvo(hh, {});
      core.notify(hh, 'ok', 'Situación resuelta', `${member.name} marcó que ${hh.elder_name} está bien.`);
      return [200, { ok: true }];
    }],

    // ----- dispositivo de la casa -----
    ['POST', '/api/casa/pair', async req => {
      const b = await readJson(req);
      const code = str(b.code, 10).replace(/\D/g, '');
      const hh = code.length === 6 && q.get('SELECT * FROM households WHERE device_code = ?', code);
      if (!hh) throw new HttpError(404, 'Código incorrecto');
      const t = token();
      q.run('UPDATE households SET device_token = ?, device_code = ? WHERE id = ?', t, freeCode(), hh.id);
      core.send(hh.id, 'device', { type: 'unpaired' }); // si había otro dispositivo, queda desvinculado
      core.notify(hh, 'info', 'Tata quedó vinculada', `El dispositivo de ${hh.elder_name} ya está conectado.`);
      return [200, { token: t, elder_name: hh.elder_name }];
    }],
    ['GET', '/api/casa/state', (req, url) => [200, deviceView(authDevice(req, url))]],
    ['GET', '/api/casa/stream', (req, url, res) => {
      const hh = authDevice(req, url);
      openStream(req, res, hh.id, 'device');
      q.run('UPDATE households SET last_seen = ?, offline_alerted = 0 WHERE id = ?', core.ts(), hh.id);
      if (hh.offline_alerted) core.notify(hh, 'ok', 'Tata volvió a conectarse', `El dispositivo de ${hh.elder_name} está en línea otra vez.`);
      core.send(hh.id, 'family', { type: 'refresh' });
    }],
    ['POST', '/api/casa/hear', async (req, url) => {
      const hh = authDevice(req, url); const b = await readJson(req);
      const { replies } = await handle(core, hh, str(b.text, 300));
      core.send(hh.id, 'family', { type: 'refresh' });
      return [200, { replies, ui: uiState(core, core.household(hh.id)) }];
    }],
    ['POST', '/api/casa/sos', async (req, url) => {
      const hh = authDevice(req, url); const replies = [];
      await sos(core, hh, 'boton', null, (text, extra = {}) => replies.push({ text, ...extra }));
      return [200, { replies, ui: uiState(core, core.household(hh.id)) }];
    }],
    ['GET', '/api/casa/audio/:id', (req, url, res, p) => sendAudio(res, authDevice(req, url), p.id)]
  ];

  function sendAudio(res, hh, id) {
    const a = q.get('SELECT mime, data FROM audio WHERE id = ? AND household_id = ?', Number(id), hh.id);
    if (!a) throw new HttpError(404, 'No existe');
    res.writeHead(200, { 'content-type': a.mime, 'cache-control': 'private, max-age=86400', 'content-length': a.data.length });
    res.end(Buffer.from(a.data));
  }

  const compiled = routes.map(([method, path, fn]) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    return { method, re, keys, fn };
  });

  async function serveStatic(url, res) {
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) throw new HttpError(404, 'No existe');
    try {
      if (!(await stat(file)).isFile()) throw 0;
    } catch {
      if (!extname(p)) { res.writeHead(301, { location: url.pathname + '/' }); return res.end(); }
      throw new HttpError(404, 'No existe');
    }
    const headers = { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' };
    if (p.endsWith('sw.js')) headers['service-worker-allowed'] = '/familia/';
    res.writeHead(200, headers);
    res.end(await readFile(file));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const r of compiled) {
          const m = r.method === req.method && r.re.exec(url.pathname);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          const out = await r.fn(req, url, res, params);
          if (out) json(res, out[0], out[1]);
          return;
        }
        throw new HttpError(404, 'No existe');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido');
      await serveStatic(url, res);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.headersSent) json(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Error interno' });
      else res.end();
    }
  });

  return { server, core, db, q };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, core } = createApp();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(`Tata escuchando en http://localhost:${port}`));
  startScheduler(core);
}
