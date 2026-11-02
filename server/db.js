import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS households (
  id INTEGER PRIMARY KEY,
  elder_name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Argentina/Cordoba',
  device_code TEXT UNIQUE,
  device_token TEXT UNIQUE,
  device_phone TEXT,
  inactivity_on INTEGER NOT NULL DEFAULT 1,
  inactivity_at INTEGER NOT NULL DEFAULT 660,
  summary_on INTEGER NOT NULL DEFAULT 1,
  summary_at INTEGER NOT NULL DEFAULT 1260,
  emergency_phone TEXT NOT NULL DEFAULT '107',
  last_seen INTEGER,
  offline_alerted INTEGER NOT NULL DEFAULT 0,
  convo TEXT NOT NULL DEFAULT '{}',
  sos TEXT,
  city TEXT NOT NULL DEFAULT '',
  barrio TEXT NOT NULL DEFAULT '',
  lat REAL,
  lon REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT '',
  phone TEXT,
  token TEXT NOT NULL UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  gets_alerts INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  sub TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  say TEXT NOT NULL,
  at INTEGER NOT NULL,
  days TEXT NOT NULL DEFAULT '0123456',
  date TEXT,
  is_med INTEGER NOT NULL DEFAULT 0,
  audio_id INTEGER REFERENCES audio(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reminder_runs (
  reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  fired_at INTEGER,
  done_at INTEGER,
  nudged INTEGER NOT NULL DEFAULT 0,
  escalated INTEGER NOT NULL DEFAULT 0,
  missed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (reminder_id, date)
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  at INTEGER NOT NULL,
  what TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  remind_eve INTEGER NOT NULL DEFAULT 1,
  eve_done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  list TEXT
);
CREATE INDEX IF NOT EXISTS events_hh ON events(household_id, ts);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  date TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_hh ON activity(household_id, date);

CREATE TABLE IF NOT EXISTS days (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  first_activity INTEGER,
  check_asked INTEGER,
  inact_alerted INTEGER NOT NULL DEFAULT 0,
  summary_sent INTEGER NOT NULL DEFAULT 0,
  briefed INTEGER,
  prepared INTEGER,
  news TEXT,
  weather TEXT,
  PRIMARY KEY (household_id, date)
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT '',
  phone TEXT,
  member_id INTEGER REFERENCES members(id) ON DELETE CASCADE
);

-- Charla libre con Claude: solo se agrega (nunca se edita), y una charla nueva arranca vacía.
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  session INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_hh ON chat(household_id, session, id);

-- Cosas que ella le contó a Tata y quiere que recuerde (gustos, nombres, historias).
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL
);

-- Muestra de voz de un familiar (WAV) para que Tata diga sus mensajes con su voz. Solo con consentimiento.
CREATE TABLE IF NOT EXISTS voices (
  member_id INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  wav BLOB NOT NULL,
  consent_at INTEGER NOT NULL,
  always INTEGER NOT NULL DEFAULT 0  -- usar su voz en todos sus mensajes y recordatorios
);

CREATE TABLE IF NOT EXISTS audio (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

-- Cartelera de Órbita (Encuentro): compartida por todos los hogares.
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  place TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,
  barrio TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL,
  days TEXT NOT NULL DEFAULT '',
  date TEXT,
  price TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Intereses de ella, cargados por la familia ("Talleres", "tango", "recetas").
CREATE TABLE IF NOT EXISTS interests (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  text TEXT NOT NULL
);

-- Qué contestó ella a cada actividad sugerida: para no insistir y para la familia.
CREATE TABLE IF NOT EXISTS activity_answers (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  answer TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (household_id, activity_id, date)
);
`;

// Columnas agregadas después: una base vieja las suma al abrirse (CREATE TABLE IF NOT EXISTS no lo hace).
const ADDED = [
  ['households', 'city', "TEXT NOT NULL DEFAULT ''"],
  ['households', 'barrio', "TEXT NOT NULL DEFAULT ''"],
  ['households', 'lat', 'REAL'],
  ['households', 'lon', 'REAL'],
  ['days', 'briefed', 'INTEGER'],
  ['days', 'prepared', 'INTEGER'],
  ['days', 'news', 'TEXT'],
  ['days', 'weather', 'TEXT'],
  ['activities', 'auto', 'INTEGER NOT NULL DEFAULT 0'],
  ['voices', 'always', 'INTEGER NOT NULL DEFAULT 0']
];

export function migrate(db) {
  for (const [table, col, def] of ADDED) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

export const token = () => randomBytes(24).toString('base64url');
export const deviceCode = () => String(randomInt(100000, 1000000));

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Atajos para no repetir prepare() en todos lados. */
export function q(db) {
  const cache = new Map();
  const st = sql => { if (!cache.has(sql)) cache.set(sql, db.prepare(sql)); return cache.get(sql); };
  return {
    get: (sql, ...a) => st(sql).get(...a),
    all: (sql, ...a) => st(sql).all(...a),
    run: (sql, ...a) => st(sql).run(...a),
    tx(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  };
}
