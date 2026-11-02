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
from fastapi.responses import FileResponse, JSONResponse
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
# ビルド済みのフロントエンド(frontend/dist)。あれば同じポートで配る
FRONTEND_DIST = Path(os.getenv("FRONTEND_DIST", str(Path(__file__).resolve().parents[2] / "frontend" / "dist")))

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
    # 仕様 6.4: base_etag は必須(無いと競合を検出できず、他の端末の変更を上書きしてしまう)
    base_etag: str = Field(min_length=1)
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
    # Vault のフォルダは作らない。NAS/HDD が外れているときにマウント先の空フォルダへ
    # 書き込んで「保存済み」にしてしまわないよう、無ければ失敗させる(仕様 8: NAS切断時に成功を偽装しない)
    try:
        root = VAULT_ROOT.resolve(strict=True)
    except OSError as exc:
        raise HTTPException(status_code=503, detail="Vault unavailable") from exc
    if not root.is_dir():
        raise HTTPException(status_code=503, detail="Vault unavailable")
    return root


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


def keep_newlines(original: bytes, payload: bytes) -> bytes:
    # 仕様 5.1: 既存ファイルの改行コードを保つ。ブラウザのエディタは LF で返すので、
    # 元が CRLF だけのファイルなら CRLF に戻す
    if b"\r\n" in original and b"\n" not in original.replace(b"\r\n", b""):
        return payload.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    return payload


def atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # mkstemp は 0600 で作るので、元のファイルの権限(なければ umask どおり)に合わせる
    try:
        mode = path.stat().st_mode & 0o777
    except FileNotFoundError:
        umask = os.umask(0)
        os.umask(umask)
        mode = 0o666 & ~umask
    fd, temp_name = tempfile.mkstemp(prefix=".mw-", suffix=".tmp", dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
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
        # Vault にファイルを作らずに書き込めるかを見る(Obsidian などに一時ファイルが見えないように)
        if not os.access(root, os.W_OK):
            raise OSError("Vault is not writable")
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
            item = {
                "path": rel,
                "name": path.stem,
                "modified_at": datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc
                ).isoformat(),
                "size": stat.st_size,
            }
            # 並べ替え・タスクの表示に使うプロパティ(date・遂行日・完了)。ファイルは変えない
            item.update(sort_props(note_text(rel, path)))
            items.append(item)
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
        if body.base_etag != current_etag:
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

        payload = keep_newlines(current, payload)
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
        # このサーバー内で同時に同名ノートを作っても上書きしないよう、ロックの中で確かめてから作る
        with lock_for(path):
            if path.exists():
                raise HTTPException(status_code=409, detail="Note already exists")
            atomic_write(path, payload)
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"Write failed: {exc}") from exc
    return {"ok": True, "path": body.path, "etag": etag_for(payload)}


# ---- 検索・タグ(ファイルを読み、更新時刻が変わるまで覚えておく) ----

_text_cache: dict[str, tuple[float, int, str]] = {}
_text_cache_guard = threading.Lock()
FENCE_RE = re.compile(r"^\s*(```|~~~)")
INLINE_TAG_RE = re.compile(r"(?<![\w/#&])#([^\s#\[\](){}.,!?;:'\"`<>|]+)")


def iter_notes(root: Path):
    for path in root.rglob("*.md"):
        rel = path.relative_to(root)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if path.is_symlink() or not path.is_file():
            continue
        yield rel.as_posix(), path


def note_text(rel: str, path: Path) -> Optional[str]:
    try:
        st = path.stat()
    except OSError:
        return None
    if st.st_size > MAX_NOTE_BYTES:
        return None
    with _text_cache_guard:
        hit = _text_cache.get(rel)
    if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
        return hit[2]
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    with _text_cache_guard:
        _text_cache[rel] = (st.st_mtime, st.st_size, text)
    return text


def split_frontmatter(text: str) -> tuple[list[str], list[str]]:
    lines = text.splitlines()
    if len(lines) > 1 and lines[0].strip() == "---":
        for i in range(1, min(len(lines), 200)):
            if lines[i].strip() in ("---", "..."):
                return lines[1:i], lines[i + 1:]
    return [], lines


def _scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    return value


def sort_props(text: Optional[str]) -> dict:
    """Frontmatter の date・遂行日・完了(めもの並べ替えと、タスクかどうかの判定に使う)"""
    if text is None:
        return {}
    fm, _ = split_frontmatter(text)
    out: dict = {"has_props": bool(fm) or text.lstrip("\ufeff").startswith("---")}
    for i, line in enumerate(fm):
        m = re.match(r"^(date|遂行日|完了)\s*:\s*(.*)$", line)
        if not m:
            continue
        key, value = m.group(1), _scalar(m.group(2))
        if not value and i + 1 < len(fm) and fm[i + 1].startswith((" ", "\t")):
            value = _scalar(fm[i + 1])
        if key == "date":
            out["date"] = value or None
        elif key == "遂行日":
            out["task_day"] = value or None
        else:
            out["done"] = value.lower() == "true"
    if "task_day" in out or "done" in out:
        out["task"] = True
    return out


