# services/voice-sidecar/tests/test_server.py
from unittest.mock import MagicMock
import server
from fastapi.testclient import TestClient


def test_health_ok():
    server._tts_pipelines = {"a": MagicMock(), "b": MagicMock()}
    server._stt_model = MagicMock()
    client = TestClient(server.app)
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["tts"] == "ok"
    assert data["stt"] == "ok"


def test_health_no_models():
    server._tts_pipelines = {}
    server._stt_model = None
    client = TestClient(server.app)
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["tts"] == "error"
    assert data["stt"] == "error"


import io
import subprocess
import numpy as np
from unittest.mock import patch


def test_tts_returns_ogg():
    fake_audio = np.zeros(24000, dtype=np.float32)
    mock_pipeline = MagicMock()
    mock_pipeline.return_value = [("gs", "ps", fake_audio)]
    server._tts_pipelines = {"a": mock_pipeline, "b": mock_pipeline}
    server._stt_model = MagicMock()

    def fake_ffmpeg(cmd, **kwargs):
        ogg_path = cmd[-1]
        with open(ogg_path, "wb") as f:
            f.write(b"OggS\x00fake")
        return MagicMock(returncode=0)

    with patch("server.subprocess.run", side_effect=fake_ffmpeg):
        client = TestClient(server.app)
        resp = client.post("/tts", json={"text": "hello", "voice_id": "am_echo", "speed": 1.0})

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/ogg"


def test_tts_503_when_no_pipeline():
    server._tts_pipelines = {}
    server._stt_model = None
    client = TestClient(server.app)
    resp = client.post("/tts", json={"text": "hello", "voice_id": "am_echo"})
    assert resp.status_code == 503


def test_tts_500_when_ffmpeg_fails():
    fake_audio = np.zeros(24000, dtype=np.float32)
    mock_pipeline = MagicMock()
    mock_pipeline.return_value = [("gs", "ps", fake_audio)]
    server._tts_pipelines = {"a": mock_pipeline}

    def failing_ffmpeg(cmd, **kwargs):
        result = MagicMock()
        result.returncode = 1
        result.stderr = b"ffmpeg: error"
        raise subprocess.CalledProcessError(1, cmd, stderr=b"ffmpeg: error")

    with patch("server.subprocess.run", side_effect=failing_ffmpeg):
        client = TestClient(server.app)
        resp = client.post("/tts", json={"text": "hello", "voice_id": "am_echo"})

    assert resp.status_code == 500
