# Encuentro, intereses y la mañana: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sumar a Tata la cartelera de Órbita (Encuentro), los intereses de Elsa y un resumen de la mañana con la pastilla, el clima o una noticia liviana, y una actividad.

**Architecture:**
- La lógica nueva vive en dos módulos chicos: `server/encuentro.js` (qué actividad sugerir y cómo decirla) y `server/news.js` (clima, geocodificación, RSS y la preparación diaria).
- `brain.js` agrega el resumen después de la respuesta normal.
- `scheduler.js` prepara noticias y clima de madrugada.
- Las rutas nuevas van en el array `routes` de `server/index.js`, igual que las demás.

**Tech Stack:** Node ≥ 22.13, `node:sqlite`, `node:test`, HTML/CSS/JS sin build. No se agregan dependencias.

**Spec:** `docs/superpowers/specs/2026-11-02-encuentro-intereses-manana-design.md`

## Global Constraints

- **Dependencias:** ninguna nueva. El RSS se parsea con expresiones regulares y los pedidos HTTP usan `fetch` global, inyectable como `fetchImpl` para los tests.
- **Idioma:** todo texto que dice Tata va en castellano rioplatense, con voseo, en frases cortas. Nunca "monitorear".
- **Tata habla sola** únicamente en lo que ya existe (recordatorios, turnos, chequeo de inactividad, buenas noches). El resumen va solo después de que Elsa habla.
- **Resumen:** una sola vez por día, entre 06:00 y 13:00 hora del hogar. Como mucho 4 oraciones. Una sola cosa de cada tipo.
- **Noticias:**
  - Solo de sus intereses y temas livianos.
  - Hasta 5 intereses por consulta.
  - Una frase de hasta 25 palabras.
  - Sin Claude no hay noticias, solo el clima.
  - Si algo falla, no hay noticia: nunca se inventa.
- **Actividades:** misma ciudad, solo hoy (más tarde que ahora) o mañana. Primero su barrio, después más etiquetas en común con sus intereses, después la más próxima. Una actividad con `no` no se vuelve a ofrecer para esa fecha.
- **Panel:** `ORBITA_KEY` en el entorno. Si no está, `/api/orbita/*` responde 404. Con una clave incorrecta, 401.
- **Intereses:** como máximo 12 por hogar, de 40 caracteres cada uno.
- **UI nueva:** textos de 18 px como mínimo. La paleta actual no cambia.
- **Tests:** `"/c/laragon/bin/nodejs/node-v22/node.exe" --disable-warning=ExperimentalWarning --test test/*.test.js` (en esta compu `npm` no está en el PATH). Antes de cada commit tienen que pasar todos.

## Review Focus

1. **Una base de datos vieja,** con hogares, `days` y recordatorios ya cargados, tiene que abrir sin perder nada y sumar las columnas nuevas. El test va en la Task 1.
2. **El primer mensaje del día es un SOS:** no hay resumen y el SOS sale idéntico. El resumen queda para la próxima frase en la ventana. El test va en la Task 6.
3. **Una ciudad escrita distinto** en la actividad y en el hogar ("Córdoba" y "cordoba ") igual tiene que coincidir. El test va en la Task 2.
4. **Un RSS con entidades HTML o CDATA** (`&quot;`, `<![CDATA[...]]>`) llega a Claude como texto limpio. El test va en la Task 5.
5. **Claude responde algo que no es JSON** o una frase de más de 25 palabras: no hay noticia. El test va en la Task 5.

---

### Task 1: Esquema y migración

**Files:**
- Modify: `server/db.js` (`SCHEMA` y `openDb`)
- Test: `test/tata.test.js`

**Interfaces:**
- Produces:
  - Las tablas `activities`, `interests` y `activity_answers` del spec (sección 1), copiadas tal cual.
  - En `households`: las columnas `city`, `barrio`, `lat` y `lon`.
  - En `days`: las columnas `briefed INTEGER`, `prepared INTEGER`, `news TEXT` y `weather TEXT`.
  - `migrate(db)`, exportada.

