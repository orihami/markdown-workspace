from __future__ import annotations

import hashlib
import os
import shutil
import re
import sqlite3
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Optional
from uuid import UUID

from dotenv import load_dotenv

from . import ai, brain, kogi, seisaku
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
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
# 毎日の写し(kopi-omni-snapshot が作る ~/backup-omni/日付/)。ノートの「過去の版」に使う。読むだけ
SNAPSHOT_ROOT = Path(os.getenv("SNAPSHOT_ROOT")).expanduser() if os.getenv("SNAPSHOT_ROOT") else None
# 貼った画像の置き場所(Obsidian の attachmentFolderPath と同じにする)と、新しいメモの置き場所
ATTACH_DIR = os.getenv("ATTACH_DIR", "etc")
MEMO_DIR = os.getenv("MEMO_DIR", "めも")
MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif", ".avif", ".bmp", ".svg"}
FILE_EXT = IMAGE_EXT | {".pdf", ".mp4", ".mov", ".m4a", ".mp3", ".wav"}
# 「消す」= 整理待ちへ移す(NAS のきまり: 削除はしない。_整理待ち/<日付>/ に元のパスのまま移し、整理ログ.md に書く)
TRASH_ROOT = Path(os.getenv("TRASH_ROOT")).expanduser() if os.getenv("TRASH_ROOT") else None
VAULT_LABEL = os.getenv("VAULT_LABEL") or VAULT_ROOT.name
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
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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
    conn.execute(
        "CREATE TABLE IF NOT EXISTS favorites (path TEXT PRIMARY KEY, kind TEXT NOT NULL, added_at TEXT NOT NULL)"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS trash (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, moved_to TEXT NOT NULL, etag TEXT NOT NULL, moved_at TEXT NOT NULL, restored_at TEXT)"
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
        for rel, path in iter_notes(root):
            stat = path.stat()
            item = {
                "path": rel,
                "name": path.stem,
                "modified_at": datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc
                ).isoformat(),
                "size": stat.st_size,
            }
            # 並べ替え・タスクの表示に使うプロパティ(date・遂行日・完了)と、ホームに出す書き出し・タグ。ファイルは変えない
            text = note_text(rel, path)
            item.update(sort_props(text))
            if text is not None:
                item["excerpt"] = excerpt_of(text)
                item["tags"] = sorted(tags_of(text))[:6]
            items.append(item)
    except OSError as exc:
        raise HTTPException(status_code=503, detail=f"Vault read failed: {exc}") from exc
    items.sort(key=lambda item: item["path"].casefold())
    return {"items": items}


class OfflineRequest(BaseModel):
    known: dict[str, str] = Field(default_factory=dict)  # 端末が持っている ノート → ETag


@app.post("/api/offline", dependencies=[Depends(require_auth)])
def offline_copy(body: OfflineRequest):
    """端末に持たせる めも の写し(つながらないときも読めて書けるように)。端末と違うものだけ中身を返す"""
    root = ensure_root()
    folder = root / MEMO_DIR
    changed, seen = [], set()
    if folder.is_dir():
        try:
            for rel, path in iter_notes(folder):
                rel = f"{MEMO_DIR}/{rel}"
                try:
                    data = path.read_bytes()
                except OSError:
                    continue
                if len(data) > MAX_NOTE_BYTES:
                    continue
                seen.add(rel)
                etag = etag_for(data)
                if body.known.get(rel) == etag:
                    continue
                try:
                    changed.append({"path": rel, "etag": etag, "content": data.decode("utf-8")})
                except UnicodeDecodeError:
                    continue
        except OSError as exc:
            raise HTTPException(status_code=503, detail=f"Vault read failed: {exc}") from exc
    removed = [p for p in body.known if p.startswith(MEMO_DIR + "/") and p not in seen]
    return {"folder": MEMO_DIR, "changed": changed, "removed": removed}


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


# 中を見ないフォルダ(隠しフォルダ・Python の環境など)。HDD を毎回すみずみまで読まないよう、入る前に外す
SKIP_DIRS = {"venv", "node_modules", "__pycache__"}


