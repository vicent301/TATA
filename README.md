# Tata

Compañía por voz para personas mayores. **Ella solo habla; la familia arma todo desde el celular.**

- **Tata (la casa)**: una tablet o celular viejo que queda enchufado en casa. Escucha, habla, recuerda la pastilla, avisa de los turnos, pasa mensajes y tiene un botón SOS.
- **Tata Familia**: app web (instalable) para el celular de la familia. Carga recordatorios y turnos, manda mensajes de texto o de voz, y recibe notificaciones push si pide ayuda, si no confirma la pastilla o si a la mañana no habló con nadie.

## Correrlo en tu compu

Necesitás [Node.js 22.13 o más nuevo](https://nodejs.org).

```bash
npm install
npm start          # abre en http://localhost:3000
npm test           # tests de la lógica
```

1. Abrí `http://localhost:3000` y creá el hogar (te lleva a la app de la familia).
2. En **Ajustes** vas a ver un código de 6 números.
3. En otra pestaña (o en la tablet) abrí `http://localhost:3000/casa/`, escribí el código y tocá **Empezar**.

> El micrófono y las notificaciones del navegador solo funcionan en `localhost` o con **HTTPS**. Para probar con una tablet real hay que publicarlo (ver abajo) o usar un túnel como `npx localtunnel --port 3000` / `cloudflared tunnel --url http://localhost:3000`.

## La pantalla de la casa

Solo el parlante de Tata en el centro, como un Echo:

- **Decí “Tata” y lo que necesites**: escucha siempre (se puede apagar en `···`).
- **Tocalo** para hablarle sin decir “Tata”.
- **Mantenelo apretado 2 segundos** para pedir ayuda: el aro se llena de rojo y avisa a toda la familia.
- Lo que Tata dice aparece en letras grandes y se apaga solo. Los botones (“Sí, dale”, “Llamar a Laura”) aparecen solo cuando hacen falta.

## Charla con Claude (opcional)

SOS, pastillas, turnos y llamadas siguen siendo reglas fijas y testeables. Todo lo que esas reglas no entienden lo charla Claude: preguntas generales, compañía, y también puede avisarle algo a un familiar, anotar un recordatorio, recordar cosas que ella cuenta o disparar el SOS si detecta una urgencia (`server/ai.js`).

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Sin la clave, Tata funciona igual que antes. `TATA_MODEL` cambia el modelo (por defecto `claude-opus-5-5`).

## La voz del familiar (opcional, gratis y local)

Cada familiar puede grabar 10 a 30 segundos de su voz en **Ajustes → Tu voz en Tata** (con consentimiento explícito). Después, al mandar un mensaje o crear un recordatorio, elige “Que lo diga con mi voz”.

Hay dos motores, los dos gratis y locales (mejor con una placa NVIDIA). Tata usa el principal y, si falla o no está prendido, el otro. Con prender uno alcanza.

**VoiceStudio (principal).** [VoiceStudio](https://github.com/debpalash/VoiceStudio) es una app aparte (licencia AGPL-3.0) que trae varios motores para elegir. Instalala desde su página, abrila y dejala abierta: su API queda en `http://127.0.0.1:3900`. Tata crea un perfil por cada voz grabada, con un nombre del tipo `tata-1a2b…` sin datos del familiar, y lo borra si el familiar borra o cambia su voz. Por defecto usa el motor que tengas elegido en VoiceStudio.

**Chatterbox (respaldo).** [Chatterbox Multilingual](https://github.com/resemble-ai/chatterbox) (Resemble AI, licencia MIT):

```powershell
voz\instalar.ps1                          # una vez: crea voz\.venv (baja ~3 GB)
voz\.venv\Scripts\python voz\servidor.py  # deja el servicio en http://127.0.0.1:5005
```

Con `VOZ_MOTOR=chatterbox`, Chatterbox pasa a ser el principal y VoiceStudio el respaldo.

Sobre la licencia: Tata le habla a VoiceStudio por HTTP, como a un programa aparte, y no incluye su código. Si modificás VoiceStudio y lo ofrecés por red, la AGPL te obliga a publicar esos cambios.

Cuidados, porque las estafas con voces clonadas apuntan a personas mayores:

- Antes de la voz del familiar, Tata siempre dice “Laura te dejó dicho:”.
- Lo que hable de plata, bancos, claves o códigos se dice con la voz de Tata, nunca con la clonada (`server/voice.js`).
- La voz clonada solo dice lo que ese familiar escribió; nunca lo que genera Claude.
- Chatterbox le agrega una marca de agua inaudible a cada audio. El familiar puede borrar su voz cuando quiera, y se borra también de VoiceStudio.

Si ningún servicio de voz está prendido, Tata dice el mensaje con su propia voz y la app avisa por qué.

## Publicarlo

Es un solo proceso Node con una base SQLite en `data/tata.db`. Cualquier hosting con disco persistente sirve (Render, Railway, Fly.io, un VPS). Variables opcionales:

| Variable | Para qué |
|---|---|
| `PORT` | Puerto (por defecto 3000) |
| `DB_FILE` | Ruta de la base (por defecto `data/tata.db`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Claves de push. Si no están, se generan solas y se guardan en la base |
| `VAPID_SUBJECT` | `mailto:` de contacto para el servicio de push |
| `ANTHROPIC_API_KEY` | Activa la charla con Claude |
| `TATA_MODEL` | Modelo de Claude (por defecto `claude-opus-5-5`) |
| `VOZ_MOTOR` | Motor de voz principal: `voicestudio` (por defecto) o `chatterbox`. El otro queda de respaldo |
| `VOICESTUDIO_URL` | Dónde está la API de VoiceStudio (por defecto `http://127.0.0.1:3900`) |
| `VOICESTUDIO_MODEL` | Motor de VoiceStudio, por ejemplo `omnivoice` (por defecto `tts-1`, que es el que tenga elegido la app) |
| `VOZ_URL` | Dónde está Chatterbox (por defecto `http://127.0.0.1:5005`) |

Más contexto del proyecto en [HANDOFF.md](HANDOFF.md).
