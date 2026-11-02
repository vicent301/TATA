// App de la familia: ver cómo está, cargar recordatorios y turnos, mandarle mensajes
// (texto o tu voz) y responder si pide ayuda.
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
  };

  // El link de invitación trae el token en el #; lo guardamos y lo sacamos de la barra.
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
  if (fromHash) { store.set('tata.member', fromHash); history.replaceState(null, '', location.pathname); }
  const token = store.get('tata.member');
  if (!token) { $('#nologin').hidden = false; return; }
  $('#app').hidden = false;

  let D = null; // datos del hogar
  let tab = store.get('tata.tab') || 'hoy';

  async function api(path, opts = {}) {
    const headers = { authorization: 'Bearer ' + token, ...(opts.body && !(opts.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) };
    const r = await fetch(path, { ...opts, headers });
    if (r.status === 401) { store.set('tata.member', null); location.reload(); throw new Error('Sesión vencida'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Algo salió mal');
    return j;
  }
  const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b || {}) });
  const patch = (p, b) => api(p, { method: 'PATCH', body: JSON.stringify(b) });
  const del = p => api(p, { method: 'DELETE' });

  const hhmm = ts => new Date(ts).toLocaleTimeString('es-AR', { timeZone: D.household.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayOf = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: D.household.timezone });
  const nice = date => new Date(date + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const DAYS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
  const daysText = d => d === '0123456' ? 'Todos los días' : d === '12345' ? 'De lunes a viernes' : [...'1234560'].filter(x => d.includes(x)).map(x => ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][x]).join(', ');

  // ---------- carga y tiempo real ----------
  async function load() {
    D = await api('/api/familia/me');
    render();
  }
  let reloadT = null;
  const soon = () => { clearTimeout(reloadT); reloadT = setTimeout(() => load().catch(() => {}), 150); };
  function connect() {
    const es = new EventSource('/api/familia/stream?t=' + encodeURIComponent(token));
    es.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.type === 'event') toast(m.title);
      soon();
    };
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5000); };
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') soon(); });

  function toast(text) {
    const t = $('#toast'); t.hidden = false;
    t.innerHTML = `<div class="hint">TATA · ahora</div><b>${esc(text)}</b>`;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // ---------- pestañas ----------
  function setTab(t) {
    tab = t; store.set('tata.tab', t);
    document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    document.querySelectorAll('.screen').forEach(s => { s.hidden = s.dataset.tab !== t; });
    window.scrollTo(0, 0);
  }
  document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); });
  setTab(tab);

  // ---------- render ----------
  function render() {
    const H = D.household, name = H.elder_name;
    $('#whoPill').textContent = name;
    document.title = `Tata · ${name}`;
    $('#msgTitle').textContent = `Mandarle un mensaje a ${name}`;
    renderStatus(); renderOverlay(); renderToday(); renderFeed(); renderAgenda(); renderSettings(); renderVoice();
  }

  function renderStatus() {
    const H = D.household, name = H.elder_name, s = D.sos;
    const today = D.now.date;
    const inactAlert = D.events.find(e => e.kind === 'warn' && /no habló con Tata/.test(e.title) && dayOf(e.ts) === today);
    let html;
    if (s && s.state === 'open') html = `<div class="status alert"><span class="eyebrow" style="color:var(--red)">Ahora</span><div class="st-title">${esc(name)} pidió ayuda</div><div class="st-sub">A las ${hhmm(s.at)}</div></div>`;
    else if (s) html = `<div class="status warn"><span class="eyebrow">Ahora</span><div class="st-title">${esc(s.by || 'Alguien')} va en camino</div><div class="st-sub">Tata le avisó que llegan pronto. <button class="btn small" data-act="resolve" type="button">Ya está todo bien</button></div></div>`;
    else if (inactAlert && !D.firstActivityToday) html = `<div class="status warn"><span class="eyebrow">Ahora</span><div class="st-title">Sin actividad esta mañana</div><div class="st-sub">No respondió a Tata. Probá llamarla.</div></div>`;
    else {
      const last = D.lastActivity;
      const sub = !D.firstActivityToday ? 'Todavía no habló con Tata hoy.' : last ? `Última actividad ${hhmm(last.ts)} · ${esc(last.text.toLowerCase())}` : `Habló con Tata a las ${hhmm(D.firstActivityToday)}.`;
      html = `<div class="status ok"><span class="eyebrow" style="color:var(--green)">Ahora</span><div class="st-title">${esc(name)} está bien</div><div class="st-sub">${sub}</div></div>`;
    }
    $('#statusCard').innerHTML = html;
    const dl = $('#devLine');
    if (!H.paired) { dl.className = 'devline off'; dl.innerHTML = '<i></i>Tata todavía no está instalada en su casa. Mirá Ajustes.'; }
    else if (H.online) { dl.className = 'devline on'; dl.innerHTML = '<i></i>Tata está encendida en su casa'; }
    else { dl.className = 'devline off'; dl.innerHTML = `<i></i>Tata está desconectada${H.last_seen ? ' desde las ' + hhmm(H.last_seen) : ''}`; }
  }

  function renderOverlay() {
    const ov = $('#overlay'), s = D.sos, H = D.household;
    if (!(s && s.state === 'open')) { ov.hidden = true; ov.innerHTML = ''; return; }
    ov.hidden = false;
    const tel = H.device_phone ? `<a class="ovb white" href="tel:${esc(H.device_phone.replace(/[^\d+]/g, ''))}">Llamar a ${esc(H.elder_name)}</a>` : '';
    ov.innerHTML = `<div class="avatar">!</div><div class="big">${esc(H.elder_name)} pidió ayuda</div>
      <div class="meta">${hhmm(s.at)} · desde Tata en su casa</div>
      <div class="quote">${s.source === 'voz' && s.raw ? '“' + esc(s.raw) + '”' : 'Apretó el botón SOS'}</div>
      <div class="ov-actions">${tel}<button class="ovb ${tel ? 'ghost' : 'white'}" type="button" data-act="coming">Voy para allá</button>
      <a class="ovb ghost" href="tel:${esc(H.emergency_phone)}">Llamar a emergencias (${esc(H.emergency_phone)})</a>
      <button class="ovb ghost" style="font-size:14px;padding:10px" type="button" data-act="resolve">Ya está todo bien</button></div>`;
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    b.disabled = true;
    try { await post('/api/familia/sos/' + b.dataset.act); await load(); } catch (x) { toast(x.message); b.disabled = false; }
  });

  function remPill(r) {
    if (!r.active) return '<span class="pill">Pausado</span>';
    if (r.done_at) return `<span class="pill ok">Tomada ${hhmm(r.done_at)}</span>`;
    if (r.missed) return '<span class="pill">No se dijo</span>';
    if (r.fired_at) return r.is_med ? '<span class="pill warn">Sin confirmar</span>' : '<span class="pill ok">Avisado</span>';
    return '<span class="pill">Programado</span>';
  }
  function isToday(r) {
    const wd = new Date(D.now.date + 'T12:00:00').getDay();
    return r.date ? r.date === D.now.date : r.days.includes(String(wd));
  }
  function renderToday() {
    const list = D.reminders.filter(r => r.active && isToday(r));
    $('#todayList').innerHTML = list.length ? list.map(r => `<li><span class="tm">${r.at}</span><span class="tx">${esc(r.label)}${r.audio_id ? '<small>Con tu voz</small>' : ''}</span>${remPill(r)}</li>`).join('')
      : '<li class="empty">Sin recordatorios para hoy. Agregalos en Agenda.</li>';
  }
  function renderFeed() {
    $('#feed').innerHTML = D.events.length ? D.events.map(f => `<li class="fi k-${f.kind}"><div class="fi-top"><span class="dot"></span><b>${esc(f.title)}</b><span class="fi-t">${dayOf(f.ts) === D.now.date ? hhmm(f.ts) : nice(dayOf(f.ts)).split(' ').slice(0, 2).join(' ') + ' ' + hhmm(f.ts)}</span></div>${f.body ? `<div class="fi-b">${esc(f.body)}</div>` : ''}${f.list?.length ? `<ul>${f.list.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</li>`).join('')
      : '<li class="empty">Todavía no hay avisos. Si no llega nada, es buena noticia.</li>';
  }

  function renderAgenda() {
    $('#remList').innerHTML = D.reminders.length ? D.reminders.map(r => `<li class="${r.active ? '' : 'off'}"><span class="tm">${r.at}</span>
      <span class="tx">${esc(r.label)}<small>${r.date ? nice(r.date) : daysText(r.days)}${r.is_med ? ' · pide confirmación' : ''}${r.audio_id ? ' · con tu voz' : ''}</small></span>
      <span class="acts"><button class="icon" type="button" title="${r.active ? 'Pausar' : 'Activar'}" data-rem-toggle="${r.id}">${r.active ? '❚❚' : '▶'}</button><button class="icon" type="button" title="Borrar" data-rem-del="${r.id}">✕</button></span></li>`).join('')
      : '<li class="empty">Todavía no hay recordatorios.</li>';
    $('#aptList').innerHTML = D.appointments.length ? D.appointments.map(a => `<li><span class="tm">${a.at}</span>
      <span class="tx">${esc(a.what.charAt(0).toUpperCase() + a.what.slice(1))}<small>${nice(a.date)}${a.note ? ' · ' + esc(a.note) : ''}${a.remind_eve ? ' · se lo recuerda la noche anterior' : ''}</small></span>
      <span class="acts"><button class="icon" type="button" title="Borrar" data-apt-del="${a.id}">✕</button></span></li>`).join('')
      : '<li class="empty">No hay turnos cargados.</li>';
  }
  document.addEventListener('click', async e => {
    const t = e.target.closest('[data-rem-toggle],[data-rem-del],[data-apt-del],[data-contact-del],[data-member-del]'); if (!t) return;
    try {
      if (t.dataset.remToggle) { const r = D.reminders.find(x => x.id == t.dataset.remToggle); await patch('/api/familia/reminders/' + r.id, { active: !r.active }); }
      else if (t.dataset.remDel) { if (!confirm('¿Borrar este recordatorio?')) return; await del('/api/familia/reminders/' + t.dataset.remDel); }
      else if (t.dataset.aptDel) { if (!confirm('¿Borrar este turno?')) return; await del('/api/familia/appointments/' + t.dataset.aptDel); }
      else if (t.dataset.contactDel) { if (!confirm('¿Borrar este contacto?')) return; await del('/api/familia/contacts/' + t.dataset.contactDel); }
      else if (t.dataset.memberDel) { if (!confirm('¿Quitar a esta persona? Su link deja de funcionar.')) return; await del('/api/familia/members/' + t.dataset.memberDel); }
      await load();
    } catch (x) { toast(x.message); }
  });

  // ---------- grabador de voz ----------
  function recorder(box) {
    const st = { id: null, mr: null, chunks: [], t0: 0, timer: null };
    const canRec = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    const draw = (state, extra = '') => {
      if (!canRec) { box.innerHTML = ''; return; }
      box.innerHTML = state === 'rec'
        ? `<button type="button" class="btn small recbtn on">■ Parar <span>0:00</span></button>`
        : state === 'done'
          ? `${extra}<button type="button" class="btn small" data-x>Borrar audio</button>`
          : `<button type="button" class="btn small recbtn">🎙 Grabar con tu voz</button>${extra}`;
    };
    draw('idle');
    box.addEventListener('click', async e => {
      if (e.target.closest('[data-x]')) { st.id = null; draw('idle'); return; }
      const b = e.target.closest('.recbtn'); if (!b) return;
      if (st.mr) { st.mr.stop(); return; }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported?.(t)) || '';
        st.mr = new MediaRecorder(stream, type ? { mimeType: type } : {});
        st.chunks = [];
        st.mr.ondataavailable = ev => ev.data.size && st.chunks.push(ev.data);
        st.mr.onstop = async () => {
          clearInterval(st.timer); stream.getTracks().forEach(t => t.stop());
          const blob = new Blob(st.chunks, { type: (st.mr.mimeType || 'audio/webm').split(';')[0] });
          st.mr = null;
          draw('idle', ' <span class="hint">Subiendo…</span>');
          try {
            const r = await api('/api/familia/audio', { method: 'POST', body: blob, headers: { 'content-type': blob.type } });
            st.id = r.id;
            draw('done', `<audio controls src="${URL.createObjectURL(blob)}"></audio>`);
          } catch (x) { draw('idle', ` <span class="err">${esc(x.message)}</span>`); }
        };
        st.mr.start(); st.t0 = Date.now(); draw('rec');
        st.timer = setInterval(() => {
          const s = Math.floor((Date.now() - st.t0) / 1000); const sp = box.querySelector('.recbtn span');
          if (sp) sp.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
          if (s >= 60) st.mr?.stop();
        }, 250);
      } catch { draw('idle', ' <span class="err">No pude usar el micrófono.</span>'); }
    });
    return { get id() { return st.id; }, reset() { st.id = null; draw('idle'); } };
  }
  const msgRec = recorder($('#msgRec'));
  const remRec = recorder($('#remRec'));

  // ---------- formularios ----------
  $('#msgForm').addEventListener('submit', async e => {
    e.preventDefault();
    const text = $('#msgText').value.trim();
    if (!text && !msgRec.id) return;
    try {
      const own = !$('#msgOwnBox').hidden && $('#msgOwn').checked && !msgRec.id;
      if (own) $('#msgHint').textContent = 'Preparando tu voz…';
      const r = await post('/api/familia/say', { text, audio_id: msgRec.id, own_voice: own });
      $('#msgHint').textContent = (r.delivered ? '✓ Tata se lo está diciendo' : 'Tata está desconectada: no le llegó.') + (r.voiceNote ? ' · ' + r.voiceNote : '');
      $('#msgText').value = ''; msgRec.reset();
      setTimeout(() => { $('#msgHint').textContent = ''; }, r.voiceNote ? 9000 : 5000);
      load();
    } catch (x) { $('#msgHint').textContent = x.message; }
  });

  $('#dayPick').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d => `<label><input type="checkbox" name="d" value="${d}" checked><span>${DAYS[d]}</span></label>`).join('');
  const remForm = $('#remForm');
  remForm.once.addEventListener('change', () => {
    remForm.date.disabled = !remForm.once.checked;
    $('#dayPick').style.opacity = remForm.once.checked ? .4 : 1;
    if (remForm.once.checked && !remForm.date.value) remForm.date.value = D.now.date;
  });
  remForm.addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#remErr'); err.hidden = true;
    const days = [...remForm.querySelectorAll('input[name=d]:checked')].map(i => i.value).join('');
    if (!remForm.once.checked && !days) { err.textContent = 'Elegí al menos un día.'; err.hidden = false; return; }
    try {
      const r = await post('/api/familia/reminders', {
        label: remForm.label.value, say: remForm.say.value, at: remForm.at.value, is_med: remForm.kind.value === 'med',
        days: remForm.once.checked ? '' : days, date: remForm.once.checked ? remForm.date.value : null, audio_id: remRec.id,
        own_voice: !$('#remOwnBox').hidden && remForm.own_voice.checked
      });
      remForm.reset(); remRec.reset(); remForm.date.disabled = true; $('#dayPick').style.opacity = 1;
      $('#remAdd').open = false; await load(); toast(r.voiceNote ? 'Guardado. ' + r.voiceNote : 'Recordatorio guardado');
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  });

  const aptForm = $('#aptForm');
  aptForm.addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#aptErr'); err.hidden = true;
    try {
      await post('/api/familia/appointments', { date: aptForm.date.value, at: aptForm.at.value, what: aptForm.what.value, note: aptForm.note.value, remind_eve: aptForm.remind_eve.checked });
      aptForm.reset(); aptForm.closest('details').open = false; await load(); toast('Turno guardado');
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  });

  // ---------- tu voz en Tata ----------
  // Se graba una muestra de 10 a 30 segundos y se sube como WAV (el servicio de voz no lee webm).
  const VOICE_TEXT = 'Hola, ¿cómo andás? Hoy me levanté temprano, tomé unos mates y salí a caminar un rato por el barrio. Estaba lindo el día, con sol y un poco de viento. A la tarde paso a verte y charlamos tranquilos.';
  const voiceSt = { mr: null, timer: null, again: false };
  async function toWav(blob) {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    ac.close?.();
    const n = buf.length, rate = buf.sampleRate, mono = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / buf.numberOfChannels; }
    const v = new DataView(new ArrayBuffer(44 + n * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, mono[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([v], { type: 'audio/wav' });
  }
  function renderVoice() {
    const has = D.me.has_voice;
    $('#msgOwnBox').hidden = !has; $('#remOwnBox').hidden = !has;
    if (voiceSt.mr) return; // no pisar la grabación en curso
    const off = D.features?.voice ? '' : '<p class="hint">El servicio de voz no está prendido en el servidor. Podés grabar igual; mientras tanto, Tata dice los mensajes con su voz.</p>';
    if (has && !voiceSt.again) {
      $('#voiceCard').innerHTML = `<p style="margin:0">✓ Tu voz está guardada. Al mandar un mensaje o crear un recordatorio podés elegir “Que lo diga con mi voz”.</p>
        <p class="hint">Antes de tu voz, Tata siempre aclara que el mensaje es tuyo. Lo que hable de plata, bancos o claves lo dice Tata con su propia voz.</p>${off}
        <div class="rec" id="voiceOut"></div>
        <div class="row"><button class="btn small" type="button" data-v="test">Escuchar cómo suena</button><button class="btn small" type="button" data-v="again">Grabar de nuevo</button><button class="btn small danger" type="button" data-v="del">Borrar mi voz</button></div>`;
      return;
    }
    $('#voiceCard').innerHTML = `<p style="margin:0">Grabá tu voz una vez y Tata le va a poder decir tus mensajes y recordatorios <b>con tu voz</b>, para que ${esc(D.household.elder_name)} la reconozca.</p>
      <p class="hint">Buscá un lugar sin ruido, apretá Grabar y leé este texto tranquilo, con tu forma de hablar de siempre (entre 10 y 30 segundos):</p>
      <blockquote class="readme">${esc(VOICE_TEXT)}</blockquote>
      <label class="set"><input type="checkbox" id="voiceConsent"><span>Doy mi consentimiento para que Tata use esta grabación para decir, con mi voz, los mensajes y recordatorios que yo escriba.
        <small>Tata siempre aclara que el mensaje es tuyo, nunca usa tu voz para temas de plata o claves, y la podés borrar cuando quieras.</small></span></label>${off}
      <div class="row"><button class="btn primary recbtn" type="button" data-v="rec" disabled>🎙 Grabar mi voz</button>${voiceSt.again ? '<button class="btn small" type="button" data-v="cancel">Cancelar</button>' : ''}<span class="hint" id="voiceHint"></span></div>`;
  }
  $('#voiceCard').addEventListener('change', e => {
    if (e.target.id === 'voiceConsent') $('#voiceCard [data-v=rec]').disabled = !e.target.checked;
  });
  $('#voiceCard').addEventListener('click', async e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    const act = b.dataset.v;
    if (act === 'again') { voiceSt.again = true; renderVoice(); return; }
    if (act === 'cancel') { voiceSt.again = false; renderVoice(); return; }
    if (act === 'del') {
      if (!confirm('¿Borrar tu voz de Tata?')) return;
      await del('/api/familia/voice'); voiceSt.again = false; await load(); toast('Tu voz se borró'); return;
    }
    if (act === 'test') {
      b.disabled = true; b.textContent = 'Generando… (puede tardar)';
      try {
        const r = await fetch('/api/familia/voice/test', { method: 'POST', headers: { authorization: 'Bearer ' + token } });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'No se pudo');
        $('#voiceOut').innerHTML = `<audio controls autoplay src="${URL.createObjectURL(await r.blob())}"></audio>`;
      } catch (x) { toast(x.message); }
      b.disabled = false; b.textContent = 'Escuchar cómo suena';
      return;
    }
    if (act !== 'rec') return;
    const hint = $('#voiceHint');
    if (voiceSt.mr) { voiceSt.mr.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
      const chunks = [];
      voiceSt.mr = new MediaRecorder(stream);
      voiceSt.mr.ondataavailable = ev => ev.data.size && chunks.push(ev.data);
      const t0 = Date.now();
      voiceSt.mr.onstop = async () => {
        clearInterval(voiceSt.timer); stream.getTracks().forEach(t => t.stop()); voiceSt.mr = null;
        const secs = (Date.now() - t0) / 1000;
        b.classList.remove('on'); b.textContent = '🎙 Grabar mi voz';
        if (secs < 8) { hint.textContent = 'Fue muy corto: leé el texto completo (al menos 10 segundos).'; return; }
        hint.textContent = 'Guardando…';
        try {
          const wav = await toWav(new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' }));
          await api('/api/familia/voice?consent=1', { method: 'POST', body: wav, headers: { 'content-type': 'audio/wav' } });
          voiceSt.again = false; await load(); toast('¡Listo! Tu voz quedó guardada');
        } catch (x) { hint.textContent = x.message; }
      };
      voiceSt.mr.start();
      b.classList.add('on'); b.textContent = '■ Terminé';
      voiceSt.timer = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        hint.textContent = `Grabando… 0:${String(s).padStart(2, '0')}`;
        if (s >= 30) voiceSt.mr?.stop();
      }, 250);
    } catch { hint.textContent = 'No pude usar el micrófono.'; }
  });

  // ---------- ajustes ----------
  let settingsFilled = false;
  function renderSettings() {
    const H = D.household;
    $('#deviceCard').innerHTML = H.paired
      ? `<p style="margin:0 0 8px">${H.online ? '✓ Tata está conectada.' : 'Tata está vinculada pero ahora no está conectada.'}</p>
         <p class="hint">Para cambiar de dispositivo, abrí <b>${esc(location.host)}/casa</b> en el nuevo y escribí este código:</p>
         <div class="code">${esc(H.device_code)}</div>
         <p><button class="btn small danger" type="button" id="unpair">Desvincular el dispositivo actual</button></p>`
      : `<p style="margin:0 0 8px">En la tablet o celular que va a quedar en su casa, abrí <b>${esc(location.host)}/casa</b> y escribí este código:</p>
         <div class="code">${esc(H.device_code)}</div>
         <p class="hint">Dejala enchufada, con wifi y el volumen alto. Funciona mejor con Chrome en Android.</p>`;
    $('#unpair')?.addEventListener('click', async () => { if (confirm('El dispositivo actual va a dejar de funcionar. ¿Seguir?')) { await post('/api/familia/device/unpair'); load(); } });

    $('#memberList').innerHTML = D.members.map(m => `<li><span class="tx">${esc(m.name)}${m.id === D.me.id ? ' (vos)' : ''}<small>${esc(m.relation || 'familia')}${m.phone ? ' · ' + esc(m.phone) : ''}</small></span>
      ${m.gets_alerts ? '<span class="pill ok">Avisos</span>' : '<span class="pill">Sin avisos</span>'}
      ${D.me.is_admin && m.id !== D.me.id ? `<button class="icon" type="button" title="Quitar" data-member-del="${m.id}">✕</button>` : ''}</li>`).join('');
    $('#inviteBox').hidden = !D.me.is_admin;
    const others = D.contacts.filter(c => !c.member_id);
    $('#contactList').innerHTML = others.length ? others.map(c => `<li><span class="tx">${esc(c.name)}<small>${esc(c.relation || 'contacto')}${c.phone ? ' · ' + esc(c.phone) : ' · sin teléfono'}</small></span><button class="icon" type="button" title="Borrar" data-contact-del="${c.id}">✕</button></li>`).join('')
      : '<li class="empty">Tata puede llamar o mandarle mensajes a quien cargues acá.</li>';

    if (!settingsFilled) {
      settingsFilled = true;
      const f = $('#hhForm');
      f.inactivity_on.checked = H.inactivity_on; f.inactivity_at.value = H.inactivity_at;
      f.summary_on.checked = H.summary_on; f.summary_at.value = H.summary_at;
      f.elder_name.value = H.elder_name; f.emergency_phone.value = H.emergency_phone; f.device_phone.value = H.device_phone || '';
      const m = $('#meForm'); m.phone.value = D.me.phone || ''; m.gets_alerts.checked = D.me.gets_alerts;
    }
    renderPush();
  }
  $('#hhForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    try {
      await patch('/api/familia/household', { inactivity_on: f.inactivity_on.checked, inactivity_at: f.inactivity_at.value, summary_on: f.summary_on.checked, summary_at: f.summary_at.value,
        elder_name: f.elder_name.value, emergency_phone: f.emergency_phone.value, device_phone: f.device_phone.value });
      $('#hhSaved').textContent = '✓ Guardado'; setTimeout(() => { $('#hhSaved').textContent = ''; }, 3000); load();
    } catch (x) { $('#hhSaved').textContent = x.message; }
  });
  $('#meForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    try { await patch('/api/familia/me', { phone: f.phone.value, gets_alerts: f.gets_alerts.checked }); $('#meSaved').textContent = '✓ Guardado'; load(); }
    catch (x) { $('#meSaved').textContent = x.message; }
  });
  $('#inviteForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    try {
      const r = await post('/api/familia/members', { name: f.name.value, relation: f.relation.value, phone: f.phone.value });
      const link = `${location.origin}/familia/#t=${r.token}`;
      const msg = `Hola ${f.name.value}! Te sumé a Tata para que recibas los avisos de ${D.household.elder_name}. Abrí este link en tu celular: ${link}`;
      $('#inviteOut').innerHTML = `<div class="invite"><span>Mandale este link (es personal, no lo compartas con nadie más):</span><code>${esc(link)}</code>
        <div class="row"><a class="btn small primary" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">Mandar por WhatsApp</a><button class="btn small" type="button" id="copyLink">Copiar</button></div></div>`;
      $('#copyLink').onclick = () => navigator.clipboard?.writeText(link).then(() => toast('Link copiado'));
      f.reset(); load();
    } catch (x) { $('#inviteOut').innerHTML = `<p class="err">${esc(x.message)}</p>`; }
  });
  $('#contactForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    try { await post('/api/familia/contacts', { name: f.name.value, relation: f.relation.value, phone: f.phone.value }); f.reset(); f.closest('details').open = false; load(); }
    catch (x) { toast(x.message); }
  });
  $('#logout').addEventListener('click', () => {
    if (!confirm('Vas a necesitar tu link de invitación para volver a entrar. ¿Salir?')) return;
    store.set('tata.member', null); location.href = '/';
  });

  // ---------- notificaciones push ----------
  let swReg = null;
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/familia/sw.js', { scope: '/familia/' }).then(r => { swReg = r; renderPush(); }).catch(() => {});
  const b64ToBytes = s => { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  async function renderPush() {
    const box = $('#pushCard'); if (!D) return;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (!pushSupported) {
      box.innerHTML = isIOS && !standalone
        ? '<p style="margin:0">En iPhone: tocá <b>Compartir</b> → <b>Agregar a inicio</b>, abrí Tata desde el ícono y volvé acá para activar los avisos.</p>'
        : '<p style="margin:0">Este navegador no recibe notificaciones. Probá con Chrome.</p>';
      return;
    }
    const sub = swReg && await swReg.pushManager.getSubscription();
    if (Notification.permission === 'denied') box.innerHTML = '<p style="margin:0">Las notificaciones están bloqueadas. Habilitalas desde la configuración del navegador para este sitio.</p>';
    else if (sub) box.innerHTML = '<p style="margin:0 0 8px">✓ Activadas. Si pide ayuda, te llega aunque tengas la app cerrada.</p><button class="btn small" type="button" id="pushTest">Mandar una de prueba</button>';
    else box.innerHTML = '<p style="margin:0 0 8px"><b>Importante:</b> activalas para enterarte al instante si pide ayuda.</p><button class="btn primary" type="button" id="pushOn">Activar notificaciones</button>';
    $('#pushOn')?.addEventListener('click', enablePush);
    $('#pushTest')?.addEventListener('click', () => post('/api/familia/push/test').then(() => toast('Enviada')).catch(x => toast(x.message)));
  }
  async function enablePush() {
    try {
      if (await Notification.requestPermission() !== 'granted') return renderPush();
      swReg = swReg || await navigator.serviceWorker.ready;
      const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(D.vapidPublicKey) });
      await post('/api/familia/push/subscribe', { sub: sub.toJSON() });
      toast('Notificaciones activadas'); renderPush();
    } catch (x) { toast('No se pudo activar: ' + x.message); }
  }

  load().then(() => { connect(); if (!D.household.paired || (pushSupported && Notification.permission === 'default')) { if (tab === 'hoy' && !D.household.paired) setTab('ajustes'); } })
    .catch(x => toast(x.message));
})();
