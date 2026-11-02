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
  - Única dependencia: `web-push`.
- **Tiempo real**: Server-Sent Events (`/api/casa/stream` y `/api/familia/stream`).
- **Frontend**: HTML, CSS y JS sin build (vanilla), servido como estático desde `public/`.
- **Voz**:
  - Escucha con la Web Speech API del navegador (`SpeechRecognition`, `es-AR`).
  - Habla con `speechSynthesis`.
  - Los audios grabados por la familia se graban con `MediaRecorder` y se guardan como BLOB en SQLite.
- **Notificaciones**: Web Push con VAPID. Las claves se generan solas la primera vez y se guardan en la tabla `settings`. El service worker está en `public/familia/sw.js`.
- **Tests**: `node:test` (`npm test`), con 22 tests de lógica y reloj simulado.

## Decisiones tomadas (y por qué)

1. **Web primero, sin hardware propio.** El "parlante" es una tablet o celular viejo en modo pantalla completa. Así se valida el producto sin fabricar nada. El parlante físico, que podría ser una Raspberry Pi con micrófono y botones, queda para después.
2. **El cerebro vive en el servidor** (`server/brain.js`). La casa manda el texto que escuchó y recibe qué decir. El estado de la charla (preguntas pendientes, modo paso a paso) queda guardado en el hogar, así que sobrevive a recargas.
3. **Reglas primero, Claude de respaldo.** SOS, pastillas, turnos y llamadas son reglas determinísticas y testeables (`server/brain.js`). Lo que no matchea ninguna regla va a Claude (`server/ai.js`), que charla y tiene 4 herramientas: avisar a un familiar, crear un recordatorio, recordar un dato y pedir ayuda (dispara el mismo SOS). Con Claude activo, las reglas de charla (saludos, "estoy bien", "me siento sola") solo aplican a frases de hasta 5 palabras. El historial con Claude es solo de agregar: tras 30 minutos sin charlar, o si falla, arranca una charla nueva.
4. **La voz del familiar, con cuidado.** El familiar graba 10–30 s en la app (WAV, con consentimiento) y un motor local genera sus mensajes y recordatorios con su voz: VoiceStudio (AGPL, app aparte, API en :3900) como principal y Chatterbox Multilingual (MIT, `voz/servidor.py`) de respaldo, o al revés con `VOZ_MOTOR=chatterbox`. En VoiceStudio cada voz es un perfil `tata-<hash>`, que se busca por nombre en cada mensaje (si se le pasa un id que no existe, habla con una voz genérica sin dar error) y se borra cuando el familiar borra o cambia su voz. Tata siempre lo presenta ("Laura te dejó dicho"), lo que habla de plata o claves va con la voz de Tata (`server/voice.js`), y Claude nunca habla con voz clonada. Los audios grabados a mano siguen funcionando igual.
5. **Llamadas honestas.** Una web no puede hacer llamadas telefónicas. Cuando ella dice "llamá a Laura", Tata le manda un push a Laura ("quiere hablar con vos") y en la casa muestra un botón grande `tel:`. Ese botón funciona si el dispositivo tiene línea. Con emergencias pasa lo mismo: aviso a toda la familia y botón para llamar al 107, que se puede configurar.
6. **Primero se le pregunta a ella.** Si a la mañana no hubo actividad, Tata pregunta "¿Cómo amaneciste?" y espera 15 minutos antes de avisar a la familia. Si después habla, la familia recibe "ya habló con Tata". La ventana de chequeo es de 3 horas desde la hora configurada.
7. **Pastillas con seguimiento.** Tata recuerda a la hora configurada. Si no hay confirmación, pregunta de nuevo a los 30 minutos y avisa a la familia a la hora. Un recordatorio con más de 60 minutos de atraso, por ejemplo porque el servidor estuvo caído, no se dice.
8. **Acceso sin contraseñas.** Cada familiar entra con un link personal (`/familia/#t=TOKEN`) que queda en `localStorage`. La casa se vincula con un código de 6 dígitos que se renueva cada vez que se usa. Alcanza para un piloto, pero no para producción (ver próximos pasos).
9. **Todo en la zona horaria del hogar** (`server/time.js`), no en la del servidor.

## Estado actual

**Funciona y está probado:**

- Crear un hogar, invitar familiares (link + WhatsApp), cargar contactos (vecina, amigos).
- Vincular la casa con un código, con una pantalla grande con reloj, carita de Tata, botones **Hablar** y **SOS**, opciones rápidas y la lista de hoy.
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
- Tests: `npm test` da 22/22. Además se hizo una prueba de punta a punta en Chromium: crear hogar → vincular casa → SOS por voz → overlay en el celular → "voy en camino" → la casa muestra "Laura ya está en camino".

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
9. **Terminar VoiceStudio como motor de voz** (esta rama, `dev`; `main` sigue solo con Chatterbox).
   - **Hecho:** `server/voice.js` usa VoiceStudio y cae a Chatterbox si falla. Crea, reusa y borra perfiles. Tiene 3 tests con fetch simulado (`npm test`).
   - **Probado:** solo con fetch simulado. La API real de VoiceStudio se leyó del código fuente (`backend/api/routers/openai_compat.py` y `profiles.py`), sin llamarla nunca.
   - **Pendiente en la compu de desarrollo:** VoiceStudio 0.5.7 está instalado (`%LOCALAPPDATA%\Programs\VoiceStudio`), pero falta que la app baje su entorno de Python (~9 GB en `%APPDATA%\VoiceStudio\runtime`; la primera vez se cortó por falta de espacio). Después hay que elegir un motor liviano (OmniVoice), porque la placa es una RTX 3050 de 4 GB.
   - **Para probar:**
     - Con VoiceStudio abierto, `curl http://127.0.0.1:3900/health` tiene que devolver `{"status":"ok"}`, y `/api/familia/me` tiene que mostrar `features.voice: true`.
     - Grabar una voz en Ajustes y tocar probar.
     - Confirmar que en VoiceStudio aparece un perfil `tata-…`.
     - Borrar la voz y confirmar que el perfil desaparece.
   - **A verificar en la prueba real:**
     - Que `POST /profiles` acepte el WAV que graba la app.
     - Que `language: "es"` suene bien en castellano rioplatense.
     - Cuánto tarda la primera generación (el timeout es de 300 s).
   - **Licencia:** VoiceStudio es AGPL-3.0. Tata solo lo llama por HTTP, pero si se modifica y se ofrece por red, hay que publicar esos cambios.
   - **Para pasarlo a `main`:** cuando la prueba real dé bien, `git switch main && git merge dev`.

## Cómo seguir con Claude Code en tu terminal

```bash
git clone https://github.com/vicent301/TATA.git && cd TATA
npm install && npm test && npm start
claude    # y pedile: "leé HANDOFF.md y seguí con el paso 1"
```
