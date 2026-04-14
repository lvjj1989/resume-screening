import mimetypes
import os
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote

from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import func, text
from sqlalchemy.orm import Session, joinedload

from database import ARCHIVE_DIR, ATTACHMENT_DIR, Base, DB_PATH, UPLOAD_DIR, engine, get_db
from models import Folder, Resume, ResumeAttachment

Base.metadata.create_all(bind=engine)


def _ensure_legacy_schema_compat() -> None:
    """向历史数据库补齐新字段，避免升级后接口报错。"""
    with engine.begin() as conn:
        cols = conn.execute(text("PRAGMA table_info(resumes)")).mappings().all()
        names = {c["name"] for c in cols}
        if "remark" not in names:
            conn.execute(text("ALTER TABLE resumes ADD COLUMN remark TEXT NOT NULL DEFAULT ''"))


_ensure_legacy_schema_compat()

JIANLI_PREFIX = "/jianli"

jianli_app = FastAPI(title="小熊简历筛选")

jianli_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
if STATIC_DIR.exists():
    jianli_app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


class FolderCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)


class AdminResumePatch(BaseModel):
    download_count: Optional[int] = Field(None, ge=0)


class ResumeRemarkPatch(BaseModel):
    remark: str = Field(default="", max_length=5000)


class AdminSqlBody(BaseModel):
    sql: str = Field(..., min_length=1, max_length=100_000)


_SQL_ATTACH_DETACH = re.compile(r"\b(attach|detach)\s+database\b", re.IGNORECASE)


def _sql_cell_json(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, bytes):
        n = len(v)
        return f"<bytes {n} B>" if n else "<bytes 0>"
    if isinstance(v, (int, float, str, bool)):
        return v
    return str(v)


def _to_sql_literal(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, datetime):
        s = v.isoformat(sep=" ", timespec="seconds")
        return "'" + s.replace("'", "''") + "'"
    if isinstance(v, (bytes, bytearray)):
        return "X'" + bytes(v).hex() + "'"
    s = str(v)
    return "'" + s.replace("'", "''") + "'"


