// Lo que Tata entiende y responde. Reglas simples y predecibles, pensadas para frases
// cortas dichas en voz alta; el estado de la charla (preguntas pendientes, modo simple)
// queda guardado en el hogar para que sobreviva a recargas del dispositivo.

import { spokenTime, spokenDate, relativeDay, fmtMin, addDays } from './time.js';
import { pickActivity, offerText, detailsText, answer } from './encuentro.js';

export const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[¿?¡!.,;:"“”()]/g, ' ').replace(/\s+/g, ' ').trim();
const cap1 = s => s.charAt(0).toUpperCase() + s.slice(1);

export const GUIDES = {
  transferencia: {
    title: 'Hacer una transferencia', done: 'Hizo una transferencia con ayuda de Tata', steps: [
      'Abrí la aplicación de tu banco en el celular. Avisame cuando estés adentro.',
      'Buscá el botón que dice "Transferir" y tocalo. Suele estar abajo de todo.',
      'Ahora elegí a quién le mandás. Si ya lo tenés agendado, tocá su nombre en la lista.',
      'Escribí el monto con números, sin puntos ni comas. Por ejemplo: quince mil es 15000.',
      'Revisá que el nombre sea el correcto y tocá "Confirmar".'
    ]
  },
  foto: {
    title: 'Mandar una foto por WhatsApp', done: 'Mandó una foto por WhatsApp con ayuda de Tata', steps: [
      'Abrí WhatsApp, el ícono verde con el teléfono.',
      'Tocá el nombre de la persona a la que le querés mandar la foto.',
      'Abajo, al lado de donde se escribe, tocá el dibujito del clip o de la cámara.',
      'Elegí la foto tocándola una vez.',
      'Tocá la flechita verde para enviarla.'
    ]
  },
  videollamada: {
    title: 'Hacer una videollamada por WhatsApp', done: 'Hizo una videollamada con ayuda de Tata', steps: [
      'Abrí WhatsApp, el ícono verde con el teléfono.',
      'Tocá el nombre de la persona que querés ver.',
      'Arriba a la derecha hay un dibujito de una cámara. Tocalo una vez.',
      'Esperá a que atienda. Si querés cortar, tocá el botón rojo.'
    ]
  }
};

const RELATIONS = ['hija', 'hijo', 'nieta', 'nieto', 'vecina', 'vecino', 'hermana', 'hermano', 'sobrina', 'sobrino', 'amiga', 'amigo', 'nuera', 'yerno', 'cuidadora', 'cuidador', 'medico', 'medica'];

export function findContact(core, hh, t) {
  const contacts = core.q.all('SELECT * FROM contacts WHERE household_id = ? ORDER BY id', hh.id);
  const words = ` ${norm(t)} `;
  const byName = contacts.find(c => words.includes(` ${norm(c.name)} `) || norm(c.name).split(' ').some(w => w.length > 2 && words.includes(` ${w} `)));
  if (byName) return byName;
  const rel = RELATIONS.find(r => words.includes(` ${r} `));
  if (rel) return contacts.find(c => norm(c.relation).startsWith(rel)) || null;
  return null;
}

function todayMeds(core, hh) {
  const { date, wd } = core.now(hh);
  return core.q.all(`SELECT r.*, rr.fired_at, rr.done_at FROM reminders r
    LEFT JOIN reminder_runs rr ON rr.reminder_id = r.id AND rr.date = ?
    WHERE r.household_id = ? AND r.active = 1 AND r.is_med = 1 AND (r.date = ? OR (r.date IS NULL AND instr(r.days, ?) > 0))
    ORDER BY r.at`, date, hh.id, date, String(wd));
}
function pendingMed(core, hh) {
  const meds = todayMeds(core, hh).filter(r => !r.done_at);
  return meds.find(r => r.fired_at) || meds[0] || null;
}

/** Lo que ella dijo -> lo que responde Tata. La primera vez en la mañana, suma el resumen del día. */
export async function handle(core, hh, raw) {
  const out = await respond(core, hh, raw);
  morning(core, hh, out.replies);
  return out;
}

// Resumen de la mañana: la primera vez que ella habla entre las 6 y las 13, después de contestarle.
// Nunca arranca solo (para no asustarla) y no interrumpe un pedido de ayuda ni una pregunta pendiente.
function morning(core, hh, replies) {
  const now = core.now(hh);
  if (!replies.length || now.min < 360 || now.min >= 780 || core.sos(hh)) return;
  const c = core.convo(hh);
  if (c.confirm || c.guide || c.awaitWho) return;
  const day = core.day(hh, now.date);
  if (day.briefed) return;
  core.q.run('UPDATE days SET briefed = ? WHERE household_id = ? AND date = ?', core.ts(), hh.id, now.date);
  const parts = [];
  const r = pendingMed(core, hh);
  if (r && r.at <= now.min) parts.push(`Te toca ${r.say}.`);
  if (day.news || day.weather) parts.push(day.news || day.weather);
  const p = pickActivity(core, hh);
  if (p) {
    parts.push(offerText(hh, p.a, p.date, now.date));
    core.setConvo(hh, { ...c, confirm: { kind: 'activity', id: p.a.id, date: p.date }, lastActivity: { id: p.a.id, date: p.date } });
  }
  if (!parts.length) return;
  if (!/^¡?Buen día/.test(replies[0].text)) parts.unshift(`Buen día, ${hh.elder_name}.`);
  replies.push({ text: parts.join(' ') });
}

// "Estoy bien", "fue sin querer"... pero nunca si dice que NO está bien o nombra algo que le pasa.
const OK_NOW = /\b(estoy bien|ya estoy bien|todo bien|fue sin querer|sin querer|me equivoque|falsa alarma|no pasa nada|no necesito ayuda|no hace falta|cancela(r)?( la ayuda| el aviso)?)\b/;
const STILL_BAD = /\b(me duele|me cai|mareada|mareado|no puedo|sangre|ayuda ya|ayudame|socorro|auxilio|emergencia|me siento mal)\b/;
const OOPS = /\b(sin querer|falsa alarma|me equivoque)\b/;
function okNow(t, raw) {
  if (!OK_NOW.test(t) || STILL_BAD.test(t)) return false;
  // "No, estoy bien" cierra; "no estoy bien" no. Se mira con la puntuación original.
  const low = String(raw).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/\bno\s+(estoy|me siento)\s+bien/.test(low) && !OOPS.test(t)) return false;
  return true;
}