`days.prepared` no está en el spec. Marca que la preparación de noticias y clima ya corrió ese día, aunque no haya encontrado nada.

- [ ] **Step 1: Escribir el test que falla**

```js
import { DatabaseSync } from 'node:sqlite';
test('una base vieja suma las columnas nuevas sin perder datos', () => {
  const file = join(tmpdir(), `tata-mig-${process.pid}.db`);
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE households (id INTEGER PRIMARY KEY, elder_name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'America/Argentina/Cordoba', device_code TEXT UNIQUE, device_token TEXT UNIQUE, device_phone TEXT, inactivity_on INTEGER NOT NULL DEFAULT 1, inactivity_at INTEGER NOT NULL DEFAULT 660, summary_on INTEGER NOT NULL DEFAULT 1, summary_at INTEGER NOT NULL DEFAULT 1260, emergency_phone TEXT NOT NULL DEFAULT '107', last_seen INTEGER, offline_alerted INTEGER NOT NULL DEFAULT 0, convo TEXT NOT NULL DEFAULT '{}', sos TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE days (household_id INTEGER NOT NULL, date TEXT NOT NULL, first_activity INTEGER, check_asked INTEGER, inact_alerted INTEGER NOT NULL DEFAULT 0, summary_sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (household_id, date));
    INSERT INTO households (elder_name, created_at) VALUES ('Elsa', 0);`);
  old.close();
  const q = makeQ(openDb(file));
  assert.equal(q.get('SELECT elder_name, city FROM households').elder_name, 'Elsa');
  assert.equal(q.get('SELECT city FROM households').city, '');
  q.run("INSERT INTO days (household_id, date, briefed, prepared, news, weather) VALUES (1, '2026-11-02', 1, 1, 'x', 'y')");
  q.run("INSERT INTO activities (title, place, city, at, created_at) VALUES ('Tejido', 'Centro', 'Córdoba', 1020, 0)");
  openDb(file); // reabrir no rompe (migración idempotente)
});
```

Sumar `import { tmpdir } from 'node:os'` e `import { join } from 'node:path'` arriba del archivo.

- [ ] **Step 2: Correrlo y ver que falla.** Esperado: FAIL, `no such column: city`.
- [ ] **Step 3: Implementar.** Agregar las tablas a `SCHEMA` y exportar `migrate(db)`. `migrate` recorre una lista `[tabla, columna, definición]`, mira `PRAGMA table_info(tabla)` y hace `ALTER TABLE … ADD COLUMN` solo si la columna falta. `openDb` la llama después de `db.exec(SCHEMA)`. Las definiciones de columna van en `SCHEMA`, para las bases nuevas, y en `migrate`, para las viejas.
- [ ] **Step 4: Correr todos los tests.** Esperado: PASS (20).
- [ ] **Step 5: Commit** `Esquema de Encuentro, intereses y mañana, con migración`.

### Task 2: Qué actividad sugerir (`server/encuentro.js`)

**Files:**
- Create: `server/encuentro.js`
- Test: `test/tata.test.js`

**Interfaces:**
- Consumes: `norm` de `brain.js`, y `core.now(hh)` (devuelve `{ date, min, wd }`).
- Produces:
  - `pickActivity(core, hh) -> { a, date } | null`, donde `a` es la fila de `activities` y `date` es `'AAAA-MM-DD'`.
  - `upcoming(core, hh, days = 7) -> Array<{ a, date }>`: las de los próximos `days` días en su ciudad, ordenadas por barrio y después por fecha y hora. Lo usa la pestaña de la familia.
  - `offerText(hh, a, date, today) -> string`, por ejemplo `"Hoy a las 17 hay Taller de tejido en Centro vecinal Alta Córdoba. ¿Te interesa?"`.
  - `detailsText(a, date, today) -> string`: dirección, hora y precio.
  - `answer(core, hh, activityId, date, 'si'|'no')`: registra la respuesta. Con `'si'`, además hace `core.notify(hh, 'info', \`A ${hh.elder_name} le interesó una actividad\`, \`${a.title} · ${día} ${HH:MM} · ${place}${address ? ', ' + address : ''}${price ? ' · ' + price : ''}${phone ? ' · Tel ' + phone : ''}\`, null, { push: true })`.

Una actividad "ocurre" en una fecha si `a.date === fecha`, o si `a.date` es nulo y `a.days` incluye el día de la semana de esa fecha. Para hoy, solo si `a.at > now.min`.

- [ ] **Step 1: Escribir los tests que fallan.** Usar el `setup()` del archivo y una función local `act(fields)` que inserte en `activities` con valores por defecto (`city: 'Córdoba'`, `days: '0123456'`, `at: 1020`).
  - `pickActivity: misma ciudad, sin tildes ni mayúsculas`. El hogar tiene `city='cordoba '` y la actividad `city='Córdoba'`: se elige. Una de `Rosario` nunca.
  - `pickActivity: primero su barrio, después intereses, después la más próxima`. Hay tres actividades:
    - `A`: otro barrio, etiquetas "tango", 18:00.
    - `B`: otro barrio, sin etiquetas, 16:00.
    - `C`: su barrio, sin etiquetas, 19:00.
    - Sin intereses cargados, se elige `C`. Si se borra `C` y se carga el interés `Tango`, se elige `A`.
  - `pickActivity: la de hoy que ya pasó no, la de mañana sí`. A las 18:00 (`t.at('2026-10-19T18:00:00-03:00')`), una de 17:00 solo los lunes devuelve `null`. Una de 10:00 todos los días devuelve la fecha de mañana.
  - `pickActivity: respeta el no y sin ciudad devuelve null`.
  - `answer si: la familia recibe el aviso con los datos`. `t.events().at(-1).title === 'A Elsa le interesó una actividad'`, y en `t.pushed` hay un push con ese título.
- [ ] **Step 2: Correrlos y ver que fallan** (`Cannot find module`).
- [ ] **Step 3: Implementar `server/encuentro.js`** con las firmas de arriba. El día en palabras se toma de `relativeDay` en `time.js` ("hoy", "mañana"). La hora se lee como "las 17" o "las 17 y 30", con `fmtMin` o la frase que ya use `time.js`.
- [ ] **Step 4: Correr los tests.** Esperado: PASS.
- [ ] **Step 5: Commit** `Encuentro: elegir la actividad para sugerir`.

### Task 3: Panel de Órbita

**Files:**
- Modify: `server/index.js` (`createApp` suma la opción `orbitaKey = process.env.ORBITA_KEY` y rutas en `routes`)
- Create: `public/orbita/index.html`, `public/orbita/orbita.js`
- Test: `test/tata.test.js`

**Interfaces:**
- Produces:
  - `GET /api/orbita/activities`: devuelve `{ activities: [...] }`.
  - `POST /api/orbita/activities`: con `{ title, place, address?, city, barrio?, at: 'HH:MM', days?: '0-6…', date?: 'AAAA-MM-DD', price?, phone?, tags?, note? }`, devuelve `201 { id }`.
  - `PATCH /api/orbita/activities/:id`: los mismos campos, más `active`.
  - `DELETE /api/orbita/activities/:id`.
  - Validación: `title`, `place` y `city` obligatorios; `at` con `parseHHMM`; `days` o `date`, al menos uno. Errores con `bad(...)`.
  - Auth: `Authorization: Bearer <clave>`. Se compara con `timingSafeEqual` sobre `Buffer`s de igual largo. Sin `orbitaKey` → 404 `No existe`. Clave mala → 401.

- [ ] **Step 1: Escribir los tests que fallan.** Un helper `serve(opts)` hace `createApp({ dbFile: ':memory:', withPush: false, ai: null, voice: null, ...opts })` y `server.listen(0)`, y devuelve `{ url, close }`.
  - `panel de Órbita: apagado sin clave y protegido con clave`: sin `orbitaKey`, el `GET` da 404. Con `orbitaKey: 'k'` y `Bearer x`, da 401.
  - `panel de Órbita: crea, lista, pausa y borra`: con `Bearer k`, el `POST` de una actividad válida da 201. El `GET` la lista. El `PATCH { active: false }` la deja en `active === 0`. El `DELETE` la saca. Un `POST` sin `city` da 400.
- [ ] **Step 2: Correrlos y ver que fallan** (404 en vez de 201).
- [ ] **Step 3: Implementar las rutas** con el estilo de `reminderFields`: una función `activityFields(b, partial)`.
- [ ] **Step 4: Hacer la página `/orbita/`.**
  - Usa `shared/base.css`.
  - Pide la clave una vez y la guarda en `localStorage` con la clave `orbita.key`. Si recibe un 401, la borra.
  - Tiene un formulario con los campos del POST: los días como checkboxes de D a S, o una fecha.
  - Lista lo cargado con botones Pausar/Activar y Borrar.
  - Textos de 18 px como mínimo.
- [ ] **Step 5: Correr los tests.** Esperado: PASS.
- [ ] **Step 6: Commit** `Panel de Órbita para cargar la cartelera`.

### Task 4: Ubicación e intereses desde la app de la familia (API)

**Files:**
- Create: `server/news.js` (solo `geocode` en esta task)
- Modify: `server/index.js` (`createApp` suma la opción `fetchImpl = globalThis.fetch`, el `PATCH /api/familia/household`, las rutas de intereses y `familyView`)
- Test: `test/tata.test.js`

**Interfaces:**
- Produces:
  - `geocode(city, fetchImpl) -> Promise<{ lat, lon } | null>`. Pide `https://geocoding-api.open-meteo.com/v1/search?name=<city>&count=1&language=es&country=AR` y toma `results[0]`. Ante cualquier error devuelve `null`. Timeout de 5 s.
  - `PATCH /api/familia/household`:
    - Acepta `city` (60 caracteres) y `barrio` (60).
    - Si cambia `city`, geocodifica y guarda `lat`/`lon`, o `NULL` si no la encuentra.
    - Cambiar la ciudad también borra `prepared`, `news` y `weather` del día, para que el scheduler vuelva a preparar.
  - `POST /api/familia/interests { text }`: devuelve `201 { id }`. Si se pasa de 12, da 400 `Ya hay 12 intereses`. Si el texto está vacío, 400.
  - `DELETE /api/familia/interests/:id`: solo para el propio hogar.
  - `familyView` suma:
    - `household.city` y `household.barrio`;
    - `interests: [{ id, text }]`;
    - `encuentro: { upcoming: [{ id, title, place, address, barrio, date, at, price, phone }], liked: [{ title, date, at, place, ts }] }`.
    - `upcoming` sale de `upcoming(core, hh, 7)` de la Task 2; `liked` son las respuestas `si` de los últimos 30 días.

- [ ] **Step 1: Escribir los tests que fallan.** Con `serve({ fetchImpl: fakeGeo })`, donde `fakeGeo` responde `{ results: [{ latitude: -31.4, longitude: -64.18 }] }`, se crea un hogar con `POST /api/households`.
  - `familia: guarda ciudad y barrio y geocodifica`: el `PATCH { city: 'Córdoba', barrio: 'Alta Córdoba' }` deja `lat === -31.4` en la base, y `me.household.city === 'Córdoba'`.
  - `familia: intereses, hasta 12`: 12 `POST` dan 201 y el número 13 da 400. Un `DELETE` de un interés de otro hogar da 404.
  - `familia: ve lo que hay cerca y lo que le interesó`: una actividad cargada en Córdoba aparece en `me.encuentro.upcoming`.
- [ ] **Step 2: Correrlos y ver que fallan.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr los tests.** Esperado: PASS.
- [ ] **Step 5: Commit** `Familia: ubicación e intereses de Elsa`.

### Task 5: Noticias y clima (`server/news.js` + Claude + scheduler)

**Files:**
- Modify: `server/news.js`, `server/ai.js` (suma `pickNews` al objeto que devuelve `createAi`), `server/scheduler.js` (`startScheduler`)
- Test: `test/tata.test.js`

**Interfaces:**
- Consumes: `geocode` de la Task 4, y las columnas de `days` y `households` de la Task 1.
- Produces:
  - `weatherLine({ code, max, min }) -> string`. Por ejemplo, `weatherLine({ code: 0, max: 24.4, min: 12 })` da `"Hoy va a estar soleado, con una máxima de 24 grados."`. Los grados se redondean.
  - `fetchWeather(lat, lon, tz, fetchImpl) -> Promise<{ code, max, min } | null>`, con Open-Meteo `forecast?latitude=…&longitude=…&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=<tz>&forecast_days=1`.
  - `parseRss(xml) -> Array<{ title, source }>`. Toma `<item>…<title>…</title>…<source …>…</source>`, saca el CDATA y decodifica `&amp; &lt; &gt; &quot; &#39;`. Google pone " - Fuente" al final del título; eso también se saca.
  - `fetchHeadlines(query, fetchImpl, date) -> Promise<Array<{ title, source }>>`. URL: `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:1d')}&hl=es-419&gl=AR&ceid=AR:es-419`. Se queda con los primeros 5. Usa un caché en memoria con la clave `date|query`.
  - `ai.pickNews(interests: string[], headlines: Array<{ title, source }>) -> Promise<string | null>`.
    - Hace una sola llamada, sin tools, con el mismo `MODEL` y `output_config: { effort: 'low' }`, y le pide la respuesta en JSON `{"frase": string|null}`.
    - Devuelve `null` si el JSON no parsea, si `frase` no es string, o si tiene más de 25 palabras.
    - El texto del pedido lleva las reglas del spec, sección 5, paso 3, tal cual.
  - `prepareDay(core, hh, { fetchImpl }) -> Promise<void>`:
    1. Si no hay `lat`/`lon` y hay `city`, geocodifica y los guarda.
    2. Busca el clima.
    3. Si hay `core.ai` e intereses, junta titulares de hasta 5 intereses más `"<ciudad>"` y llama a `pickNews`.
    4. Guarda `weather`, `news` (o `''`) y `prepared = 1` en `days` para la fecha local.
    5. Cualquier error deja `''` en el campo afectado y marca `prepared` igual.
  - `startScheduler(core, everyMs, { fetchImpl = globalThis.fetch } = {})`: en cada vuelta, para cada hogar donde `now.min >= 300` (05:00) y `days.prepared` está vacío, lanza `prepareDay` sin esperarlo. Un `Set` de ids en curso evita lanzarlo dos veces.

- [ ] **Step 1: Escribir los tests que fallan.**
  - `weatherLine: soleado y redondea`. Además, `code: 61` contiene `"lluvia"`.
  - `parseRss: limpia CDATA, entidades y la fuente del título`. Con `<item><title><![CDATA[Talleres gan&oacute; &quot;el clásico&quot; - La Voz]]></title><source url="x">La Voz</source></item>`, el título queda `Talleres ganó "el clásico"`. Sumar `&oacute;` (y las vocales acentuadas) al decodificador.
  - `pickNews: frase válida, null, JSON roto y frase larga`, con un `fakeClaude` que devuelve en orden:
    - `text('{"frase":"Talleres ganó el clásico, Elsa."}')` → la frase;
    - `text('{"frase":null}')` → `null`;
    - `text('no sé')` → `null`;
    - una frase de 30 palabras → `null`.
  - `prepareDay: guarda clima y noticia; sin Claude solo clima`. Un `fetchImpl` simulado responde Open-Meteo y RSS según la URL. Con `t.core.ai = fakeClaude(...)` y el interés `Talleres`, `days.news` es la frase y `days.weather` empieza con `"Hoy va a estar"`. Con `t.core.ai = null`, `news === ''` y `prepared === 1`.
- [ ] **Step 2: Correrlos y ver que fallan.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr los tests.** Esperado: PASS.
- [ ] **Step 5: Commit** `Noticias de sus intereses y clima, preparados a la madrugada`.

### Task 6: La mañana y las actividades en lo que dice Tata (`server/brain.js`, `server/ai.js`)

**Files:**
- Modify: `server/brain.js`, `server/ai.js` (`context`)
- Test: `test/tata.test.js`

**Interfaces:**
- Consumes: `pickActivity`, `offerText`, `detailsText` y `answer` de la Task 2; `days.news`, `days.weather` y `days.briefed` de la Task 1.
- Produces:
  - `handle(core, hh, raw)` mantiene su firma. Por dentro, la lógica actual pasa a una función privada `respond(core, hh, raw)`, y `handle` le suma el resumen con `morning(core, hh, replies)`.
  - `confirm` suma `{ kind: 'activity', id, date }`.

**Algoritmo de `morning`.** No hay resumen si pasa cualquiera de estas cosas:
- la hora local está fuera de `[360, 780)`;
- `day.briefed` ya está;
- se recarga el hogar con `core.household(hh.id)` y `core.sos(...)` no es nulo;
- el convo nuevo tiene `confirm`, `guide` o `awaitWho`;
- `replies` está vacío.

Si no, arma las partes:
1. `"Buen día, ${name}."`, salvo que el primer reply empiece con `¡Buen día`.
2. `"Te toca ${r.label.toLowerCase()}."` si `pendingMed` devuelve algo.
3. `day.news || day.weather`, si hay alguno.
4. `offerText(...)` de `pickActivity`. Si sale, setea `confirm: { kind: 'activity', id, date }`.

Si solo quedó el saludo, no se dice nada, pero igual se marca `briefed`. Si no, se agrega un reply con las partes unidas por espacio y se marca `briefed`.

**Reglas nuevas en `respond`**, antes de la parte de Claude:
- `/(que hay para hacer|alguna actividad|que puedo hacer hoy|actividades)/` → oferta de `pickActivity` con su `confirm`. Si no hay ninguna: `"Hoy no tengo actividades cerca para sugerirte."`.
- `/(donde es|a que hora es|cuanto sale|cuanto cuesta)/` → si `convo.lastActivity` (`{ id, date }`, guardado al ofrecer o al aceptar) existe, `detailsText`.
- `/(contame una noticia|que hay de nuevo|novedades|como va a estar el dia|como esta el dia|el clima)/` → `day.news || day.weather || 'Hoy no tengo novedades para contarte.'`.

**`confirmYes`/`no` con `kind: 'activity'`:**
- **Sí:** llama a `answer(..., 'si')`, dice `detailsText` y guarda `lastActivity`.
- **No:** llama a `answer(..., 'no')` y dice `"Bueno, no hay problema."`.

**`ai.js context`** suma tres líneas:
- `[Contexto] Le interesa: …`
- `[Contexto] Actividades cerca: …` (las de `upcoming(core, hh, 2)`, en formato corto)
- `[Contexto] Novedad de hoy: …`

Y suma una línea al system prompt: `"- Solo mencioná actividades y noticias que estén en el [Contexto]; nunca inventes otras."`.

- [ ] **Step 1: Escribir los tests que fallan.** Usan `setup('2026-10-19T09:00:00-03:00')`. El hogar tiene `city='Córdoba'`, una actividad de Tejido a las 17:00 todos los días y la pastilla de la presión a las 08:30, sin confirmar.
  - `mañana: después de la primera respuesta suma pastilla, clima y actividad, una sola vez`. Se precarga `days` con `weather = 'Hoy va a estar soleado, con una máxima de 24 grados.'`. `await t.hear('qué hora es')` coincide con `/^Son las .* Buen día, Elsa\. Te toca la pastilla de la presión\. Hoy va a estar soleado.* Hoy a las 17 hay Tejido/`. Un segundo `t.hear('qué hora es')` ya no contiene `Buen día`.
  - `mañana: fuera de la ventana no hay resumen`, a las 14:00.
  - `mañana: si lo primero es un SOS, no hay resumen y el SOS sale igual`. `t.hear('me caí, ayuda')` coincide con `/Ya le avisé a tu familia/` y no contiene `Tejido`, y `days.briefed` sigue nulo.
  - `actividad: sí avisa a la familia y da los datos; no, no insiste`. Después del resumen, `t.hear('sí')` contiene la dirección y hay un evento `A Elsa le interesó una actividad`. En otro hogar o fecha, con `t.hear('no')` y después `t.hear('qué hay para hacer')`, no ofrece Tejido para esa fecha (devuelve la de mañana).
  - `noticias a pedido`: `t.hear('contame una noticia')` devuelve `days.news`, y si no hay nada, `Hoy no tengo novedades para contarte.`.
  - Que los 19 tests que ya existían sigan pasando: fijan que nada se rompió.
- [ ] **Step 2: Correrlos y ver que fallan.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr todos los tests.** Esperado: PASS.
- [ ] **Step 5: Commit** `Tata: resumen de la mañana y sugerencia de actividades`.

### Task 7: App de la familia: Ajustes y pestaña Encuentro

**Files:**
- Modify: `public/familia/index.html`, `public/familia/familia.js`, `public/familia/familia.css`

**Interfaces:**
- Consumes: de la Task 4, `me.household.city`/`barrio`, `me.interests`, `me.encuentro` y las rutas de intereses y del `PATCH` del hogar.

- [ ] **Step 1: En Ajustes, agregar dos tarjetas después de "Avisos".**
  - **"Dónde vive"**: un formulario con ciudad y barrio que hace `PATCH /api/familia/household`. Abajo, el texto: "Con esto Tata le sugiere actividades cerca y le cuenta el clima.".
  - **"Le interesa"**: chips con una ✕ para borrar, y un input con botón "Agregar". Placeholder: "Talleres, tango, recetas…".
- [ ] **Step 2: Agregar la pestaña `encuentro`** entre `agenda` y `ajustes`, con su `<section class="screen" data-tab="encuentro" hidden>`.
  - Tiene dos listas: "Lo que hay cerca" (próximos 7 días) y "Lo que le interesó".
  - Si no hay ciudad, muestra una tarjeta "Cargá en Ajustes dónde vive para ver actividades cerca" con un botón que hace `setTab('ajustes')`.
  - Se renderiza en `render()`, con `renderEncuentro()`.
- [ ] **Step 3: Revisar el CSS.** Todo texto nuevo, incluidos los chips y las listas, va en 18 px o más.
- [ ] **Step 4: Probar a mano.**
  - Levantar el servidor con `ORBITA_KEY=prueba` y `PORT=4321`.
  - Cargar una actividad en `/orbita/`.
  - En `/familia/`, cargar ciudad, barrio e intereses.
  - Ver la pestaña Encuentro.
  - En `/casa/`, escribir "qué hora es" y ver el resumen.
  - Para la verificación: `curl` de `/api/familia/me` muestra `encuentro.upcoming` con la actividad.
- [ ] **Step 5: Commit** `App de la familia: dónde vive, intereses y Encuentro`.

### Task 8: Documentación

**Files:**
- Modify: `README.md`, `HANDOFF.md`

- [ ] **Step 1: README.**
  - Una sección "Encuentro y la mañana": qué hace, el panel `/orbita/` y `ORBITA_KEY`, y las noticias (que necesitan Claude).
  - En la tabla de variables, `ORBITA_KEY`.
  - En "Qué entiende", las frases nuevas.
- [ ] **Step 2: HANDOFF.**
  - Una decisión nueva: "10. Encuentro y la mañana", con el porqué en una línea por punto.
  - Actualizar Estado, Archivos clave (`encuentro.js`, `news.js`, `public/orbita/`), la cantidad de tests e Ideas: se sacan las que ya se hicieron.
- [ ] **Step 3: Correr todos los tests y commitear** `Documentación de Encuentro y la mañana`.
