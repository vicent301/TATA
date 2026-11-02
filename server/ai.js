// Charla libre con Claude para todo lo que las reglas de brain.js no entienden.
// SOS, pastillas y turnos siguen siendo reglas fijas; Claude conversa, acompaña y puede
// usar unas pocas herramientas (avisar a un familiar, anotar un recordatorio, recordar algo
// que ella contó o pedir ayuda). Si no hay ANTHROPIC_API_KEY, Tata funciona como antes.

import Anthropic from '@anthropic-ai/sdk';
import { spokenDate, spokenTime, fmtMin, parseHHMM, addDays, relativeDay } from './time.js';
import { findContact, sos } from './brain.js';
import { upcoming } from './encuentro.js';
import { createOpenAiCompatClient, GEMINI_BASE_URL } from './openai-compat.js';

const DEFAULT_MODEL = 'claude-opus-5-5';
const SESSION_IDLE_MS = 30 * 60_000;   // después de media hora sin charlar, arranca una charla nueva
const SESSION_MAX_ROWS = 60;           // y también si la charla se hizo muy larga
const MAX_STEPS = 4;                   // vueltas de herramientas por cada cosa que dice

const system = hh => `Sos Tata, una compañera de voz que vive en un parlante en la casa de ${hh.elder_name}, una persona mayor que vive en Argentina. Su familia te configuró para acompañarla.

Cómo hablás:
- Todo lo que escribís se lee en voz alta. Respondé en una a tres oraciones cortas, con palabras simples.
- Hablá en castellano rioplatense, con voseo, cálida y paciente, como una amiga de la casa. Llamala por su nombre de vez en cuando.
- Nada de listas, emojis, asteriscos ni direcciones web. Los números, como se dicen.
- Si no entendiste, pedile que lo repita con otras palabras.

Qué hacés:
- Charlás, acompañás, contestás preguntas generales (historia, recetas, palabras, el día) y le seguís la conversación.
- Usá las herramientas cuando ella lo pide: avisarle algo a un familiar, anotar un recordatorio, o guardar algo que te contó y quiere que recuerdes.
- Si ella se siente mal, se cayó, le falta el aire o hay cualquier urgencia, usá pedir_ayuda enseguida. Ante la duda, también.

Cuidados:
- No des diagnósticos ni cambies dosis de remedios. Para eso, sugerile hablar con su médico o con su familia.
- Nunca le pidas claves, contraseñas, códigos, números de tarjeta ni datos del banco, y recordale que nadie de confianza se los pide.
- Si te cuenta que alguien la llamó o le escribió pidiendo plata, un código o datos (aunque diga ser un familiar), decile que no dé nada, que corte, y ofrecé avisarle a su familia.
- No digas que hiciste algo si no usaste la herramienta. Si algo no lo podés hacer, decilo con sencillez.
- Solo mencioná actividades y noticias que estén en el [Contexto]; nunca inventes otras.
- Las líneas que empiezan con [Contexto] son datos para vos; no las leas en voz alta.`;

const tool = (name, description, properties) => ({
  name, description, strict: true,
  input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
});
const TOOLS = [
  tool('avisar_familiar', 'Le manda un mensaje escrito al celular de un familiar o contacto, de parte de ella.', {
    nombre: { type: 'string', description: 'Nombre o parentesco del contacto, tal como lo dijo ella (por ejemplo "Laura" o "mi nieto").' },
    mensaje: { type: 'string', description: 'El mensaje, en primera persona de ella.' }
  }),
  tool('crear_recordatorio', 'Anota un recordatorio que Tata le va a decir en voz alta a la hora pedida. La familia se entera.', {
    que: { type: 'string', description: 'Título corto, por ejemplo "Llamar a Marta".' },
    decir: { type: 'string', description: 'Lo que Tata le va a decir a esa hora, en segunda persona. Por ejemplo "llamar a Marta por su cumpleaños".' },
    hora: { type: 'string', description: 'Hora en formato HH:MM, 24 horas.' },
    fecha: { type: 'string', description: 'Fecha AAAA-MM-DD, o vacío si es la próxima vez que llegue esa hora.' }
  }),
  tool('recordar_dato', 'Guarda algo que ella contó y conviene recordar en charlas futuras (gustos, nombres, fechas importantes, historias).', {
    dato: { type: 'string', description: 'El dato, en una oración en tercera persona.' }
  }),
  tool('pedir_ayuda', 'Avisa a toda la familia que necesita ayuda ya y le ofrece llamar a emergencias. Usala ante cualquier urgencia de salud o seguridad.', {
    motivo: { type: 'string', description: 'Qué le pasa, con sus palabras.' }
  })
];