async function respond(core, hh, raw) {
  const replies = [];
  const say = (text, extra = {}) => replies.push({ text, ...extra });
  const t = norm(raw).replace(/^(oye |che )?tata /, '');
  const name = hh.elder_name;
  const now = core.now(hh);
  if (!t) return { replies };

  core.touch(hh);
  const convo = core.convo(hh);
  const set = c => core.setConvo(hh, c);
  const yes = /\b(si|dale|bueno|claro|ok|okey|por favor|obvio|bueno dale)\b/.test(t) && !/\bno\b/.test(t);
  const no = /\b(no|deja|despues|nada|todavia)\b/.test(t);

  // --- 0. con el pedido de ayuda abierto, ella misma puede decir que está bien ---
  if (core.sos(hh)?.state === 'open' && okNow(t, raw)) {
    core.setSos(hh, null); set({});
    core.activity(hh, 'Dijo que está bien');
    core.notify(hh, 'ok', `${name} está bien`, `Le dijo a Tata: “${raw}”. El pedido de ayuda quedó cerrado.`, null, { push: true, tag: 'sos-' + hh.id });
    say(`Qué alivio, ${name}. Ya le avisé a tu familia que estás bien.`);
    return { replies };
  }

  // --- 1. respuestas a una pregunta que hizo Tata ---
  if (convo.confirm && (yes || no)) {
    const c = convo.confirm;
    set({ ...convo, confirm: undefined });
    if (yes) return (await confirmYes(core, hh, c, say), { replies });
    if (c.kind === 'activity') answer(core, hh, c.id, c.date, 'no');
    if (c.kind === 'emergency') say('Bueno. Quedate sentada tranquila, que tu familia ya sabe.');
    else if (c.kind === 'pill') say('Bueno, tomala cuando puedas y avisame.');
    else say('Bueno, no hay problema.');
    return { replies };
  }
  if (convo.awaitWho) {
    set({ ...convo, awaitWho: undefined });
    const c = findContact(core, hh, t);
    if (c) return (callContact(core, hh, c, say), { replies });
  }
  if (convo.guide) {
    const g = convo.guide, G = GUIDES[g.key];
    if (/\b(repeti|repetir|otra vez|como era|no entendi)\b/.test(t)) { say(G.steps[g.i]); return { replies }; }
    if (/\b(para|basta|salir|cancela|despues sigo|deja|dejemos)\b/.test(t)) {
      set({}); say('Dejamos acá. Cuando quieras seguimos.'); return { replies };
    }
    if (/\b(listo|ya|siguiente|dale|hecho|ok|lo hice|y ahora|ya esta)\b/.test(t)) {
      const i = g.i + 1;
      if (i >= G.steps.length) {
        set({}); core.activity(hh, G.done);
        say(`¡Listo, ${name}! Lo hiciste vos. Cuando lo necesites de nuevo, pedímelo.`);
      } else { set({ guide: { key: g.key, i } }); say(G.steps[i]); }
      return { replies };
    }
  }

  // --- 2. pedidos nuevos ---
  if (/(necesito ayuda|me siento mal|me cai|socorro|auxilio|me duele|mareada|mareado|emergencia|ayudame|ayuda|no puedo respirar|me cai)/.test(t)
      && !/(transferencia|whatsapp|foto|celular|app|banco|videollamada)/.test(t)) {
    return (await sos(core, hh, 'voz', raw, say), { replies });
  }
  if (/(transferencia|transferir|mandar plata|pasar plata|banco)/.test(t)) return (guideStart(core, hh, 'transferencia', say), { replies });
  if (/(videollamada|video llamada|verle la cara|verla|verlo)/.test(t)) return (guideStart(core, hh, 'videollamada', say), { replies });

  const m = t.match(/(?:decile|avisale|mandale un mensaje|escribile|contale)\s+a\s+(?:mi\s+)?(\w+)\s+(?:que\s+)?(.+)/);
  if (m) {
    const c = findContact(core, hh, m[1]);
    if (!c) { say('No tengo a esa persona en tus contactos. Tu familia la puede agregar desde su celular.'); return { replies }; }
    const msg = cap1(m[2].trim());
    core.activity(hh, `Le mandó un mensaje a ${c.name}`);
    core.notify(hh, 'msg', `Mensaje de ${name} para ${c.name}`, `“${msg}” · dictado a Tata`, null, c.member_id ? { to: c.member_id } : {});
    say(c.member_id ? `Listo, le mandé a ${c.name}: ${msg}.` : `Le dejé el mensaje a tu familia para ${c.name}: ${msg}.`);
    return { replies };
  }
  if (/(foto|whatsapp|wasap|guasap)/.test(t)) return (guideStart(core, hh, 'foto', say), { replies });

  if (/\b(llama|llamar|llamame|llamale|llames|comunicame|hablar con|habla con)\b/.test(t) && !/\bse llama\b/.test(t)) {
    const c = findContact(core, hh, t);
    if (c) return (callContact(core, hh, c, say), { replies });
    const names = core.q.all('SELECT name FROM contacts WHERE household_id = ? ORDER BY id LIMIT 3', hh.id).map(x => x.name);
    if (!names.length) { say('Todavía no tengo contactos. Tu familia los puede cargar desde su celular.'); return { replies }; }
    set({ awaitWho: true });
    say(`¿A quién llamo? ¿${names.length > 1 ? names.slice(0, -1).map(n => 'A ' + n).join(', ') + ' o a ' + names.at(-1) : 'A ' + names[0]}?`);
    return { replies };
  }

  if (/(ya (la |me la |lo |me lo )?tome|me la tome|me lo tome|tomada|ya me tome)/.test(t)) return (pillDone(core, hh, say), { replies });
  if (/(pastilla|remedio|medicamento|me toca|medicacion)/.test(t)) {
    const r = pendingMed(core, hh);
    if (!r) say('Por hoy no te toca ningún otro remedio. Si tu familia agrega uno, yo te aviso.');
    else if (r.fired_at || r.at <= now.min) {
      set({ confirm: { kind: 'pill' } });
      say(`Te toca ${r.say}, desde las ${fmtMin(r.at)}. ¿Ya la tomaste?`);
    } else say(`A las ${fmtMin(r.at)} te toca ${r.say}. Tranquila, yo te aviso.`);
    return { replies };
  }
  if (/(turno|medico|doctor|dentista|consulta|cita)/.test(t)) {
    const list = core.q.all('SELECT * FROM appointments WHERE household_id = ? AND date >= ? ORDER BY date, at', hh.id, now.date);
    if (!list.length) { say('No tengo ningún turno anotado. Si querés, le pido a tu familia que lo cargue.'); return { replies }; }
    const a = list.find(x => t.split(' ').some(w => w.length > 4 && norm(x.what).includes(w))) || list[0];
    core.activity(hh, 'Consultó su próximo turno');
    const base = `Tu turno es ${relativeDay(a.date, now.date)} a las ${fmtMin(a.at)}, con ${a.what}.${a.note ? ' ' + a.note : ''}`;
    if (a.remind_eve || a.date <= addDays(now.date, 1)) say(base + (a.remind_eve && a.date > addDays(now.date, 1) ? ' La noche anterior te lo recuerdo.' : ''));
    else { set({ confirm: { kind: 'turnoEve', id: a.id } }); say(base + ' ¿Querés que te lo recuerde la noche anterior?'); }
    return { replies };
  }
  if (/(que hora|hora es)/.test(t)) { say(spokenTime(now.min) + '.'); return { replies }; }
  if (/(que dia|que fecha|dia es hoy)/.test(t)) { say('Hoy es ' + spokenDate(now.date) + '.'); return { replies }; }
  // Charla corta: con Claude disponible, solo para frases breves; lo demás lo charla él.
  const brief = !core.ai || t.split(' ').length <= 5;
  if (brief && /\b(sola|solo|aburrida|aburrido|triste|extrano)\b/.test(t)) {
    const c = core.q.get("SELECT * FROM contacts WHERE household_id = ? ORDER BY CASE WHEN relation LIKE 'niet%' THEN 0 ELSE 1 END, id LIMIT 1", hh.id);
    if (c) { set({ confirm: { kind: 'call', id: c.id } }); say(`Te entiendo, ${name}. ¿Querés que le avise a ${c.name} para charlar un rato?`); }
    else say(`Te entiendo, ${name}. Acá estoy con vos.`);
    return { replies };
  }
  if (brief && /\b(hola|buen dia|buenas|buenos dias|buenas tardes|buenas noches)\b/.test(t)) {
    say(`${now.min < 720 ? '¡Buen día' : now.min < 1200 ? '¡Buenas tardes' : '¡Buenas noches'}, ${name}! ¿En qué te ayudo?`); return { replies };
  }
  if (brief && /(estoy bien|todo bien|\bbien\b|recien me levanto|amaneci bien)/.test(t)) { say(`Me alegro mucho, ${name}. Cualquier cosa, acá estoy.`); return { replies }; }
  if (brief && /gracias/.test(t)) { say(`De nada, ${name}. Para eso estoy.`); return { replies }; }

  // Encuentro y novedades del día. Con Claude, solo para pedidos cortos: lo largo es charla.
  const ask = !core.ai || t.split(' ').length <= 7;
  if (ask && /(que hay para hacer|alguna actividad|que puedo hacer hoy|actividades)/.test(t)) {
    const p = pickActivity(core, hh);
    if (!p) { say('Hoy no tengo actividades cerca para sugerirte.'); return { replies }; }
    set({ ...convo, confirm: { kind: 'activity', id: p.a.id, date: p.date }, lastActivity: { id: p.a.id, date: p.date } });
    say(offerText(hh, p.a, p.date, now.date));
    return { replies };
  }
  if (ask && convo.lastActivity && /(donde es|a que hora es|cuanto sale|cuanto cuesta)/.test(t)) {
    const a = core.q.get('SELECT * FROM activities WHERE id = ?', convo.lastActivity.id);
    if (a) { say(detailsText(a, convo.lastActivity.date, now.date)); return { replies }; }
  }
  if (ask && /(contame una noticia|que hay de nuevo|novedades|como va a estar el dia|como esta el dia|el clima)/.test(t)) {
    const day = core.day(hh, now.date);
    say(day.news || day.weather || 'Hoy no tengo novedades para contarte.');
    return { replies };
  }

  // Nada de lo anterior: si hay Claude, que charle él.
  if (core.ai) {
    const ai = await core.ai.reply(core, hh, String(raw).trim());
    if (ai?.length) return { replies: ai };
  }
  say(`Perdoná, ${name}, no te entendí bien. Podés pedirme que llame a alguien, preguntarme por tus turnos o tus remedios, o decirme "necesito ayuda".`);
  return { replies };
}

