# services/voice-sidecar/tests/conftest.py
import pytest
import server


@pytest.fixture(autouse=True)
def reset_models():
    server._tts_pipelines = {}
    server._stt_model = None
    yield
    server._tts_pipelines = {}
    server._stt_model = None
