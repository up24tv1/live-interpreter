// Live Interpreter — same file runs as the web app (GitHub Pages) and the Chrome extension side panel.
// Flow: mic/tab audio -> split into phrases on silence -> 16kHz WAV -> API -> caption + speech.

const API = 'https://live-interpreter-api.bukasa2014.workers.dev';
const $ = (id) => document.getElementById(id);
const isExt = !!globalThis.chrome?.runtime?.id;
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const status = (t) => { $('status').textContent = t; };

// Extension mic permission must be granted from a full tab once.
if (new URLSearchParams(location.search).has('grant')) {
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then((s) => { s.getTracks().forEach((t) => t.stop()); status('Microphone allowed. Close this tab and use the side panel.'); })
    .catch((e) => status('Microphone blocked: ' + e.message));
}

const langs = await fetch(API + '/langs').then((r) => r.json()).catch(() => ({ en: 'English', fr: 'French' }));
for (const sel of [$('a'), $('b')]) for (const [code, name] of Object.entries(langs)) sel.add(new Option(name, code));
$('a').value = store.get('a', 'en');
$('b').value = store.get('b', 'fr');
$('a').onchange = $('b').onchange = () => { store.set('a', $('a').value); store.set('b', $('b').value); };
$('swap').onclick = () => { [$('a').value, $('b').value] = [$('b').value, $('a').value]; $('a').onchange(); };
if (isExt) $('srcRow').hidden = false;

let ctx, stream, proc;
$('go').onclick = () => (ctx ? stop() : start());

async function getStream() {
  if (isExt && $('src').value === 'tab') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    return navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id } } });
  }
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
}

async function start() {
  if ($('a').value === $('b').value) return status('Pick two different languages.');
  const tabMode = isExt && $('src').value === 'tab';
  try {
    stream = await getStream();
  } catch (e) {
    if (isExt && !tabMode) chrome.tabs.create({ url: location.pathname + '?grant=1' });
    return status(tabMode ? 'Click the extension icon on the tab first, then Start. (' + e.message + ')'
                          : 'Microphone permission needed. (' + e.message + ')');
  }
  ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  if (tabMode) src.connect(ctx.destination); // capturing mutes the tab; play it back
  // ponytail: ScriptProcessor is deprecated but universal and tiny; move to AudioWorklet if Chrome drops it
  proc = ctx.createScriptProcessor(4096, 1, 1);
  src.connect(proc);
  proc.connect(ctx.destination); // outputs silence; required for onaudioprocess to fire

  const rate = ctx.sampleRate;
  let buf = [], len = 0, speech = false, silent = 0;
  proc.onaudioprocess = (e) => {
    // Don't re-translate our own voice coming back through the mic.
    if (!tabMode && speechSynthesis.speaking) { buf = []; len = 0; speech = false; silent = 0; return; }
    const x = new Float32Array(e.inputBuffer.getChannelData(0));
    buf.push(x); len += x.length;
    let sum = 0; for (const v of x) sum += v * v;
    const thresh = 0.004 * (11 - $('sens').value); // sens 5 -> 0.024 RMS
    if (Math.sqrt(sum / x.length) > thresh) { speech = true; silent = 0; } else silent += x.length;
    const dur = len / rate;
    if ((speech && silent / rate > 0.7 && dur > 1) || dur > 8) {
      if (speech) send(buf, rate);
      buf = []; len = 0; speech = false; silent = 0;
    } else if (!speech && buf.length > 4) {
      len -= buf.shift().length; // keep ~0.3s pre-roll so first syllable isn't clipped
    }
  };
  $('go').textContent = 'Stop'; $('go').classList.add('on');
  status(tabMode ? 'Interpreting this tab…' : 'Listening… speak naturally, pause between sentences.');
}

function stop() {
  proc?.disconnect(); stream?.getTracks().forEach((t) => t.stop()); ctx?.close();
  ctx = stream = proc = null;
  $('go').textContent = 'Start listening'; $('go').classList.remove('on');
  status('Stopped.');
}

async function send(frames, rate) {
  const row = document.createElement('div');
  row.className = 'row pending';
  row.innerHTML = '<div class="heard"></div><div class="text">…</div>';
  $('log').prepend(row);
  try {
    const res = await fetch(API + '/interpret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: toBase64(wav(frames, rate)), a: $('a').value, b: $('b').value }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || res.status);
    if (!d.heard) return row.remove();
    row.querySelector('.heard').textContent = d.heard;
    row.querySelector('.text').textContent = d.text;
    row.classList.remove('pending');
    speak(d.text, d.lang);
  } catch (e) {
    row.querySelector('.text').textContent = '⚠ ' + e.message;
  }
}

function speak(text, lang) {
  if (!$('speak').checked || !text || !lang) return;
  const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang));
  if (!voice) return; // no system voice for e.g. Lingala: caption only
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice; u.lang = voice.lang;
  speechSynthesis.speak(u);
}

// Float32 frames at `rate` -> 16kHz 16-bit mono WAV
function wav(frames, rate) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const all = new Float32Array(total);
  let o = 0; for (const f of frames) { all.set(f, o); o += f.length; }
  const step = rate / 16000, n = Math.floor(total / step);
  const out = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (p, s) => [...s].forEach((c, i) => out.setUint8(p + i, c.charCodeAt(0)));
  str(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    let s = 0; const a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step));
    for (let j = a; j < b; j++) s += all[j];
    const v = Math.max(-1, Math.min(1, s / (b - a)));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return out.buffer;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export { wav, toBase64 }; // for console self-checks
