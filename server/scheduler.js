// Lo que pasa solo, sin que nadie hable: recordatorios, seguimiento de la pastilla,
// turnos de mañana, la pregunta de la mañana si no hubo actividad, el resumen de la
// noche y el aviso si el dispositivo se desconecta. Corre cada 30 segundos.

import { spokenTime, fmtMin, addDays, localNow } from './time.js';

const MIN = 60_000;
export const RULES = {
  lateWindow: 60,        // un recordatorio atrasado más de esto (min) ya no se dice
  pillNudge: 30 * MIN,   // Tata vuelve a preguntar por la pastilla
  pillEscalate: 60 * MIN,// la familia recibe aviso si no confirmó
  inactWait: 15 * MIN,   // tras preguntar "¿cómo amaneciste?", espera esto antes de avisar
  offlineAfter: 10 * MIN,
  eveAt: 20 * 60         // recordatorio de turnos: 20:00 del día anterior
};

export function tickHousehold(core, hh) {
  const { q } = core;
  const now = core.now(hh);
  const ts = core.ts();
  const name = hh.elder_name;
  const online = core.deviceOnline(hh.id);

  // 1. recordatorios del día
  const due = q.all(`SELECT r.* FROM reminders r
    WHERE r.household_id = ? AND r.active = 1 AND r.at <= ?
      AND (r.date = ? OR (r.date IS NULL AND instr(r.days, ?) > 0))
      AND NOT EXISTS (SELECT 1 FROM reminder_runs rr WHERE rr.reminder_id = r.id AND rr.date = ?)`,
    hh.id, now.min, now.date, String(now.wd), now.date);
  for (const r of due) {
    if (now.min - r.at > RULES.lateWindow) {
      q.run('INSERT INTO reminder_runs (reminder_id, date, missed) VALUES (?, ?, 1)', r.id, now.date);
      continue;
    }
    q.run('INSERT INTO reminder_runs (reminder_id, date, fired_at) VALUES (?, ?, ?)', r.id, now.date, ts);
    const hora = spokenTime(now.min).toLowerCase();
    const text = r.is_med ? `${name}, ${hora}. Te toca ${r.say}. Avisame cuando la tomes.` : `${name}, te recuerdo: ${r.say}.`;
    const item = { text, ...(r.audio_id ? { audio: `/api/casa/audio/${r.audio_id}` } : {}) };
    if (r.is_med) core.setConvo(hh, { confirm: { kind: 'pill' } });
    if (!core.say(hh, item)) {
      core.notify(hh, 'warn', 'Tata no pudo dar un recordatorio', `${r.label} (${fmtMin(r.at)}): el dispositivo de ${name} está desconectado.`);
    }
    core.send(hh.id, 'family', { type: 'refresh' });
  }

  // 2. seguimiento de la pastilla
  const open = q.all(`SELECT r.*, rr.fired_at, rr.nudged, rr.escalated FROM reminder_runs rr JOIN reminders r ON r.id = rr.reminder_id
    WHERE r.household_id = ? AND rr.date = ? AND r.is_med = 1 AND rr.fired_at IS NOT NULL AND rr.done_at IS NULL`, hh.id, now.date);
  for (const r of open) {
    if (!r.nudged && ts - r.fired_at >= RULES.pillNudge) {
      q.run('UPDATE reminder_runs SET nudged = 1 WHERE reminder_id = ? AND date = ?', r.id, now.date);
      core.setConvo(hh, { confirm: { kind: 'pill' } });
      core.say(hh, { text: `${name}, ¿ya tomaste ${r.say}?` });
    }
    if (!r.escalated && ts - r.fired_at >= RULES.pillEscalate) {
      q.run('UPDATE reminder_runs SET escalated = 1 WHERE reminder_id = ? AND date = ?', r.id, now.date);
      core.notify(hh, 'warn', `${name} no confirmó la pastilla`, `${r.label} de las ${fmtMin(r.at)}. Tata le preguntó dos veces. ¿La llamás?`);
    }
  }

  // 3. turnos de mañana
  if (now.min >= RULES.eveAt) {
    const tomorrow = addDays(now.date, 1);
    for (const a of q.all('SELECT * FROM appointments WHERE household_id = ? AND date = ? AND remind_eve = 1 AND eve_done = 0', hh.id, tomorrow)) {
      q.run('UPDATE appointments SET eve_done = 1 WHERE id = ?', a.id);
      core.say(hh, { text: `${name}, te recuerdo que mañana a las ${fmtMin(a.at)} tenés turno con ${a.what}.${a.note ? ' ' + a.note : ''}` });
    }
  }

  // 4. mañana sin actividad: primero se le pregunta a ella, después se avisa
  const day = core.day(hh, now.date);
  if (hh.inactivity_on && now.min >= hh.inactivity_at && (day.check_asked != null || now.min < hh.inactivity_at + 180) && day.first_activity == null) {
    if (day.check_asked == null) {
      q.run('UPDATE days SET check_asked = ? WHERE household_id = ? AND date = ?', ts, hh.id, now.date);
      if (!core.say(hh, { text: `Buen día, ${name}. ¿Cómo amaneciste?` })) {
        q.run('UPDATE days SET inact_alerted = 1 WHERE household_id = ? AND date = ?', hh.id, now.date);
        core.notify(hh, 'warn', `${name} no habló con Tata esta mañana`, `No hubo actividad hasta las ${fmtMin(now.min)} y el dispositivo está desconectado. ¿La llamás?`);
      }
      core.send(hh.id, 'device', { type: 'refresh' });
    } else if (day.inact_alerted === 0 && ts - day.check_asked >= RULES.inactWait) {
      q.run('UPDATE days SET inact_alerted = 1 WHERE household_id = ? AND date = ?', hh.id, now.date);
      core.notify(hh, 'warn', `${name} no habló con Tata esta mañana`, `No hubo actividad hasta las ${fmtMin(now.min)}. Tata le preguntó cómo estaba y no respondió. ¿La llamás?`);
    }
  }

  // 5. resumen de la noche
  if (hh.summary_on && now.min >= hh.summary_at && now.min - hh.summary_at < 120 && !day.summary_sent) {
    q.run('UPDATE days SET summary_sent = 1 WHERE household_id = ? AND date = ?', hh.id, now.date);
    const items = q.all('SELECT ts, text FROM activity WHERE household_id = ? AND date = ? ORDER BY ts', hh.id, now.date)
      .map(a => `${fmtMin(localNow(hh.timezone, new Date(a.ts)).min)} · ${a.text}`);
    const alerts = q.all("SELECT ts FROM events WHERE household_id = ? AND kind IN ('alert','warn') AND ts > ?", hh.id, ts - 24 * 60 * MIN)
      .filter(e => localNow(hh.timezone, new Date(e.ts)).date === now.date).length;
    const body = alerts ? `Hoy hubo ${alerts} aviso${alerts > 1 ? 's' : ''}.` : `Ningún aviso en el día. ${name} estuvo bien.`;
    core.notify(hh, 'ok', `Resumen del día de ${name}`, items.length ? body : body + ' No registró actividad con Tata.', items, { push: true, tag: 'summary-' + hh.id });
    core.say(hh, { text: `Buenas noches, ${name}. Que descanses.` });
  }

  // 6. dispositivo desconectado
  if (!online && hh.last_seen && ts - hh.last_seen > RULES.offlineAfter && !hh.offline_alerted) {
    q.run('UPDATE households SET offline_alerted = 1 WHERE id = ?', hh.id);
    core.notify(hh, 'warn', 'Tata está desconectada', `Desde las ${fmtMin(localNow(hh.timezone, new Date(hh.last_seen)).min)}. Revisá que esté enchufada y con wifi.`);
  }
}

export function startScheduler(core, everyMs = 30_000) {
  const run = () => {
    for (const { id } of core.q.all('SELECT id FROM households')) {
      try { tickHousehold(core, core.household(id)); } catch (e) { console.error('scheduler', id, e); }
    }
    core.keepalive();
  };
  run();
  return setInterval(run, everyMs);
}