def tags_of(text: str) -> set[str]:
    """Frontmatter の tags と本文の #タグ(コードの中はのぞく)。ファイルは変えない"""
    fm, body = split_frontmatter(text)
    tags: set[str] = set()
    in_tags = False
    for line in fm:
        m = re.match(r"^(tags?|aliases)\s*:\s*(.*)$", line)
        if m:
            in_tags = m.group(1) != "aliases"
            value = m.group(2).strip()
            if in_tags and value:
                value = value.strip("[]")
                tags.update(t.strip().strip("'\"").lstrip("#") for t in re.split(r"[,\s]+", value) if t.strip())
                in_tags = False
            continue
        if in_tags:
            item = re.match(r"^\s*-\s*(.+)$", line)
            if item:
                tags.add(item.group(1).strip().strip("'\"").lstrip("#"))
            elif line.strip():
                in_tags = False
    fenced = False
    for line in body:
        if FENCE_RE.match(line):
            fenced = not fenced
            continue
        if fenced:
            continue
        for m in INLINE_TAG_RE.finditer(re.sub(r"`[^`]*`", "", line)):
            tag = m.group(1)
            if not tag.replace("/", "").isdigit():
                tags.add(tag)
    tags.discard("")
    return tags


@app.get("/api/search", dependencies=[Depends(require_auth)])
def search(q: str = "", tag: str = "", limit: int = 50):
    """名前・本文を探す。名前で当たったものを先に。本文で当たったものは前後の文を付ける。
    tag を付けると、そのタグ(Frontmatter または本文の #タグ)を持つノートだけ"""
    root = ensure_root()
    if tag.strip():
        want = tag.strip().lstrip("#").casefold()
        hits = []
        for rel, path in iter_notes(root):
            text = note_text(rel, path)
            if text is not None and any(t.casefold() == want or t.casefold().startswith(want + "/") for t in tags_of(text)):
                hits.append({"path": rel, "name": path.stem, "snippet": None})
        hits.sort(key=lambda i: i["path"].casefold())
        return {"items": hits[: max(1, min(limit, 500))]}
    query = q.strip().casefold()
    if not query:
        return {"items": []}
    by_name, by_body = [], []
    for rel, path in iter_notes(root):
        text = note_text(rel, path)
        name_hit = query in rel.casefold()
        snippet = None
        if text is not None:
            pos = text.casefold().find(query)
            if pos >= 0:
                start = max(0, pos - 40)
                snippet = text[start:pos + len(query) + 60].replace("\n", " ").strip()
        if name_hit:
            by_name.append({"path": rel, "name": path.stem, "snippet": snippet})
        elif snippet is not None:
            by_body.append({"path": rel, "name": path.stem, "snippet": snippet})
    items = (by_name + by_body)[: max(1, min(limit, 200))]
    return {"items": items}


@app.get("/api/tags", dependencies=[Depends(require_auth)])
def tags():
    root = ensure_root()
    counts: dict[str, int] = {}
    for rel, path in iter_notes(root):
        text = note_text(rel, path)
        if text is None:
            continue
        for tag in tags_of(text):
            counts[tag] = counts.get(tag, 0) + 1
    items = sorted(({"tag": t, "count": c} for t, c in counts.items()), key=lambda x: (-x["count"], x["tag"].casefold()))
    return {"items": items}


# ---- フロントエンド(ビルド済み)を同じポートで配る ----

@app.get("/{asset_path:path}", include_in_schema=False)
def frontend(asset_path: str):
    if asset_path.startswith("api/") or not FRONTEND_DIST.is_dir():
        raise HTTPException(status_code=404, detail="Not found")
    dist = FRONTEND_DIST.resolve()
    target = (dist / asset_path).resolve()
    try:
        target.relative_to(dist)
    except ValueError:
        raise HTTPException(status_code=404, detail="Not found")
    if asset_path and target.is_file():
        # 名前に版の入ったファイル(assets/)は長く覚えさせ、それ以外(sw.js など)は毎回確かめさせる
        cache = "public, max-age=31536000, immutable" if asset_path.startswith("assets/") else "no-cache"
        return FileResponse(target, headers={"Cache-Control": cache})
    if "." in PurePosixPath(asset_path).name:
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})
