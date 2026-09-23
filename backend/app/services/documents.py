from __future__ import annotations

import io
import re
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, UploadFile, status
from pypdf import PdfReader

from app.schemas import DocumentInfo, EvidenceSource

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_DOCUMENT_CHARACTERS = 100_000
DOCUMENT_CHUNK_WORDS = 220
DOCUMENT_CHUNK_OVERLAP_WORDS = 40
MAX_OCR_IMAGES_PER_PDF = 20
MAX_OCR_IMAGE_BYTES = MAX_FILE_BYTES
IMAGE_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}
DOCUMENT_QUERY_STOP_WORDS = {
    "about", "available", "does", "for", "from", "gate", "have", "how",
    "list", "name", "only", "options", "paper", "papers", "the", "there",
    "these", "what", "which", "with",
}
_documents: dict[str, "StoredDocument"] = {}


@dataclass
class StoredDocument:
    info: DocumentInfo
    text: str


class OCRUnavailable(RuntimeError):
    """Raised only when OCR-dependent input cannot be processed locally."""


def _configure_ocr(tesseract_cmd: str | None = None):
    """Load the optional OCR dependencies and validate the native executable."""
    try:
        import pytesseract
        from PIL import Image
    except ImportError as exc:
        raise OCRUnavailable(
            "OCR packages are not installed. Run pip install -r backend/requirements.txt and retry."
        ) from exc

    if tesseract_cmd:
        pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
    try:
        pytesseract.get_tesseract_version()
    except Exception as exc:
        raise OCRUnavailable(
            "OCR needs the Tesseract application. Install Tesseract, add it to PATH, or set TESSERACT_CMD in backend/.env."
        ) from exc
    return pytesseract, Image


def _ocr_image_bytes(content: bytes, *, tesseract_cmd: str | None = None) -> str:
    """Extract readable text from one image without retaining the original file."""
    pytesseract, Image = _configure_ocr(tesseract_cmd)
    try:
        with Image.open(io.BytesIO(content)) as image:
            image.load()
            text = pytesseract.image_to_string(image)
    except OCRUnavailable:
        raise
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This image could not be read.") from exc
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _ocr_embedded_pdf_images(content: bytes, *, tesseract_cmd: str | None = None) -> str:
    """Read text embedded in scanned pages, screenshots, and PDF figures.

    The page's selectable text is still extracted with pypdf. This separate
    pass contributes only text recovered from actual image objects, preventing
    a text PDF from being needlessly OCRed page by page.
    """
    try:
        import fitz
    except ImportError as exc:
        raise OCRUnavailable(
            "PDF image extraction packages are not installed. Run pip install -r backend/requirements.txt and retry."
        ) from exc

    # Validate once before opening every image. This also gives a useful error
    # for image-only/scanned PDFs rather than silently returning no evidence.
    _configure_ocr(tesseract_cmd)
    recovered: list[str] = []
    seen_xrefs: set[int] = set()
    try:
        pdf = fitz.open(stream=content, filetype="pdf")
        for page in pdf:
            for image in page.get_images(full=True):
                if len(seen_xrefs) >= MAX_OCR_IMAGES_PER_PDF:
                    break
                xref = image[0]
                if xref in seen_xrefs:
                    continue
                seen_xrefs.add(xref)
                extracted = pdf.extract_image(xref)
                image_bytes = extracted.get("image", b"")
                if not image_bytes or len(image_bytes) > MAX_OCR_IMAGE_BYTES:
                    continue
                text = _ocr_image_bytes(image_bytes, tesseract_cmd=tesseract_cmd)
                if text:
                    recovered.append(text)
            if len(seen_xrefs) >= MAX_OCR_IMAGES_PER_PDF:
                break
    except OCRUnavailable:
        raise
    except Exception:
        # An unreadable embedded image must not discard selectable PDF text.
        return ""
    finally:
        if "pdf" in locals():
            pdf.close()
    return "\n\n".join(recovered)


def _document_chunks(text: str) -> list[str]:
    """Split a document into overlapping excerpts for local retrieval."""
    words = text.split()
    if len(words) <= DOCUMENT_CHUNK_WORDS:
        return [text]

    step = DOCUMENT_CHUNK_WORDS - DOCUMENT_CHUNK_OVERLAP_WORDS
    return [
        " ".join(words[start:start + DOCUMENT_CHUNK_WORDS])
        for start in range(0, len(words), step)
        if words[start:start + DOCUMENT_CHUNK_WORDS]
    ]


