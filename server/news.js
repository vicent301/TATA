// Lo que Tata le cuenta a la mañana además de la pastilla: el clima y una noticia liviana de sus intereses.
// Todo con servicios gratis y sin claves (Open-Meteo y el RSS de Google Noticias); la noticia la elige Claude.

/** Ciudad -> { lat, lon } con el geocodificador de Open-Meteo, o null si no la encuentra o falla. */
export async function geocode(city, fetchImpl = globalThis.fetch) {
  if (!city) return null;
  try {
    const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es&country=AR`;
    const r = await fetchImpl(u, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const p = (await r.json())?.results?.[0];
    return p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) ? { lat: p.latitude, lon: p.longitude } : null;
  } catch { return null; }
}

// Códigos del tiempo de Open-Meteo (WMO) -> cómo lo dice Tata.
const SKY = [
  [[0], 'Hoy va a estar soleado'], [[1, 2], 'Hoy va a estar algo nublado'], [[3], 'Hoy va a estar nublado'],
  [[45, 48], 'Hoy va a haber niebla'], [[51, 53, 55, 56, 57], 'Hoy va a lloviznar'],
  [[61, 63, 65, 66, 67, 80, 81, 82], 'Hoy va a haber lluvia'], [[71, 73, 75, 77, 85, 86], 'Hoy va a nevar'],
  [[95, 96, 99], 'Hoy va a haber tormenta']
];

/** { code, max, min } -> "Hoy va a estar soleado, con una máxima de 24 grados." */
export function weatherLine({ code, max }) {
  const sky = SKY.find(([codes]) => codes.includes(code))?.[1] || 'Hoy';
  return `${sky}, con una máxima de ${Math.round(max)} grados.`;
}

export async function fetchWeather(lat, lon, tz, fetchImpl = globalThis.fetch) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=${encodeURIComponent(tz)}&forecast_days=1`;
  const r = await fetchImpl(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const d = (await r.json())?.daily;
  const w = { code: d?.weathercode?.[0], max: d?.temperature_2m_max?.[0], min: d?.temperature_2m_min?.[0] };
  return Number.isFinite(w.code) && Number.isFinite(w.max) ? w : null;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', iexcl: '¡', iquest: '¿', laquo: '«', raquo: '»' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#'
  ? String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10))
  : NAMED[e] ?? m);
const inner = (xml, tag) => {
  const m = xml.match(new RegExp(String.raw`<${tag}\b[^>]*>([\s\S]*?)</${tag}>`));
  return m ? decode(m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim()) : '';
};

/** RSS de Google Noticias -> [{ title, source }], sin la " - Fuente" que Google agrega al título. */
export function parseRss(xml) {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const source = inner(it, 'source');
    let title = inner(it, 'title');
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    return { title, source };
  }).filter(h => h.title);
}

// Titulares del día por consulta, compartidos entre hogares para no repetir pedidos.
const headlineCache = new Map();
export async function fetchHeadlines(query, fetchImpl = globalThis.fetch, date = '') {
  const key = date + '|' + query.toLowerCase();
  if (headlineCache.has(key)) return headlineCache.get(key);
  const u = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:1d')}&hl=es-419&gl=AR&ceid=AR:es-419`;
  const r = await fetchImpl(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return [];
  const list = parseRss(await r.text()).slice(0, 5);
  for (const k of headlineCache.keys()) if (!k.startsWith(date + '|')) headlineCache.delete(k);
  headlineCache.set(key, list);
  return list;
}

/**
 * Prepara el día de un hogar (lo llama el scheduler a la madrugada): el clima y, si hay Claude e intereses,
 * una noticia liviana. Si algo falla, ese campo queda vacío; nunca se inventa nada.
 */
export async function prepareDay(core, hh, { fetchImpl = globalThis.fetch } = {}) {
  const { date } = core.now(hh);
  core.day(hh, date);
  let { lat, lon } = hh;
  if (hh.city && (lat == null || lon == null)) {
    const geo = await geocode(hh.city, fetchImpl);
    if (geo) { ({ lat, lon } = geo); core.q.run('UPDATE households SET lat = ?, lon = ? WHERE id = ?', lat, lon, hh.id); }
  }
  let weather = '', news = '';
  if (lat != null && lon != null) {
    try { const w = await fetchWeather(lat, lon, hh.timezone, fetchImpl); if (w) weather = weatherLine(w); }
    catch (e) { console.error('clima', hh.id, e.message); }
  }
  const interests = core.q.all('SELECT text FROM interests WHERE household_id = ? ORDER BY id LIMIT 5', hh.id).map(i => i.text);
  if (core.ai?.pickNews && interests.length) {
    const queries = [...interests, ...(hh.city ? [hh.city] : [])];
    const lists = await Promise.all(queries.map(q => fetchHeadlines(q, fetchImpl, date).catch(() => [])));
    const seen = new Set(), headlines = lists.flat().filter(h => !seen.has(h.title) && seen.add(h.title));
    if (headlines.length) {
      try { news = (await core.ai.pickNews(interests, headlines)) || ''; }
      catch (e) { console.error('noticias', hh.id, e.message); }
    }
  }
  core.q.run('UPDATE days SET weather = ?, news = ?, prepared = 1 WHERE household_id = ? AND date = ?', weather, news, hh.id, date);
}
