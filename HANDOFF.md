# Handoff: Tata

## Objetivo del proyecto

Pasar de un prototipo de Demo Day a un **MVP funcional que se pueda probar con una familia real**.

El prototipo original era una simulación en una sola página: [artefacto](https://claude.ai/artifact/J3m96K1EWDCbj3juuhn6yM). Contaba "Un día de Elsa con Tata": Elsa, de 78 años, vive en Córdoba y solo habla, y su hija Laura arma todo desde el celular.

Este MVP lleva eso a dos apps reales conectadas a un servidor:

| | Quién la usa | Dónde corre | Ruta |
|---|---|---|---|
| **Tata (casa)** | La persona mayor | Tablet o celular viejo enchufado, Chrome en Android | `/casa/` |
| **Tata Familia** | Hijos, nietos, etc. | Celular de cada familiar (PWA instalable) | `/familia/` |
| Inicio | Quien crea el hogar | Cualquiera | `/` |

## Stack

- **Servidor**: Node.js ≥ 22.13, sin framework (`node:http`).
  - Base: **SQLite** con el módulo nativo `node:sqlite`.
  - Dependencias: `web-push` y `@anthropic-ai/sdk` (este último solo se usa si hay `ANTHROPIC_API_KEY`).
- **Voz del familiar**: servicio aparte en Python (`voz/`, Chatterbox Multilingual), local y opcional.
- **Tiempo real**: Server-Sent Events (`/api/casa/stream` y `/api/familia/stream`).
- **Frontend**: HTML, CSS y JS sin build (vanilla), servido como estático desde `public/`.
- **Voz**:
  - Escucha con la Web Speech API del navegador (`SpeechRecognition`, `es-AR`).
  - Habla con `speechSynthesis`.
  - Los audios grabados por la familia se graban con `MediaRecorder` y se guardan como BLOB en SQLite.
- **Notificaciones**: Web Push con VAPID. Las claves se generan solas la primera vez y se guardan en la tabla `settings`. El service worker está en `public/familia/sw.js`.
- **Tests**: `node:test` (`npm test`), con 19 tests de lógica y reloj simulado.

## Decisiones tomadas (y por qué)

1. **Web primero, sin hardware propio.** El "parlante" es una tablet o celular viejo en modo pantalla completa. Así se valida el producto sin fabricar nada. El parlante físico, que podría ser una Raspberry Pi con micrófono y botones, queda para después.
2. **El cerebro vive en el servidor** (`server/brain.js`). La casa manda el texto que escuchó y recibe qué decir. El estado de la charla (preguntas pendientes, modo paso a paso) queda guardado en el hogar, así que sobrevive a recargas.
3. **Reglas primero, Claude de respaldo.** SOS, pastillas, turnos y llamadas son reglas determinísticas y testeables (`server/brain.js`). Lo que no matchea ninguna regla va a Claude (`server/ai.js`), que charla y tiene 4 herramientas: avisar a un familiar, crear un recordatorio, recordar un dato y pedir ayuda (dispara el mismo SOS). Con Claude activo, las reglas de charla (saludos, "estoy bien", "me siento sola") solo aplican a frases de hasta 5 palabras. El historial con Claude es solo de agregar: tras 30 minutos sin charlar, o si falla, arranca una charla nueva.
4. **La voz del familiar, con cuidado.** El familiar graba 10–30 s en la app (WAV, con consentimiento) y Chatterbox Multilingual (MIT, local, `voz/servidor.py`) genera sus mensajes y recordatorios con su voz. Tata siempre lo presenta ("Laura te dejó dicho"), lo que habla de plata o claves va con la voz de Tata (`server/voice.js`), y Claude nunca habla con voz clonada. Los audios grabados a mano siguen funcionando igual.
5. **Llamadas honestas.** Una web no puede hacer llamadas telefónicas. Cuando ella dice "llamá a Laura", Tata le manda un push a Laura ("quiere hablar con vos") y en la casa muestra un botón grande `tel:`. Ese botón funciona si el dispositivo tiene línea. Con emergencias pasa lo mismo: aviso a toda la familia y botón para llamar al 107, que se puede configurar.
6. **Primero se le pregunta a ella.** Si a la mañana no hubo actividad, Tata pregunta "¿Cómo amaneciste?" y espera 15 minutos antes de avisar a la familia. Si después habla, la familia recibe "ya habló con Tata". La ventana de chequeo es de 3 horas desde la hora configurada.
7. **Pastillas con seguimiento.** Tata recuerda a la hora configurada. Si no hay confirmación, pregunta de nuevo a los 30 minutos y avisa a la familia a la hora. Un recordatorio con más de 60 minutos de atraso, por ejemplo porque el servidor estuvo caído, no se dice.
8. **Acceso sin contraseñas.** Cada familiar entra con un link personal (`/familia/#t=TOKEN`) que queda en `localStorage`. La casa se vincula con un código de 6 dígitos que se renueva cada vez que se usa. Alcanza para un piloto, pero no para producción (ver próximos pasos).
9. **Todo en la zona horaria del hogar** (`server/time.js`), no en la del servidor. No se le pregunta a nadie: al crear el hogar se toma la del navegador de quien lo crea, y al vincular la tablet se reemplaza por la de la tablet (`POST /api/casa/pair`), porque es la que está en la casa. Si no llega una válida, queda `America/Argentina/Cordoba`. Hoy no se puede cambiar desde la app, aunque el `PATCH /api/familia/household` la acepta.

## Estado actual

**Funciona y está probado:**

- Crear un hogar, invitar familiares (link + WhatsApp), cargar contactos (vecina, amigos).
- Vincular la casa con un código de 6 dígitos. La zona horaria se toma sola, sin preguntar.
- Pantalla de la casa: solo el parlante de Tata en el centro. Un toque para hablar, mantener apretado 2 s para SOS, y lo que dice en letras grandes.
- Escuchar:
  - Tocar para hablar.
  - Modo "Escuchar siempre" con la palabra "Tata".
  - Texto como alternativa si el navegador no tiene reconocimiento de voz.
- Lo que Tata entiende:
  - Pedido de ayuda.
  - Pastilla ("ya la tomé", "¿me toca algo?").
  - Turnos.
  - Hora y fecha.
  - Llamar a alguien y mensajes dictados ("decile a Laura que…").
  - Modo paso a paso: transferencia, foto por WhatsApp, videollamada.
  - Soledad (ofrece avisar a un nieto), saludos.
- Automático (`server/scheduler.js`, cada 30 segundos):
  - Recordatorios por día de la semana o fecha única.
  - Seguimiento de la pastilla.
  - Turno la noche anterior a las 20:00.
  - Chequeo de inactividad.
  - Resumen diario.
  - Aviso si el dispositivo se desconecta más de 10 minutos.
- App familia:
  - Estado ("Elsa está bien", "pidió ayuda", "sin actividad").
  - Pantalla roja de SOS con "Voy para allá", "Llamar" y "Ya está todo bien".
  - Historial de avisos.
  - Agenda.
  - Grabar voz.
  - Mandar mensajes que Tata dice en voz alta.
  - Ajustes y activación de push.
- Tests: `npm test` da 19/19. Además se hizo una prueba de punta a punta en Chromium: crear hogar → vincular casa → SOS por voz → overlay en el celular → "voy en camino" → la casa muestra "Laura ya está en camino".

**No probado todavía:**

- Push real en un celular. Requiere HTTPS. En iPhone solo funciona con la app agregada a inicio, en iOS 16.4 o más nuevo.
- Reconocimiento de voz con una persona mayor real y ruido de cocina.
- Uso prolongado: que la tablet quede días encendida, se reconecte y el wake lock aguante.

## Archivos clave

```
server/
  index.js      HTTP: rutas /api/*, estáticos, arranque. Toda la API está en el array `routes`.
  brain.js      Qué entiende Tata y qué responde (handle), SOS, estado de la pantalla de la casa (uiState).
  scheduler.js  Lo automático: recordatorios, seguimiento, turnos, inactividad, resumen, desconexión. Tiempos en RULES.
  core.js       Avisos a la familia (historial + push), actividad del día, canal SSE.
  db.js         Esquema SQLite completo.
  push.js       Web Push / VAPID.
  time.js       Hora local del hogar y frases ("son las 9 y cuarto de la mañana").
  ai.js         Charla con Claude para lo que las reglas no entienden, con 4 herramientas.
  voice.js      Puente con el servicio de voz del familiar y el filtro de temas riesgosos (risky).
voz/            Servicio de voz en Python (Chatterbox): instalar.ps1, servidor.py. Escucha solo en 127.0.0.1:5005.
public/
  index.html            Inicio + crear hogar.
  casa/                 App de la casa (index.html, casa.js, casa.css).
  familia/              App de la familia (index.html, familia.js, familia.css, sw.js, manifest).
  shared/base.css       Tema (crema, tinta y ámbar) y el dibujo del parlante.
test/tata.test.js       Tests de la lógica con reloj simulado.
```

## Próximos pasos sugeridos

0. **Pantalla de la casa = solo el parlante** (hecho): escucha siempre con "Tata", un toque para hablar, mantener apretado 2 s para SOS.

1. **Publicarlo con HTTPS** (Render, Railway o Fly.io, con disco persistente para `data/`) y probar push y micrófono en celulares reales.
2. **Piloto con 1 o 2 familias.** Medir cuántas frases no entiende (sumar un log de "no entendí"), si confirman la pastilla y cuántos falsos avisos de inactividad hay.
3. **(Hecho) Respaldo con Claude** para las frases que no matchean ninguna regla, sin tocar SOS ni pastillas.
4. **Seguridad para producción:**
   - Tokens con vencimiento y revocación.
   - Límite de intentos en `/api/casa/pair`.
   - Rate limiting.
   - Backups de SQLite.
   - Política de privacidad, porque se manejan datos de salud.
5. **Llamadas reales:** integración con Twilio o WhatsApp Business, o videollamada WebRTC entre la casa y la familia.
6. **Editar** recordatorios y turnos desde la app (hoy solo se pueden crear, pausar y borrar). El endpoint `PATCH` ya existe.
7. **Más guías paso a paso**, cargables por la familia.
8. **Hardware:** Raspberry Pi + micrófono de conferencia + botón SOS físico, corriendo la misma `/casa/` en modo kiosco.
9. **VoiceStudio como motor de voz (en la rama `dev`).** El código está hecho y testeado, pero falta probarlo con voces reales. Detalles y pasos pendientes en el HANDOFF de esa rama.

## Ideas propuestas (sin hacer todavía)

Ordenadas por impacto para la persona mayor y la familia:

1. **Portarretrato.** Cuando Tata no está hablando, la pantalla de la casa muestra fotos que sube la familia. Le da a la tablet un motivo para estar a la vista y encendida, y acerca a la familia todos los días.
2. **"Tata, poné la radio".** Radios en vivo por streaming (por ejemplo Cadena 3 o Mitre Córdoba), elegidas por la familia en Ajustes. Es compañía, y es de lo que más usa una persona mayor un parlante inteligente.
3. **Registro de "no entendí".** En la app de la familia, una lista de las frases que Tata no entendió. Sirve para mejorar las reglas y es la métrica clave del piloto (paso 2).
4. **Modo noche.** De noche la pantalla se apaga y Tata no habla, salvo SOS y lo que le pregunten. Evita que despierte a la persona con un recordatorio o una luz fuerte.
5. **Cambiar la zona horaria y los horarios desde Ajustes** (inactividad, resumen, teléfono de emergencia). La API ya lo soporta; falta la pantalla.

## Ramas

- `main`: lo estable. Voz del familiar solo con Chatterbox.
- `dev`: VoiceStudio como motor de voz principal, con Chatterbox de respaldo. Pendiente de prueba real (ver el paso 9 del HANDOFF de esa rama).

## Cómo seguir con Claude Code en tu terminal

```bash
git clone https://github.com/vicent301/TATA.git && cd TATA
npm install && npm test && npm start
claude    # y pedile: "leé HANDOFF.md y seguí con el paso 1"
```
