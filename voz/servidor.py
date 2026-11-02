"""Servicio de voz de Tata: dice un texto con la voz de un familiar.

Usa Chatterbox Multilingual (Resemble AI, licencia MIT): con 10 a 30 segundos de la voz
de una persona, genera audio nuevo con su voz. Corre local, sin pagar nada, mejor con GPU.

El servidor de Tata (Node) le manda el texto y la muestra de voz; este servicio devuelve un WAV.
Escucha solo en 127.0.0.1: no exponerlo a internet.

    POST /tts   {"text": "...", "voice_wav_b64": "...", "lang": "es"}  ->  audio/wav
    GET  /health                                                      ->  {"ok": true, "device": "cuda"}
"""

import base64
import hashlib
import io
import os
import tempfile
import threading

import torch
import torchaudio as ta
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from chatterbox.mtl_tts import ChatterboxMultilingualTTS

DEVICE = os.environ.get("VOZ_DEVICE") or ("cuda" if torch.cuda.is_available() else "cpu")
VOICES_DIR = os.path.join(tempfile.gettempdir(), "tata-voces")
os.makedirs(VOICES_DIR, exist_ok=True)

print(f"Cargando Chatterbox Multilingual en {DEVICE} (la primera vez descarga el modelo)...", flush=True)
model = ChatterboxMultilingualTTS.from_pretrained(device=DEVICE)
lock = threading.Lock()  # el modelo no es seguro para usar desde varios hilos a la vez
print("Listo.", flush=True)

app = FastAPI(title="Tata voz")


class TTS(BaseModel):
    text: str = Field(min_length=1, max_length=400)
    voice_wav_b64: str = Field(min_length=100)
    lang: str = "es"


def voice_file(b64: str) -> str:
    """Guarda la muestra en disco una sola vez (por hash) y devuelve la ruta."""
    data = base64.b64decode(b64)
    path = os.path.join(VOICES_DIR, hashlib.sha256(data).hexdigest()[:32] + ".wav")
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(data)
    return path


@app.get("/health")
def health():
    return {"ok": True, "device": DEVICE}


@app.post("/tts")
def tts(req: TTS):
    try:
        ref = voice_file(req.voice_wav_b64)
    except Exception:
        raise HTTPException(400, "Muestra de voz inválida")
    with lock, torch.inference_mode():
        wav = model.generate(req.text, language_id=req.lang, audio_prompt_path=ref)
    buf = io.BytesIO()
    ta.save(buf, wav.cpu(), model.sr, format="wav")
    return Response(buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("VOZ_PORT", "5005")))
