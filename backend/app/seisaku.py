"""制作ログ(スマホのアプリ「制作ログ」が NAS の 制作ログ/年/月/日付/記録のID/ に置く写真と log.json)を読む。読むだけ(書かない)。
メモとのつながりは、メモのプロパティ「制作ログ: 記録のID」に書く(main.py の tree が返す)。"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path, PurePosixPath

ROOT = Path(os.getenv("SEISAKU_ROOT")).expanduser() if os.getenv("SEISAKU_ROOT") else None
IMAGE = {".jpg", ".jpeg", ".png", ".webp", ".heic", ".gif"}
DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def logs(month: str) -> list[dict]:
    """その月の記録。古い形(日付フォルダに写真が直に置いてある)は、その日の1件にまとめる"""
    if ROOT is None or not ROOT.is_dir() or not re.fullmatch(r"\d{4}-\d{2}", month):
        return []
    folder = ROOT / month[:4] / month[5:]
    if not folder.is_dir():
        return []
    out = []
    for day_dir in sorted(folder.iterdir()):
        if not day_dir.is_dir() or not DAY.match(day_dir.name):
            continue
        loose = sorted(p for p in day_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE and not p.name.startswith("thumb_"))
        if loose:
            out.append({"id": f"legacy-{day_dir.name}", "date": day_dir.name, "title": "", "intention": "", "memo": "", "photos": [rel(p, thumb(p)) for p in loose], "created_at": 0})
        for log_dir in sorted(day_dir.iterdir()):
            f = log_dir / "log.json"
            if not log_dir.is_dir() or not f.is_file():
                continue
            try:
                d = json.loads(f.read_text("utf-8"))
            except (OSError, ValueError):
                continue
            if d.get("deleted"):
                continue
            photos = []
            for ph in d.get("photos", []):
                if ph.get("deleted"):
                    continue
                p = log_dir / ph.get("name", "")
                if p.is_file():
                    photos.append(rel(p, thumb(p)))
            out.append({"id": d.get("id") or log_dir.name, "date": d.get("date") or day_dir.name, "title": d.get("title") or "", "intention": d.get("intention") or "", "memo": d.get("memo") or "", "photos": photos, "created_at": d.get("createdAt") or 0})
    out.sort(key=lambda x: (x["date"], x["created_at"]))
    return out


def find(log_id: str) -> dict | None:
    """記録の ID から探す(メモの「制作ログ:」プロパティから写真を出すとき)"""
    if ROOT is None or not ROOT.is_dir():
        return None
    if log_id.startswith("legacy-") and DAY.match(log_id[7:]):
        return next((x for x in logs(log_id[7:14]) if x["id"] == log_id), None)
    if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", log_id):
        return None
    for f in ROOT.glob(f"*/*/*/{log_id}/log.json"):
        d = f.read_text("utf-8")
        date = json.loads(d).get("date") or f.parent.parent.name
        return next((x for x in logs(date[:7]) if x["id"] == log_id), None)
    return None


def thumb(p: Path) -> Path:
    t = p.with_name("thumb_" + p.name)
    return t if t.is_file() else p


def rel(p: Path, t: Path) -> dict:
    return {"full": p.relative_to(ROOT).as_posix(), "thumb": t.relative_to(ROOT).as_posix()}


def photo(path: str) -> Path:
    """写真のファイル(制作ログの中だけ。隠しファイル・外は出さない)"""
    if ROOT is None:
        raise FileNotFoundError
    pure = PurePosixPath(path.replace("\\", "/"))
    if pure.is_absolute() or any(p in ("", ".", "..") or p.startswith(".") for p in pure.parts) or pure.suffix.lower() not in IMAGE:
        raise FileNotFoundError
    p = ROOT.joinpath(*pure.parts)
    p.resolve(strict=True).relative_to(ROOT.resolve())
    if not p.is_file() or p.is_symlink():
        raise FileNotFoundError
    return p
