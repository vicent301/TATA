// Puente con los servicios de voz: mensajes y recordatorios dichos con la voz de un familiar
// que grabó su muestra y dio su consentimiento.
//
// Dos motores, locales los dos. Se usa el elegido en VOZ_MOTOR y, si falla o no está prendido, el otro:
// - VoiceStudio (https://github.com/debpalash/VoiceStudio, AGPL-3.0): app aparte, API en :3900.
// - Chatterbox Multilingual (voz/servidor.py, MIT): en :5005.
//
// Reglas de cuidado, porque las estafas con voces clonadas apuntan a personas mayores:
// - Tata siempre aclara quién manda el mensaje antes de reproducirlo ("Laura te dejó dicho").
// - Nada que hable de plata, bancos, claves o códigos se dice con voz clonada: va con la voz de Tata.
// - La voz solo se usa para lo que ese familiar escribió en la app; nunca para lo que genera Claude.

import { createHash } from 'node:crypto';
import { norm } from './brain.js';

const RISKY = /\b(plata|dinero|guita|transferi\w*|transferencia|deposit\w*|cbu|cvu|alias|clave|claves|contrasena|pin|tarjeta|banco|cuenta|codigo|token|pago|pagar|pagame|prestamo|deuda|mercado ?pago|efectivo|dolares|pesos)\b/;
export const risky = text => RISKY.test(norm(text));

export function createVoice({
  engine = process.env.VOZ_MOTOR || 'voicestudio',
  url = process.env.VOZ_URL || 'http://127.0.0.1:5005',
  studioUrl = process.env.VOICESTUDIO_URL || 'http://127.0.0.1:3900',
  studioModel = process.env.VOICESTUDIO_MODEL || 'tts-1', // 'tts-1' = el motor activo en la app de VoiceStudio
  fetchImpl = globalThis.fetch
} = {}) {
  async function wavFrom(r, who) {
    if (!r.ok) throw new Error(`${who} respondió ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  const chatterbox = {
    name: 'Chatterbox',
    health: url + '/health',
    async speak(text, wav) {
      const r = await fetchImpl(url + '/tts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice_wav_b64: Buffer.from(wav).toString('base64'), lang: 'es' }),
        signal: AbortSignal.timeout(120_000)
      });
      return wavFrom(r, 'Chatterbox');
    },
    async forget() {} // no guarda nada: recibe la muestra en cada pedido
  };

  // VoiceStudio guarda cada voz como un perfil. Lo nombramos con un hash de la muestra (sin datos
  // del familiar) y lo buscamos cada vez: si se le pasa un id que no existe, VoiceStudio no falla,
  // habla con una voz genérica.
  const profileName = wav => 'tata-' + createHash('sha256').update(wav).digest('hex').slice(0, 16);
  async function studioJson(path, opts = {}) {
    const r = await fetchImpl(studioUrl + path, { signal: AbortSignal.timeout(15_000), ...opts });
    if (!r.ok) throw new Error(`VoiceStudio respondió ${r.status} en ${path}`);
    return r.json();
  }
  const findProfile = async wav => (await studioJson('/profiles')).find(p => p.name === profileName(wav));
  async function profileId(wav) {
    const found = await findProfile(wav);
    if (found) return found.id;
    const form = new FormData();
    form.set('name', profileName(wav));
    form.set('ref_audio', new Blob([wav], { type: 'audio/wav' }), 'muestra.wav');
    return (await studioJson('/profiles', { method: 'POST', body: form })).id;
  }

  const studio = {
    name: 'VoiceStudio',
    health: studioUrl + '/health',
    async speak(text, wav) {
      const voice = await profileId(wav);
      const r = await fetchImpl(studioUrl + '/v1/audio/speech', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: studioModel, input: text, voice, language: 'es', response_format: 'wav' }),
        signal: AbortSignal.timeout(300_000) // la primera vez carga el modelo
      });
      return wavFrom(r, 'VoiceStudio');
    },
    async forget(wav) {
      const found = await findProfile(wav);
      if (found) await studioJson('/profiles/' + encodeURIComponent(found.id), { method: 'DELETE' });
    }
  };

  const engines = engine === 'chatterbox' ? [chatterbox, studio] : [studio, chatterbox];
  for (const e of engines) Object.assign(e, { up: false, checkedAt: 0, checking: null });

  function isUp(e) {
    if (e.checking) return e.checking; // un chequeo en curso: esperar ese mismo
    if (Date.now() - e.checkedAt < 30_000) return Promise.resolve(e.up);
    e.checkedAt = Date.now();
    e.checking = fetchImpl(e.health, { signal: AbortSignal.timeout(2000) })
      .then(r => r.ok, () => false)
      .then(up => { e.up = up; e.checking = null; return up; });
    return e.checking;
  }

  async function check() {
    const ups = await Promise.all(engines.map(isUp));
    return ups.some(Boolean);
  }

  /** Texto + muestra WAV del familiar -> WAV con su voz, del primer motor que ande. */
  async function speak(text, wav) {
    let err = new Error('Ningún servicio de voz está prendido');
    for (const e of engines) {
      if (!(await isUp(e))) continue;
      try {
        const out = await e.speak(text, wav);
        e.up = true; e.checkedAt = Date.now();
        return out;
      } catch (x) {
        console.error('voz', e.name, x.message);
        e.up = false; e.checkedAt = Date.now();
        err = x;
      }
    }
    throw err;
  }

  /** El familiar borró o cambió su voz: que no quede guardada en ningún motor. */
  async function forget(wav) {
    await Promise.all(engines.map(e => e.forget(wav).catch(x => console.error('voz', e.name, 'no se pudo borrar:', x.message))));
  }

  check();
  return { check, speak, forget, get ready() { return engines.some(e => e.up); } };
}