async function confirmYes(core, hh, c, say) {
  const replies = [];
  if (c.kind === 'pill') return pillDone(core, hh, say);
  if (c.kind === 'activity') {
    const a = core.q.get('SELECT * FROM activities WHERE id = ?', c.id);
    if (a) {
      answer(core, hh, a.id, c.date, 'si');
      core.setConvo(hh, { ...core.convo(hh), lastActivity: { id: a.id, date: c.date } });
      say(`¡Qué lindo! ${detailsText(a, c.date, core.now(hh).date)} Le aviso a tu familia.`);
    }
  }
  if (c.kind === 'call') {
    const ct = core.q.get('SELECT * FROM contacts WHERE id = ? AND household_id = ?', c.id, hh.id);
    if (ct) return callContact(core, hh, ct, say);
  }
  if (c.kind === 'turnoEve') {
    core.q.run('UPDATE appointments SET remind_eve = 1 WHERE id = ? AND household_id = ?', c.id, hh.id);
    core.notify(hh, 'info', 'Tata va a recordarle el turno', `${hh.elder_name} pidió que se lo recuerde la noche anterior.`);
    say('Listo. La noche anterior te lo recuerdo.');
  }
  if (c.kind === 'emergency') {
    core.notify(hh, 'alert', `${hh.elder_name} pidió llamar a emergencias`, `A las ${fmtMin(core.now(hh).min)}. Tata le mostró el botón para llamar al ${hh.emergency_phone}.`, null, { tag: 'sos-' + hh.id });
    say(`Les avisé a todos. Si podés, tocá el botón rojo para llamar al ${hh.emergency_phone}. Quedate sentada, que ya vienen.`,
      { action: { type: 'dial', phone: hh.emergency_phone, label: `Llamar al ${hh.emergency_phone}` } });
  }
  return replies;
}

