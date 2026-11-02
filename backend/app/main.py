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
