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

## Publicarlo

Es un solo proceso Node con una base SQLite en `data/tata.db`. Cualquier hosting con disco persistente sirve (Render, Railway, Fly.io, un VPS). Variables opcionales:

| Variable | Para qué |
|---|---|
| `PORT` | Puerto (por defecto 3000) |
| `DB_FILE` | Ruta de la base (por defecto `data/tata.db`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Claves de push. Si no están, se generan solas y se guardan en la base |
| `VAPID_SUBJECT` | `mailto:` de contacto para el servicio de push |

Más contexto del proyecto en [HANDOFF.md](HANDOFF.md).
