// Panel de Órbita: cargar y mantener la cartelera de Encuentro.
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
  };
  const DAY_NAMES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  let key = store.get('orbita.key');

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { authorization: 'Bearer ' + key, ...(opts.body ? { 'content-type': 'application/json' } : {}) } });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { store.set('orbita.key', null); key = null; showKey('Clave incorrecta.'); throw new Error('Clave incorrecta'); }
    if (r.status === 404 && path === '/api/orbita/activities') { showKey('El panel está apagado en este servidor (falta ORBITA_KEY).'); throw new Error('Apagado'); }
    if (!r.ok) throw new Error(j.error || 'Algo salió mal');
    return j;
  }

  function showKey(msg) {
    $('#panel').hidden = true; $('#keyForm').hidden = false;
    const e = $('#keyErr'); e.hidden = !msg; e.textContent = msg || '';
  }
  $('#keyForm').addEventListener('submit', e => {
    e.preventDefault();
    key = new FormData(e.target).get('key'); store.set('orbita.key', key);
    load().catch(() => {});
  });

  $('#days').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d => `<label><input type="checkbox" value="${d}"> ${DAY_NAMES[d]}</label>`).join('');

  async function load() {
    const { activities } = await api('/api/orbita/activities');
    $('#keyForm').hidden = true; $('#panel').hidden = false;
    $('#list').innerHTML = activities.length ? activities.map(a => `
      <li class="card${a.active ? '' : ' off'}">
        <div class="tx">
          <b>${esc(a.title)}</b>
          <div>${esc(a.place)}${a.address ? ' · ' + esc(a.address) : ''}</div>
          <div>${esc(a.city)}${a.barrio ? ' · ' + esc(a.barrio) : ''}</div>
          <div>${a.date ? esc(a.date) : esc([...a.days].map(d => DAY_NAMES[d]).join(', '))} · ${hhmm(a.at)}${a.price ? ' · ' + esc(a.price) : ''}${a.tags ? ' · ' + esc(a.tags) : ''}</div>
        </div>
        <div class="acts">
          <button class="btn small" type="button" data-toggle="${a.id}" data-active="${a.active}">${a.active ? 'Pausar' : 'Activar'}</button>
          <button class="btn small danger" type="button" data-del="${a.id}">Borrar</button>
        </div>
      </li>`).join('') : '<li class="hint">Todavía no hay actividades cargadas.</li>';
  }

  $('#list').addEventListener('click', async e => {
    const t = e.target.closest('[data-toggle]'), d = e.target.closest('[data-del]');
    if (t) await api('/api/orbita/activities/' + t.dataset.toggle, { method: 'PATCH', body: JSON.stringify({ active: t.dataset.active !== '1' }) });
    if (d) await api('/api/orbita/activities/' + d.dataset.del, { method: 'DELETE' });
    if (t || d) load();
  });

  $('#actForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#actErr'); err.hidden = true;
    const b = Object.fromEntries(new FormData(e.target));
    b.days = [...document.querySelectorAll('#days input:checked')].map(i => i.value).join('');
    try {
      await api('/api/orbita/activities', { method: 'POST', body: JSON.stringify(b) });
      e.target.reset();
      $('#actSaved').textContent = 'Guardada.'; setTimeout(() => { $('#actSaved').textContent = ''; }, 2500);
      load();
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  });

  if (key) load().catch(() => {}); else showKey();
})();
