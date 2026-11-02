// Puente con el servicio de voz (voz/servidor.py): mensajes y recordatorios dichos con la voz
// de un familiar que grabó su muestra y dio su consentimiento.
//
// Reglas de cuidado, porque las estafas con voces clonadas apuntan a personas mayores:
// - Tata siempre aclara quién manda el mensaje antes de reproducirlo ("Laura te dejó dicho").
// - Nada que hable de plata, bancos, claves o códigos se dice con voz clonada: va con la voz de Tata.
// - La voz solo se usa para lo que ese familiar escribió en la app; nunca para lo que genera Claude.

import { norm } from './brain.js';

const RISKY = /\b(plata|dinero|guita|transferi\w*|transferencia|deposit\w*|cbu|cvu|alias|clave|claves|contrasena|pin|tarjeta|banco|cuenta|codigo|token|pago|pagar|pagame|prestamo|deuda|mercado ?pago|efectivo|dolares|pesos)\b/;
export const risky = text => RISKY.test(norm(text));

export function createVoice({ url = process.env.VOZ_URL || 'http://127.0.0.1:5005', fetchImpl = globalThis.fetch } = {}) {
  let ready = false, checkedAt = 0;

  async function check() {
    if (Date.now() - checkedAt < 30_000) return ready;
    checkedAt = Date.now();
    try {
      const r = await fetchImpl(url + '/health', { signal: AbortSignal.timeout(2000) });
      ready = r.ok;
    } catch { ready = false; }
    return ready;
  }

  /** Texto + muestra WAV del familiar -> WAV con su voz. */
  async function speak(text, wav) {
    const r = await fetchImpl(url + '/tts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice_wav_b64: Buffer.from(wav).toString('base64'), lang: 'es' }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!r.ok) throw new Error('El servicio de voz respondió ' + r.status);
    ready = true; checkedAt = Date.now();
    return Buffer.from(await r.arrayBuffer());
  }

  check();
  return { check, speak, get ready() { return ready; } };
}
