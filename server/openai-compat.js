// Adaptador para usar una IA con API "compatible con OpenAI" (Gemini gratis, Groq, Ollama...)
// en lugar de Claude. Expone la misma forma que el SDK de Anthropic que usa ai.js
// (client.beta.messages.create) y traduce mensajes, herramientas y respuestas de ida y vuelta,
// así el historial guardado y el resto de Tata no cambian.

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

// Gemini no acepta algunas palabras de JSON Schema en las herramientas (additionalProperties, strict...).
function cleanSchema(s) {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) if (k !== 'additionalProperties' && k !== 'strict') out[k] = cleanSchema(v);
  return out;
}

/** Mensajes en formato Anthropic -> mensajes en formato OpenAI. */
export function toOpenAiMessages(system, messages) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      const calls = m.content.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        ...(b.extra_content ? { extra_content: b.extra_content } : {})  // firma de pensamiento de Gemini
      }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Usuario con bloques: resultados de herramientas y/o texto.
    for (const b of m.content) {
      if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content ?? '') });
      else if (b.type === 'text') out.push({ role: 'user', content: b.text });
    }
  }
  return out;
}

/** Respuesta OpenAI -> respuesta con forma Anthropic ({ content, stop_reason }). */
export function fromOpenAiResponse(data, { json = false } = {}) {
  const choice = data?.choices?.[0];
  if (!choice) throw new Error('La IA no devolvió ninguna respuesta');
  const msg = choice.message || {};
  const content = [];
  let text = typeof msg.content === 'string' ? msg.content.trim() : '';
  if (json) text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (text) content.push({ type: 'text', text });
  (msg.tool_calls || []).forEach((c, i) => {
    let input = {};
    try { input = c.function?.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = {}; }
    content.push({ type: 'tool_use', id: c.id || `call_${Date.now()}_${i}`, name: c.function?.name, input,
      ...(c.extra_content ? { extra_content: c.extra_content } : {}) });
  });
  const stop_reason = choice.finish_reason === 'content_filter' ? 'refusal'
    : content.some(b => b.type === 'tool_use') ? 'tool_use'
    : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return { content, stop_reason };
}

export function createOpenAiCompatClient({ baseURL, apiKey, model, reasoningEffort, timeout = 25_000, fetchImpl = globalThis.fetch }) {
  async function create(params) {
    const format = params.output_config?.format;
    const system = format
      ? `${params.system}\n\nRespondé únicamente con un objeto JSON que cumpla este esquema, sin texto alrededor: ${JSON.stringify(format.schema)}`
      : params.system;
    const body = {
      model: model || params.model,
      max_tokens: params.max_tokens,
      messages: toOpenAiMessages(system, params.messages),
      ...(params.tools?.length ? {
        tools: params.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: cleanSchema(t.input_schema) } }))
      } : {}),
      ...(format ? { response_format: { type: 'json_object' } } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
    };
    const r = await fetchImpl(baseURL.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
    if (!r.ok) {
      const err = new Error(`La IA respondió ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
      err.status = r.status;
      throw err;
    }
    return fromOpenAiResponse(await r.json(), { json: !!format });
  }
  return { beta: { messages: { create } } };
}
