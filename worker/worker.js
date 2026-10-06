// Live Interpreter API — one endpoint: audio phrase in, transcript + translation out.
// Primary: Groq direct (whisper-large-v3-turbo + gpt-oss-120b), sub-second.
// Fallback: OpenClaw gateway (Gemini audio-in) via service binding.

const LANGS = {
  en: 'English', fr: 'French', es: 'Spanish', pt: 'Portuguese', sw: 'Swahili',
  ln: 'Lingala', lua: 'Tshiluba', ar: 'Arabic', zh: 'Chinese', hi: 'Hindi',
  de: 'German', it: 'Italian', ru: 'Russian', ja: 'Japanese', ko: 'Korean', tr: 'Turkish',
};
const MAX_B64 = 1_500_000; // ~25s of 16kHz mono WAV
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (d, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const prompt = (a, b) =>
  `You are a live interpreter between ${LANGS[a]} (${a}) and ${LANGS[b]} (${b}). ` +
  `If the speech is in ${LANGS[a]}, translate it into ${LANGS[b]}; otherwise translate it into ${LANGS[a]}. ` +
  `Keep the speaker's tone, natural and spoken. ` +
  `Reply ONLY with JSON: {"heard":"<transcript>","lang":"<target code: ${a} or ${b}>","text":"<translation>"}. ` +
  `If there is no intelligible speech reply {"heard":""}.`;

function parse(content, heard) {
  const m = String(content || '').match(/\{[\s\S]*\}/);
  const out = m ? JSON.parse(m[0]) : {};
  return { heard: (heard ?? out.heard ?? '').trim(), lang: out.lang, text: (out.text ?? '').trim() };
}

async function groq(env, path, body) {
  const r = await fetch(`https://api.groq.com/openai/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      ...(typeof body === 'string' && { 'Content-Type': 'application/json' }),
    },
    body,
  });
  if (!r.ok) throw new Error(`groq ${path} ${r.status}`);
  return r.json();
}

async function viaGroq(env, wav, a, b) {
  const fd = new FormData();
  fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'phrase.wav');
  fd.append('model', 'whisper-large-v3-turbo');
  const heard = (await groq(env, 'audio/transcriptions', fd)).text?.trim();
  if (!heard) return { heard: '' };
  const r = await groq(env, 'chat/completions', JSON.stringify({
    model: 'openai/gpt-oss-120b',
    reasoning_effort: 'low',
    temperature: 0.2,
    max_completion_tokens: 800,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: prompt(a, b) }, { role: 'user', content: heard }],
  }));
  return parse(r.choices?.[0]?.message?.content, heard);
}

async function viaGateway(env, b64, a, b) {
  const r = await env.GATEWAY.fetch('https://gateway/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENCLAW_API_KEY}`,
      'Content-Type': 'application/json',
      'User-Agent': 'live-interpreter-api/1',
    },
    body: JSON.stringify({
      model: 'gemini-3.5-flash',
      temperature: 0.2,
      max_tokens: 800,
      messages: [
        { role: 'system', content: prompt(a, b) },
        { role: 'user', content: [{ type: 'input_audio', input_audio: { data: b64, format: 'wav' } }] },
      ],
    }),
  });
  if (!r.ok) throw new Error(`gateway ${r.status}`);
  return parse((await r.json()).choices?.[0]?.message?.content);
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (pathname === '/langs') return json(LANGS);
    if (pathname !== '/interpret' || req.method !== 'POST') return json({ error: 'not found' }, 404);

    const ip = req.headers.get('CF-Connecting-IP') || '?';
    if (env.LIMITER && !(await env.LIMITER.limit({ key: ip })).success) {
      return json({ error: 'Too many requests, slow down.' }, 429);
    }

    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
    const { audio, a, b } = body || {};
    if (typeof audio !== 'string' || !audio || audio.length > MAX_B64) return json({ error: 'audio missing or too long' }, 400);
    if (!LANGS[a] || !LANGS[b] || a === b) return json({ error: 'pick two different languages' }, 400);

    const errors = [];
    if (env.GROQ_API_KEY) {
      try {
        const wav = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0));
        return json({ ...(await viaGroq(env, wav, a, b)), via: 'groq' });
      } catch (e) { errors.push(e.message); }
    }
    for (let i = 0; i < 2; i++) { // Gemini 503s intermittently; one retry usually lands
      try {
        return json({ ...(await viaGateway(env, audio, a, b)), via: 'openclaw' });
      } catch (e) { errors.push(e.message); }
    }
    return json({ error: 'interpreter busy, try again', detail: errors }, 502);
  },
};
