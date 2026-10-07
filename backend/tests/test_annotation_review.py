"""Offline checks for the independent HaluEval review workflow."""

from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "evaluation" / "annotation"))
import review  # noqa: E402


def _sample(task: str, index: int) -> dict[str, str]:
    fact = f"The {task} event {index} occurred in 1997."
    if task == "qa":
        return {"knowledge": fact, "question": f"When did event {index} happen?", "right_answer": fact, "hallucinated_answer": f"Event {index} happened in 2001."}
    if task == "dialogue":
        return {"knowledge": fact, "dialogue_history": f"User asks about event {index}.", "right_response": fact, "hallucinated_response": f"Event {index} happened in 2001."}
    return {"document": fact, "right_summary": fact, "hallucinated_summary": f"Event {index} happened in 2001."}


def _vendor(tmp_path: Path) -> Path:
    vendor = tmp_path / "vendor"
    vendor.mkdir()
    for task in review.TASKS:
        (vendor / f"{task}_data.json").write_text(
            "\n".join(json.dumps(_sample(task, index)) for index in range(6)) + "\n",
            encoding="utf-8",
        )
    return vendor


def test_prepare_is_blinded_and_group_split_is_disjoint(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(review, "existing_benchmark_ids", lambda: set())
    output = tmp_path / "work"
    result = review.prepare(_vendor(tmp_path), output, seed=27, offset=0, groups_per_task=3, heldout_groups=1)
    assert result["cases"] == 18
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    cases = review.read_jsonl(output / "reviewer_a.jsonl")
    assert cases == review.read_jsonl(output / "reviewer_b.jsonl")
    assert not any("expected_status" in row or "grounded" in row["case_id"] for row in cases)
    assert all(row["verdict"] == "" for row in cases)
    groups: dict[str, set[str]] = {}
    for row in manifest["cases"]:
        groups.setdefault(row["group_id"], set()).add(row["split"])
    assert len(groups) == 9
    assert all(len(splits) == 1 for splits in groups.values())
    assert sum("holdout" in splits for splits in groups.values()) == 3
    with pytest.raises(FileExistsError):
        review.prepare(_vendor(tmp_path), output, seed=27, offset=0, groups_per_task=3, heldout_groups=1)


def test_compare_requires_exact_evidence_then_finalizes_manual_disagreement(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(review, "existing_benchmark_ids", lambda: set())
    output = tmp_path / "work"
    review.prepare(_vendor(tmp_path), output, seed=31, offset=0, groups_per_task=2, heldout_groups=1)
    a = review.read_jsonl(output / "reviewer_a.jsonl")
    b = review.read_jsonl(output / "reviewer_b.jsonl")
    for row in a + b:
        row["verdict"] = "uncertain"
    a[0]["verdict"] = "supported"
    a[0]["evidence_excerpt"] = a[0]["evidence"][0]["snippet"]
    review.write_jsonl(output / "reviewer_a.jsonl", a)
    review.write_jsonl(output / "reviewer_b.jsonl", b)
    summary = review.compare(output)
    assert summary["disagreements"] == 1
    with pytest.raises(ValueError, match="Complete final_verdict"):
        review.finalize(output)
    changed = review.read_jsonl(output / "reviewer_b.jsonl")
    changed[0]["notes"] = "Edited after comparison"
    review.write_jsonl(output / "reviewer_b.jsonl", changed)
    with pytest.raises(ValueError, match="changed after comparison"):
        review.finalize(output)
    review.write_jsonl(output / "reviewer_b.jsonl", b)
    adjudication = review.read_jsonl(output / "adjudication.jsonl")
    adjudication[0]["final_verdict"] = "supported"
    adjudication[0]["rationale"] = "The source says so explicitly."
    review.write_jsonl(output / "adjudication.jsonl", adjudication)
    final = review.finalize(output)
    assert final["dev"] == 6
    assert final["holdout"] == 6
    assert final["not_factual"] == 0
    with pytest.raises(FileExistsError):
        review.finalize(output)


def test_review_rejects_fabricated_excerpt(tmp_path: Path) -> None:
    path = tmp_path / "bad.jsonl"
    review.write_jsonl(path, [{
        "case_id": "a", "verdict": "supported", "evidence_excerpt": "not in source",
        "evidence": [{"snippet": "A different sentence."}],
    }])
    with pytest.raises(ValueError, match="copied exactly"):
        review.indexed_reviews(path)
