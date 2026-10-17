# VeriSight Frontend

React and Vite frontend for the VeriSight evidence-grounded AI reliability platform.

It provides the conversational interface for asking questions, uploading PDFs or text-containing images, selecting an LLM provider, viewing claim-level verification, opening highlighted evidence excerpts, comparing models, and managing saved conversations.

## User-facing capabilities

- Chat-style question and follow-up flow
- Web, PDF, image-text, and hybrid verification modes
- PDF upload, image OCR upload, and document-backed questioning
- Speech-to-text input where supported by the browser
- Gemini, Groq, and provider comparison controls
- Supported / needs-review / unsupported claim cards
- Reliability, confidence, uncertainty, evidence-quality, and source-agreement signals
- Claim-level evidence excerpts with matching terms highlighted
- Helpful / needs-correction feedback controls on each verification
- Supabase sign-up, sign-in, password recovery, and persistent chat history
- Rename and delete controls for saved signed-in conversations
- Conversation Insights for signed-in users, including question/answer pairs, recorded reliability and uncertainty, and printable charts

## Prerequisites

- Node.js 20 or later
- The FastAPI backend running locally or deployed
- Optional Supabase project values for sign-in and persistent history

## Configuration

Copy `.env.example` to `.env`:

```text
VITE_API_URL=http://localhost:8000
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
```

`VITE_API_URL` must point to the FastAPI backend. Do not put Gemini, Groq, Tavily, or other private provider keys in this frontend environment file.

## Run locally

```powershell
npm install
npm run dev
```

Vite is configured to use `http://localhost:5173` in normal local development.

To view insights, sign in, select the chat, and choose **View insights** (or **Insights** beside its history entry). Conversation Insights opens in a new tab; choose **Print / Save as PDF** there if you want a copy. Missing scores are labelled *Not measured*, not treated as zero. The insights use the selected chat data in the browser and do not make a new AI or search request.

## Build for deployment

```powershell
npm run build
```

The generated `dist/` folder is static output suitable for a host such as Render Static Sites. Before deployment, set `VITE_API_URL` to the public HTTPS URL of the deployed backend and configure the backend to allow the frontend origin through CORS.

## Related documentation

- [Project overview](../README.md)
- [Backend API documentation](../backend/README.md)
- [Evaluation methodology](../evaluation/README.md)