/**
 * Elige el proveedor según las variables de entorno, en este orden:
 * ANTHROPIC_API_KEY (Claude) · GEMINI_API_KEY (Gemini, gratis) · AI_BASE_URL (+ AI_API_KEY) para Groq, Ollama u otra API compatible con OpenAI.
 */
function pickProvider(env) {
  if (env.ANTHROPIC_API_KEY) return { apiKey: env.ANTHROPIC_API_KEY };
  if (env.GEMINI_API_KEY) {
    const model = env.TATA_MODEL || 'gemini-flash-lite-latest';
    return { model, client: createOpenAiCompatClient({ baseURL: GEMINI_BASE_URL, apiKey: env.GEMINI_API_KEY, model, reasoningEffort: env.AI_REASONING ?? 'low' }) };
  }
  if (env.AI_BASE_URL) {
    const model = env.TATA_MODEL;
    if (!model) { console.error('tata ai: con AI_BASE_URL hace falta TATA_MODEL'); return {}; }
    return { model, client: createOpenAiCompatClient({ baseURL: env.AI_BASE_URL, apiKey: env.AI_API_KEY, model, reasoningEffort: env.AI_REASONING }) };
  }
  return {};
}

export function createAi({ env = process.env, ...opts } = {}) {
  const picked = opts.client || 'apiKey' in opts ? opts : pickProvider(env);
  const { apiKey, client } = picked;
  if (!client && !apiKey) return null;
  const MODEL = picked.model || env.TATA_MODEL || DEFAULT_MODEL;
  const anthropic = client || new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 });

  function session(core, hh) {
    const last = core.q.get('SELECT session, ts, role FROM chat WHERE household_id = ? ORDER BY id DESC LIMIT 1', hh.id);
    if (!last) return 1;
    const rows = core.q.get('SELECT COUNT(*) AS n FROM chat WHERE household_id = ? AND session = ?', hh.id, last.session).n;
    const stale = last.role === 'reset' || core.ts() - last.ts > SESSION_IDLE_MS || rows >= SESSION_MAX_ROWS;
    return stale ? last.session + 1 : last.session;
  }
  const history = (core, hh, s) => core.q.all("SELECT role, content FROM chat WHERE household_id = ? AND session = ? AND role != 'reset' ORDER BY id", hh.id, s)
    .map(r => ({ role: r.role, content: JSON.parse(r.content) }));
  const append = (core, hh, s, role, content) =>
    core.q.run('INSERT INTO chat (household_id, session, ts, role, content) VALUES (?, ?, ?, ?, ?)', hh.id, s, core.ts(), role, JSON.stringify(content));
  const reset = (core, hh, s) => append(core, hh, s, 'reset', '');

  function context(core, hh) {
    const now = core.now(hh);
    const meds = core.q.all(`SELECT r.label, r.at, rr.done_at FROM reminders r
      LEFT JOIN reminder_runs rr ON rr.reminder_id = r.id AND rr.date = ?
      WHERE r.household_id = ? AND r.active = 1 AND (r.date = ? OR (r.date IS NULL AND instr(r.days, ?) > 0)) ORDER BY r.at`,
      now.date, hh.id, now.date, String(now.wd));
    const apts = core.q.all('SELECT date, at, what FROM appointments WHERE household_id = ? AND date >= ? ORDER BY date, at LIMIT 3', hh.id, now.date);
    const contacts = core.q.all('SELECT name, relation, member_id FROM contacts WHERE household_id = ? ORDER BY id', hh.id);
    const mem = core.q.all('SELECT text FROM memories WHERE household_id = ? ORDER BY id DESC LIMIT 30', hh.id);
    const likes = core.q.all('SELECT text FROM interests WHERE household_id = ? ORDER BY id', hh.id).map(i => i.text);
    const near = upcoming(core, hh, 2).slice(0, 4);
    const day = core.day(hh, now.date);
    return [
      `[Contexto] Hoy es ${spokenDate(now.date)} (${now.date}), ${spokenTime(now.min).replace(/^Son las /, 'las ')}.`,
      meds.length ? `[Contexto] Recordatorios de hoy: ${meds.map(r => `${fmtMin(r.at)} ${r.label}${r.done_at ? ' (hecho)' : ''}`).join('; ')}.` : '',
      apts.length ? `[Contexto] Próximos turnos: ${apts.map(a => `${relativeDay(a.date, now.date)} ${fmtMin(a.at)} con ${a.what}`).join('; ')}.` : '',
      contacts.length ? `[Contexto] Contactos: ${contacts.map(c => `${c.name}${c.relation ? ` (${c.relation})` : ''}`).join(', ')}.` : '',
      mem.length ? `[Contexto] Lo que sabés de ${hh.elder_name}: ${mem.reverse().map(m => m.text).join(' ')}` : '',
      likes.length ? `[Contexto] Le interesa: ${likes.join(', ')}.` : '',
      near.length ? `[Contexto] Actividades cerca: ${near.map(({ a, date }) => `${relativeDay(date, now.date)} ${fmtMin(a.at)} ${a.title} en ${a.place}`).join('; ')}.` : '',
      day.news ? `[Contexto] Novedad de hoy: ${day.news}` : ''
    ].filter(Boolean).join('\n');
  }

  // Cada herramienta devuelve el texto para Claude; `stop` corta la charla (SOS ya habló).
  async function run(core, hh, name, input, say) {
    if (name === 'pedir_ayuda') {
      await sos(core, hh, 'voz', input.motivo, say);
      return { text: 'Aviso enviado a toda la familia.', stop: true };
    }
    if (name === 'avisar_familiar') {
      const c = findContact(core, hh, input.nombre);
      const msg = String(input.mensaje || '').trim().slice(0, 300);
      if (!c) return { text: `No hay ningún contacto que coincida con "${input.nombre}". Contactos: ${core.q.all('SELECT name FROM contacts WHERE household_id = ?', hh.id).map(x => x.name).join(', ')}.` };
      if (!msg) return { text: 'El mensaje está vacío.' };
      core.activity(hh, `Le mandó un mensaje a ${c.name}`);
      core.notify(hh, 'msg', `Mensaje de ${hh.elder_name} para ${c.name}`, `“${msg}” · dictado a Tata`, null, c.member_id ? { to: c.member_id } : {});
      return { text: c.member_id ? `Mensaje enviado al celular de ${c.name}.` : `${c.name} no tiene la app; el mensaje le llegó al resto de la familia.` };
    }
    if (name === 'crear_recordatorio') {
      const at = parseHHMM(input.hora);
      if (at == null) return { text: 'Hora inválida. Preguntale a qué hora.' };
      const now = core.now(hh);
      let date = /^\d{4}-\d{2}-\d{2}$/.test(input.fecha || '') ? input.fecha : (at > now.min ? now.date : addDays(now.date, 1));
      if (date < now.date || (date === now.date && at <= now.min)) return { text: 'Esa hora ya pasó. Preguntale para cuándo.' };
      const label = String(input.que || '').trim().slice(0, 80) || 'Recordatorio';
      core.q.run("INSERT INTO reminders (household_id, label, say, at, days, date, is_med) VALUES (?, ?, ?, ?, '', ?, 0)",
        hh.id, label, String(input.decir || label).trim().slice(0, 200), at, date);
      core.activity(hh, `Le pidió a Tata que le recuerde: ${label}`);
      core.notify(hh, 'info', `${hh.elder_name} anotó un recordatorio`, `${label} · ${relativeDay(date, now.date)} a las ${fmtMin(at)}`);
      core.send(hh.id, 'all', { type: 'refresh' });
      return { text: `Anotado para ${relativeDay(date, now.date)} a las ${fmtMin(at)}.` };
    }
    if (name === 'recordar_dato') {
      const dato = String(input.dato || '').trim().slice(0, 300);
      if (!dato) return { text: 'Vacío.' };
      if (core.q.get('SELECT COUNT(*) AS n FROM memories WHERE household_id = ?', hh.id).n >= 200) return { text: 'Ya no hay lugar para más recuerdos.' };
      core.q.run('INSERT INTO memories (household_id, ts, text) VALUES (?, ?, ?)', hh.id, core.ts(), dato);
      return { text: 'Guardado.' };
    }
    return { text: 'Herramienta desconocida.' };
  }

  /** Devuelve las respuestas para la casa, o null si Claude no está disponible (la casa usa el "no te entendí" de siempre). */
  async function reply(core, hh, raw) {
    const replies = [];
    const say = (text, extra = {}) => replies.push({ text, ...extra });
    const s = session(core, hh);
    const messages = history(core, hh, s);
    const user = { role: 'user', content: `${context(core, hh)}\n${hh.elder_name} dice: ${raw}` };
    messages.push(user); append(core, hh, s, 'user', user.content);
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const res = await anthropic.beta.messages.create({
          model: MODEL, max_tokens: 4000,
          betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
          output_config: { effort: 'low' },
          system: system(hh), tools: TOOLS, messages
        });
        if (res.stop_reason === 'refusal') {
          reset(core, hh, s);
          say(`De eso no puedo hablar, ${hh.elder_name}. ¿Te ayudo con otra cosa?`);
          return replies;
        }
        messages.push({ role: 'assistant', content: res.content }); append(core, hh, s, 'assistant', res.content);
        for (const b of res.content) if (b.type === 'text' && b.text.trim()) say(b.text.trim());
        const uses = res.content.filter(b => b.type === 'tool_use');
        if (res.stop_reason !== 'tool_use' || !uses.length) return replies;

        const results = []; let stop = false;
        for (const u of uses) {
          let out;
          try { out = await run(core, hh, u.name, u.input || {}, say); }
          catch (e) { console.error('tata ai tool', u.name, e); out = { text: 'Falló: ' + e.message }; }
          results.push({ type: 'tool_result', tool_use_id: u.id, content: out.text });
          stop ||= !!out.stop;
        }
        messages.push({ role: 'user', content: results }); append(core, hh, s, 'user', results);
        if (stop) return replies;
      }
      return replies;
    } catch (e) {
      console.error('tata ai', e?.status || '', e?.message || e);
      reset(core, hh, s);
      return replies.length ? replies : null;
    }
  }

  /**
   * Elige como mucho una noticia liviana que coincida con sus intereses y la cuenta en una frase.
   * Devuelve null si no hay ninguna adecuada o si la respuesta no es válida: nunca se inventa una noticia.
   */
  async function pickNews(interests, headlines) {
    const list = headlines.map((h, i) => `${i + 1}. ${h.title}${h.source ? ` (${h.source})` : ''}`).join('\n');
    try {
      const res = await anthropic.beta.messages.create({
        model: MODEL, max_tokens: 2000,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: NEWS_SCHEMA } },
        system: NEWS_SYSTEM,
        messages: [{ role: 'user', content: `Le interesa: ${interests.join(', ')}.\n\nTitulares de hoy:\n${list}` }]
      });
      if (res.stop_reason === 'refusal') return null;
      const raw = res.content.find(b => b.type === 'text')?.text || '';
      const frase = JSON.parse(raw)?.frase;
      if (typeof frase !== 'string' || !frase.trim() || frase.trim().split(/\s+/).length > 25) return null;
      return frase.trim();
    } catch (e) {
      if (!(e instanceof SyntaxError)) console.error('tata noticias', e?.status || '', e?.message || e);
      return null;
    }
  }

  return { reply, pickNews, model: MODEL };
}

const NEWS_SCHEMA = {
  type: 'object',
  properties: { frase: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
  required: ['frase'], additionalProperties: false
};
const NEWS_SYSTEM = `Elegís noticias para Tata, una compañera de voz de una persona mayor que vive sola en Argentina. Lo que elijas se lee en voz alta a la mañana.

- Elegí como mucho una noticia que coincida con alguno de sus intereses y sea liviana o positiva.
- Descartá policiales, accidentes, muertes, enfermedades, política, economía alarmante, estafas, guerras y catástrofes. Ante la duda, descartá.
- Contala en una frase de hasta 25 palabras, en castellano rioplatense con voseo, sin inventar nada que no diga el titular.
- Si ninguna sirve, respondé con frase en null.`;
