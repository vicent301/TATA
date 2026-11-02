import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiCompatClient, toOpenAiMessages } from '../server/openai-compat.js';
import { createAi } from '../server/ai.js';

const fakeFetch = (reply, calls = []) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
  return { ok: true, json: async () => reply };
};

test('traduce un intercambio con herramienta de formato Anthropic a OpenAI', () => {
  const msgs = toOpenAiMessages('sos Tata', [
    { role: 'user', content: 'avisale a Laura que llegué' },
    { role: 'assistant', content: [{ type: 'text', text: 'Dale.' },
      { type: 'tool_use', id: 'c1', name: 'avisar_familiar', input: { nombre: 'Laura', mensaje: 'llegué' }, extra_content: { google: { thought_signature: 'x' } } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Enviado.' }] }
  ]);
  assert.deepEqual(msgs[0], { role: 'system', content: 'sos Tata' });
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[2].content, 'Dale.');
  assert.deepEqual(msgs[2].tool_calls[0].function, { name: 'avisar_familiar', arguments: '{"nombre":"Laura","mensaje":"llegué"}' });
  assert.deepEqual(msgs[2].tool_calls[0].extra_content, { google: { thought_signature: 'x' } });
  assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'c1', content: 'Enviado.' });
});

test('una llamada a herramienta vuelve como tool_use aunque finish_reason diga stop', async () => {
  const calls = [];
  const client = createOpenAiCompatClient({ baseURL: 'http://ia/v1/', apiKey: 'k', model: 'm', fetchImpl: fakeFetch({
    choices: [{ finish_reason: 'stop', message: { content: null, tool_calls: [{ id: 't1', function: { name: 'recordar_dato', arguments: '{"dato":"Le gusta el tango"}' } }] } }]
  }, calls) });
  const res = await client.beta.messages.create({
    model: 'ignorado', max_tokens: 100, system: 's', messages: [{ role: 'user', content: 'hola' }],
    tools: [{ name: 'recordar_dato', description: 'd', strict: true, input_schema: { type: 'object', properties: { dato: { type: 'string' } }, required: ['dato'], additionalProperties: false } }]
  });
  assert.equal(res.stop_reason, 'tool_use');
  assert.deepEqual(res.content, [{ type: 'tool_use', id: 't1', name: 'recordar_dato', input: { dato: 'Le gusta el tango' } }]);
  assert.equal(calls[0].url, 'http://ia/v1/chat/completions');
  assert.equal(calls[0].headers.authorization, 'Bearer k');
  assert.equal(calls[0].body.model, 'm');
  assert.equal('additionalProperties' in calls[0].body.tools[0].function.parameters, false);
});

test('pedido con formato JSON: limpia los ``` y queda como texto', async () => {
  const client = createOpenAiCompatClient({ baseURL: 'http://ia', model: 'm', fetchImpl: fakeFetch({
    choices: [{ finish_reason: 'stop', message: { content: '```json\n{"frase":"Ganó Talleres"}\n```' } }]
  }) });
  const res = await client.beta.messages.create({ max_tokens: 50, system: 's', messages: [{ role: 'user', content: 'x' }],
    output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } });
  assert.equal(JSON.parse(res.content[0].text).frase, 'Ganó Talleres');
});

test('createAi elige proveedor por variables de entorno', () => {
  assert.equal(createAi({ env: {} }), null);
  assert.equal(createAi({ env: { GEMINI_API_KEY: 'g' } }).model, 'gemini-flash-lite-latest');
  assert.equal(createAi({ env: { GEMINI_API_KEY: 'g', TATA_MODEL: 'gemini-x' } }).model, 'gemini-x');
  assert.equal(createAi({ env: { AI_BASE_URL: 'http://localhost:11434/v1', TATA_MODEL: 'qwen' } }).model, 'qwen');
  assert.equal(createAi({ env: { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' } }).model, 'claude-opus-5-5');
});