function pillDone(core, hh, say) {
  const r = pendingMed(core, hh);
  if (!r) { say(`Anotado, ${hh.elder_name}. Hoy ya tenías todo tomado.`); return []; }
  const { date, min } = core.now(hh);
  core.q.run('INSERT INTO reminder_runs (reminder_id, date, fired_at, done_at) VALUES (?, ?, ?, ?) ON CONFLICT(reminder_id, date) DO UPDATE SET done_at = excluded.done_at',
    r.id, date, core.ts(), core.ts());
  core.activity(hh, 'Tomó ' + r.label.toLowerCase());
  core.notify(hh, 'ok', `${hh.elder_name} tomó la pastilla`, `${r.label} · confirmó a las ${fmtMin(min)}`);
  say(`¡Perfecto, ${hh.elder_name}! Anotado. Le aviso a tu familia que ya la tomaste.`);
  return [];
}

function callContact(core, hh, c, say) {
  core.activity(hh, `Pidió hablar con ${c.name}`);
  if (c.member_id) {
    core.notify(hh, 'msg', `${hh.elder_name} quiere hablar con vos`, `Te pidió por Tata a las ${fmtMin(core.now(hh).min)}. Llamala cuando puedas.`, null,
      { to: c.member_id, tag: 'call-' + c.id });
  }
  const action = c.phone ? { type: 'dial', phone: c.phone, label: `Llamar a ${c.name}` } : null;
  if (c.member_id && action) say(`Le avisé a ${c.name} que querés hablar. Si querés llamar ahora, tocá el botón verde.`, { action });
  else if (c.member_id) say(`Le avisé a ${c.name} que querés hablar. Te va a llamar apenas pueda.`);
  else if (action) say(`Para llamar a ${c.name}, tocá el botón verde.`, { action });
  else say(`No tengo el número de ${c.name}. Tu familia lo puede cargar desde su celular.`);
  return [];
}

