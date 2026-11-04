"""講義棚(kogi-shelf)の課題を、めも のタスクにする。講義棚のファイルは読むだけ(書きもどさない)。
- 講義棚が Moodle のカレンダーから取った課題(と手で足した課題)を、締切の日を遂行日にしたタスクとして作る
- 講義棚で締切が動けば遂行日を合わせ、講義棚で済みにすれば完了にする(プロパティの値だけを書きかえる)
- Moodle の授業の番号(2026_99F2130 など)は、画面で選んだ授業名に結びつけて覚える(このアプリの SQLite)"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEADLINES = Path(os.getenv("KOGI_DEADLINES")).expanduser() if os.getenv("KOGI_DEADLINES") else None
SETTINGS = Path(os.getenv("KOGI_SETTINGS")).expanduser() if os.getenv("KOGI_SETTINGS") else None
JST = timezone(timedelta(hours=9))
WEEK = "月火水木金土日"
KEEP_PAST_DAYS = 1  # 締切がこれより前に過ぎた課題は作らない(もう出したかもしれないので)
CODE = re.compile(r"^\d{4}_[0-9A-Z]+$")  # Moodle の授業の番号(2026_99F2130 など)


def m():
    from . import main
    return main


def setup(conn) -> None:
    conn.execute("CREATE TABLE IF NOT EXISTS kogi_tasks (uid TEXT PRIMARY KEY, path TEXT, start INTEGER)")
    conn.execute("CREATE TABLE IF NOT EXISTS kogi_map (code TEXT PRIMARY KEY, course TEXT)")


def events() -> list[dict]:
    if DEADLINES is None or not DEADLINES.is_file():
        return []
    try:
        return list(json.loads(DEADLINES.read_text("utf-8")).get("events", {}).values())
    except (OSError, ValueError):
        return []


def term_courses() -> list[str]:
    if SETTINGS is None or not SETTINGS.is_file():
        return []
    try:
        terms = json.loads(SETTINGS.read_text("utf-8")).get("term_courses", {})
    except (OSError, ValueError):
        return []
    out: list[str] = []
    for key in sorted(terms, reverse=True):  # 新しい学期から
        for c in terms[key]:
            if c not in out:
                out.append(c)
    return out


def course_map() -> dict[str, str]:
    with m().db() as conn:
        setup(conn)
        return {r[0]: r[1] for r in conn.execute("SELECT code, course FROM kogi_map")}


def set_course(code: str, course: str) -> None:
    with m().db() as conn:
        setup(conn)
        if course:
            conn.execute("INSERT OR REPLACE INTO kogi_map VALUES (?, ?)", (code, course))
        else:
            conn.execute("DELETE FROM kogi_map WHERE code = ?", (code,))
        conn.commit()


def title_of(summary: str) -> str:
    """「提出：§27の章末問題(上にあるレポート用紙…)」の提出期限 → §27の章末問題"""
    t = summary.strip()
    mm = re.search(r"「(.+)」", t)
    if mm:
        t = mm.group(1)
    t = re.sub(r"の(提出)?期限$|の締め?切り?$", "", t)
    t = re.sub(r"^(提出|課題|レポート)\s*[:：]\s*", "", t)
    t = re.sub(r"[(（][^()（）]*[)）]", "", t).strip()
    return m().cleanup_name(t)[:40] or "課題"


def course_of(e: dict, cmap: dict[str, str]) -> str:
    return (e.get("course") or cmap.get(e.get("category") or "") or "").strip()


def when(e: dict) -> datetime:
    return datetime.fromtimestamp(int(e["start"]) / 1000, tz=JST)


def note_text(e: dict, course: str, today: str) -> str:
    d = when(e)
    head = [
        "---",
        f"遂行日: {d.strftime('%Y-%m-%d')}",
        "完了: false",
        f"date: '{today}'",
        f"締切: '{d.strftime('%Y-%m-%d %H:%M')}'",
        f"講義棚: '{e['uid']}'",
        "---",
        "",
        "#課題 #学校",
        "",
    ]
    body = [e.get("summary", "").strip()]
    body.append(f"授業: {course or e.get('category') or '(未設定)'}")
    body.append(f"締切: {d.month}/{d.day}({WEEK[d.weekday()]}) {d.strftime('%H:%M')}")
    if (e.get("description") or "").strip():
        body += ["", e["description"].strip()]
    body += ["", "(講義棚の課題から自動で作りました)"]
    return "\n".join(head + body) + "\n"


def set_props(text: str, values: dict[str, str]) -> str:
    """プロパティの値だけを書きかえる(無いものは閉じ --- の前に足す)"""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return text
    try:
        close = next(i for i in range(1, len(lines)) if lines[i].strip() in ("---", "..."))
    except StopIteration:
        return text
    left = dict(values)
    for i in range(1, close):
        mm = re.match(r"^([^\s:#-][^:]*):\s*(.*)$", lines[i])
        if mm and mm.group(1) in left:
            lines[i] = f"{mm.group(1)}: {left.pop(mm.group(1))}"
    for k, v in left.items():
        lines.insert(close, f"{k}: {v}")
        close += 1
    return "\n".join(lines)


def sync() -> dict:
    """講義棚の課題 → めも のタスク。作った・合わせた件数を返す"""
    evs = events()
    if not evs:
        return {"created": 0, "updated": 0}
    main = m()
    root = main.ensure_root()
    folder = root / main.MEMO_DIR
    folder.mkdir(parents=True, exist_ok=True)
    cmap = course_map()
    now = datetime.now(tz=JST)
    today = now.strftime("%Y-%m-%d")
    with main.db() as conn:
        setup(conn)
        known = {r[0]: (r[1], r[2]) for r in conn.execute("SELECT uid, path, start FROM kogi_tasks")}
    created = updated = 0
    for e in evs:
        if e.get("removed") or not e.get("uid") or not e.get("start"):
            continue
        d = when(e)
        if e["uid"] not in known:
            if e.get("done") or d < now - timedelta(days=KEEP_PAST_DAYS):
                continue
            course = course_of(e, cmap)
            # 授業の番号のままの課題は、画面で授業名を選んでから作る(どの授業か分からない名前にしない)
            if not course and CODE.match(e.get("category") or ""):
                continue
            base = title_of(e.get("summary", ""))
            name = f"{base}({course})" if course else base
            for n in range(1, 50):
                path = folder / f"{name if n == 1 else f'{name} {n}'}.md"
                with main.lock_for(path):
                    if path.exists():
                        continue
                    main.atomic_write(path, note_text(e, course, today).encode("utf-8"))
                    break
            rel = path.relative_to(root).as_posix()
            with main.db() as conn:
                conn.execute("INSERT OR REPLACE INTO kogi_tasks VALUES (?, ?, ?)", (e["uid"], rel, int(e["start"])))
                conn.commit()
            created += 1
            continue
        rel, start = known[e["uid"]]
        path = root / rel
        if not path.is_file():
            continue  # 消された・名前を変えられた(本人のもの。追いかけない)
        want: dict[str, str] = {}
        if int(e["start"]) != start:
            want.update({"遂行日": d.strftime("%Y-%m-%d"), "締切": f"'{d.strftime('%Y-%m-%d %H:%M')}'"})
        text = path.read_text(encoding="utf-8")
        if e.get("done") and not re.search(r"^完了:\s*true", text, re.M):
            want["完了"] = "true"
        if not want:
            continue
        with main.lock_for(path):
            text = path.read_text(encoding="utf-8")
            new = set_props(text, want)
            if new != text:
                main.atomic_write(path, new.encode("utf-8"))
                updated += 1
        with main.db() as conn:
            conn.execute("UPDATE kogi_tasks SET start = ? WHERE uid = ?", (int(e["start"]), e["uid"]))
            conn.commit()
    return {"created": created, "updated": updated}


def status() -> dict:
    evs = events()
    cmap = course_map()
    codes: dict[str, int] = {}
    now = datetime.now(tz=JST)
    waiting = 0
    for e in evs:
        if e.get("category") and not e.get("course") and CODE.match(e["category"]):
            codes[e["category"]] = codes.get(e["category"], 0) + 1
            if not cmap.get(e["category"]) and not e.get("done") and not e.get("removed") and when(e) >= now - timedelta(days=KEEP_PAST_DAYS):
                waiting += 1
    with m().db() as conn:
        setup(conn)
        synced = conn.execute("SELECT COUNT(*) FROM kogi_tasks").fetchone()[0]
    return {
        "configured": bool(evs),
        "events": len(evs),
        "synced": synced,
        "waiting": waiting,  # 授業名を選べば取りこむ課題
        "courses": term_courses(),
        "codes": [{"code": c, "count": n, "course": cmap.get(c, "")} for c, n in sorted(codes.items())],
    }
