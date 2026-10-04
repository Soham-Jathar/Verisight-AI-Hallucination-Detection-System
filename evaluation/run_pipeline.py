"""Replay labelled questions through retrieval selection and the analysis pipeline.

Recorded candidate search results and model answers keep runs reproducible and
free of provider/search API calls. A separate live mode captures real outputs
for human review; it does not pretend recorded-answer labels apply to them.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.config import Settings  # noqa: E402
from app.schemas import AnalyzeRequest, EvidenceSource, LLMProvider, VerificationMode  # noqa: E402
from app.services import pipeline  # noqa: E402
from app.services.retrieval import rank_web_candidates  # noqa: E402

DEFAULT_DATASET = ROOT / "evaluation" / "datasets" / "pipeline_replay.jsonl"
DEFAULT_RESULTS = ROOT / "evaluation" / "results"


def load_cases(path: Path) -> list[dict]:
    cases: list[dict] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        case = json.loads(line)
        if not isinstance(case, dict) or not all(key in case for key in ("id", "question")):
            raise ValueError(f"Pipeline case on line {line_number} needs id and question.")
        cases.append(case)
    if not cases:
        raise ValueError("The pipeline dataset has no cases.")
    return cases


def diagnose(case: dict, response: dict, retrieved_urls: list[str]) -> list[str]:
    """Attribute a failed replay to observable pipeline stages."""
    failures: list[str] = []
    if any(url not in retrieved_urls for url in case.get("expected_source_urls", [])):
        failures.append("retrieval_miss")

    assessments = {item["claim"].strip(): item for item in response["claims"]}
    for expected in case.get("expected_claims", []):
        actual = assessments.get(expected["claim"].strip())
        if actual is None:
            failures.append("claim_extraction_miss")
            continue
        if actual["status"] != expected["status"]:
            failures.append("verdict_error")
        citation_url = expected.get("citation_url")
        if citation_url and citation_url not in {
            source["url"] for source in actual["citations"]
        }:
            failures.append("citation_error")

    if "expect_correction" in case:
        has_correction = response["correction"] is not None
        if case["expect_correction"] and not has_correction:
            failures.append("correction_missing")
        elif not case["expect_correction"] and has_correction:
            failures.append("unsafe_correction")
    return list(dict.fromkeys(failures))


async def replay_case(case: dict, settings: Settings) -> dict:
    mode = VerificationMode(case.get("mode", "web"))
    candidates = [EvidenceSource.model_validate(item) for item in case.get("candidates", [])]
    retrieved_urls: list[str] = []

    async def recorded_web_retrieval(question: str, **_kwargs) -> list[EvidenceSource]:
        selected = rank_web_candidates(question, candidates)
        for source in selected:
            if source.url not in retrieved_urls:
                retrieved_urls.append(source.url)
        return selected

    def recorded_document_retrieval(_document_id: str, _question: str, **_kwargs) -> list[EvidenceSource]:
        selected = [source for source in candidates if source.url.startswith("document://")]
        for source in selected:
            if source.url not in retrieved_urls:
                retrieved_urls.append(source.url)
        return selected

    async def recorded_generation(*_args, **_kwargs) -> tuple[str, str]:
        return case["answer"], "recorded-answer"

    async def recorded_correction(*_args, **_kwargs) -> tuple[str, str]:
        return case.get("correction_answer", "The evidence is insufficient to correct this answer."), "recorded-correction"

    request = AnalyzeRequest(
        question=case["question"],
        mode=mode,
        provider=LLMProvider.GEMINI,
        history=case.get("history", []),
        document_id="replay-document" if mode in {VerificationMode.DOCUMENT, VerificationMode.IMAGE, VerificationMode.HYBRID} else None,
    )
    with (
        patch.object(pipeline, "retrieve_web_evidence", recorded_web_retrieval),
        patch.object(pipeline, "document_evidence", recorded_document_retrieval),
        patch.object(pipeline, "document_secondary_paper_options", lambda *_args: None),
        patch.object(pipeline, "generate_answer", recorded_generation),
        patch.object(pipeline, "generate_correction", recorded_correction),
    ):
        result = await pipeline.run_analysis(request, settings=settings)
    response = result.model_dump(mode="json")
    failures = diagnose(case, response, retrieved_urls)
    return {
        "id": case["id"],
        "question": case["question"],
        "passed": not failures,
        "failure_stages": failures,
        "retrieved_urls": retrieved_urls,
        "response": response,
    }


async def live_case(case: dict, settings: Settings, provider: LLMProvider) -> dict:
    if VerificationMode(case.get("mode", "web")) != VerificationMode.WEB:
        raise ValueError("Live collection currently supports web mode only; upload documents through the API first.")
    request = AnalyzeRequest(question=case["question"], provider=provider)
    response = await pipeline.run_analysis(request, settings=settings)
    return {
        "id": case["id"],
        "question": case["question"],
        "review_required": True,
        "response": response.model_dump(mode="json"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate the VeriSight question-to-verdict pipeline.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_RESULTS)
    parser.add_argument("--live", action="store_true", help="Call real web/LLM services and save unlabelled traces for human review.")
    parser.add_argument("--provider", choices=("gemini", "groq"), default="gemini", help="LLM for live collection only.")
    parser.add_argument("--limit", type=int, default=0, help="Run only the first N cases (zero means all).")
    args = parser.parse_args()

    cases = load_cases(args.dataset)
    if args.limit < 0:
        raise ValueError("--limit must be zero or greater.")
    if args.limit:
        cases = cases[:args.limit]
    if not args.live and any("answer" not in case for case in cases):
        raise ValueError("Every replay case needs a recorded answer.")
    settings = Settings(_env_file=BACKEND / ".env") if args.live else Settings(_env_file=None)
    if args.live:
        web_cases = [case for case in cases if VerificationMode(case.get("mode", "web")) == VerificationMode.WEB]
        if not web_cases:
            raise ValueError("Live collection needs at least one web-mode question.")
        results = []
        for case in web_cases:
            print(f"Collecting live case: {case['id']}", flush=True)
            results.append(asyncio.run(live_case(case, settings, LLMProvider(args.provider))))
    else:
        results = []
        for case in cases:
            print(f"Replaying case: {case['id']}", flush=True)
            results.append(asyncio.run(replay_case(case, settings)))

    output = args.output_dir / datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    output.mkdir(parents=True, exist_ok=False)
    (output / "pipeline_results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    if args.live:
        print(f"Collected {len(results)} live trace(s) for human review: {output}")
    else:
        failures = Counter(stage for result in results for stage in result["failure_stages"])
        summary = {"cases": len(results), "passed": sum(result["passed"] for result in results), "failure_stages": dict(failures)}
        (output / "pipeline_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(f"Pipeline replay: {summary['passed']}/{summary['cases']} passed | failures: {dict(failures)}")
        print(f"Reports written to: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
