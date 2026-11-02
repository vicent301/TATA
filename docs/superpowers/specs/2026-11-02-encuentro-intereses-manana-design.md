# Encuentro, intereses y la mañana de Tata

Fecha: 2026-11-02 · Rama: `main` · Estado: para aprobar

## Por qué

Tata es el producto de **Órbita**, que nació de la alianza entre Tata (asistente por voz: pastillas, turnos, SOS) y **Encuentro** (actividades sociales y talleres cercanos). Las dos necesidades de Elsa (78 años, vive sola) son la **adherencia al tratamiento** y el **aislamiento social**. Hoy el código solo resuelve la primera.

Este cambio suma la mitad que falta:

- una **cartelera de actividades** que arma Órbita y Tata le sugiere a Elsa;
- los **intereses** de Elsa, que carga la familia, para que Tata tenga de qué charlar;
- un **resumen de la mañana** con la pastilla, algo de interés (una noticia liviana o el clima) y una actividad.

La idea guía de la marca es "acompañar, no monitorear": Elsa decide sola y la familia se entera.

## Objetivos

1. Órbita carga y mantiene una cartelera compartida de actividades desde un panel propio.
2. La familia carga en Ajustes la ciudad y el barrio de Elsa, y sus intereses.
3. La primera vez que Elsa le habla a Tata en la mañana, Tata contesta lo que le pidió y suma un resumen corto: la pastilla, una cosa de interés y una actividad.
4. Tata sugiere actividades directo. Si a Elsa le interesa una, la familia recibe un aviso con los datos.
5. Las noticias son solo de sus intereses y de temas livianos. Nunca son malas noticias.

## Qué no es (no-objetivos)

- No hay mapa, distancia, transporte ni inscripción a la actividad.
- La familia no aprueba ni oculta actividades antes de que Tata las sugiera (decisión del usuario).
- Sin `ANTHROPIC_API_KEY` no hay noticias, solo el clima.
- No hay cuentas por persona en Órbita: el panel tiene una sola clave compartida.
- No cambia la paleta (decisión del usuario: se queda la actual, crema, tinta y ámbar).

## Qué lo haría un fracaso aunque funcione (anti-objetivos)

- **Que Tata hable sin que le hablen.** El resumen espera a que Elsa hable primero. El único caso en que Tata habla sola sigue siendo el chequeo de inactividad que ya existe.
- **Que cuente una mala noticia:** policiales, tragedias, muertes, política, estafas, salud alarmante.
- **Que invente una noticia o una actividad.**
- **Que insista** con una actividad a la que Elsa dijo que no.
- **Que el resumen sea largo.** Son como mucho 4 oraciones cortas, una sola cosa de cada tipo.

## Caminos considerados (noticias)

| | Cómo | A favor | En contra |
|---|---|---|---|
| **A (elegido)** | RSS de Google Noticias por cada interés y por la ciudad. Claude elige una noticia liviana y la cuenta en una frase. Clima de Open-Meteo. | Gratis, automático y sin claves nuevas. El filtro de tono queda en Claude. | Algunos días no hay nada lindo, y ese día no hay noticia. |
| B | Claude busca en internet (herramienta de búsqueda web). | Menos código y más fresco. | Cada búsqueda se paga aparte y es más lento, mientras Elsa espera la respuesta en voz. |
| C | Órbita carga las novedades a mano en el panel. | Lo más seguro. | Trabajo diario; si nadie carga, no hay nada. |

El usuario eligió **A**.

## Diseño

### 1. Datos (`server/db.js`)

Tablas nuevas:

```sql
-- Cartelera de Órbita: compartida por todos los hogares.
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,              -- "Taller de tejido"
  place TEXT NOT NULL,              -- "Centro vecinal Alta Córdoba"
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL,               -- "Córdoba"
  barrio TEXT NOT NULL DEFAULT '',  -- "Alta Córdoba"
  at INTEGER NOT NULL,              -- minutos desde 00:00, hora local del hogar
  days TEXT NOT NULL DEFAULT '',    -- "24" = martes y jueves; vacío si es de una sola fecha
  date TEXT,                        -- AAAA-MM-DD si es de una sola vez
  price TEXT NOT NULL DEFAULT '',   -- "Gratis", "$2000"
  phone TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',    -- "tejido,manualidades"
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

-- Qué contestó ella a cada sugerencia: sirve para no insistir y para la pestaña Encuentro.
CREATE TABLE IF NOT EXISTS activity_answers (
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  date TEXT NOT NULL,               -- el día de la actividad que se le ofreció
  answer TEXT NOT NULL,             -- 'si' | 'no'
  ts INTEGER NOT NULL,
  PRIMARY KEY (household_id, activity_id, date)
);
```

Columnas nuevas en tablas que ya existen:

- `households`: `city TEXT NOT NULL DEFAULT ''`, `barrio TEXT NOT NULL DEFAULT ''`, `lat REAL`, `lon REAL`.
- `days`: `briefed INTEGER` (cuándo se dio el resumen), `news TEXT` (la frase de noticia del día, o vacío si no hubo), `weather TEXT` (la frase del clima).

