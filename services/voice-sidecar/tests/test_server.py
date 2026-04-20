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
