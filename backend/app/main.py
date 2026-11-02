from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Optional
from uuid import UUID

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

load_dotenv()

VAULT_ROOT = Path(os.getenv("VAULT_ROOT", "./sample-vault")).expanduser()
APP_TOKEN = os.getenv("APP_TOKEN", "").strip()
MAX_NOTE_BYTES = int(os.getenv("MAX_NOTE_BYTES", "2000000"))
ALLOWED_ORIGINS = [
    item.strip()
    for item in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
    if item.strip()
]
DB_PATH = Path(os.getenv("WORKSPACE_DB", "./workspace-state.sqlite3")).resolve()

app = FastAPI(title="Markdown Workspace API", version="0.1.0")
_path_locks: dict[str, threading.Lock] = {}
_path_locks_guard = threading.Lock()

def lock_for(path: Path) -> threading.Lock:
    key = str(path.resolve(strict=False)).casefold()
    with _path_locks_guard:
        return _path_locks.setdefault(key, threading.Lock())

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "If-Match", "X-Mutation-Id"],
)


class SaveRequest(BaseModel):
    content: str
    base_etag: Optional[str] = None
    mutation_id: UUID


class CreateRequest(BaseModel):
    path: str = Field(min_length=1, max_length=240)
    content: str = ""


def require_auth(authorization: Optional[str] = Header(default=None)) -> None:
    if not APP_TOKEN:
        return
    expected = f"Bearer {APP_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


def ensure_root() -> Path:
    try:
        VAULT_ROOT.mkdir(parents=True, exist_ok=True)
        return VAULT_ROOT.resolve(strict=True)
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"Vault unavailable: {exc}") from exc


def safe_note_path(relative: str, must_exist: bool = False) -> Path:
    root = ensure_root()
    normalized = relative.replace("\\", "/")
    pure = PurePosixPath(normalized)
    if pure.is_absolute() or not pure.parts or any(part in ("", ".", "..") for part in pure.parts):
        raise HTTPException(status_code=400, detail="Invalid note path")
    if pure.suffix.lower() != ".md":
        raise HTTPException(status_code=400, detail="Only .md files are supported")
    candidate = root.joinpath(*pure.parts)
    # Resolve existing parents to prevent traversal through symlinks.
    parent = candidate.parent.resolve(strict=False)
    try:
        parent.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Path escapes Vault root")
    if candidate.exists() and candidate.is_symlink():
        raise HTTPException(status_code=400, detail="Symlink notes are not supported")
    if must_exist and not candidate.is_file():
        raise HTTPException(status_code=404, detail="Note not found")
    return candidate


def etag_for(content: bytes) -> str:
    return "sha256:" + hashlib.sha256(content).hexdigest()


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS mutations (mutation_id TEXT PRIMARY KEY, path TEXT NOT NULL, etag TEXT NOT NULL, saved_at TEXT NOT NULL)"
    )
    conn.commit()
    return conn


def mutation_result(mutation_id: str):
    with db() as conn:
        return conn.execute(
            "SELECT etag, saved_at FROM mutations WHERE mutation_id = ?",
            (mutation_id,),
        ).fetchone()


def remember_mutation(mutation_id: str, path: str, etag: str, saved_at: str):
    with db() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO mutations(mutation_id, path, etag, saved_at) VALUES (?, ?, ?, ?)",
            (mutation_id, path, etag, saved_at),
        )
        conn.commit()


def atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".mw-", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


@app.get("/api/health", dependencies=[Depends(require_auth)])
def health():
    try:
        root = ensure_root()
        probe = root / ".markdown-workspace-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return {"ok": True, "vault_available": True, "vault_root_configured": True}
    except Exception as exc:
        return JSONResponse(
            status_code=503,
            content={"ok": False, "vault_available": False, "error": str(exc)},
        )


