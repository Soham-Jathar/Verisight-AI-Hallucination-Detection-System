import asyncio

import pytest
import httpx
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app
from app.schemas import AnalyzeRequest, ClaimAssessment, EvidenceSource, LLMProvider
from app.services import pipeline
from app.services.pipeline import _claims_needing_focused_evidence, _merge_evidence, _verified_correction
from app.services.generator import _connection_error, _document_grounding_instruction, _list_answer_instruction


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_health_endpoint(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_default_groq_model_is_not_retired() -> None:
    settings = Settings(_env_file=None)

    assert settings.groq_model == "openai/gpt-oss-120b"


def test_root_endpoint(client: TestClient) -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert "message" in response.json()


def test_render_static_frontend_is_allowed_by_cors(client: TestClient) -> None:
    response = client.get(
        "/health",
        headers={"Origin": "https://verisight-web.onrender.com"},
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "https://verisight-web.onrender.com"


def test_analyze_requires_question(client: TestClient) -> None:
    response = client.post("/api/analyze", json={"question": "ab", "mode": "web"})
    assert response.status_code == 422


def test_merge_evidence_keeps_focused_excerpt_for_same_url() -> None:
    initial = EvidenceSource(
        title="Python",
        url="https://example.com/python",
        snippet="Python is a programming language.",
    )
    focused = EvidenceSource(
        title="Python",
        url="https://example.com/python",
        snippet="Python was created by Guido van Rossum and first released in 1991.",
    )

    merged = _merge_evidence([initial], [focused])

    assert len(merged) == 1
    assert "Guido van Rossum" in merged[0].snippet


def test_unresolved_claims_receive_focused_evidence_retrieval() -> None:
    claims = [
        ClaimAssessment(claim="Supported fact.", status="supported", confidence=0.99, rationale="ok"),
        ClaimAssessment(claim="Missing date.", status="uncertain", confidence=0.70, rationale="review"),
        ClaimAssessment(claim="Potentially contradicted event.", status="unsupported", confidence=0.80, rationale="check"),
    ]

    assert _claims_needing_focused_evidence(claims) == [
        "Missing date.",
        "Potentially contradicted event.",
    ]


def test_no_evidence_response_has_no_reliability_percentage(monkeypatch) -> None:
    async def no_sources(*_args, **_kwargs):
        return []

    async def generated_answer(*_args, **_kwargs):
        return "Guido van Rossum created Python.", "recorded-model"

    monkeypatch.setattr(pipeline, "retrieve_web_evidence", no_sources)
    monkeypatch.setattr(pipeline, "generate_answer", generated_answer)
    response = asyncio.run(pipeline.run_analysis(
        AnalyzeRequest(question="Who created Python?", provider=LLMProvider.GEMINI),
        settings=Settings(_env_file=None),
    ))

    assert response.claims[0].status == "uncertain"
    assert response.reliability_score is None
    assert response.evidence == []


def test_correction_is_hidden_if_any_new_claim_needs_review(monkeypatch) -> None:
    source = EvidenceSource(title="Python", url="https://example.com/python", snippet="Guido van Rossum created Python.")
    monkeypatch.setattr(pipeline, "verify_claims", lambda *_args, **_kwargs: [
        ClaimAssessment(claim="Guido van Rossum created Python.", status="supported", confidence=0.99, rationale="entailed", citations=[source]),
        ClaimAssessment(claim="Python was first released in 1980.", status="uncertain", confidence=0.55, rationale="not established"),
    ])

    assert _verified_correction(
        "Guido van Rossum created Python. Python was first released in 1980.",
        "Who created Python?",
        [source],
    ) is None


def test_verified_correction_uses_the_rechecked_claim_citation(monkeypatch) -> None:
    source = EvidenceSource(title="Python", url="https://example.com/python", snippet="Guido van Rossum created Python.")
    monkeypatch.setattr(pipeline, "verify_claims", lambda *_args, **_kwargs: [
        ClaimAssessment(claim="Guido van Rossum created Python.", status="supported", confidence=0.99, rationale="entailed", citations=[source]),
    ])

    correction = _verified_correction("Guido van Rossum created Python.", "Who created Python?", [source])

    assert correction is not None
    assert correction.citations == [source]


def test_verified_correction_keeps_excerpts_for_multiple_claims_on_one_page(monkeypatch) -> None:
    creator = EvidenceSource(title="Python", url="https://example.com/python", snippet="Guido van Rossum created Python.")
    release = EvidenceSource(title="Python", url="https://example.com/python", snippet="Python was first released in 1991.")
    monkeypatch.setattr(pipeline, "verify_claims", lambda *_args, **_kwargs: [
        ClaimAssessment(claim="Guido van Rossum created Python.", status="supported", confidence=0.99, rationale="entailed", citations=[creator]),
        ClaimAssessment(claim="Python was first released in 1991.", status="supported", confidence=0.99, rationale="entailed", citations=[release]),
    ])

    correction = _verified_correction(
        "Guido van Rossum created Python. Python was first released in 1991.",
        "When was Python first released?",
        [creator, release],
    )

    assert correction is not None
    assert len(correction.citations) == 1
    assert "created Python" in correction.citations[0].snippet
    assert "released in 1991" in correction.citations[0].snippet


def test_document_only_generation_requires_exact_document_values() -> None:
    document = EvidenceSource(
        title="syllabus.pdf",
        url="document://syllabus",
        snippet="GATE 2027 is organised by IIT Madras.",
    )

    instruction = _document_grounding_instruction([document])

    assert "authoritative" in instruction
    assert "exact value directly" in instruction


def test_factual_list_instruction_preserves_complete_supported_lists() -> None:
    instruction = _list_answer_instruction("Name all the GATE 2027 test papers")

    assert "every requested item" in instruction
    assert "six items" in instruction


def test_document_mode_requires_an_uploaded_pdf(client: TestClient) -> None:
    response = client.post(
        "/api/analyze",
        json={"question": "Who created Python?", "mode": "document"},
    )
    assert response.status_code == 400
    assert "Upload a PDF or image" in response.json()["detail"]


def test_image_mode_requires_an_uploaded_image(client: TestClient) -> None:
    response = client.post(
        "/api/analyze",
        json={"question": "What text is in the image?", "mode": "image"},
    )

    assert response.status_code == 400
    assert "Upload a PDF or image" in response.json()["detail"]


def test_analyze_web_mode_contract(client: TestClient) -> None:
    response = client.post(
        "/api/analyze",
        json={"question": "Who created Python?", "mode": "web"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["question"] == "Who created Python?"
    assert payload["mode"] == "web"
    assert payload["stage"] == "complete"
    assert isinstance(payload["message"], str)
    assert payload["message"]


def test_empty_connection_error_keeps_a_useful_error_type() -> None:
    error = _connection_error("Gemini", httpx.ConnectError(""))

    assert "ConnectError" in str(error)
    assert "VPN, proxy, or firewall" in str(error)
