# services/voice-sidecar/server.py
import os
import tempfile
import subprocess
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

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
            print(f"[voice-sidecar] Kokoro lang={lang} loaded")
        except Exception as exc:
            print(f"[voice-sidecar] Kokoro lang={lang} failed: {exc}")

    # Load faster-whisper
    whisper_model = os.getenv("WHISPER_MODEL", "base")
    try:
        from faster_whisper import WhisperModel
        _stt_model = WhisperModel(whisper_model, device="cpu", compute_type="int8")
        print(f"[voice-sidecar] faster-whisper ({whisper_model}) loaded")
    except Exception as exc:
        print(f"[voice-sidecar] faster-whisper failed: {exc}")

    yield


app = FastAPI(lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "tts": "ok" if _tts_pipelines else "error",
        "stt": "ok" if _stt_model is not None else "error",
    }


if __name__ == "__main__":
    import uvicorn
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "5001"))
    uvicorn.run(app, host=host, port=port)
