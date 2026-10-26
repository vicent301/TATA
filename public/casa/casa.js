// Tata en la casa: escucha (reconocimiento de voz del navegador), habla (síntesis de voz
// o audios grabados por la familia) y mantiene un canal abierto con el servidor para
// recibir recordatorios y mensajes en el momento.
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
  };

  let token = store.get('tata.device');
  let info = null;            // estado que manda el servidor
  let es = null;              // EventSource
  let speaking = false, queue = [], convoUntil = 0;
  let rate = Number(store.get('tata.rate')) || 0.92;
  let always = store.get('tata.always') === '1';
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  const show = id => ['pairView', 'startView', 'homeView'].forEach(v => { $('#' + v).hidden = v !== id; });

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
    if (r.status === 401) { unpair(); throw new Error('unpaired'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Error');
    return j;
  }
  function unpair() { store.set('tata.device', null); token = null; es?.close(); show('pairView'); }

  // ---------- vincular ----------
  $('#pairForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#pairErr'); err.hidden = true;
    try {
      const r = await fetch('/api/casa/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: $('#pairCode').value }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'No se pudo vincular');
      token = j.token; store.set('tata.device', token);
      show('startView');
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  });

  // ---------- empezar (un toque habilita audio, micrófono y pantalla encendida) ----------
  $('#startBtn').addEventListener('click', async () => {
    try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(' ')); } catch {}
    if (SR && navigator.mediaDevices?.getUserMedia) {
      try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); } catch {}
    }
    keepAwake();
    try { await document.documentElement.requestFullscreen?.(); } catch {}
    show('homeView');
    await loadState();
    connect();
    if (always) startAlways();
    say([{ text: `Hola, ${info.elder_name}. Acá estoy. Cuando quieras, tocá el botón y hablame.` }]);
  });

  let wake = null;
  async function keepAwake() {
    try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && token && !$('#homeView').hidden) { keepAwake(); loadState(); } });

  // ---------- estado y canal en vivo ----------
  async function loadState() {
    info = await api('/api/casa/state');
    render(info.ui);
    tick();
  }
  function connect() {
    es?.close();
    es = new EventSource('/api/casa/stream?t=' + encodeURIComponent(token));
    es.onopen = () => setConn(true);
    es.onerror = () => { setConn(false); if (es.readyState === EventSource.CLOSED) setTimeout(() => loadState().then(connect).catch(() => {}), 5000); };
    es.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'say') { say(m.items); loadState().catch(() => {}); }
      else if (m.type === 'refresh') loadState().catch(() => {});
      else if (m.type === 'unpaired') api('/api/casa/state').catch(() => {});
    };
  }
  function setConn(on) {
    const c = $('#conn'); c.className = 'conn ' + (on ? 'on' : 'off');
    c.querySelector('span').textContent = on ? 'Conectada' : 'Sin conexión';
  }

  // ---------- reloj ----------
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  function tick() {
    if (!info) return;
    const tz = info.timezone;
    const now = new Date();
    $('#clock').textContent = now.toLocaleTimeString('es-AR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const d = now.toLocaleDateString('es-AR', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
    $('#date').textContent = d.charAt(0).toUpperCase() + d.slice(1).replace(',', '');
  }
  setInterval(tick, 5000);

  // ---------- pantalla ----------
  function render(ui) {
    if (!ui) return;
    const sos = ui.sos;
    const bar = $('#sosbar');
    if (sos) {
      bar.hidden = false;
      bar.className = 'sosbar' + (sos.state === 'coming' ? ' coming' : '');
      bar.textContent = sos.state === 'coming' ? `${sos.by || 'Tu familia'} ya está en camino.` : 'Tu familia ya sabe que pediste ayuda.';
    } else bar.hidden = true;
    if (!speaking) setMode('idle');

    const g = $('#guide');
    if (ui.guide) {
      g.hidden = false;
      g.innerHTML = `<div class="g-head"><span class="eyebrow">Paso a paso</span><b>${esc(ui.guide.title)}</b><span class="g-n">Paso ${ui.guide.i + 1} de ${ui.guide.n}</span></div>
        <div class="g-dots">${Array.from({ length: ui.guide.n }, (_, k) => `<i class="${k <= ui.guide.i ? 'on' : ''}"></i>`).join('')}</div>
        <p>${esc(ui.guide.text)}</p><small>Tata nunca te va a pedir claves ni contraseñas.</small>`;
    } else { g.hidden = true; g.innerHTML = ''; }

    $('#chips').innerHTML = ui.chips.map(c => `<button type="button" class="chip" data-say="${esc(c)}">${esc(c)}</button>`).join('');
    if (ui.chips.length) convoUntil = Date.now() + 25000;

    $('#today').innerHTML = ui.today.length ? `<h2>Hoy</h2><ul>${ui.today.map(r =>
      `<li class="${r.past ? 'past' : ''} ${r.done ? 'done' : ''}"><span class="tm">${esc(r.at)}</span><span>${esc(r.label)}</span>${r.done ? '<span class="ok">✓ Hecho</span>' : ''}</li>`).join('')}</ul>` : '';
  }
  function setMode(m) {
    const sosOpen = info?.ui?.sos?.state === 'open';
    $('#tata').dataset.mode = m === 'idle' && sosOpen ? 'alert' : m;
    $('#status').textContent = m === 'speaking' ? 'Tata está hablando' : m === 'listening' ? 'Te escucho…' : m === 'thinking' ? 'Un momento…'
      : always ? 'Decí “Tata” y lo que necesites' : 'Tocá el botón y hablame';
  }
  function addLine(who, text) {
    const log = $('#log'); const d = document.createElement('div');
    d.className = 'ln ' + who;
    d.innerHTML = `<span class="who">${who === 'me' ? esc(info?.elder_name || 'Vos') : 'Tata'}</span><p>${esc(text)}</p>`;
    log.appendChild(d);
    while (log.children.length > 4) log.removeChild(log.firstChild);
    d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function showAction(a) {
    const box = $('#action');
    if (!a || a.type !== 'dial') return;
    const red = a.phone === info?.emergency_phone;
    box.innerHTML = `<a class="${red ? 'red' : ''}" href="tel:${esc(a.phone.replace(/[^\d+]/g, ''))}">${esc(a.label)}</a>`;
    box.hidden = false;
    clearTimeout(showAction.t); showAction.t = setTimeout(() => { box.hidden = true; }, 3 * 60_000);
  }

  // ---------- hablar ----------
  let voices = [];
  const loadVoices = () => { try { voices = speechSynthesis.getVoices(); } catch { voices = []; } };
  loadVoices(); try { speechSynthesis.onvoiceschanged = loadVoices; } catch {}
  function pickVoice() {
    for (const p of ['es-ar', 'es-419', 'es-us', 'es-mx', 'es-es']) {
      const v = voices.find(v => (v.lang || '').replace('_', '-').toLowerCase().startsWith(p));
      if (v) return v;
    }
    return voices.find(v => /^es/i.test(v.lang || '')) || null;
  }
  function tts(text) {
    return new Promise(res => {
      let done = false; const fin = () => { if (!done) { done = true; res(); } };
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text); const v = pickVoice();
        if (v) u.voice = v; u.lang = v ? v.lang : 'es-AR'; u.rate = rate; u.pitch = 1;
        u.onend = fin; u.onerror = fin; speechSynthesis.speak(u);
        setTimeout(fin, Math.max(3000, text.length * 110) + 3000);
      } catch { setTimeout(fin, 1500); }
    });
  }
  function playAudio(src) {
    return new Promise((res, rej) => {
      const a = new Audio(src + (src.includes('?') ? '&' : '?') + 't=' + encodeURIComponent(token));
      a.onended = res; a.onerror = rej;
      a.play().catch(rej);
    });
  }
  function say(items) {
    queue.push(...items);
    if (!speaking) drain();
  }
  async function drain() {
    speaking = true; pauseListening();
    while (queue.length) {
      const it = queue.shift();
      setMode('speaking'); addLine('tata', it.text);
      if (it.action) showAction(it.action);
      if (it.audio) { try { await playAudio(it.audio); } catch { await tts(it.text); } }
      else await tts(it.text);
      if (/\?\s*$/.test(it.text)) convoUntil = Date.now() + 25000;
    }
    speaking = false; setMode('idle'); resumeListening();
  }

  // ---------- escuchar ----------
  async function send(text) {
    text = text.trim(); if (!text) return;
    addLine('me', text); $('#heard').textContent = '';
    setMode('thinking');
    try {
      const r = await api('/api/casa/hear', { method: 'POST', body: JSON.stringify({ text }) });
      info.ui = r.ui; render(r.ui); say(r.replies);
    } catch (e) {
      if (e.message !== 'unpaired') say([{ text: 'Perdoná, no me pude conectar. Probá de nuevo en un ratito.' }]);
    }
  }

  let rec = null, recOn = false, wantAlways = false;
  function makeRec(continuous) {
    const r = new SR();
    r.lang = 'es-AR'; r.interimResults = true; r.continuous = continuous; r.maxAlternatives = 1;
    r.onresult = ev => {
      let interim = '', final = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) final += res[0].transcript; else interim += res[0].transcript;
      }
      if (interim && (!continuous || Date.now() < convoUntil || /\btata\b/i.test(interim))) $('#heard').textContent = interim;
      if (final) onFinal(final, continuous);
    };
    r.onerror = ev => { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { wantAlways = false; showTypeFallback(); } };
    r.onend = () => {
      recOn = false; $('#talkBtn').classList.remove('on'); $('#talkTxt').textContent = 'Hablar';
      if (!speaking) setMode('idle');
      if (continuous && wantAlways && !speaking) setTimeout(() => { if (wantAlways && !speaking && !recOn) startRec(true); }, 300);
    };
    return r;
  }
  function onFinal(text, continuous) {
    if (!continuous) { send(text); return; }
    const hasWake = /\btata\b/i.test(text);
    if (hasWake || Date.now() < convoUntil) send(hasWake ? text.replace(/^.*?\btata\b[,\s]*/i, '') || 'hola' : text);
    else $('#heard').textContent = '';
  }
  function startRec(continuous) {
    if (!SR || recOn) return;
    try { rec = makeRec(continuous); rec.start(); recOn = true; } catch { recOn = false; }
    if (!continuous) { $('#talkBtn').classList.add('on'); $('#talkTxt').textContent = 'Te escucho'; setMode('listening'); }
  }
  function pauseListening() { if (recOn) { try { rec.abort(); } catch {} recOn = false; } }
  function resumeListening() { if (wantAlways) startRec(true); }
  function startAlways() { if (!SR) return showTypeFallback(); wantAlways = true; startRec(true); setMode('idle'); }
  function stopAlways() { wantAlways = false; pauseListening(); setMode('idle'); }
  function showTypeFallback() { $('#typeForm').hidden = false; $('#optType').checked = true; }

  $('#talkBtn').addEventListener('click', () => {
    if (!SR) { showTypeFallback(); $('#typeInput').focus(); return; }
    speechSynthesis.cancel(); queue = []; speaking = false;
    if (recOn && !wantAlways) { rec.stop(); return; }
    pauseListening();
    convoUntil = Date.now() + 25000;
    startRec(false);
  });
  $('#sosBtn').addEventListener('click', async () => {
    speechSynthesis.cancel(); queue = []; speaking = false;
    try { const r = await api('/api/casa/sos', { method: 'POST' }); info.ui = r.ui; render(r.ui); say(r.replies); }
    catch { say([{ text: 'No me pude conectar. Si es urgente, llamá al ' + (info?.emergency_phone || '107') + '.' }]); showAction({ type: 'dial', phone: info?.emergency_phone || '107', label: 'Llamar al ' + (info?.emergency_phone || '107') }); }
  });
  $('#chips').addEventListener('click', e => { const b = e.target.closest('[data-say]'); if (b) send(b.dataset.say); });
  $('#typeForm').addEventListener('submit', e => { e.preventDefault(); const i = $('#typeInput'); send(i.value); i.value = ''; });

  // ---------- opciones ----------
  $('#optAlways').checked = always;
  $('#optAlways').addEventListener('change', e => { always = e.target.checked; store.set('tata.always', always ? '1' : '0'); always ? startAlways() : stopAlways(); });
  $('#optType').checked = !SR;
  $('#typeForm').hidden = !!SR;
  $('#optType').addEventListener('change', e => { $('#typeForm').hidden = !e.target.checked; });
  $('#optRate').value = rate;
  $('#optRate').addEventListener('change', e => { rate = Number(e.target.value); store.set('tata.rate', String(rate)); });
  $('#optTest').addEventListener('click', () => say([{ text: `Hola, ${info?.elder_name || ''}. Así suena mi voz.` }]));

  // ---------- inicio ----------
  if (!token) show('pairView');
  else show('startView');
})();
