from fastapi import APIRouter, Depends, File, UploadFile

from app.config import Settings, get_settings
from app.schemas import DocumentInfo
from app.services.documents import save_image

router = APIRouter(prefix="/api/images", tags=["images"])


@router.post("", response_model=DocumentInfo)
async def upload_image(
    file: UploadFile = File(...),
    settings: Settings = Depends(get_settings),
) -> DocumentInfo:
    """Extract visible image text with OCR and retain it as temporary evidence."""
    return await save_image(file, tesseract_cmd=settings.tesseract_cmd)
