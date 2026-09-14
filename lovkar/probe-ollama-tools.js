/* lovkar/probe-ollama-tools.js — can a local model actually drive a StarNet agent?

   Chat quality is not the question. StarNet's loop hands the model a tool schema and executes
   whatever it calls back; a model that writes a lovely paragraph instead of a tool call is
   useless as an agent no matter how it reads. So this probes the ONE thing that decides it,
   through the exact seam StarNet uses — the OpenAI-compatible endpoint at
   http://127.0.0.1:11434/v1, which `providers/registry.js` already points the `ollama`
   profile at — rather than through Ollama's native API.

   Three things a station agent needs, in increasing order of how often small models fail them:
     1. emit a syntactically valid tool call at all
     2. put the RIGHT arguments in it (a wrong city is a wrong answer, not a near miss)
     3. NOT call a tool when the question does not need one (the expensive failure: an agent
        that reaches for the shell on every turn burns the machine, not the limit)

   Run:  node lovkar/probe-ollama-tools.js [model ...]
*/
'use strict';

const BASE = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';

const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather in a given city.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, e.g. Maribor' },
        unit: { type: 'string', enum: ['c', 'f'], description: 'Temperature unit' }
      },
      required: ['city']
    }
  }
}];

async function ask(model, content, opts) {
  const body = {
    model,
    messages: [{ role: 'user', content }],
    tools: TOOLS,
    temperature: 0,
    stream: false
  };
  if (opts && opts.noThink) body.think = false;
  const started = Date.now();
  const res = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const ms = Date.now() - started;
  if (!res.ok) return { ms, error: res.status + ' ' + (await res.text()).slice(0, 200) };
  const j = await res.json();
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  return { ms, calls: msg.tool_calls || [], text: String(msg.content || '').trim(), usage: j.usage || {} };
}

function parseArgs(call) {
  try { return JSON.parse(call.function.arguments); }
  catch (_) { return null; }   // a small model that emits almost-JSON fails here, which is the point
}

async function probe(model) {
  console.log('\n=== ' + model + ' ===');
  let score = 0, of = 0;
  const check = (ok, what, detail) => { of++; if (ok) score++; console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + what + (detail ? '  — ' + detail : '')); };

  /* 1 + 2: calls the tool, with the right arguments */
  const a = await ask(model, 'What is the weather in Maribor right now? Use the tool.');
  if (a.error) { console.log('  ERROR ' + a.error); return { model, score: 0, of: 4, ms: a.ms }; }
  check(a.calls.length === 1, 'emits exactly one tool call', a.calls.length + ' call(s), ' + a.ms + 'ms');
  const args = a.calls.length ? parseArgs(a.calls[0]) : null;
  check(!!args, 'its arguments are valid JSON', a.calls.length ? String(a.calls[0].function.arguments).slice(0, 80) : '');
  check(!!args && /maribor/i.test(String(args.city || '')), 'and carry the right city', args ? JSON.stringify(args) : '');

  /* 3: restraint — the failure that makes an agent expensive rather than merely wrong */
  const b = await ask(model, 'Reply with the single word OK. Do not use any tool.');
  check(b.calls && b.calls.length === 0, 'does NOT call a tool when told not to',
        (b.calls && b.calls.length ? b.calls.map(c => c.function.name).join(',') : 'clean') + ', ' + b.ms + 'ms');

  const tps = a.usage && a.usage.completion_tokens ? Math.round(a.usage.completion_tokens / (a.ms / 1000)) : null;
  console.log('  ' + score + '/' + of + (tps ? '   ~' + tps + ' tok/s' : ''));
  return { model, score, of, ms: a.ms };
}

(async () => {
  let models = process.argv.slice(2);
  if (!models.length) {
    const r = await fetch(BASE + '/models').catch(() => null);
    if (!r || !r.ok) { console.error('ollama not reachable at ' + BASE); process.exit(1); }
    models = ((await r.json()).data || []).map(m => m.id);
  }
  if (!models.length) { console.error('no models pulled yet'); process.exit(1); }

  const rows = [];
  for (const m of models) rows.push(await probe(m));

  console.log('\n--- verdict ---');
  for (const r of rows) {
    const v = r.score === r.of ? 'usable as a station agent'
            : r.score >= 3 ? 'usable with care — one failure mode above'
            : 'not usable as an agent; fine as a chat brain';
    console.log('  ' + String(r.model).padEnd(18) + ' ' + r.score + '/' + r.of + '  ' + v);
  }
})();