def iter_notes(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS and not os.path.islink(os.path.join(dirpath, d)))
        for name in sorted(filenames):
            if not name.endswith(".md") or name.startswith("."):
                continue
            path = Path(dirpath) / name
            if path.is_symlink() or not path.is_file():
                continue
            yield path.relative_to(root).as_posix(), path


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
        m = re.match(r"^(date|遂行日|完了|くり返し|締切|制作ログ)\s*:\s*(.*)$", line)
        if not m:
            continue
        key, value = m.group(1), _scalar(m.group(2))
        if not value and i + 1 < len(fm) and fm[i + 1].startswith((" ", "\t")):
            value = _scalar(fm[i + 1])
        if key == "date":
            out["date"] = value or None
        elif key == "遂行日":
            out["task_day"] = value or None
        elif key == "くり返し":
            out["repeat"] = value or None
            continue
        elif key == "締切":
            out["deadline"] = value or None
            continue
        elif key == "制作ログ":
            out["seisaku"] = value or None
            continue
        else:
            out["done"] = value.lower() == "true"
    if "task_day" in out or "done" in out:
        out["task"] = True
    return out


def excerpt_of(text: str, limit: int = 110) -> str:
    """本文の書き出し(プロパティ・タグの行・見出しの記号・リンクの記号をのぞいた最初の文)"""
    _, body = split_frontmatter(text)
    out: list[str] = []
    fenced = False
    for line in body:
        t = line.strip()
        if FENCE_RE.match(t):
            fenced = not fenced
            continue
        if fenced or not t or re.fullmatch(r"(#[^\s#]+\s*)+", t) or t in ("---", "***"):
            continue
        t = re.sub(r"^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)", "", t)
        t = re.sub(r"!?\[\[([^\]|]+)(\|([^\]]+))?\]\]", lambda m: m.group(3) or m.group(1), t)
        t = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", t)
        t = re.sub(r"[*_`~]", "", t)
        if t:
            out.append(t)
        if sum(len(x) for x in out) >= limit:
            break
    joined = " ".join(out)
    return joined[:limit] + ("…" if len(joined) > limit else "")


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


# ---- 整理待ち(消す・戻す) ----

class TrashRequest(BaseModel):
    path: str = Field(min_length=1, max_length=400)
    base_etag: Optional[str] = None


_log_guard = threading.Lock()


def trash_root() -> Path:
    if TRASH_ROOT is None:
        raise HTTPException(status_code=503, detail="整理待ちの場所が設定されていません")
    try:
        root = TRASH_ROOT.resolve(strict=True)
    except OSError as exc:
        raise HTTPException(status_code=503, detail="整理待ちの場所が見つかりません(HDD が外れているかもしれません)") from exc
    return root


