# Tata

Compañía por voz para personas mayores. **Ella solo habla; la familia arma todo desde el celular.**

| | Quién la usa | Qué hace |
|---|---|---|
| **Tata (la casa)** | La persona mayor | Una tablet o un celular viejo que queda enchufado. Escucha, habla, recuerda la pastilla, avisa de los turnos, pasa mensajes y tiene SOS. |
| **Tata Familia** | Hijos, nietos, vecinos | App web instalable en el celular. Carga recordatorios y turnos, manda mensajes de texto o de voz, y recibe un aviso si pide ayuda, si no confirma la pastilla o si a la mañana no habló con nadie. |

Es una web sin build: un servidor Node con SQLite y dos apps en HTML, CSS y JS. No hace falta comprar hardware para probarla.

## Correrlo en tu compu

Necesitás [Node.js 22.13 o más nuevo](https://nodejs.org).

```bash
npm install
npm start          # http://localhost:3000
npm test           # tests de la lógica
```

Si el puerto 3000 está ocupado (pasa con Docker), usá otro:

```powershell
$env:PORT=4321; npm start      # Windows (PowerShell)
```
```bash
PORT=4321 npm start            # macOS / Linux
```

### Primer uso

1. Abrí `http://localhost:3000` y creá el hogar. Te lleva a la app de la familia, y ese link es tu acceso personal.
2. En **Ajustes** vas a ver un código de 6 números.
3. En otra pestaña, o en la tablet, abrí `/casa/`, escribí el código y tocá **Empezar**. Usá Chrome: es el que tiene reconocimiento de voz.

No hace falta configurar la zona horaria. Al crear el hogar se toma la del celular, y cuando se vincula la tablet se corrige con la de la casa.

> El micrófono y las notificaciones solo funcionan en `localhost` o con **HTTPS**. Para probar con una tablet o un celular reales hay que publicarlo (ver abajo) o usar un túnel: `npx localtunnel --port 3000` o `cloudflared tunnel --url http://localhost:3000`.

## La pantalla de la casa

Solo el parlante de Tata en el centro, como un Echo:

- **Decí "Tata" y lo que necesites.** Escucha siempre; se puede apagar en `···`.
- **Tocalo** para hablarle sin decir "Tata".
- **Mantenelo apretado 2 segundos** para pedir ayuda: el aro se llena de rojo y avisa a toda la familia.
- Lo que Tata dice aparece en letras grandes y se apaga solo. Los botones ("Sí, dale", "Llamar a Laura") aparecen solo cuando hacen falta.
- Si el navegador no reconoce voz, en `···` se puede activar un cuadro para escribir.

## Qué entiende y qué hace sola

**Cuando le hablan** (reglas fijas, en `server/brain.js`):
- Pedido de ayuda.
- Pastillas: "ya la tomé", "¿me toca algo?".
- Turnos, hora y fecha.
- "Llamá a Laura": le avisa a Laura y muestra un botón grande para llamar.
- "Decile a Laura que…": le manda el mensaje.
- Paso a paso para hacer una transferencia, mandar una foto por WhatsApp o hacer una videollamada.
- Saludos, y compañía si dice que se siente sola.

**Sola** (cada 30 segundos, en `server/scheduler.js`):
- **Recordatorios** por día de la semana o con fecha.
- **Pastilla:** si no confirma, pregunta de nuevo a los 30 minutos y avisa a la familia a la hora.
- **Turnos:** los recuerda la noche anterior a las 20:00.
- **Mañana:** si no hubo actividad, pregunta "¿Cómo amaneciste?" y avisa a la familia si no contesta en 15 minutos (por defecto a las 11:00).
- **Resumen del día** para la familia (por defecto a las 21:00).
- **Desconexión:** avisa si la tablet se desconecta más de 10 minutos.

## Charla con Claude (opcional)

SOS, pastillas, turnos y llamadas siguen siendo reglas fijas y testeables. Lo que esas reglas no entienden lo charla Claude (`server/ai.js`): preguntas generales y compañía. También puede avisarle algo a un familiar, anotar un recordatorio, recordar cosas que ella cuenta o disparar el SOS si detecta una urgencia.

```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."; npm start     # Windows (PowerShell)
```
```bash
ANTHROPIC_API_KEY=sk-ant-... npm start             # macOS / Linux
```

Sin la clave, Tata funciona solo con las reglas: si le hablan de otra cosa, dice que no entendió. `TATA_MODEL` cambia el modelo (por defecto `claude-opus-5-5`).

## La voz del familiar (opcional, gratis y local)

Cada familiar puede grabar de 10 a 30 segundos de su voz en **Ajustes → Tu voz en Tata**, con consentimiento explícito. Después, al mandar un mensaje o crear un recordatorio, elige "Que lo diga con mi voz".

Usa [Chatterbox Multilingual](https://github.com/resemble-ai/chatterbox) (Resemble AI, licencia MIT), que corre en tu compu. Necesita Python 3.11 y anda mejor con placa NVIDIA:

```powershell
voz\instalar.ps1                          # una vez: crea voz\.venv (baja ~3 GB)
voz\.venv\Scripts\python voz\servidor.py  # deja el servicio en http://127.0.0.1:5005
```

Cuidados, porque las estafas con voces clonadas apuntan a personas mayores:

- Antes de la voz del familiar, Tata siempre dice "Laura te dejó dicho:".
- Lo que hable de plata, bancos, claves o códigos se dice con la voz de Tata, nunca con la clonada (`server/voice.js`).
- La voz clonada solo dice lo que ese familiar escribió; nunca lo que genera Claude.
- Chatterbox le agrega una marca de agua inaudible a cada audio. El familiar puede borrar su voz cuando quiera.

Si el servicio de voz no está prendido, Tata dice el mensaje con su propia voz y la app avisa por qué.

> En la rama `dev` está **VoiceStudio** como motor principal, con Chatterbox de respaldo. El código está hecho y testeado, pero falta probarlo con voces reales (ver el paso 9 del HANDOFF de esa rama).

## Publicarlo

Es un solo proceso Node con una base SQLite en `data/tata.db`. Sirve cualquier hosting con disco persistente (Render, Railway, Fly.io, un VPS) y HTTPS. Todas las variables son opcionales:

| Variable | Para qué |
|---|---|
| `PORT` | Puerto (por defecto 3000) |
| `DB_FILE` | Ruta de la base (por defecto `data/tata.db`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Claves de push. Si no están, se generan solas y se guardan en la base |
| `VAPID_SUBJECT` | `mailto:` de contacto para el servicio de push |
| `ANTHROPIC_API_KEY` | Activa la charla con Claude |
| `TATA_MODEL` | Modelo de Claude (por defecto `claude-opus-5-5`) |
| `VOZ_URL` | Dónde está el servicio de voz (por defecto `http://127.0.0.1:5005`) |

El acceso es con links personales y un código de 6 dígitos para la tablet, sin contraseñas. Alcanza para un piloto, no para producción: ver "Seguridad para producción" en [HANDOFF.md](HANDOFF.md).

## Estructura

```
server/   index.js (rutas HTTP), brain.js (qué entiende), scheduler.js (lo automático),
          ai.js (Claude), voice.js (voz del familiar), core.js, db.js, push.js, time.js
public/   index.html (inicio), casa/ (app de la casa), familia/ (app de la familia), shared/
voz/      servicio de voz con Chatterbox (Python)
test/     tests de la lógica con reloj simulado
```

## Problemas comunes

| Pasa esto | Probá esto |
|---|---|
| `npm` no se reconoce | Node no está en el PATH. Instalalo desde nodejs.org o abrí la terminal de donde lo tengas (por ejemplo, Laragon). |
| `EADDRINUSE` al arrancar | El puerto está ocupado: arrancá con otro `PORT`. |
| La casa no escucha | Usá Chrome, dale permiso al micrófono y abrilo en `localhost` o con HTTPS. |
| Tata no charla de cualquier tema | Falta `ANTHROPIC_API_KEY`. |
| Los mensajes no salen con la voz del familiar | El servicio de `voz/` no está prendido, o el familiar no grabó su voz. |
| No llegan notificaciones | Hacen falta HTTPS y activar push en Ajustes. En iPhone, la app tiene que estar agregada a inicio (iOS 16.4 o más nuevo). |

Más contexto del proyecto (decisiones, estado y próximos pasos) en [HANDOFF.md](HANDOFF.md).
