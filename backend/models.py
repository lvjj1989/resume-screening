from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import relationship

from database import Base


class Folder(Base):
    __tablename__ = "folders"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(255), nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    resumes = relationship("Resume", back_populates="folder", cascade="all, delete-orphan")


class Resume(Base):
    __tablename__ = "resumes"

    id = Column(Integer, primary_key=True, index=True)
    folder_id = Column(Integer, ForeignKey("folders.id", ondelete="CASCADE"), nullable=False)
    original_filename = Column(String(512), nullable=False)
    stored_filename = Column(String(512), nullable=False)
    content_type = Column(String(128), nullable=True)
    download_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, server_default=func.now())

    folder = relationship("Folder", back_populates="resumes")
