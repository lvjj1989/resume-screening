import os
import shutil
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent

# 上传与归档仍在 backend/data；数据库单独放在项目根 db/，避免与文件目录混在一起
DATA_DIR = BASE_DIR / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
ATTACHMENT_DIR = DATA_DIR / "attachments"
ARCHIVE_DIR = DATA_DIR / "历史人才库"

_db_env = os.environ.get("APP_DB_PATH", "").strip()
if _db_env:
    DB_PATH = Path(_db_env).expanduser().resolve()
else:
    DB_PATH = (ROOT_DIR / "db" / "app.db").resolve()

DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
ATTACHMENT_DIR.mkdir(parents=True, exist_ok=True)
ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

_legacy_db = DATA_DIR / "app.db"
if not DB_PATH.is_file() and _legacy_db.is_file():
    shutil.copy2(_legacy_db, DB_PATH)

DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