def move_verified(src: Path, dest: Path, expected: bytes) -> None:
    """同じディスクなら rename(一瞬で、途中で壊れない)。ちがうディスクならコピーして中身を確かめてから元を消す"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.rename(src, dest)
        return
    except OSError as exc:
        if exc.errno != 18:  # EXDEV(ちがうディスク)以外はそのまま失敗にする
            raise
    shutil.copy2(src, dest)
    if hashlib.sha256(dest.read_bytes()).digest() != hashlib.sha256(expected).digest():
        dest.unlink(missing_ok=True)
        raise OSError("コピーした中身が一致しません")
    src.unlink()


def append_log(line: str) -> None:
    """整理ログ.md に「元パス → 新パス」を書く(その日の見出しが最後になければ足す)"""
    log = trash_root() / "整理ログ.md"
    day = datetime.now().astimezone().strftime("%Y-%m-%d")
    header = f"## {day}（ko-pi、Markdown Workspace で整理待ちへ移したノート）"
    with _log_guard:
        text = log.read_text(encoding="utf-8") if log.exists() else "# 整理ログ\n\n「元パス → 新パス」。元に戻すときは右から左へ移動する。\n"
        headers = [l for l in text.splitlines() if l.startswith("## ")]
        add = ""
        if not headers or headers[-1] != header:
            add += ("" if text.endswith("\n") else "\n") + "\n" + header + "\n"
        with open(log, "a", encoding="utf-8") as f:
            f.write(add + line + "\n")
            f.flush()
            os.fsync(f.fileno())


@app.post("/api/trash", dependencies=[Depends(require_auth)])
def trash_note(body: TrashRequest):
    root = trash_root()
    path = safe_note_path(body.path, must_exist=True)
    vault = ensure_root()
    rel = path.relative_to(vault).as_posix()
    now = datetime.now().astimezone()
    with lock_for(path):
        raw = path.read_bytes()
        etag = etag_for(raw)
        # 開いたあとにほかの場所で書きかえられていたら止める(知らない内容を消さない)
        if body.base_etag and body.base_etag != etag:
            return JSONResponse(status_code=409, content={"detail": "ほかの場所でこのノートが更新されています。開き直してから消してください", "server_etag": etag})
        dest = root / now.strftime("%Y-%m-%d") / VAULT_LABEL / rel
        n = 1
        while dest.exists():
            dest = dest.with_name(f"{path.stem} ({now.strftime('%H%M%S')}-{n}){path.suffix}")
            n += 1
        try:
            move_verified(path, dest, raw)
        except OSError as exc:
            raise HTTPException(status_code=503, detail=f"移せませんでした: {exc}") from exc
    moved_to = dest.relative_to(root).as_posix()
    with db() as conn:
        cur = conn.execute("INSERT INTO trash(path, moved_to, etag, moved_at) VALUES (?, ?, ?, ?)", (rel, moved_to, etag, now.isoformat()))
        conn.commit()
        trash_id = cur.lastrowid
    shown = f"{root.name}/{moved_to}"
    try:
        append_log(f"- {now.strftime('%H:%M')} `{VAULT_LABEL}/{rel}` → `{shown}`")
    except OSError:
        pass  # ログが書けなくても移動は済んでいる(整理待ちの一覧と DB に残る)
    with _text_cache_guard:
        _text_cache.pop(rel, None)
    return {"ok": True, "id": trash_id, "path": rel, "moved_to": shown}


@app.get("/api/trash", dependencies=[Depends(require_auth)])
def list_trash():
    root = trash_root()
    with db() as conn:
        rows = conn.execute("SELECT id, path, moved_to, moved_at FROM trash WHERE restored_at IS NULL ORDER BY id DESC LIMIT 200").fetchall()
    return {"items": [
        {"id": r[0], "path": r[1], "name": Path(r[1]).stem, "moved_to": f"{root.name}/{r[2]}", "moved_at": r[3], "exists": (root / r[2]).is_file()}
        for r in rows
    ]}


@app.post("/api/trash/{trash_id}/restore", dependencies=[Depends(require_auth)])
def restore_note(trash_id: int):
    root = trash_root()
    with db() as conn:
        row = conn.execute("SELECT path, moved_to, restored_at FROM trash WHERE id = ?", (trash_id,)).fetchone()
    if not row or row[2]:
        raise HTTPException(status_code=404, detail="戻せるものが見つかりません")
    src = root / row[1]
    if not src.is_file():
        raise HTTPException(status_code=404, detail="整理待ちの中にファイルがありません(手で動かされたかもしれません)")
    target = safe_note_path(row[0])
    with lock_for(target):
        if target.exists():
            raise HTTPException(status_code=409, detail="元の場所に同じ名前のノートがあります")
        try:
            move_verified(src, target, src.read_bytes())
        except OSError as exc:
            raise HTTPException(status_code=503, detail=f"戻せませんでした: {exc}") from exc
    now = datetime.now().astimezone()
    with db() as conn:
        conn.execute("UPDATE trash SET restored_at = ? WHERE id = ?", (now.isoformat(), trash_id))
        conn.commit()
    try:
        append_log(f"- {now.strftime('%H:%M')} 戻した: `{root.name}/{row[1]}` → `{VAULT_LABEL}/{row[0]}`")
    except OSError:
        pass
    return {"ok": True, "path": row[0]}


# ---- 名前を変える(同じ Vault の中で移す。上書きはしない) ----

class RenameRequest(BaseModel):
    path: str = Field(min_length=1, max_length=400)
    new_path: str = Field(min_length=1, max_length=400)
    base_etag: Optional[str] = None


@app.post("/api/rename", dependencies=[Depends(require_auth)])
def rename_note(body: RenameRequest):
    src = safe_note_path(body.path, must_exist=True)
    dest = safe_note_path(body.new_path)
    vault = ensure_root()
    if src == dest:
        return {"ok": True, "path": body.path, "etag": etag_for(src.read_bytes())}
    first, second = sorted([src, dest], key=lambda p: str(p))
    with lock_for(first), lock_for(second):
        raw = src.read_bytes()
        etag = etag_for(raw)
        if body.base_etag and body.base_etag != etag:
            return JSONResponse(status_code=409, content={"detail": "ほかの場所でこのノートが更新されています", "server_etag": etag})
        # 大文字小文字だけのちがいは同じファイルとみなす(Windows から見たとき困らないように)
        if dest.exists() and not (dest.parent == src.parent and dest.name.casefold() == src.name.casefold()):
            raise HTTPException(status_code=409, detail="同じ名前のノートがもうあります")
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.rename(src, dest)
        except OSError as exc:
            raise HTTPException(status_code=503, detail=f"名前を変えられませんでした: {exc}") from exc
    old_rel = src.relative_to(vault).as_posix()
    new_rel = dest.relative_to(vault).as_posix()
    with _text_cache_guard:
        _text_cache.pop(old_rel, None)
    with db() as conn:
        conn.execute("UPDATE OR REPLACE favorites SET path = ? WHERE path = ?", (new_rel, old_rel))
        conn.commit()
    return {"ok": True, "path": new_rel, "etag": etag}


# ---- 画像・添付(貼る・見る) ----

def safe_vault_file(relative: str) -> Path:
    """Vault の中の .md 以外のファイル(画像など)。Vault の外・隠しフォルダ・シンボリックリンクは断る"""
    root = ensure_root()
    pure = PurePosixPath(relative.replace("\\", "/"))
    if pure.is_absolute() or not pure.parts or any(p in ("", ".", "..") or p.startswith(".") for p in pure.parts):
        raise HTTPException(status_code=400, detail="Invalid path")
    if pure.suffix.lower() not in FILE_EXT:
        raise HTTPException(status_code=400, detail="この種類のファイルは出せません")
    path = root.joinpath(*pure.parts)
    try:
        path.resolve(strict=True).relative_to(root)
    except (OSError, ValueError):
        raise HTTPException(status_code=404, detail="Not found")
    if path.is_symlink() or not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return path


_name_index: dict[str, str] = {}
_name_index_at = 0.0


def find_by_name(name: str) -> Optional[str]:
    """![[名前]] の名前から、Vault の中のファイルを探す(Obsidian と同じく、どのフォルダにあってもよい)"""
    global _name_index_at
    key = name.strip().casefold()
    now = datetime.now().timestamp()
    if key not in _name_index or now - _name_index_at > 60:
        root = ensure_root()
        idx: dict[str, str] = {}
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in SKIP_DIRS]
            for f in filenames:
                if Path(f).suffix.lower() in FILE_EXT:
                    idx.setdefault(f.casefold(), (Path(dirpath) / f).relative_to(root).as_posix())
        _name_index.clear()
        _name_index.update(idx)
        _name_index_at = now
    return _name_index.get(key)


@app.get("/api/files/{file_path:path}", dependencies=[Depends(require_auth)])
def get_file(file_path: str):
    return FileResponse(safe_vault_file(file_path), headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/embed", dependencies=[Depends(require_auth)])
def get_embed(name: str = "", src: str = "", note: str = ""):
    """画像を出す。name = ![[名前]] の名前。src = ![](道のり)(ノートのフォルダから、なければ Vault の一番上から、それでもなければ名前で)"""
    candidates: list[str] = []
    if src:
        folder = str(PurePosixPath(note).parent) if note else ""
        candidates += [str(PurePosixPath(folder) / src) if folder not in ("", ".") else src, src]
    for c in candidates:
        try:
            parts = []
            for part in PurePosixPath(c).parts:
                if part == "..":
                    if parts:
                        parts.pop()
                elif part not in ("", "."):
                    parts.append(part)
            return FileResponse(safe_vault_file("/".join(parts)), headers={"Cache-Control": "private, max-age=86400"})
        except HTTPException:
            continue
    found = find_by_name(name or PurePosixPath(src).name)
    if not found:
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(safe_vault_file(found), headers={"Cache-Control": "private, max-age=86400"})


def save_upload(data: bytes, filename: str) -> str:
    """貼った画像を Vault の etc/ に「Pasted image 日時.拡張子」で置く(Obsidian と同じ名前の付け方)。置いた名前を返す"""
    ext = Path(filename or "").suffix.lower() or ".png"
    if ext == ".jpeg":
        ext = ".jpg"
    if ext not in FILE_EXT:
        raise HTTPException(status_code=415, detail="この種類のファイルは貼れません")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="ファイルが大きすぎます")
    root = ensure_root()
    folder = root / ATTACH_DIR
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().astimezone().strftime("%Y%m%d%H%M%S")
    base = f"Pasted image {stamp}" if ext in IMAGE_EXT else (cleanup_name(Path(filename).stem) or f"file {stamp}")
    name = f"{base}{ext}"
    n = 1
    while (folder / name).exists():
        n += 1
        name = f"{base} {n}{ext}"
    with lock_for(folder / name):
        atomic_write(folder / name, data)
    _name_index[name.casefold()] = f"{ATTACH_DIR}/{name}"
    return name


@app.post("/api/attachments", dependencies=[Depends(require_auth)])
async def upload_attachment(file: UploadFile = File(...)):
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    name = save_upload(data, file.filename or "image.png")
    return {"ok": True, "name": name, "path": f"{ATTACH_DIR}/{name}", "markdown": f"![[{name}]]"}


# ---- 過去の版(毎日の写しから) ----

def snapshot_days() -> list[Path]:
    if SNAPSHOT_ROOT is None or not SNAPSHOT_ROOT.is_dir():
        return []
    return sorted((d for d in SNAPSHOT_ROOT.iterdir() if d.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", d.name)), key=lambda d: d.name, reverse=True)


@app.get("/api/versions/{note_path:path}", dependencies=[Depends(require_auth)])
def list_versions(note_path: str, day: str = ""):
    safe_note_path(note_path)  # パスの形だけ確かめる(今は無くても、過去の版は見られる)
    rel = PurePosixPath(note_path.replace("\\", "/"))
    if day:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise HTTPException(status_code=400, detail="Invalid day")
        for d in snapshot_days():
            if d.name == day:
                f = d.joinpath(*rel.parts)
                try:
                    f.resolve(strict=True).relative_to(d.resolve())
                    raw = f.read_bytes()
                except (OSError, ValueError):
                    break
                return {"day": day, "content": raw.decode("utf-8", errors="replace"), "etag": etag_for(raw)}
        raise HTTPException(status_code=404, detail="その日の版はありません")
    items = []
    last = None
    for d in snapshot_days():
        f = d.joinpath(*rel.parts)
        try:
            st = f.stat()
        except OSError:
            continue
        # 中身が同じ日(ハードリンクで同じファイル)はまとめる。新しい日を残す
        key = (st.st_ino, st.st_size)
        if key == last:
            continue
        last = key
        items.append({"day": d.name, "size": st.st_size, "modified_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat()})
    return {"items": items}


# ---- すぐメモを作る(キー1つのメモ窓・スマホの共有・ボットから) ----

def cleanup_name(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|#^\[\]]', " ", name)
    return re.sub(r"\s+", " ", name).strip().lstrip(".")[:80]


def name_from_body(text: str) -> str:
    for line in text.splitlines():
        t = line.strip()
        if not t or re.fullmatch(r"(#[^\s#]+\s*)+", t) or re.match(r"^(```|~~~|---)", t):
            continue
        t = re.sub(r"^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)", "", t)
        t = re.sub(r"!?\[\[([^\]|]+)(\|([^\]]+))?\]\]", lambda m: m.group(3) or m.group(1), t)
        t = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", t)
        t = re.sub(r"https?://\S+", "", t)
        t = cleanup_name(re.sub(r"[*_`~]", "", t))
        if not t:
            continue
        if len(t) > 24:
            m = re.search(r"[。．.!！?？、,，]", t[8:28])
            t = t[: 8 + m.start()] if m else t[:24]
        return t.rstrip("。．、,， ")
    return "メモ " + datetime.now().astimezone().strftime("%Y-%m-%d %H%M")


def create_memo(body: str, task: bool = False, title: str = "", day: str = "") -> str:
    """めも に date 付きのメモを作る(タスクなら 遂行日・完了・date)。名前はタイトルか本文の書き出し。作ったパスを返す"""
    root = ensure_root()
    today_s = datetime.now().astimezone().strftime("%Y-%m-%d")
    due = day if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day or "") else today_s
    head = f"---\n遂行日: {due}\n完了: false\ndate: '{today_s}'\n---\n" if task else f"---\ndate: '{today_s}'\n---\n"
    content = head + "\n" + body.strip() + "\n"
    base = cleanup_name(title) or name_from_body(body)
    folder = root / MEMO_DIR
    folder.mkdir(parents=True, exist_ok=True)
    for n in range(1, 50):
        name = base if n == 1 else f"{base} {n}"
        path = folder / f"{name}.md"
        with lock_for(path):
            if path.exists():
                continue
            payload = content.encode("utf-8")
            if len(payload) > MAX_NOTE_BYTES:
                raise HTTPException(status_code=413, detail="Note exceeds configured size limit")
            atomic_write(path, payload)
            return path.relative_to(root).as_posix()
    raise HTTPException(status_code=409, detail="同じ名前のノートが多すぎます")


class CaptureRequest(BaseModel):
    text: str = Field(min_length=1, max_length=200000)
    task: bool = False
    title: str = ""


@app.post("/api/capture", dependencies=[Depends(require_auth)])
def capture(body: CaptureRequest):
    return {"ok": True, "path": create_memo(body.text, body.task, body.title)}


@app.post("/share", include_in_schema=False)
async def share_target(title: str = Form(""), text: str = Form(""), url: str = Form(""), files: list[UploadFile] = File(default=[])):
    """スマホの「共有」メニューから(ホーム画面に追加したアプリ)。文・URL・写真をそのまま めも に残して、そのメモを開く"""
    lines: list[str] = []
    if text.strip():
        lines.append(text.strip())
    if url.strip() and url.strip() not in text:
        lines.append(url.strip())
    for f in files or []:
        data = await f.read(MAX_UPLOAD_BYTES + 1)
        if data:
            lines.append(f"![[{save_upload(data, f.filename or 'image.jpg')}]]")
    if not lines and not title.strip():
        return RedirectResponse("/", status_code=303)
    # タイトルが本文に含まれていなければ、タイトルを名前にする(記事を共有したとき)
    name_title = title.strip() if title.strip() and title.strip() not in text else ""
    path = create_memo("\n\n".join(lines) or title.strip(), title=name_title)
    return RedirectResponse("/#/" + "/".join(p for p in path.split("/")), status_code=303)


# ---- AI(雑記を整える など)。博士の Gemini の鍵を使い、月の上限を守る ----

WEEK_JA = "月火水木金土日"

TIDY_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING"},
        "tags": {"type": "ARRAY", "items": {"type": "STRING"}},
        "tasks": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {"text": {"type": "STRING"}, "due": {"type": "STRING", "nullable": True}}, "required": ["text"]}},
        "summary": {"type": "STRING"},
    },
    "required": ["title", "tags", "tasks", "summary"],
}

TIDY_SYSTEM = """あなたは大学生のメモ帳の整理係です。授業中のメモ、課題のメモ、課題の情報集め、下書き、思いつきの雑記が入ってきます。
書かれていないことを足さない。推測で事実を作らない。日本語で答える。"""


class TidyRequest(BaseModel):
    path: str = Field(min_length=1, max_length=400)
    content: Optional[str] = None  # 画面にある最新の内容(保存の前でも使えるように)


@app.get("/api/ai/status", dependencies=[Depends(require_auth)])
def ai_status():
    return {"enabled": ai.api_key() is not None, "spent_yen": round(ai.spent_yen(db), 2), "monthly_yen": ai.MONTHLY_YEN}


def tags_known() -> list[str]:
    return [i["tag"] for i in tags()["items"]]


@app.post("/api/ai/tidy", dependencies=[Depends(require_auth)])
def ai_tidy(body: TidyRequest):
    """雑記を整える提案: 名前・タグ(いまあるタグから)・課題/やることと期限・要約。ファイルは変えない(当てるのは画面で選んでから)"""
    path = safe_note_path(body.path, must_exist=body.content is None)
    text = body.content if body.content is not None else path.read_text(encoding="utf-8")
    try:
        return {**tidy_suggest(body.path, text), "spent_yen": round(ai.spent_yen(db), 2)}
    except ai.AIError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


def tidy_suggest(note_path: str, text: str) -> dict:
    now = datetime.now().astimezone()
    known = tags_known()[:150]
    current_name = Path(note_path).stem
    prompt = f"""今日は {now.strftime('%Y-%m-%d')}({WEEK_JA[now.weekday()]}曜)です。次のメモを整えるための提案を JSON で返してください。