**Migración.** Hoy el esquema solo usa `CREATE TABLE IF NOT EXISTS`, así que una base existente no toma columnas nuevas. Se agrega una función `migrate(db)` en `openDb`: por cada columna nueva mira `PRAGMA table_info` y, si falta, hace `ALTER TABLE … ADD COLUMN`. Es idempotente.

### 2. Panel de Órbita

- **Página:** `/orbita/` (`public/orbita/index.html` y `orbita.js`), con los estilos de `shared/base.css`.
- **Acceso:** la clave va en la variable de entorno `ORBITA_KEY`. La página la pide una vez y la guarda en `localStorage`. La API la recibe como `Authorization: Bearer <ORBITA_KEY>` y la compara en tiempo constante. Sin `ORBITA_KEY`, todas las rutas `/api/orbita/*` responden 404 (el panel queda apagado).
- **API:**
  - `GET /api/orbita/activities`
  - `POST /api/orbita/activities`
  - `PATCH /api/orbita/activities/:id`
  - `DELETE /api/orbita/activities/:id`
  - Validación igual a la de los recordatorios: longitudes máximas, hora `HH:MM`, días `0-6` o fecha `AAAA-MM-DD`, al menos uno de los dos.
- **Formulario:**
  - Qué (`title`), dónde (`place`), dirección, ciudad y barrio.
  - Hora, y días de la semana o una fecha.
  - Precio, teléfono, etiquetas (texto separado por comas) y nota.
  - Una lista con las cargadas, con botones para pausar y borrar.

### 3. Ajustes de la familia

En la pestaña **Ajustes** de `/familia/`:

- **Dónde vive:** ciudad y barrio, en texto libre. Al guardar la ciudad, el servidor la busca en la API de geocodificación de Open-Meteo (`geocoding-api.open-meteo.com/v1/search?name=<ciudad>&language=es&count=1`, preferentemente con `country=AR`) y guarda `lat`/`lon`. Si no la encuentra, guarda la ciudad igual y no habrá clima.
- **Le interesa:** una lista de chips para agregar y sacar intereses (como máximo 12, de 40 caracteres cada uno). Por ejemplo "Talleres", "tango", "recetas", "la novela de la tarde".

API:

- `PATCH /api/familia/household` acepta `city` y `barrio`.
- `POST /api/familia/interests` y `DELETE /api/familia/interests/:id`.
- `/api/familia/me` devuelve `interests`, `city`, `barrio` y la lista de Encuentro (ver 6).

### 4. Qué actividad sugerir (`server/encuentro.js`)

`pickActivity(core, hh, { from })` devuelve la mejor actividad, o `null`:

1. **Candidatas:** activas, de la misma ciudad (comparando con `norm()`: sin tildes ni mayúsculas), que ocurren **hoy más tarde** (`at > ahora`) o **mañana**, y sin un `no` registrado para esa actividad en esa fecha.
2. **Orden:** primero las de su barrio. Después, las que tienen más etiquetas que coinciden con sus intereses (comparando con `norm()`, por inclusión de palabras). Por último, la más próxima.
3. Si el hogar no tiene ciudad, no hay sugerencias.

### 5. Noticias y clima (`server/news.js`)

**Se prepara de antemano, no cuando Elsa habla.** El scheduler, una vez por día y por hogar, desde las **05:00** hora local, arma `days.news` y `days.weather`. Así el resumen no la hace esperar.

**Clima.** Open-Meteo `forecast?latitude&longitude&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=<tz>&forecast_days=1`. Se convierte en una frase con plantilla: "Hoy va a estar soleado, con una máxima de 24 grados.". El `weathercode` se traduce a "soleado", "nublado", "con lluvia", etc. Sin `lat`/`lon` no hay clima.

**Noticias** (solo si hay Claude e intereses):

1. Por cada interés (hasta 5) y por la ciudad, se lee `https://news.google.com/rss/search?q=<consulta>+when:1d&hl=es-419&gl=AR&ceid=AR:es-419`. Se quedan los 5 primeros titulares de cada consulta, con su fuente. El RSS se parsea con expresiones simples, sin dependencias nuevas.
2. Hay un caché en memoria por consulta y por día, compartido entre hogares, para no repetir pedidos.
3. **Una llamada a Claude, sin herramientas,** con los titulares, los intereses y estas reglas:
   - Elegir **como mucho una** noticia que coincida con un interés y sea liviana o positiva.
   - Descartar policiales, accidentes, muertes, enfermedades, política, economía alarmante, estafas, guerras y catástrofes. Ante la duda, descartar.
   - Contarla en **una frase de hasta 25 palabras,** en voseo, sin inventar nada que no diga el titular.
   - Responder en JSON: `{"frase": "..."}` o `{"frase": null}`.
4. Si algo falla (red, RSS, Claude), `days.news` queda vacío y ese día no hay noticia. Nunca se reintenta durante el resumen.

### 6. La mañana (`server/brain.js`)

**Cuándo.** El resumen se dispara la primera vez en el día que Elsa le habla a Tata **entre las 06:00 y las 13:00** (`days.briefed` vacío). Va **después** de la respuesta normal a lo que dijo.

**Cuándo no.**

