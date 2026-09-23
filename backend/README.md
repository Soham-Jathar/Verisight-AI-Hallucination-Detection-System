# Backend

FastAPI service for the VeriSight hallucination detection frontend.

## Setup

```bash
cd backend
python -m venv .venv

# Windows PowerShell
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt
cp .env.example .env
```

## Run

```bash
uvicorn app.main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`.

Interactive docs: `http://localhost:8000/docs`

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (`{"status":"ok"}`) |
| GET | `/` | Service banner |
| POST | `/api/analyze` | Run web verification pipeline |
| POST | `/api/documents` | Upload a PDF and extract selectable/OCR text as temporary evidence |
| POST | `/api/images` | Upload a PNG, JPEG, or WEBP image and extract visible text with OCR |

### `POST /api/analyze`

Request:

```json
{
  "question": "Who created Python and when was it first released?",
  "mode": "web"
}
```

Response (frontend uses `message`; additional fields are ready for later UI work):

```json
{
  "question": "...",
  "mode": "web",
  "stage": "complete",
  "message": "Analyzed 2 claim(s) using 3 evidence source(s)...",
  "answer": "...",
  "evidence": [{ "title": "...", "url": "...", "snippet": "..." }],
  "claims": [{ "claim": "...", "status": "supported", "confidence": 0.42, "rationale": "..." }],
  "reliability_score": 0.61
}
```

Supported modes:

- `web` — retrieves and filters web evidence, then verifies generated factual claims
- `document` — verifies against uploaded PDF evidence
- `image` — verifies against OCR text extracted from an uploaded image
- `hybrid` — combines uploaded-document and web evidence

## Environment variables

See `.env.example`. All are optional for local development.

| Variable | Default | Purpose |
|----------|---------|---------|
| `GEMINI_API_KEY` | unset | Enables Gemini answer generation |
| `GEMINI_MODEL` | configured model | Gemini model name |
| `GROQ_API_KEY` | unset | Enables Groq answer generation |
| `GROQ_MODEL` | configured model | Groq model name |
| `TAVILY_API_KEY` | unset | Enables Tavily web retrieval |
| `TESSERACT_CMD` | unset | Optional path to `tesseract.exe`; required only if it is not on PATH for image/scanned-PDF OCR |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated frontend origins |
| `REQUEST_TIMEOUT_SECONDS` | `30` | External HTTP timeout |

Without an LLM provider key, the API returns a clear provider-configuration error rather than inventing an answer.

## Image and scanned-PDF evidence

PDF text is always read with `pypdf`. When Tesseract OCR is available, VeriSight additionally extracts readable text from embedded PDF images and scanned pages. `POST /api/images` uses the same OCR path for PNG, JPEG, and WEBP uploads. The extracted text flows through the existing evidence retrieval and claim-verification pipeline.

This is text/OCR evidence, not general computer-vision verification: diagrams, charts, and photographs without readable text are not yet interpreted.

## Tests

```bash
pytest
```

## Frontend integration

The React app expects the backend at `http://localhost:8000` by default. Override with `VITE_API_URL` in the frontend `.env` if needed. For production, use the public HTTPS backend URL and set the matching frontend URL in `CORS_ORIGINS`.

Run both services locally:

```bash
# terminal 1
cd backend && uvicorn app.main:app --reload --port 8000

# terminal 2
cd frontend && npm run dev
```