- title: 中身がひと目で分かる名前。24文字くらいまで。いまの名前「{current_name}」がよければそのまま。ファイル名に使えない記号 \\ / : * ? " < > | # ^ [ ] は使わない
- tags: いまあるタグの中から合うものを最大4つ。どうしても合うものが無いときだけ、新しいタグを1つまで。# は付けない。いまあるタグ: {', '.join(known)}
- tasks: メモの中にある「やること・課題・提出物・締切・予定」だけ。無ければ空。text は短く(「〇〇のレポートを出す」など)。due は日付が書いてあれば YYYY-MM-DD(「来週水曜」なども今日から数える)、無ければ null
- summary: 1〜2文の要約

メモ:
<<<
{text[:12000]}
>>>"""
    out = ai.generate_json(prompt, TIDY_SCHEMA, db, system=TIDY_SYSTEM)
    title = cleanup_name(str(out.get("title") or ""))[:40]
    tag_list = []
    for t in out.get("tags") or []:
        t = re.sub(r"\s+", "", str(t)).lstrip("#")
        # clippings は Web Clipper が付ける印なので、AI は付けない
        if t and t != "clippings" and not t.replace("/", "").isdigit() and t not in tag_list:
            tag_list.append(t)
    tasks_out = []
    for t in out.get("tasks") or []:
        due = t.get("due") if isinstance(t, dict) else None
        if due and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(due)):
            due = None
        text_t = str(t.get("text") or "").strip() if isinstance(t, dict) else ""
        if text_t:
            tasks_out.append({"text": text_t[:80], "due": due})
    return {"title": title, "tags": tag_list[:5], "new_tags": [t for t in tag_list if t not in known], "tasks": tasks_out[:10], "summary": str(out.get("summary") or "").strip()[:300]}


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=500)


@app.post("/api/ai/ask", dependencies=[Depends(require_auth)])
def ai_ask(body: AskRequest):
    """「あのメモどこだっけ？」「あれってどんな内容だっけ？」: 自分のメモだけを根拠に答え、元のメモを出す"""
    try:
        return brain.ask(body.question.strip())
    except ai.AIError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc)) from exc


@app.get("/api/ai/index", dependencies=[Depends(require_auth)])
def ai_index_status():
    return brain.index_status()


@app.post("/api/ai/index", dependencies=[Depends(require_auth)])
def ai_index_update():
    threading.Thread(target=lambda: _safe(brain.update_index), daemon=True).start()
    return {"ok": True, "started": True}


def _safe(fn):
    try:
        return fn()
    except Exception as exc:
        print("うしろの作業でエラー:", exc)


class AutoSetting(BaseModel):
    enabled: bool


@app.get("/api/ai/auto", dependencies=[Depends(require_auth)])
def ai_auto():
    return {"enabled": brain.auto_enabled(), "items": brain.auto_log()}


@app.post("/api/ai/auto", dependencies=[Depends(require_auth)])
def ai_auto_set(body: AutoSetting):
    brain.kv_set("auto_enabled", "1" if body.enabled else "0")
    return ai_auto()


@app.post("/api/ai/auto/{log_id}/undo", dependencies=[Depends(require_auth)])
def ai_auto_undo(log_id: int):
    return brain.auto_undo(log_id)


# ---- 制作ログ(読むだけ)。メモとのつながりは、メモのプロパティ「制作ログ: 記録のID」 ----

@app.get("/api/seisaku", dependencies=[Depends(require_auth)])
def seisaku_month(month: str):
    return {"configured": seisaku.ROOT is not None and seisaku.ROOT.is_dir(), "items": seisaku.logs(month)}


@app.get("/api/seisaku/log/{log_id}", dependencies=[Depends(require_auth)])
def seisaku_log(log_id: str):
    found = seisaku.find(log_id)
    if not found:
        raise HTTPException(status_code=404, detail="制作ログが見つかりません")
    return found


@app.get("/api/seisaku/photo", dependencies=[Depends(require_auth)])
def seisaku_photo(path: str):
    try:
        return FileResponse(seisaku.photo(path), headers={"Cache-Control": "private, max-age=86400"})
    except (FileNotFoundError, OSError, ValueError):
        raise HTTPException(status_code=404, detail="Not found")


# ---- 講義棚の課題 → めも のタスク ----

class KogiMap(BaseModel):
    code: str = Field(min_length=1, max_length=100)
    course: str = Field(default="", max_length=100)


@app.get("/api/kogi", dependencies=[Depends(require_auth)])
def kogi_status():
    return kogi.status()


@app.post("/api/kogi/map", dependencies=[Depends(require_auth)])
def kogi_map(body: KogiMap):
    kogi.set_course(body.code, body.course.strip())
    return kogi.status()


@app.post("/api/kogi/sync", dependencies=[Depends(require_auth)])
def kogi_sync():
    return kogi.sync()


@app.on_event("startup")
def start_brain():
    # 見回り(自動で整える・索引)。テストでは動かさない(AI_BACKGROUND=0)
    if os.getenv("AI_BACKGROUND", "1") != "0":
        brain.start_background()


# ---- お気に入り(どの端末からも同じ。Vault のファイルや Obsidian の設定には書かない) ----

class FavoriteRequest(BaseModel):
    path: str = Field(min_length=1, max_length=400)
    kind: str = Field(pattern="^(note|folder)$")


def clean_rel(path: str) -> str:
    pure = PurePosixPath(path.replace("\\", "/").strip("/"))
    if pure.is_absolute() or not pure.parts or any(p in ("", ".", "..") for p in pure.parts):
        raise HTTPException(status_code=400, detail="Invalid path")
    return pure.as_posix()


@app.get("/api/favorites", dependencies=[Depends(require_auth)])
def list_favorites():
    with db() as conn:
        rows = conn.execute("SELECT path, kind FROM favorites ORDER BY added_at").fetchall()
    return {"items": [{"path": r[0], "kind": r[1]} for r in rows]}


@app.post("/api/favorites", dependencies=[Depends(require_auth)])
def add_favorite(body: FavoriteRequest):
    path = clean_rel(body.path)
    with db() as conn:
        conn.execute("INSERT OR IGNORE INTO favorites(path, kind, added_at) VALUES (?, ?, ?)", (path, body.kind, datetime.now(timezone.utc).isoformat()))
        conn.commit()
    return list_favorites()


@app.delete("/api/favorites", dependencies=[Depends(require_auth)])
def remove_favorite(path: str):
    with db() as conn:
        conn.execute("DELETE FROM favorites WHERE path = ?", (clean_rel(path),))
        conn.commit()
    return list_favorites()


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
