// Núcleo compartido: hogares, avisos a la familia, actividad del día y canal en vivo
// (Server-Sent Events) con el dispositivo de la casa y los celulares de la familia.

import { localNow, fmtMin } from './time.js';

export function createCore({ q, push = null, clock = () => new Date() }) {
  const clients = new Map(); // householdId -> Set<{ res, role, memberId }>

  const core = {
    q, clock,

    household(id) { return q.get('SELECT * FROM households WHERE id = ?', id); },
    now(hh) { return localNow(hh.timezone, clock()); },
    ts() { return clock().getTime(); },

    convo(hh) {
      const c = JSON.parse(hh.convo || '{}');
      if (c.expires && c.expires < core.ts()) return {};
      return c;
    },
    setConvo(hh, c) {
      const v = JSON.stringify(Object.keys(c).length ? { ...c, expires: core.ts() + 5 * 60_000 } : {});
      q.run('UPDATE households SET convo = ? WHERE id = ?', v, hh.id);
      hh.convo = v;
    },
    sos(hh) { return hh.sos ? JSON.parse(hh.sos) : null; },
    setSos(hh, s) {
      hh.sos = s ? JSON.stringify(s) : null;
      q.run('UPDATE households SET sos = ? WHERE id = ?', hh.sos, hh.id);
      core.send(hh.id, 'all', { type: 'refresh' });
    },

    day(hh, date = core.now(hh).date) {
      q.run('INSERT OR IGNORE INTO days (household_id, date) VALUES (?, ?)', hh.id, date);
      return q.get('SELECT * FROM days WHERE household_id = ? AND date = ?', hh.id, date);
    },

    /** Elsa hizo algo (habló, apretó un botón): cuenta como actividad del día. */
    touch(hh) {
      const { date } = core.now(hh);
      const d = core.day(hh, date);
      if (d.first_activity == null) q.run('UPDATE days SET first_activity = ? WHERE household_id = ? AND date = ?', core.ts(), hh.id, date);
      if (d.inact_alerted === 1) {
        q.run('UPDATE days SET inact_alerted = 2 WHERE household_id = ? AND date = ?', hh.id, date);
        core.notify(hh, 'ok', `${hh.elder_name} ya habló con Tata`, `Todo en orden: respondió a las ${fmtMin(core.now(hh).min)}.`, null, { push: true });
      }
    },

    /** Registro de lo que hizo Elsa en el día (va al resumen de la noche). */
    activity(hh, text) {
      const { date } = core.now(hh);
      q.run('INSERT INTO activity (household_id, ts, date, text) VALUES (?, ?, ?, ?)', hh.id, core.ts(), date, text);
      core.send(hh.id, 'family', { type: 'refresh' });
    },

    /**
     * Aviso al celular de la familia. Queda en el historial y, según el tipo, llega como notificación push.
     * kind: alert | warn | ok | msg | info
     */
    notify(hh, kind, title, body = '', list = null, opts = {}) {
      q.run('INSERT INTO events (household_id, ts, kind, title, body, list) VALUES (?, ?, ?, ?, ?, ?)',
        hh.id, core.ts(), kind, title, body, list ? JSON.stringify(list) : null);
      core.send(hh.id, 'family', { type: 'event', kind, title });
      const wantsPush = kind === 'alert' || kind === 'warn' || opts.push || opts.to;
      if (push && wantsPush) {
        const members = opts.to
          ? q.all('SELECT id FROM members WHERE id = ?', opts.to)
          : q.all('SELECT id FROM members WHERE household_id = ? AND gets_alerts = 1', hh.id);
        for (const m of members) {
          push.toMember(m.id, { title, body, kind, url: '/familia/', tag: opts.tag || kind + '-' + hh.id }).catch(() => {});
        }
      }
    },

    /** Le pide al dispositivo de la casa que diga algo (si está conectado). Devuelve si llegó. */
    say(hh, items) {
      return core.send(hh.id, 'device', { type: 'say', items: [].concat(items) }) > 0;
    },

    // ---- canal en vivo ----
    attach(hhId, res, role, memberId = null) {
      if (!clients.has(hhId)) clients.set(hhId, new Set());
      const c = { res, role, memberId };
      clients.get(hhId).add(c);
      return () => { clients.get(hhId)?.delete(c); };
    },
    deviceOnline(hhId) {
      return [...(clients.get(hhId) || [])].some(c => c.role === 'device');
    },
    send(hhId, role, msg) {
      let n = 0;
      for (const c of clients.get(hhId) || []) {
        if (role !== 'all' && c.role !== role) continue;
        try { c.res.write(`data: ${JSON.stringify(msg)}\n\n`); n++; } catch { /* conexión caída */ }
      }
      return n;
    },
    keepalive() {
      for (const set of clients.values()) for (const c of set) { try { c.res.write(': ping\n\n'); } catch {} }
    }
  };
  return core;
}
