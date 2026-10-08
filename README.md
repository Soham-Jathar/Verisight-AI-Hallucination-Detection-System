# 🔎 VeriSight

**Evidence-grounded AI hallucination detection for LLM-generated answers.**

VeriSight lets you ask a question, see an AI-generated answer, and inspect whether each factual claim is supported by web pages or an uploaded file. It presents the evidence, a clear verdict, and a correction when the available sources can justify one.

> A fluent answer is not necessarily a factual answer. VeriSight makes the checking step visible.

## 🧠 What it does

- Generates answers with **Gemini** or **Groq**, with an option to compare both when configured.
- Retrieves evidence from the web, an uploaded PDF, text extracted from an image, or a combination of web and uploaded content.
- Splits an answer into checkable claims and labels each one **Supported**, **Needs review**, or **Unsupported**.
- Shows focused evidence excerpts and source links beside the relevant claims.
- Displays an evidence-based reliability estimate and, when enabled, an uncertainty estimate from additional answer samples.
- Offers an evidence-grounded correction when a claim is unsupported and the retrieved sources support a replacement.
- Supports follow-up questions, voice input, and optional Supabase sign-in for saved conversations.

## ⚙️ How it works

![VeriSight end-to-end workflow](docs/verisight-complete-workflow-render.png)

1. The React frontend sends the question, recent conversation context, selected provider, evidence mode, and optional upload ID to FastAPI.
2. The backend retrieves relevant web or uploaded-file evidence and filters and ranks candidate passages.
3. Gemini or Groq produces a candidate answer using the question, context, and available evidence.
4. VeriSight extracts factual claims. MiniLM helps select relevant passages; a DeBERTa NLI model and targeted rules check whether each passage supports, contradicts, or does not establish a claim. Supported mathematical statements can use deterministic checks.
5. The frontend shows the answer, claim verdicts, citations, reliability, optional uncertainty, and any evidence-grounded correction.

Verification is independent of the model's confidence in its own answer. When evidence is missing or unclear, VeriSight should be read as **unable to verify**, not as proof that a claim is false.

### Claim verdicts

| Verdict | What it means |
| --- | --- |
| **Supported** | The selected evidence establishes the claim. |
| **Needs review** | The available evidence is incomplete, indirect, or conflicting. |
| **Unsupported** | The evidence contradicts the claim, or no usable source was found. Check the explanation before treating this as a factual contradiction. |

## ✨ Features

| Feature | How it helps |
| --- | --- |
| Web, PDF, image-text, and hybrid modes | Checks claims against the type of evidence relevant to the question. |
| Claim-level citations | Connects individual verdicts to focused source excerpts instead of attaching a generic source list to the whole answer. |
| Model comparison | Shows Gemini and Groq answers side by side when both API keys are configured. |
| Follow-up context | Sends recent conversation turns so short questions can refer to the previous topic. |
| Optional uncertainty | Uses additional answer samples to estimate how much generated answers vary. |
| Evidence-grounded correction | Offers a replacement only when the retrieved evidence can support it. |
| Saved conversations | Uses Supabase Auth, PostgreSQL, and Row-Level Security for signed-in chat history. |
| Verification feedback | Lets users mark a claim check as helpful or needing correction; feedback does not automatically retrain the verifier. |

## 🛠️ Tech stack

| Layer | Technologies |
| --- | --- |
| Frontend | React, Vite, custom CSS, Web Speech API |
| API | Python, FastAPI, Pydantic, Uvicorn, HTTPX |
| Answer generation | Google Gemini API, Groq API |
| Evidence retrieval | Tavily when configured, plus other web retrieval paths; PDF and OCR text extraction |
| Verification | `all-MiniLM-L6-v2` semantic ranking, `nli-deberta-v3-small` NLI, and deterministic rules |
| PDF and image text | pypdf, PyMuPDF, Pillow, pytesseract, Tesseract OCR |
| Authentication and storage | Supabase Auth, PostgreSQL, Row-Level Security |
| Evaluation | HaluEval-based datasets, curated pipeline replay cases, pytest, independent human-review workflow |

## 🚀 Run locally

These commands use **Windows PowerShell** and do not require activating a virtual environment, so they also work when PowerShell script execution is restricted.

### Prerequisites

- Python and Node.js/npm installed locally.
- At least one working **Gemini** or **Groq** API key for the public answer-generation controls.
- Optional: a Supabase project for sign-in and persistent chats; a Tavily key for an additional web-retrieval source; Tesseract for image or scanned-PDF OCR.