@app.get("/api/tree", dependencies=[Depends(require_auth)])
def tree():
    root = ensure_root()
    items = []
    try:
        for path in root.rglob("*.md"):
            if any(part.startswith(".") for part in path.relative_to(root).parts):
                continue
            if path.is_symlink() or not path.is_file():
                continue
            rel = path.relative_to(root).as_posix()
            stat = path.stat()
            items.append(
                {
                    "path": rel,
                    "name": path.stem,
                    "modified_at": datetime.fromtimestamp(
                        stat.st_mtime, tz=timezone.utc
                    ).isoformat(),
                    "size": stat.st_size,
                }
            )
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"Vault read failed: {exc}") from exc
    items.sort(key=lambda item: item["path"].casefold())
    return {"items": items}


@app.get("/api/notes/{note_path:path}", dependencies=[Depends(require_auth)])
def get_note(note_path: str):
    path = safe_note_path(note_path, must_exist=True)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"Read failed: {exc}") from exc
    if len(raw) > MAX_NOTE_BYTES:
        raise HTTPException(status_code=413, detail="Note exceeds configured size limit")
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=415, detail="Note is not valid UTF-8") from exc
    return {
        "path": note_path,
        "content": content,
        "etag": etag_for(raw),
        "modified_at": datetime.fromtimestamp(
            path.stat().st_mtime, tz=timezone.utc
        ).isoformat(),
    }


@app.put("/api/notes/{note_path:path}", dependencies=[Depends(require_auth)])
def put_note(note_path: str, body: SaveRequest):
    path = safe_note_path(note_path, must_exist=True)
    mutation_id = str(body.mutation_id)

    previous = mutation_result(mutation_id)
    if previous:
        return {
            "ok": True,
            "duplicate": True,
            "etag": previous[0],
            "saved_at": previous[1],
            "mutation_id": mutation_id,
        }

    payload = body.content.encode("utf-8")
    if len(payload) > MAX_NOTE_BYTES:
        raise HTTPException(status_code=413, detail="Note exceeds configured size limit")

    with lock_for(path):
        try:
            current = path.read_bytes()
        except OSError as exc:
            raise HTTPException(status_code=503, detail=f"Read failed: {exc}") from exc

        current_etag = etag_for(current)
        if body.base_etag and body.base_etag != current_etag:
            try:
                server_content = current.decode("utf-8")
            except UnicodeDecodeError:
                server_content = None
            return JSONResponse(
                status_code=409,
                content={
                    "detail": "Conflict: note changed on the server",
                    "server_etag": current_etag,
                    "server_content": server_content,
                },
            )

        try:
            atomic_write(path, payload)
        except OSError as exc:
            raise HTTPException(status_code=503, detail=f"Write failed: {exc}") from exc

    saved_at = datetime.now(timezone.utc).isoformat()
    new_etag = etag_for(payload)
    remember_mutation(mutation_id, note_path, new_etag, saved_at)
    return {
        "ok": True,
        "duplicate": False,
        "etag": new_etag,
        "saved_at": saved_at,
        "mutation_id": mutation_id,
    }


@app.post("/api/notes", dependencies=[Depends(require_auth)], status_code=201)
def create_note(body: CreateRequest):
    path = safe_note_path(body.path)
    if path.exists():
        raise HTTPException(status_code=409, detail="Note already exists")
    payload = body.content.encode("utf-8")
    if len(payload) > MAX_NOTE_BYTES:
        raise HTTPException(status_code=413, detail="Note exceeds configured size limit")
    try:
        atomic_write(path, payload)
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"Write failed: {exc}") from exc
    return {"ok": True, "path": body.path, "etag": etag_for(payload)}


@app.get("/api/search", dependencies=[Depends(require_auth)])
def search(q: str = ""):
    query = q.strip().casefold()
    if not query:
        return {"items": []}
    root = ensure_root()
    results = []
    for path in root.rglob("*.md"):
        if path.is_symlink() or not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if any(part.startswith(".") for part in Path(rel).parts):
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if query in rel.casefold() or query in content.casefold():
            results.append({"path": rel, "name": path.stem})
        if len(results) >= 100:
            break
    return {"items": results}
