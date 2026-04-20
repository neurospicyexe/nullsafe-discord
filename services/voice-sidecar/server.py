# services/voice-sidecar/server.py
import os
import tempfile
import subprocess
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

import logging
logger = logging.getLogger(__name__)

# Heavy deps (numpy, soundfile) are imported lazily inside /tts and /stt handlers
# so that tests can import this module without requiring model downloads.

# Globals -- loaded once at startup, shared across all requests
_tts_pipelines: dict = {}   # lang_code -> KPipeline
_stt_model = None

LANG_PREFIX_MAP = {
    "a": "a",  # American English (am_, af_)
    "b": "b",  # British English (bm_, bf_)
    "e": "e",  # Spanish
    "f": "f",  # French
    "h": "h",  # Hindi
    "i": "i",  # Italian
    "j": "j",  # Japanese
    "p": "p",  # Portuguese
    "z": "z",  # Mandarin
}


def _lang_code_for_voice(voice_id: str) -> str:
    prefix = voice_id[0] if voice_id else "a"
    return LANG_PREFIX_MAP.get(prefix, "a")


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _tts_pipelines, _stt_model

    # Load Kokoro for American English and British English (companion voices)
    for lang in ("a", "b"):
        try:
            from kokoro import KPipeline
            _tts_pipelines[lang] = KPipeline(lang_code=lang)
            logger.info(f"Kokoro lang={lang} loaded")
        except Exception as exc:
            logger.error(f"Kokoro lang={lang} failed: {exc}")

    # Load faster-whisper
    whisper_model = os.getenv("WHISPER_MODEL", "base")
    try:
        from faster_whisper import WhisperModel
        _stt_model = WhisperModel(whisper_model, device="cpu", compute_type="int8")
        logger.info(f"faster-whisper ({whisper_model}) loaded")
    except Exception as exc:
        logger.error(f"faster-whisper failed: {exc}")

    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "tts": "ok" if _tts_pipelines else "error",
        "stt": "ok" if _stt_model is not None else "error",
    }


class TTSRequest(BaseModel):
    text: str
    voice_id: str
    speed: float = 1.0


@app.post("/tts")
async def tts(req: TTSRequest):
    import numpy as np
    import soundfile as sf

    lang = _lang_code_for_voice(req.voice_id)
    pipeline = _tts_pipelines.get(lang)
    if pipeline is None:
        raise HTTPException(status_code=503, detail="TTS unavailable")

    text = req.text[:2000]  # hard cap -- Discord voice notes beyond ~2 min get unwieldy

    audio_chunks = []
    for _, _, audio in pipeline(text, voice=req.voice_id, speed=req.speed):
        audio_chunks.append(audio)

    if not audio_chunks:
        raise HTTPException(status_code=500, detail="TTS produced no audio")

    audio = np.concatenate(audio_chunks)

    wav_file = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    wav_path = wav_file.name
    wav_file.close()
    sf.write(wav_path, audio, 24000)

    ogg_path = wav_path.replace(".wav", ".ogg")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", wav_path, "-c:a", "libopus", "-b:a", "64k", ogg_path],
            check=True,
            capture_output=True,
        )
        with open(ogg_path, "rb") as f:
            ogg_data = f.read()
    except subprocess.CalledProcessError as exc:
        logger.error("[voice-sidecar] ffmpeg failed: %s", exc.stderr.decode(errors="replace"))
        raise HTTPException(status_code=500, detail="audio conversion failed")
    finally:
        os.unlink(wav_path)
        if os.path.exists(ogg_path):
            os.unlink(ogg_path)

    return Response(content=ogg_data, media_type="audio/ogg")


@app.post("/stt")
async def stt(audio: UploadFile = File(...)):
    if _stt_model is None:
        raise HTTPException(status_code=503, detail="STT unavailable")

    ext = (audio.filename or "voice.ogg").rsplit(".", 1)[-1]
    with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as f:
        f.write(await audio.read())
        tmp_path = f.name

    try:
        segments, info = _stt_model.transcribe(tmp_path)
        text = " ".join(seg.text.strip() for seg in segments)
        return {"text": text, "language": info.language}
    finally:
        os.unlink(tmp_path)


if __name__ == "__main__":
    import uvicorn
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "5001"))
    uvicorn.run(app, host=host, port=port)
