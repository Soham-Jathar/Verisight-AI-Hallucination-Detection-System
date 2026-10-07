"""Prepare and reconcile independent, blinded HaluEval answer reviews.

This tool never uses HaluEval's answer labels as reviewer labels. The generated
work directory is ignored by Git because it contains third-party source text.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import random
import sys
from typing import Any

EVALUATION = Path(__file__).resolve().parents[1]
ROOT = EVALUATION.parent
TASKS = ("qa", "dialogue", "summarization")
VERDICTS = {"supported", "unsupported", "uncertain", "not_factual"}

sys.path.insert(0, str(EVALUATION))
from import_halueval import build_cases, load_samples  # noqa: E402


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in records),
        encoding="utf-8",
    )


def opaque_id(seed: int, value: str) -> str:
    return hashlib.sha256(f"{seed}:{value}".encode()).hexdigest()[:16]


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def existing_benchmark_ids() -> set[str]:
    used: set[str] = set()
    for path in (EVALUATION / "datasets").glob("halueval_*.jsonl"):
        for row in read_jsonl(path):
            used.add(row["id"])
    return used


def prepare(
    vendor: Path,
    output: Path,
    seed: int,
    offset: int,
    groups_per_task: int,
    heldout_groups: int,
) -> dict[str, Any]:
    if groups_per_task < 2 or not 0 < heldout_groups < groups_per_task:
        raise ValueError("Use at least two groups per task and reserve fewer held-out groups than the total.")
    if offset < 0:
        raise ValueError("The source offset must be non-negative.")
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"Review directory is not empty: {output}")

    used = existing_benchmark_ids()
    rng = random.Random(seed)
    review_cases: list[dict[str, Any]] = []
    manifest_cases: list[dict[str, str]] = []
    for task in TASKS:
        source_path = vendor / f"{task}_data.json"
        samples = load_samples(source_path)
        candidates = list(range(offset, len(samples)))
        rng.shuffle(candidates)
        selected: list[tuple[int, list[dict[str, Any]]]] = []
        for index in candidates:
            try:
                pair = build_cases(samples, task, 1, index)
            except ValueError:
                continue
            if any(row["id"] in used for row in pair):
                continue
            selected.append((index, pair))
            if len(selected) == groups_per_task:
                break
        if len(selected) != groups_per_task:
            raise ValueError(f"Only {len(selected)} fresh {task} source groups were available after offset {offset}.")

        for position, (index, pair) in enumerate(selected):
            split = "holdout" if position < heldout_groups else "dev"
            group_id = opaque_id(seed, f"{task}:{index}")
            for original in pair:
                case_id = opaque_id(seed, original["id"])
                review = {
                    "case_id": case_id,
                    "category": original["category"],
                    "question": original["question"],
                    "answer": original["answer"],
                    "evidence": original["evidence"],
                    "verdict": "",
                    "evidence_excerpt": "",
                    "notes": "",
                }
                if original.get("conversation_history"):
                    review["conversation_history"] = original["conversation_history"]
                review_cases.append(review)
                manifest_cases.append({
                    "case_id": case_id,
                    "group_id": group_id,
                    "split": split,
                    "category": original["category"],
                })

    rng.shuffle(review_cases)
    output.mkdir(parents=True, exist_ok=True)
    write_jsonl(output / "reviewer_a.jsonl", review_cases)
    write_jsonl(output / "reviewer_b.jsonl", review_cases)
    manifest = {
        "seed": seed,
        "offset": offset,
        "groups_per_task": groups_per_task,
        "heldout_groups_per_task": heldout_groups,
        "source": "HaluEval official task files; original answer labels removed",
        "cases": manifest_cases,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return {"cases": len(review_cases), "source_groups": len(manifest_cases) // 2, "output": str(output)}


def indexed_reviews(path: Path) -> dict[str, dict[str, Any]]:
    records = read_jsonl(path)
    indexed = {row["case_id"]: row for row in records}
    if len(indexed) != len(records):
        raise ValueError(f"Duplicate case_id in {path}")
    for row in records:
        verdict = row.get("verdict", "")
        if verdict not in VERDICTS:
            raise ValueError(f"Missing or invalid verdict for {row['case_id']} in {path}: {verdict!r}")
        excerpt = row.get("evidence_excerpt", "").strip()
        if verdict in {"supported", "unsupported"}:
            if not excerpt:
                raise ValueError(f"An evidence excerpt is required for {row['case_id']} in {path}")
            if not any(excerpt in source["snippet"] for source in row["evidence"]):
                raise ValueError(f"The evidence excerpt must be copied exactly from the source for {row['case_id']}")
    return indexed


def review_pair(output: Path) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, Any]]:
    manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    expected = {row["case_id"] for row in manifest["cases"]}
    a = indexed_reviews(output / "reviewer_a.jsonl")
    b = indexed_reviews(output / "reviewer_b.jsonl")
    if set(a) != expected or set(b) != expected:
        raise ValueError("Reviewer files must contain exactly the cases in the manifest.")
    for case_id in expected:
        for field in ("question", "answer", "evidence", "category"):
            if a[case_id][field] != b[case_id][field]:
                raise ValueError(f"The reviewers received different {field} for {case_id}.")
    return a, b, manifest


def compare(output: Path) -> dict[str, Any]:
    a, b, manifest = review_pair(output)
    ids = [item["case_id"] for item in manifest["cases"]]
    agreements = sum(a[case_id]["verdict"] == b[case_id]["verdict"] for case_id in ids)
    counts_a = Counter(a[case_id]["verdict"] for case_id in ids)
    counts_b = Counter(b[case_id]["verdict"] for case_id in ids)
    observed = agreements / len(ids)
    expected = sum(counts_a[label] * counts_b[label] for label in VERDICTS) / len(ids) ** 2
    kappa = (observed - expected) / (1 - expected) if expected < 1 else 1.0
    disagreements = [{
        "case_id": case_id,
        "question": a[case_id]["question"],
        "answer": a[case_id]["answer"],
        "evidence": a[case_id]["evidence"],
        "reviewer_a_verdict": a[case_id]["verdict"],
        "reviewer_b_verdict": b[case_id]["verdict"],
        "final_verdict": "",
        "rationale": "",
    } for case_id in ids if a[case_id]["verdict"] != b[case_id]["verdict"]]
    summary = {
        "cases": len(ids),
        "agreements": agreements,
        "disagreements": len(disagreements),
        "agreement_rate": round(observed, 4),
        "cohens_kappa": round(kappa, 4),
        "reviewer_a_counts": dict(counts_a),
        "reviewer_b_counts": dict(counts_b),
        "reviewer_a_sha256": file_digest(output / "reviewer_a.jsonl"),
        "reviewer_b_sha256": file_digest(output / "reviewer_b.jsonl"),
    }
    if (output / "adjudication.jsonl").exists():
        raise FileExistsError("Adjudication file already exists; compare will not overwrite your work.")
    write_jsonl(output / "adjudication.jsonl", disagreements)
    (output / "comparison.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


def finalize(output: Path) -> dict[str, Any]:
    a, b, manifest = review_pair(output)
    if not (output / "comparison.json").exists():
        raise ValueError("Run compare before finalizing.")
    comparison = json.loads((output / "comparison.json").read_text(encoding="utf-8"))
    for reviewer in ("a", "b"):
        path = output / f"reviewer_{reviewer}.jsonl"
        if file_digest(path) != comparison[f"reviewer_{reviewer}_sha256"]:
            raise ValueError(f"{path.name} changed after comparison; review the changes and compare again.")
    adjudications = read_jsonl(output / "adjudication.jsonl")
    adjudicated = {row["case_id"]: row for row in adjudications}
    if len(adjudicated) != len(adjudications):
        raise ValueError("Duplicate adjudication case_id.")
    disagreements = {case_id for case_id in a if a[case_id]["verdict"] != b[case_id]["verdict"]}
    if set(adjudicated) != disagreements:
        raise ValueError("Adjudication must contain exactly the reviewer disagreements.")
    for row in adjudicated.values():
        if row.get("final_verdict") not in VERDICTS or not row.get("rationale", "").strip():
            raise ValueError(f"Complete final_verdict and rationale for {row['case_id']}.")

    files = {
        "dev": output / "human_review_dev.jsonl",
        "holdout": output / "human_review_holdout.jsonl",
        "not_factual": output / "human_review_not_factual.jsonl",
        "summary": output / "finalization.json",
    }
    if any(path.exists() for path in files.values()):
        raise FileExistsError("A finalized output already exists; do not silently overwrite frozen labels.")
    rows: dict[str, list[dict[str, Any]]] = {key: [] for key in ("dev", "holdout", "not_factual")}
    for entry in manifest["cases"]:
        case_id = entry["case_id"]
        verdict = a[case_id]["verdict"] if case_id not in disagreements else adjudicated[case_id]["final_verdict"]
        record = {
            "id": case_id,
            "category": entry["category"],
            "evaluation_level": "answer",
            "question": a[case_id]["question"],
            "answer": a[case_id]["answer"],
            "evidence": a[case_id]["evidence"],
            "expected_status": verdict,
        }
        if a[case_id].get("conversation_history"):
            record["conversation_history"] = a[case_id]["conversation_history"]
        rows["not_factual" if verdict == "not_factual" else entry["split"]].append(record)
    for key in ("dev", "holdout", "not_factual"):
        write_jsonl(files[key], rows[key])
    summary = {"dev": len(rows["dev"]), "holdout": len(rows["holdout"]), "not_factual": len(rows["not_factual"]), "source_groups": len({row["group_id"] for row in manifest["cases"]})}
    files["summary"].write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare")
    prep.add_argument("--vendor", type=Path, default=EVALUATION / "vendor" / "HaluEval" / "data")
    prep.add_argument("--output", type=Path, default=EVALUATION / "annotation" / "work")
    prep.add_argument("--seed", type=int, default=20261007)
    prep.add_argument("--offset", type=int, default=9000)
    prep.add_argument("--groups-per-task", type=int, default=10)
    prep.add_argument("--heldout-groups", type=int, default=3)
    for command in ("compare", "finalize"):
        sub.add_parser(command).add_argument("--output", type=Path, default=EVALUATION / "annotation" / "work")
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare(args.vendor, args.output, args.seed, args.offset, args.groups_per_task, args.heldout_groups)
    elif args.command == "compare":
        result = compare(args.output)
    else:
        result = finalize(args.output)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