async def save_pdf(upload: UploadFile, *, tesseract_cmd: str | None = None) -> DocumentInfo:
    if upload.content_type not in {"application/pdf", "application/x-pdf"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Please upload a PDF file.")

    content = await upload.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="PDF files must be 10 MB or smaller.")

    try:
        reader = PdfReader(io.BytesIO(content))
        selectable_text = "\n".join(page.extract_text() or "" for page in reader.pages).strip()
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This PDF could not be read.") from exc

    ocr_text = ""
    ocr_unavailable: OCRUnavailable | None = None
    try:
        ocr_text = _ocr_embedded_pdf_images(content, tesseract_cmd=tesseract_cmd)
    except OCRUnavailable as exc:
        ocr_unavailable = exc

    text = selectable_text
    if ocr_text:
        text = f"{selectable_text}\n\nText recovered from images in this PDF:\n{ocr_text}".strip()
    if not text:
        if ocr_unavailable:
            raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=str(ocr_unavailable)) from ocr_unavailable
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No readable text was found in this PDF image content.",
        )

    text = text[:MAX_DOCUMENT_CHARACTERS]
    document_id = uuid4().hex
    info = DocumentInfo(
        id=document_id,
        filename=upload.filename or "uploaded-document.pdf",
        pages=len(reader.pages),
        characters=len(text),
        kind="pdf",
        ocr_used=bool(ocr_text),
    )
    _documents[document_id] = StoredDocument(info=info, text=text)
    return info


async def save_image(upload: UploadFile, *, tesseract_cmd: str | None = None) -> DocumentInfo:
    """Store OCR text from an image as evidence for the existing verifier."""
    if upload.content_type not in IMAGE_CONTENT_TYPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Upload a PNG, JPEG, or WEBP image.")

    content = await upload.read(MAX_FILE_BYTES + 1)
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Image files must be 10 MB or smaller.")

    text = _ocr_image_bytes(content, tesseract_cmd=tesseract_cmd)
    if not text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No readable text was found in this image. Image evidence currently supports text/OCR, not general object or chart interpretation.",
        )

    text = text[:MAX_DOCUMENT_CHARACTERS]
    document_id = uuid4().hex
    filename = Path(upload.filename or "uploaded-image").name
    info = DocumentInfo(
        id=document_id,
        filename=filename,
        pages=1,
        characters=len(text),
        kind="image",
        ocr_used=True,
    )
    _documents[document_id] = StoredDocument(info=info, text=text)
    return info


def document_evidence(document_id: str, question: str, *, limit: int = 4) -> list[EvidenceSource]:
    document = _documents.get(document_id)
    if not document:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="The uploaded PDF is no longer available. Please upload it again.")

    # Exam and product documents frequently use two-character official codes
    # (for example CS, DA, AI, ML). Keeping them makes a lookup for a code
    # select the relevant table rather than a generic page containing "paper".
    terms = {
        term
        for term in re.findall(r"[a-zA-Z0-9]{2,}", question.lower())
        if term not in DOCUMENT_QUERY_STOP_WORDS
    }
    ranked = sorted(
        (
            (
                len(terms.intersection(set(re.findall(r"[a-zA-Z0-9]{3,}", chunk.lower())))),
                -index,
                chunk,
            )
            for index, chunk in enumerate(_document_chunks(document.text))
        ),
        reverse=True,
    )
    snippets = [chunk for _, _, chunk in ranked[:limit] if chunk] or [document.text[:1_500]]
    return [
        EvidenceSource(title=document.info.filename, url=f"document://{document.info.id}", snippet=snippet[:1_500])
        for snippet in snippets
    ]


def _secondary_paper_options_from_text(text: str, question: str) -> str | None:
    """Read an official primary→secondary code table without asking an LLM to infer rows."""
    requested_codes = re.findall(r"\b[A-Z]{2}\b", question.upper())
    if not requested_codes or not re.search(r"allowed two test paper combinations", text, re.IGNORECASE):
        return None

    table_match = re.search(
        r"Table 4: Allowed two test paper combinations.*?(?=\n\s*6\.4\b)",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not table_match:
        return None

    options_by_primary: dict[str, list[str]] = {}
    for line in table_match.group(0).splitlines():
        # pypdf preserves the two visual columns as two or more spaces.
        for cell in re.split(r"\s{2,}", line.strip()):
            match = re.fullmatch(
                r"([A-Z]{2})\s+([A-Z]{2}(?:\s*,\s*[A-Z]{2})*|-)",
                cell.strip(),
            )
            if not match:
                continue
            primary, raw_options = match.groups()
            options_by_primary[primary] = [] if raw_options == "-" else re.findall(r"[A-Z]{2}", raw_options)

    selected = [code for code in requested_codes if code in options_by_primary]
    if not selected:
        return None

    sections: list[str] = []
    for primary in dict.fromkeys(selected):
        options = options_by_primary[primary]
        if not options:
            sections.append(f"For {primary}, no secondary paper option is listed.")
            continue
        items = "\n".join(f"{index}. {option}" for index, option in enumerate(options, start=1))
        sections.append(f"For {primary}, the second paper options are:\n{items}")
    return "\n\n".join(sections)


def document_secondary_paper_options(document_id: str, question: str) -> str | None:
    """Return all requested official second-paper codes when the uploaded document contains Table 4."""
    document = _documents.get(document_id)
    if not document:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="The uploaded PDF is no longer available. Please upload it again.")
    return _secondary_paper_options_from_text(document.text, question)
