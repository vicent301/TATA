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
  let always = store.get('tata.always') !== '0'; // como un parlante: escucha siempre salvo que lo apaguen
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
      const r = await fetch('/api/casa/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: $('#pairCode').value, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
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
    say([{ text: always && SR
      ? `Hola, ${info.elder_name}. Acá estoy. Cuando me necesites, decí Tata y lo que quieras. Si necesitás ayuda, mantené apretado mi botón.`
      : `Hola, ${info.elder_name}. Acá estoy. Tocame para hablar, y si necesitás ayuda, mantené apretado mi botón.` }]);
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
    c.title = on ? 'Conectada' : 'Sin conexión';
  }

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
  }
  function setMode(m) {
    const sosOpen = info?.ui?.sos?.state === 'open';
    const mode = m === 'idle' && sosOpen ? 'alert' : m;
    $('#tata').dataset.mode = mode; $('#device').dataset.mode = mode;
    $('#status').textContent = m === 'speaking' ? '' : m === 'listening' ? 'Te escucho…' : m === 'thinking' ? 'Un momento…'
      : wantAlways ? 'Decí “Tata” o tocame' : 'Tocame para hablar';
  }
  // Lo último que se dijo, en letras grandes (ayuda si no escucha bien). Se apaga solo.
  function addLine(who, text) {
    const c = $('#caption');
    c.textContent = who === 'me' ? `“${text}”` : text;
    c.className = 'caption' + (who === 'me' ? ' me' : '');
    clearTimeout(addLine.t); addLine.t = setTimeout(() => { if (!speaking) c.classList.add('fade'); }, 15000);
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
    const of = p => voices.filter(v => (v.lang || '').replace('_', '-').toLowerCase().startsWith(p));
    const prefs = ['es-ar', 'es-419', 'es-us', 'es-mx', 'es-es'];
    // Las voces neuronales ("Natural", "Online", como las de Edge) suenan mucho menos robóticas:
    // primero cualquiera de esas en español, y recién después las comunes por acento.
    for (const p of prefs) {
      const v = of(p).find(v => /natural|online|neural/i.test(v.name));
      if (v) return v;
    }
    for (const p of prefs) {
      const v = of(p)[0];
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
    addLine('me', text);
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
      if (interim && (!continuous || Date.now() < convoUntil || /\btata\b/i.test(interim))) addLine('me', interim);
      if (final) onFinal(final, continuous);
    };
    r.onerror = ev => { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { wantAlways = false; showTypeFallback(); } };
    r.onend = () => {
      recOn = false;
      if (!speaking) setMode('idle');
      if (continuous && wantAlways && !speaking) setTimeout(() => { if (wantAlways && !speaking && !recOn) startRec(true); }, 300);
    };
    return r;
  }
  function onFinal(text, continuous) {
    if (!continuous) { send(text); return; }
    const hasWake = /\btata\b/i.test(text);
    if (hasWake || Date.now() < convoUntil) send(hasWake ? text.replace(/^.*?\btata\b[,\s]*/i, '') || 'hola' : text);
    else $('#caption').classList.add('fade');
  }
  function startRec(continuous) {
    if (!SR || recOn) return;
    try { rec = makeRec(continuous); rec.start(); recOn = true; } catch { recOn = false; }
    if (!continuous) setMode('listening');
  }
  function pauseListening() { if (recOn) { try { rec.abort(); } catch {} recOn = false; } }
  function resumeListening() { if (wantAlways) startRec(true); }
  function startAlways() { if (!SR) return showTypeFallback(); wantAlways = true; startRec(true); setMode('idle'); }
  function stopAlways() { wantAlways = false; pauseListening(); setMode('idle'); }
  function showTypeFallback() { $('#typeForm').hidden = false; $('#optType').checked = true; }

  // Un toque: hablar. Mantener apretado 2 segundos: pedir ayuda (el aro se llena de rojo).
  const HOLD_MS = 2000;
  const dev = $('#device');
  dev.style.setProperty('--hold', HOLD_MS + 'ms');
  let holdT = null, holdStart = 0;
  dev.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    holdStart = Date.now(); dev.classList.add('holding');
    holdT = setTimeout(() => { holdT = null; dev.classList.remove('holding'); navigator.vibrate?.(200); askHelp(); }, HOLD_MS);
  });
  const endHold = () => {
    dev.classList.remove('holding');
    if (!holdT) return;
    clearTimeout(holdT); holdT = null;
    if (Date.now() - holdStart < 600) talk();
  };
  dev.addEventListener('pointerup', endHold);
  dev.addEventListener('pointerleave', endHold);
  dev.addEventListener('pointercancel', endHold);
  dev.addEventListener('contextmenu', e => e.preventDefault());
  dev.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); talk(); } });

  function talk() {
    if (!SR) { showTypeFallback(); $('#typeInput').focus(); return; }
    speechSynthesis.cancel(); queue = []; speaking = false;
    if (recOn && !wantAlways) { rec.stop(); return; }
    pauseListening();
    convoUntil = Date.now() + 25000;
    startRec(false);
  }
  async function askHelp() {
    speechSynthesis.cancel(); queue = []; speaking = false;
    try { const r = await api('/api/casa/sos', { method: 'POST' }); info.ui = r.ui; render(r.ui); say(r.replies); }
    catch { say([{ text: 'No me pude conectar. Si es urgente, llamá al ' + (info?.emergency_phone || '107') + '.' }]); showAction({ type: 'dial', phone: info?.emergency_phone || '107', label: 'Llamar al ' + (info?.emergency_phone || '107') }); }
  }
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
  $('#gearBtn').addEventListener('click', () => {
    $('#optWho').textContent = info?.elder_name ? `Esta tablet es la de la casa de ${info.elder_name}.` : '';
    $('#opts').hidden = false;
  });
  // Dos toques para desvincular, para que no pase sin querer.
  let unpairArmed = null;
  $('#optUnpair').addEventListener('click', async e => {
    const b = e.currentTarget;
    if (!unpairArmed) {
      b.textContent = 'Tocá de nuevo para confirmar';
      unpairArmed = setTimeout(() => { unpairArmed = null; b.textContent = 'Desvincular esta tablet'; }, 5000);
      return;
    }
    clearTimeout(unpairArmed); unpairArmed = null; b.textContent = 'Desvincular esta tablet';
    try { await api('/api/casa/unpair', { method: 'POST' }); } catch {}
    stopAlways?.(); $('#opts').hidden = true; unpair();
  });
  $('#optClose').addEventListener('click', () => { $('#opts').hidden = true; });
  $('#opts').addEventListener('click', e => { if (e.target.id === 'opts') $('#opts').hidden = true; });

  // ---------- inicio ----------
  if (!token) show('pairView');
  else show('startView');
})();
