import json

import pytest

from evaluation.run_pipeline import diagnose, load_cases, summarize_replay_results


def test_pipeline_replay_dataset_has_unique_labelled_cases() -> None:
    from evaluation.run_pipeline import DEFAULT_DATASET

    cases = load_cases(DEFAULT_DATASET)

    assert len(cases) == 20
    assert len({case["id"] for case in cases}) == len(cases)
    assert all(case.get("answer") for case in cases)


def test_load_cases_rejects_duplicate_ids(tmp_path) -> None:
    path = tmp_path / "duplicate.jsonl"
    case = {"id": "same", "question": "What happened?", "answer": "Nothing."}
    path.write_text("\n".join((json.dumps(case), json.dumps(case))), encoding="utf-8")

    with pytest.raises(ValueError, match="Duplicate pipeline case id"):
        load_cases(path)


def test_diagnose_flags_spurious_claims_and_missing_reliability() -> None:
    case = {"expected_claims": [], "expect_no_claims": True, "expect_reliability": True}
    response = {"claims": [{"claim": "A claim.", "status": "supported", "citations": []}], "correction": None, "reliability_score": None}

    assert diagnose(case, response, []) == ["spurious_claim", "reliability_display_error"]


def test_replay_summary_groups_failures_by_slice() -> None:
    results = [
        {"slice": "web", "passed": True, "failure_stages": []},
        {"slice": "web", "passed": False, "failure_stages": ["verdict_error"]},
        {"slice": "math", "passed": True, "failure_stages": []},
    ]

    assert summarize_replay_results(results) == {
        "cases": 3,
        "passed": 2,
        "failure_stages": {"verdict_error": 1},
        "by_slice": {
            "web": {"cases": 2, "passed": 1, "failure_stages": {"verdict_error": 1}},
            "math": {"cases": 1, "passed": 1, "failure_stages": {}},
        },
    }
