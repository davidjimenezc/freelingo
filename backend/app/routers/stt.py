import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile

from app.core.app_logger import get_logger
from app.core.deps import get_current_user
from app.core.limiter import limiter
from app.models.user import User
from app.schemas.tts_stt import STTResponse

router = APIRouter(prefix="/api", tags=["stt"])
logger = get_logger(__name__)


@router.post("/stt", response_model=STTResponse)
@limiter.limit("20/minute")
async def speech_to_text(
    request: Request,
    audio: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
) -> STTResponse:
    """Proxy STT request to Whisper service. Returns transcribed text."""
    stt_service = getattr(request.app.state, "stt_service", None)
    if stt_service is None:
        raise HTTPException(status_code=503, detail="STT service is not enabled")
    audio_bytes = await audio.read()
    content_type = audio.content_type or "application/octet-stream"
    logger.info(
        "[stt] upload filename=%r content_type=%r bytes=%d",
        audio.filename,
        content_type,
        len(audio_bytes),
    )
    if len(audio_bytes) < 1024:
        raise HTTPException(status_code=400, detail="Recording is empty or too short")
    if len(audio_bytes) > 50 * 1024 * 1024:  # 50 MB
        raise HTTPException(status_code=413, detail="Audio file too large (max 50 MB)")
    try:
        text = await stt_service.transcribe(
            audio_bytes,
            audio.filename or "audio.webm",
            mime_type=content_type,
        )
    except httpx.HTTPStatusError as e:
        logger.warning(
            "[stt] transcription backend rejected audio status=%s body=%r",
            e.response.status_code,
            e.response.text[:500],
        )
        raise HTTPException(
            status_code=422,
            detail="Audio could not be decoded. Please record again after speaking for at least one second.",
        ) from e
    return STTResponse(text=text)
