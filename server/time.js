// Todo lo que tiene que ver con la hora se calcula en la zona horaria del hogar,
// no en la del servidor.

const fmtCache = new Map();
function partsFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
    }));
  }
  return fmtCache.get(tz);
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Fecha local del hogar: { date:'2026-10-19', min: 535, wd: 1 } */
export function localNow(tz, now = new Date()) {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute), wd: WD[p.weekday] };
}

export const pad = n => String(n).padStart(2, '0');
export const fmtMin = m => pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60);
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function weekdayOf(date) { return new Date(date + 'T12:00:00Z').getUTCDay(); }

/** "lunes 19 de octubre" */
export function spokenDate(date) {
  const [, mo, d] = date.split('-').map(Number);
  return `${DIAS[weekdayOf(date)]} ${d} de ${MESES[mo - 1]}`;
}

/** "hoy", "mañana", "el jueves 22", "el 3 de noviembre" */
export function relativeDay(date, today) {
  if (date === today) return 'hoy';
  if (date === addDays(today, 1)) return 'mañana';
  const diff = Math.round((new Date(date) - new Date(today)) / 86400000);
  const [, mo, d] = date.split('-').map(Number);
  if (diff > 1 && diff < 7) return `el ${DIAS[weekdayOf(date)]} ${d}`;
  return `el ${d} de ${MESES[mo - 1]}`;
}

/** "Son las 9 de la mañana", "Es la una y cuarto de la tarde" */
export function spokenTime(m) {
  const h = Math.floor(m / 60) % 24, mi = m % 60, h12 = h % 12 || 12;
  let s = h12 === 1 ? 'Es la una' : 'Son las ' + h12;
  if (mi === 15) s += ' y cuarto'; else if (mi === 30) s += ' y media'; else if (mi > 0) s += ' y ' + mi;
  s += h < 6 ? ' de la madrugada' : h < 12 ? ' de la mañana' : h < 13 ? ' del mediodía' : h < 20 ? ' de la tarde' : ' de la noche';
  return s;
}

export const DAY_NAMES = DIAS;
