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