### 1. Clone and configure

```powershell
git clone https://github.com/Soham-Jathar/Verisight-AI-Hallucination-Detection-System.git
cd Verisight-AI-Hallucination-Detection-System

python -m venv backend\.venv
.\backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt

Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env
```

Edit `backend/.env` and set `GEMINI_API_KEY` and/or `GROQ_API_KEY`. Keep these keys on the backend. `TAVILY_API_KEY` and `TESSERACT_CMD` are optional. The frontend's `VITE_API_URL` defaults to `http://localhost:8000` in its example file.

If you are **not** using Supabase yet, leave `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` empty in `frontend/.env` rather than keeping the example placeholders. Guest chat will work without saved history.

### 2. Start the backend

In one PowerShell terminal, from the repository root:

```powershell
cd backend
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Check [http://localhost:8000/health](http://localhost:8000/health) or open the [API documentation](http://localhost:8000/docs).

### 3. Start the frontend

In a second PowerShell terminal, from the repository root:

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev
```

Open [http://localhost:5173](http://localhost:5173). The backend and frontend terminals must both remain running.

### Optional: enable saved chats and OCR

- To enable sign-in and persistent chat history, configure the two Supabase values in `frontend/.env` and run the [database schema](docs/supabase-schema.sql) in your Supabase SQL editor.
- To read text in images or scanned PDFs, install Tesseract OCR and set `TESSERACT_CMD` in `backend/.env` if the executable is not on `PATH`.

The first verified request may take longer while the local verification models are downloaded and loaded. See the [backend](backend/README.md) and [frontend](frontend/README.md) guides for component details.

## 📡 API at a glance

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Backend health check |
| `GET` | `/api/providers` | Available public answer providers |
| `POST` | `/api/analyze` | Generate and optionally verify an answer |
| `POST` | `/api/documents` | Upload a PDF for text-based evidence |
| `POST` | `/api/images` | Upload an image for OCR-based evidence |

For example, `POST /api/analyze` accepts a question with `provider: "gemini"` or `"groq"` and `mode: "web"`, `"document"`, `"image"`, or `"hybrid"`. Document, image, and hybrid modes require an uploaded file ID. The full request and response models are in [backend/app/schemas.py](backend/app/schemas.py).

## 🧪 Testing and evaluation

From the repository root:

```powershell
.\backend\.venv\Scripts\python.exe -m pytest backend\tests -q
.\backend\.venv\Scripts\python.exe evaluation\run_pipeline.py
```

The pytest suite checks API behavior and individual pipeline components. Pipeline replay uses **recorded** questions, answers, and candidate sources to test retrieval filtering, claim extraction, verdicts, citations, and correction behavior without spending provider or search API quota.

The separate [evaluation module](evaluation/README.md) measures the verifier on labelled examples and reports accuracy, precision, recall, F1, confusion matrices, and latency. Its curated replay cases are regression checks—not an unbiased estimate of live-web performance. The [independent review workflow](evaluation/annotation/README.md) explains how two reviewers can label a held-out pilot set before drawing broader conclusions.

## 📁 Project structure

```text
backend/       FastAPI routes, generation, retrieval, verification, and tests
frontend/      React chat UI, evidence views, authentication, and saved chats
evaluation/    benchmark runners, datasets, replay cases, and review tooling
docs/          workflow diagram and Supabase database schema
```

## ⚠️ Current scope

- A reliability percentage describes support from the **retrieved evidence**; it is not a guarantee of universal truth or a calibrated probability that every statement is correct.
- Missing evidence, a poor search result, or a source that does not cover the exact claim can leave a correct answer unverified. Source quality and live retrieval still require human judgment.
- Image support reads **text** with OCR. It does not yet interpret visual facts in photographs, charts, or diagrams without readable text.
- Uploaded-file text is kept temporarily in backend memory, so an upload ID will not survive a backend restart.
- Live use depends on the configured provider and search services, their availability, and their quotas. No hosted demo is promised by this README.

## 🤝 Contributing

Issues and pull requests are welcome, especially for reproducible retrieval failures, citation mismatches, and cases where evidence does not justify a verdict. Please include the question, answer, relevant source excerpt, and expected behavior, but **never include API keys or private documents**.

## 📄 License

Released under the [MIT License](LICENSE).