- Si lo que dijo disparó un SOS o un pedido de ayuda: ese día queda sin resumen hasta la próxima vez que hable dentro de la ventana.
- Si Tata está en el medio de un paso a paso.
- Si quedó una pregunta pendiente (`convo.confirm`): el resumen espera a la próxima frase.

**Qué dice**, en este orden y salteando lo que no haya:

1. "Buen día, Elsa." Si la respuesta normal ya fue un saludo, no se repite.
2. **Pastilla.** Si hay una pendiente: "Te toca la pastilla de la presión.". Si no hay pendientes, no dice nada sobre pastillas.
3. **Interés.** `days.news` si hay; si no, `days.weather`. Si están las dos y el resumen sigue siendo corto, primero el clima y después la noticia. Nunca más de 4 oraciones en total.
4. **Actividad.** "Hoy a las 17 hay taller de tejido en el Centro vecinal Alta Córdoba. ¿Te interesa?". Esto deja la pregunta pendiente con `convo.confirm = { kind: 'activity', id, date }`.

Se marca `days.briefed`.

**Respuesta a la actividad** (usa el mecanismo `confirm` que ya existe):

- **Sí:** Tata le da la dirección, la hora y el precio (si lo hay). Se registra `si`, y la familia recibe por push el aviso "A Elsa le interesó una actividad", con "Taller de tejido · hoy 17:00 · Centro vecinal Alta Córdoba, Av. … · Gratis · Tel …".
- **No:** "Bueno, no hay problema." Se registra `no` y no se le vuelve a ofrecer esa actividad para esa fecha.

**Reglas nuevas, en cualquier momento del día:**

- "¿qué hay para hacer?", "¿hay alguna actividad?", "¿qué puedo hacer hoy?" → la mejor actividad, con la misma pregunta.
- "¿dónde es?", "¿a qué hora es?", "¿cuánto sale?" → si hay una actividad ofrecida u aceptada hoy, Tata contesta con sus datos.
- "contame una noticia", "¿qué hay de nuevo?", "¿cómo va a estar el día?" → `days.news` o `days.weather`. Si no hay ninguno: "Hoy no tengo novedades para contarte."

**Claude.** El `[Contexto]` suma tres líneas: los intereses ("Le interesa: …"), las actividades de hoy y mañana ("Actividades cerca: …") y la noticia del día. El prompt aclara que solo puede mencionar actividades y noticias que estén en el contexto.

### 7. App de la familia: pestaña Encuentro

Es una cuarta pestaña, **Encuentro**, entre Agenda y Ajustes:

- **Lo que hay cerca:** las actividades de los próximos 7 días en la ciudad de Elsa, con las de su barrio primero. Muestra qué, dónde, cuándo y precio.
- **Lo que le interesó:** las respuestas `si`, con fecha.
- Si no hay ciudad cargada, un aviso con un botón a Ajustes.

Los textos nuevos usan como mínimo 18 px (pedido de la guía de UX). Los colores son los actuales.

## Pruebas (`test/tata.test.js`)

- **`pickActivity`:** misma ciudad, prioridad de barrio y de intereses, que no ofrezca una de hoy que ya pasó, que respete los `no`, y sin ciudad devuelva `null`.
- **Resumen:**
  - Se dispara una sola vez, solo entre las 6 y las 13, y después de la respuesta normal.
  - No se dispara con un SOS ni con una pregunta pendiente.
  - Incluye la pastilla pendiente y la actividad.
- **Actividad:** con "sí", la familia recibe el aviso y se registra `si`. Con "no", no se ofrece de nuevo.
- **Noticias:**
  - Con fetch y Claude simulados: arma `days.news`.
  - Si Claude responde `{"frase": null}` o algo falla, no hay noticia.
  - Sin Claude, solo el clima.
- **Clima:** la plantilla con un `weathercode` simulado.
- **Migración:** una base vieja, sin las columnas nuevas, abre bien y las suma.
- **Panel:** sin `ORBITA_KEY` responde 404, y con una clave incorrecta, 401.

## Decisiones tomadas por mí (para revisar)

- Las etiquetas de las actividades, el orden de prioridad (barrio, intereses, próxima) y mostrar solo hoy y mañana.
- La ventana de 06:00 a 13:00, el orden del resumen y el máximo de 4 oraciones.
- Que el aviso a la familia sea solo cuando dice que sí.
- Noticias preparadas a las 05:00, hasta 5 intereses, frase de hasta 25 palabras y caché en memoria.
- El clima con Open-Meteo, y la ciudad geolocalizada al guardarla.
- El panel con una sola clave (`ORBITA_KEY`) y apagado si no está.
- La pestaña Encuentro en la app de la familia y 18 px como mínimo en lo nuevo.
- No cargar actividades de ejemplo en la base. Para probar se cargan desde el panel, y los tests usan datos propios.

## Lo que queda al criterio de quien lo construya

- El texto exacto de las frases, siempre en voseo y cortas.
- La tabla de `weathercode` a palabras.
- El diseño del panel y de la pestaña, con los componentes que ya existen.
- Cómo se parte el código entre `encuentro.js` y `news.js`.