function guideStart(core, hh, key, say) {
  core.setConvo(hh, { guide: { key, i: 0 } });
  say('Vamos juntas, paso a paso. Y acordate: yo nunca te voy a pedir tu clave.');
  say(GUIDES[key].steps[0]);
  return [];
}

export async function sos(core, hh, source, raw, say = () => {}) {
  const cur = core.sos(hh);
  if (cur && cur.state === 'open') { say('Ya les avisé, ' + hh.elder_name + '. Tu familia ya sabe. Estoy acá con vos.'); return []; }
  core.setSos(hh, { at: core.ts(), state: 'open', source, raw: source === 'voz' ? raw : null });
  core.touch(hh);
  core.activity(hh, 'Pidió ayuda');
  core.notify(hh, 'alert', `${hh.elder_name} pidió ayuda`, source === 'voz' ? `Le dijo a Tata: “${raw}”` : 'Apretó el botón SOS de Tata.', null, { tag: 'sos-' + hh.id });
  core.setConvo(hh, { confirm: { kind: 'emergency' } });
  say(`Tranquila, ${hh.elder_name}. Ya le avisé a tu familia. Estoy acá con vos.`);
  say('¿Querés que llame a emergencias?');
  return [];
}

/** Estado visible en la pantalla de la casa: qué botones mostrar según la charla. */
export function uiState(core, hh) {
  const convo = core.convo(hh);
  const sosNow = core.sos(hh);
  const now = core.now(hh);
  let chips;
  if (convo.confirm) chips = ['Sí, dale', 'No, gracias'];
  else if (convo.guide) chips = ['Listo', 'Repetí, por favor', 'Dejemos para después'];
  else if (convo.awaitWho) chips = core.q.all('SELECT name FROM contacts WHERE household_id = ? ORDER BY id LIMIT 4', hh.id).map(c => 'A ' + c.name);
  else {
    chips = [];
    const pm = todayMeds(core, hh).find(r => r.fired_at && !r.done_at);
    if (pm) chips.push('Ya la tomé');
    const d = core.day(hh, now.date);
    if (d.check_asked && !d.first_activity) chips.push('Bien, Tata. Recién me levanto');
  }
  if (sosNow?.state === 'open' && !convo.confirm) chips.unshift('Estoy bien');
  const guide = convo.guide ? { title: GUIDES[convo.guide.key].title, i: convo.guide.i, n: GUIDES[convo.guide.key].steps.length, text: GUIDES[convo.guide.key].steps[convo.guide.i] } : null;
  const upcoming = core.q.all(`SELECT r.label, r.at, rr.done_at FROM reminders r
    LEFT JOIN reminder_runs rr ON rr.reminder_id = r.id AND rr.date = ?
    WHERE r.household_id = ? AND r.active = 1 AND (r.date = ? OR (r.date IS NULL AND instr(r.days, ?) > 0)) ORDER BY r.at`,
    now.date, hh.id, now.date, String(now.wd));
  return { chips, guide, sos: sosNow, today: upcoming.map(r => ({ label: r.label, at: fmtMin(r.at), done: !!r.done_at, past: r.at <= now.min })) };
}