def _folder_upload_dir(folder_id: int) -> Path:
    d = UPLOAD_DIR / str(folder_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _resume_attachment_dir(resume_id: int) -> Path:
    d = ATTACHMENT_DIR / str(resume_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _sanitize_filename(name: str, max_len: int = 120) -> str:
    base = Path(name).name.replace("\x00", "")
    base = re.sub(r'[/\\:*?"<>|]', "_", base).strip() or "resume"
    if len(base) > max_len:
        stem = Path(base).stem[: max_len - 20]
        suf = Path(base).suffix
        base = stem + suf
    return base


def _unique_archive_path(dest: Path) -> Path:
    if not dest.exists():
        return dest
    stem, suf = dest.stem, dest.suffix
    for i in range(1, 1000):
        c = dest.parent / f"{stem}_{i}{suf}"
        if not c.exists():
            return c
    return dest.parent / f"{stem}_{uuid.uuid4().hex[:8]}{suf}"


def _count_archive_files(root: Path) -> int:
    if not root.is_dir():
        return 0
    return sum(1 for p in root.rglob("*") if p.is_file())


def _safe_archive_target(rel: str) -> Path:
    rel = (rel or "").strip().replace("\\", "/")
    parts = [p for p in rel.split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        raise HTTPException(status_code=400, detail="非法路径")
    full = ARCHIVE_DIR.joinpath(*parts) if parts else ARCHIVE_DIR
    full = full.resolve()
    root = ARCHIVE_DIR.resolve()
    try:
        full.relative_to(root)
    except ValueError as e:
        raise HTTPException(status_code=400, detail="非法路径") from e
    return full


def _move_resume_into_archive_subdir(r: Resume, folder_id: int, dest_dir: Path) -> None:
    """将单份简历文件移入历史人才库下的子目录 dest_dir（用于删除文件夹时补迁磁盘文件）。"""
    src = UPLOAD_DIR / str(folder_id) / r.stored_filename
    if not src.is_file():
        return
    dest_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    safe_orig = _sanitize_filename(r.original_filename)
    ext = Path(r.stored_filename).suffix
    if ext and not safe_orig.lower().endswith(ext.lower()):
        name_body = f"{Path(safe_orig).stem}{ext}"
    else:
        name_body = safe_orig
    dest_file = dest_dir / f"{ts}_fid{folder_id}_rid{r.id}_{name_body}"
    dest_file = _unique_archive_path(dest_file)
    shutil.move(str(src), str(dest_file))


def _move_file_to_archive(src: Path, resume: Resume) -> None:
    """将已删除简历的物理文件移入历史人才库（不删库记录时由调用方保证路径仍存在）。"""
    if not src.is_file():
        return
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_orig = _sanitize_filename(resume.original_filename)
    ext = Path(resume.stored_filename).suffix
    if safe_orig.lower().endswith(ext.lower()):
        name_body = safe_orig
    else:
        name_body = f"{Path(safe_orig).stem}{ext}" if ext else safe_orig
    dest = ARCHIVE_DIR / f"{ts}_f{resume.folder_id}_r{resume.id}_{name_body}"
    dest = _unique_archive_path(dest)
    shutil.move(str(src), str(dest))


@jianli_app.get("/", response_class=HTMLResponse)
def index():
    index_path = STATIC_DIR / "index.html"
    if index_path.is_file():
        return index_path.read_text(encoding="utf-8")
    return HTMLResponse("<p>请放置 static/index.html</p>", status_code=404)


# --- Folders ---


@jianli_app.post("/api/folders")
def create_folder(payload: FolderCreate, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="文件夹名称不能为空")
    f = Folder(name=name)
    db.add(f)
    db.commit()
    db.refresh(f)
    return {"id": f.id, "name": f.name, "created_at": f.created_at.isoformat() if f.created_at else None}


@jianli_app.get("/api/folders")
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
                "is_archive": False,
            }
        )
    archive_n = _count_archive_files(ARCHIVE_DIR)
    archive_entry = {
        "is_archive": True,
        "id": None,
        "name": "历史人才库",
        "created_at": None,
        "resume_count": int(archive_n),
        "undownloaded_count": 0,
    }
    return result + [archive_entry]


@jianli_app.patch("/api/folders/{folder_id}")
def rename_folder(folder_id: int, payload: FolderCreate, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="文件夹名称不能为空")
    f = db.query(Folder).filter(Folder.id == folder_id).first()
    if not f:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    f.name = name
    db.add(f)
    db.commit()
    db.refresh(f)
    return {"id": f.id, "name": f.name, "created_at": f.created_at.isoformat() if f.created_at else None}


@jianli_app.get("/api/archive/list")
def archive_list(path: str = Query("", description="相对历史人才库的路径")):
    rel = unquote(path or "")
    base = _safe_archive_target(rel)
    if not base.is_dir():
        raise HTTPException(status_code=404, detail="目录不存在")
    root_resolved = ARCHIVE_DIR.resolve()
    items = []
    for child in sorted(base.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        try:
            rel_key = str(child.resolve().relative_to(root_resolved)).replace("\\", "/")
        except ValueError:
            continue
        st = child.stat()
        items.append(
            {
                "name": child.name,
                "rel_path": rel_key,
                "type": "dir" if child.is_dir() else "file",
                "size": None if child.is_dir() else st.st_size,
                "modified_at": datetime.fromtimestamp(st.st_mtime).isoformat(),
            }
        )
    return items


@jianli_app.get("/api/archive/download")
def archive_download(path: str = Query(..., description="相对历史人才库的路径")):
    full = _safe_archive_target(unquote(path))
    if not full.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    mt, _ = mimetypes.guess_type(full.name)
    return FileResponse(
        path=str(full),
        filename=full.name,
        media_type=mt or "application/octet-stream",
    )


@jianli_app.get("/api/archive/preview")
def archive_preview(path: str = Query(...)):
    full = _safe_archive_target(unquote(path))
    if not full.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    mt, _ = mimetypes.guess_type(full.name)
    return FileResponse(
        path=str(full),
        media_type=mt or "application/octet-stream",
        filename=full.name,
        headers={"Content-Disposition": "inline"},
    )


@jianli_app.delete("/api/folders/{folder_id}")
def delete_folder(folder_id: int, db: Session = Depends(get_db)):
    f = db.query(Folder).filter(Folder.id == folder_id).first()
    if not f:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    path = UPLOAD_DIR / str(folder_id)
    resumes = db.query(Resume).filter(Resume.folder_id == folder_id).all()
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe = _sanitize_filename(f.name, max_len=80)
    dest = _unique_archive_path(ARCHIVE_DIR / f"文件夹_{safe}_fid{folder_id}_{ts}")

    try:
        if path.is_dir():
            # 整夹移入历史人才库，目录内所有文件（含未入库的）一并保留
            shutil.move(str(path), str(dest))
        elif resumes:
            # 上传目录缺失时，按数据库记录逐份迁入同一归档子目录
            dest.mkdir(parents=True, exist_ok=True)
            for r in resumes:
                _move_resume_into_archive_subdir(r, folder_id, dest)
    except OSError as e:
        raise HTTPException(
            status_code=500,
            detail=f"将文件夹内简历移入历史人才库失败: {e}",
        ) from e

    db.delete(f)
    db.commit()
    return {"ok": True}


# --- Resumes ---


@jianli_app.get("/api/folders/{folder_id}/resumes")
def list_resumes(folder_id: int, db: Session = Depends(get_db)):
    f = db.query(Folder).filter(Folder.id == folder_id).first()
    if not f:
        raise HTTPException(status_code=404, detail="文件夹不存在")
    items = (
        db.query(Resume)
        .filter(Resume.folder_id == folder_id)
        .order_by(Resume.created_at.desc(), Resume.id.desc())
        .all()
    )
    counts = dict(
        db.query(ResumeAttachment.resume_id, func.count(ResumeAttachment.id))
        .filter(ResumeAttachment.resume_id.in_([r.id for r in items] or [-1]))
        .group_by(ResumeAttachment.resume_id)
        .all()
    )
    return [
        {
            "id": r.id,
            "original_filename": r.original_filename,
            "content_type": r.content_type,
            "download_count": r.download_count,
            "remark": r.remark or "",
            "attachment_count": int(counts.get(r.id, 0)),
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in items
    ]


@jianli_app.post("/api/folders/{folder_id}/resumes")
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
        "remark": r.remark or "",
        "attachment_count": 0,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@jianli_app.delete("/api/resumes/{resume_id}")
def delete_resume(resume_id: int, db: Session = Depends(get_db)):
    r = db.query(Resume).filter(Resume.id == resume_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="简历不存在")
    path = UPLOAD_DIR / str(r.folder_id) / r.stored_filename
    if path.is_file():
        try:
            _move_file_to_archive(path, r)
        except OSError as e:
            raise HTTPException(
                status_code=500,
                detail=f"移入历史人才库失败: {e}",
            ) from e
    att_dir = ATTACHMENT_DIR / str(r.id)
    if att_dir.is_dir():
        shutil.rmtree(att_dir, ignore_errors=True)
    db.delete(r)
    db.commit()
    return {"ok": True}


@jianli_app.patch("/api/resumes/{resume_id}/remark")
def update_resume_remark(resume_id: int, payload: ResumeRemarkPatch, db: Session = Depends(get_db)):
    r = db.query(Resume).filter(Resume.id == resume_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="简历不存在")
    r.remark = (payload.remark or "").strip()
    db.add(r)
    db.commit()
    db.refresh(r)
    return {"id": r.id, "remark": r.remark or ""}


@jianli_app.get("/api/resumes/{resume_id}/attachments")
def list_resume_attachments(resume_id: int, db: Session = Depends(get_db)):
    r = db.query(Resume).filter(Resume.id == resume_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="简历不存在")
    rows = (
        db.query(ResumeAttachment)
        .filter(ResumeAttachment.resume_id == resume_id)
        .order_by(ResumeAttachment.created_at.desc(), ResumeAttachment.id.desc())
        .all()
    )
    out = []
    for a in rows:
        p = ATTACHMENT_DIR / str(resume_id) / a.stored_filename
        size = p.stat().st_size if p.is_file() else 0
        out.append(
            {
                "id": a.id,
                "resume_id": a.resume_id,
                "original_filename": a.original_filename,
                "content_type": a.content_type,
                "size": int(size),
                "created_at": a.created_at.isoformat() if a.created_at else None,
            }
        )
    return out


@jianli_app.post("/api/resumes/{resume_id}/attachments")
async def upload_resume_attachment(
    resume_id: int,
    request: Request,
    db: Session = Depends(get_db),
):
    r = db.query(Resume).filter(Resume.id == resume_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="简历不存在")
    raw_name = request.headers.get("X-Filename") or ""
    orig = unquote(raw_name).strip() or "attachment"
    ext = Path(orig).suffix
    stored = f"{uuid.uuid4().hex}{ext}"
    dest_dir = _resume_attachment_dir(resume_id)
    dest_path = dest_dir / stored

    ct = request.headers.get("Content-Type")
    if not ct or ct == "application/octet-stream":
        guessed, _ = mimetypes.guess_type(orig)
        ct = guessed or "application/octet-stream"
    content = await request.body()
    if not content:
        raise HTTPException(status_code=400, detail="空文件")
    dest_path.write_bytes(content)

    a = ResumeAttachment(
        resume_id=resume_id,
        original_filename=orig,
        stored_filename=stored,
        content_type=ct,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return {
        "id": a.id,
        "resume_id": a.resume_id,
        "original_filename": a.original_filename,
        "content_type": a.content_type,
        "created_at": a.created_at.isoformat() if a.created_at else None,
    }


@jianli_app.delete("/api/attachments/{attachment_id}")
def delete_attachment(attachment_id: int, db: Session = Depends(get_db)):
    a = db.query(ResumeAttachment).filter(ResumeAttachment.id == attachment_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="附件不存在")
    p = ATTACHMENT_DIR / str(a.resume_id) / a.stored_filename
    if p.is_file():
        p.unlink()
    db.delete(a)
    db.commit()
    return {"ok": True}


@jianli_app.get("/api/attachments/{attachment_id}/download")
def download_attachment(attachment_id: int, db: Session = Depends(get_db)):
    a = db.query(ResumeAttachment).filter(ResumeAttachment.id == attachment_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="附件不存在")
    p = ATTACHMENT_DIR / str(a.resume_id) / a.stored_filename
    if not p.is_file():
        raise HTTPException(status_code=404, detail="文件已丢失")
    return FileResponse(
        path=str(p),
        filename=a.original_filename,
        media_type=a.content_type or "application/octet-stream",
    )

@jianli_app.get("/api/resumes/{resume_id}/download")
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


@jianli_app.get("/api/resumes/{resume_id}/preview")
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


# --- Admin（数据库管理页） ---


@jianli_app.get("/api/admin/overview")
def admin_overview(db: Session = Depends(get_db)):
    folders = db.query(Folder).order_by(Folder.id.desc()).all()
    resume_total = db.query(func.count(Resume.id)).scalar() or 0
    out = []
    for f in folders:
        n = (
            db.query(func.count(Resume.id)).filter(Resume.folder_id == f.id).scalar() or 0
        )
        out.append(
            {
                "id": f.id,
                "name": f.name,
                "created_at": f.created_at.isoformat() if f.created_at else None,
                "resume_count": int(n),
            }
        )
    return {
        "db_path": str(DB_PATH),
        "resume_total": int(resume_total),
        "folders": out,
    }


@jianli_app.get("/api/admin/resumes")
def admin_resumes(
    folder_id: Optional[int] = Query(None),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    if folder_id is not None:
        f = db.query(Folder).filter(Folder.id == folder_id).first()
        if not f:
            raise HTTPException(status_code=404, detail="文件夹不存在")
    q = db.query(Resume).options(joinedload(Resume.folder))
    if folder_id is not None:
        q = q.filter(Resume.folder_id == folder_id)
    total = q.count()
    rows = q.order_by(Resume.id.desc()).offset(offset).limit(limit).all()
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": [
            {
                "id": r.id,
                "folder_id": r.folder_id,
                "folder_name": r.folder.name if r.folder else "",
                "original_filename": r.original_filename,
                "stored_filename": r.stored_filename,
                "content_type": r.content_type,
                "download_count": r.download_count or 0,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


@jianli_app.patch("/api/admin/resumes/{resume_id}")
def admin_patch_resume(
    resume_id: int,
    payload: AdminResumePatch,
    db: Session = Depends(get_db),
):
    r = db.query(Resume).filter(Resume.id == resume_id).first()
    if not r:
        raise HTTPException(status_code=404, detail="简历不存在")
    if payload.download_count is not None:
        r.download_count = payload.download_count
        db.add(r)
        db.commit()
        db.refresh(r)
    return {
        "id": r.id,
        "folder_id": r.folder_id,
        "original_filename": r.original_filename,
        "download_count": r.download_count,
    }


@jianli_app.post("/api/admin/sql")
def admin_run_sql(body: AdminSqlBody):
    """执行单条 SQL（SELECT 返回行集；INSERT/UPDATE/DELETE 等会提交）。禁止 ATTACH/DETACH DATABASE。"""
    flag = os.environ.get("ADMIN_SQL_DISABLE", "").strip().lower()
    if flag in ("1", "true", "yes", "on"):
        raise HTTPException(status_code=403, detail="已关闭 SQL 执行（环境变量 ADMIN_SQL_DISABLE）")
    sql = body.sql.strip()
    if not sql:
        raise HTTPException(status_code=400, detail="SQL 为空")
    if _SQL_ATTACH_DETACH.search(sql):
        raise HTTPException(status_code=400, detail="禁止 ATTACH / DETACH DATABASE")
    try:
        with engine.begin() as conn:
            result = conn.execute(text(sql))
            if result.returns_rows:
                cols = list(result.keys())
                mappings = result.mappings().all()
                rows = [{c: _sql_cell_json(m[c]) for c in cols} for m in mappings]
                return {
                    "kind": "select",
                    "columns": cols,
                    "rows": rows,
                    "row_count": len(rows),
                }
            rc = result.rowcount
            return {
                "kind": "mutate",
                "rowcount": rc if rc is not None else -1,
            }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@jianli_app.get("/api/admin/init-sql")
def admin_init_sql():
    """导出当前库初始化 SQL：包含所有业务表 CREATE 与 INSERT。"""
    try:
        lines = [
            "-- Generated by /api/admin/init-sql",
            "PRAGMA foreign_keys = OFF;",
            "BEGIN TRANSACTION;",
            "",
        ]
        with engine.connect() as conn:
            tables = conn.execute(
                text(
                    """
                    SELECT name, sql
                    FROM sqlite_master
                    WHERE type='table' AND name NOT LIKE 'sqlite_%'
                    ORDER BY name
                    """
                )
            ).mappings().all()

            for t in tables:
                name = t["name"]
                create_sql = (t["sql"] or "").strip()
                if create_sql:
                    lines.append(f"-- table: {name}")
                    lines.append(create_sql + ";")
                    lines.append("")

            for t in tables:
                name = t["name"]
                rows = conn.execute(text(f'SELECT * FROM "{name}"')).mappings().all()
                if not rows:
                    continue
                cols = list(rows[0].keys())
                col_sql = ", ".join(f'"{c}"' for c in cols)
                lines.append(f"-- data: {name}")
                for r in rows:
                    val_sql = ", ".join(_to_sql_literal(r[c]) for c in cols)
                    lines.append(f'INSERT INTO "{name}" ({col_sql}) VALUES ({val_sql});')
                lines.append("")

        lines.append("COMMIT;")
        return {"sql": "\n".join(lines)}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@jianli_app.get("/admin", response_class=HTMLResponse)
@jianli_app.get("/admin/", response_class=HTMLResponse)
def admin_page():
    path = STATIC_DIR / "admin.html"
    if path.is_file():
        return path.read_text(encoding="utf-8")
    return HTMLResponse("<p>请放置 static/admin.html</p>", status_code=404)


app = FastAPI()
app.mount(JIANLI_PREFIX, jianli_app)


@app.get("/")
def root_redirect():
    return RedirectResponse(url=f"{JIANLI_PREFIX}/", status_code=302)
