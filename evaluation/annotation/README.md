# Independent answer review

This is a **pilot human-labelled benchmark**, not an automatic relabelling of
HaluEval. It checks VeriSight's answer-level verdicts against two independent
readers of the same question, response, and supplied evidence. It does **not**
measure whether live web search found the right page, whether the LLM chose a
good answer, whether citations point to the right excerpt, or whether a
correction is helpful. Review live traces separately for those questions.

## 1. Prepare the blinded pack

From the project root, after obtaining the official HaluEval files described
in `evaluation/README.md`:

```powershell
.\backend\.venv\Scripts\python.exe evaluation\annotation\review.py prepare
```

The default pack has 10 source groups per task (QA, dialogue, summarization),
two answers per group: **60 answer cases**. Three source groups per task are
reserved for a held-out set before anyone labels the answers. Source groups,
not individual answers, define the split. The default selection is from a
separate source range starting at index 9000 and excludes any case IDs already
present in converted local HaluEval datasets. The seed makes selection
reproducible. Neither reviewer file exposes HaluEval's original
`right_answer`/`hallucinated_answer` designation, its expected status, the
source index, or the dev/hold-out split.

The generated `evaluation/annotation/work/` folder is ignored by Git because
it contains benchmark text and human annotations. It is intentionally not
overwritten by rerunning `prepare`. Give `reviewer_a.jsonl` and
`reviewer_b.jsonl` to different team members; each person should work alone
without reading the other file or looking up HaluEval's reference answer.

## 2. Label every response against the supplied evidence

Edit only the three empty fields in each JSONL record: `verdict`,
`evidence_excerpt`, and `notes`. Keep every other field and all case IDs
unchanged. One line must remain one valid JSON object. Judge the **entire
answer**, not just its first sentence:

| Verdict | Use when |
| --- | --- |
| `supported` | The evidence establishes **every factual claim** in the answer. Minor rewording is fine, but do not infer missing dates, names, quantities, or causal links. |
| `unsupported` | At least one factual claim is **contradicted** by the evidence. Quote the passage showing the conflicting fact. |
| `uncertain` | No clear contradiction, but at least one factual claim is not established, or the evidence is too vague, incomplete, or ambiguous. Missing evidence is *not* a contradiction. |
| `not_factual` | No externally checkable factual claim is present (for example, a greeting or preference). Do not force a factual verdict. |

For `supported` and `unsupported`, `evidence_excerpt` must be an exact,
contiguous copy from one evidence `snippet`; the script checks this. For
`uncertain` and `not_factual`, leave it empty unless a particular excerpt helps
explain your decision. Use `notes` for ambiguity, multi-claim answers, or why
you chose `uncertain`. The original benchmark design includes one intentionally
bad answer per group; **do not assume** that answer is necessarily contradicted
by the supplied passage under this stricter three-way rubric.

Examples:

- Evidence says “The launch occurred in 1997.” Answer says “The launch
  occurred in 1997.” → `supported`.
- Evidence says “The launch occurred in 1997.” Answer says “The launch
  occurred in 2001.” → `unsupported`.
- Evidence says only “The launch was successful.” Answer says “The launch
  occurred in 1997.” → `uncertain`.
- Answer says “Thanks, I can help.” → `not_factual`.

For dialogue, read `conversation_history` to resolve pronouns, but factual
support must still come from `evidence`. For summarization, compare the answer
to the supplied source excerpt. If it was truncated and the needed passage is
missing, use `uncertain`, not `unsupported`.

## 3. Compare and adjudicate

After **both** reviewers complete every row:

```powershell
.\backend\.venv\Scripts\python.exe evaluation\annotation\review.py compare
```

`comparison.json` reports exact agreement and Cohen's kappa. These measure
reviewer consistency, **not model accuracy**. `adjudication.jsonl` contains
only disagreements. A third reviewer or joint evidence review must fill
`final_verdict` and `rationale` for each. The script never silently uses a
benchmark label or automatically chooses between the reviewers. It also
refuses to overwrite an existing adjudication file. It records checksums for
both reviewer files, so changes after comparison cannot silently alter the
frozen set. If a review needs correcting, preserve the first comparison and
adjudication for the audit trail, then use a fresh work directory.

## 4. Freeze labels, then evaluate

```powershell
.\backend\.venv\Scripts\python.exe evaluation\annotation\review.py finalize
.\backend\.venv\Scripts\python.exe evaluation\run.py --dataset evaluation\annotation\work\human_review_dev.jsonl
.\backend\.venv\Scripts\python.exe evaluation\run.py --dataset evaluation\annotation\work\human_review_holdout.jsonl
```

`finalize` requires an adjudication for every disagreement and writes the
frozen factual dev and hold-out sets without overwriting earlier results.
Non-factual answers go to `human_review_not_factual.jsonl` and are excluded
from the three-class score; report their count separately. Do not tune
thresholds, prompts, or rules using the hold-out rows. The final report should
state the sample size, class distribution, reviewer agreement, number of
adjudications, exclusions, and that this is supplied-evidence answer-level
evaluation. With only 60 pilot cases, avoid broad accuracy claims.
