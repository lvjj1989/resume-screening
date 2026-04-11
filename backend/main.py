import mimetypes
import shutil
import uuid
from pathlib import Path
from urllib.parse import unquote

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import Base, UPLOAD_DIR, engine, get_db
from models import Folder, Resume

Base.metadata.create_all(bind=engine)

app = FastAPI(title="小熊简历筛选")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class FolderCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)


def _folder_upload_dir(folder_id: int) -> Path:
    d = UPLOAD_DIR / str(folder_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


@app.get("/", response_class=HTMLResponse)
def index():
    index_path = STATIC_DIR / "index.html"
    if index_path.is_file():
        return index_path.read_text(encoding="utf-8")
    return HTMLResponse("<p>请放置 static/index.html</p>", status_code=404)


# --- Folders ---


@app.post("/api/folders")
def create_folder(payload: FolderCreate, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="文件夹名称不能为空")
    f = Folder(name=name)
    db.add(f)
    db.commit()
    db.refresh(f)
    return {"id": f.id, "name": f.name, "created_at": f.created_at.isoformat() if f.created_at else None}


@app.get("/api/folders")
def list_folders(db: Session = Depends(get_db)):
    rows = db.query(Folder).order_by(Folder.created_at.desc()).all()
    result = []
    for f in rows:
        total = (
            db.query(func.count(Resume.id)).filter(Resume.folder_id == f.id).scalar() or 0
        )
        undownloaded = (
            db.query(func.count(Resume.id))
            .filter(Resume.folder_id == f.id, Resume.download_count == 0)
            .scalar()
            or 0
        )
        result.append(
            {
                "id": f.id,
                "name": f.name,
                "created_at": f.created_at.isoformat() if f.created_at else None,
                "resume_count": int(total),
                "undownloaded_count": int(undownloaded),
            }
        )
    return result


@app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: int, db: Session = Depends(get_db)):
    f = db.query(Folder).filter(Folder.id == folder_id).first()
    if not f:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    path = UPLOAD_DIR / str(folder_id)
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    db.delete(f)
    db.commit()
    return {"ok": True}


# --- Resumes ---


@app.get("/api/folders/{folder_id}/resumes")
def list_resumes(folder_id: int, db: Session = Depends(get_db)):
    f = db.query(Folder).filter(Folder.id == folder_id).first()
    if not f:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    items = (
        db.query(Resume)
        .filter(Resume.folder_id == folder_id)
        .order_by(Resume.download_count.desc(), Resume.created_at.desc())
        .all()
    )
    return [
        {
            "id": r.id,
            "original_filename": r.original_filename,
            "content_type": r.content_type,
            "download_count": r.download_count,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in items
    ]


@app.post("/api/folders/{folder_id}/resumes")
async def upload_resume(
    folder_id: int,
    request: Request,
    db: Session = Depends(get_db),
):
    """请求体为原始文件字节；文件名通过 X-Filename（URI 编码）或 Content-Disposition 文件名传递。"""
    f = db.query(Folder).filter(Folder.id == folder_id).first()
    if not f:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    raw_name = request.headers.get("X-Filename") or ""
    orig = unquote(raw_name).strip() or "resume"
    ext = Path(orig).suffix
    stored = f"{uuid.uuid4().hex}{ext}"
    dest_dir = _folder_upload_dir(folder_id)
    dest_path = dest_dir / stored

    ct = request.headers.get("Content-Type")
    if not ct or ct == "application/octet-stream":
        guessed, _ = mimetypes.guess_type(orig)
        ct = guessed or "application/octet-stream"

    content = await request.body()
    if not content:
        raise HTTPException(status_code=400, detail="空文件")
    dest_path.write_bytes(content)

    r = Resume(
        folder_id=folder_id,
        original_filename=orig,
        stored_filename=stored,
        content_type=ct,
        download_count=0,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return {
        "id": r.id,
        "original_filename": r.original_filename,
        "content_type": r.content_type,
        "download_count": r.download_count,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@app.delete("/api/resumes/{resume_id}")
def delete_resume(resume_id: int, db: Session = Depends(get_db)):
    r = db.query(Resume).filter(Resume.id == resume_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="简历不存在")
    path = UPLOAD_DIR / str(r.folder_id) / r.stored_filename
    if path.is_file():
        path.unlink()
    db.delete(r)
    db.commit()
    return {"ok": True}


@app.get("/api/resumes/{resume_id}/download")
def download_resume(resume_id: int, db: Session = Depends(get_db)):
    r = db.query(Resume).filter(Resume.id == resume_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="简历不存在")
    path = UPLOAD_DIR / str(r.folder_id) / r.stored_filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件已丢失")

    r.download_count = (r.download_count or 0) + 1
    db.add(r)
    db.commit()

    return FileResponse(
        path=str(path),
        filename=r.original_filename,
        media_type=r.content_type or "application/octet-stream",
    )


@app.get("/api/resumes/{resume_id}/preview")
def preview_resume(resume_id: int, db: Session = Depends(get_db)):
    """内联预览：不增加下载次数。"""
    r = db.query(Resume).filter(Resume.id == resume_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="简历不存在")
    path = UPLOAD_DIR / str(r.folder_id) / r.stored_filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件已丢失")

    return FileResponse(
        path=str(path),
        media_type=r.content_type or "application/octet-stream",
        filename=r.original_filename,
        headers={"Content-Disposition": "inline"},
    )
