"""メモの「頭」: 意味で引ける索引・「あのメモどこだっけ？」に答える・雑記を自動で整える。
main.py の道具(パスの確かめ・原子的な保存・タグ一覧 など)を使う。AI の呼び出しと上限は ai.py。"""
from __future__ import annotations

import json
import re
import threading
import time
from array import array
from datetime import datetime
from pathlib import Path

import numpy as np

from . import ai

_index_lock = threading.Lock()
_cache: dict = {"version": -1, "matrix": None, "meta": []}
_version = 0

AUTO_MIN_IDLE = 15 * 60  # 書き終わってからこれだけたったら整える(書いている途中は触らない)
AUTO_MAX_AGE = 3 * 86400  # これより古いメモは自動では触らない(前からあるメモは本人のもの)
AUTO_PER_RUN = 3
AUTO_BUDGET_SHARE = 0.7  # 今月の上限の7割を使ったら自動は止める(手で使う分を残す)
AUTO_NAME = re.compile(r"^メモ \d{4}-\d{2}-\d{2} \d{4}( \d+)?$")


def m():
    from . import main
    return main


def setup(conn) -> None:
    conn.execute("CREATE TABLE IF NOT EXISTS chunks (path TEXT, idx INTEGER, mtime REAL, size INTEGER, text TEXT, vec BLOB)")
    conn.execute("CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path)")
    conn.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)")
    conn.execute("CREATE TABLE IF NOT EXISTS auto_done (path TEXT PRIMARY KEY, etag TEXT)")
    conn.execute("CREATE TABLE IF NOT EXISTS auto_log (id INTEGER PRIMARY KEY AUTOINCREMENT, path_before TEXT, path_after TEXT, before TEXT, after_etag TEXT, tags TEXT, tasks TEXT, at TEXT, undone INTEGER DEFAULT 0)")


def kv_get(key: str, default: str = "") -> str:
    with m().db() as conn:
        setup(conn)
        row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def kv_set(key: str, value: str) -> None:
    with m().db() as conn:
        setup(conn)
        conn.execute("INSERT OR REPLACE INTO kv VALUES (?, ?)", (key, value))
        conn.commit()


# ---- 索引(意味で引く) ----

def chunks_of(name: str, text: str) -> list[str]:
    """メモを 700 字くらいのかたまりに分ける。どのメモか分かるよう、頭に名前を付ける"""
    _, body = m().split_frontmatter(text)
    paras, cur = [], ""
    for line in body:
        t = re.sub(r"!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)", "", line).rstrip()
        if not t.strip():
            if cur.strip():
                paras.append(cur.strip())
            cur = ""
            continue
        cur += t + "\n"
    if cur.strip():
        paras.append(cur.strip())
    out, buf = [], ""
    for p in paras:
        if len(buf) + len(p) > 700 and buf:
            out.append(buf)
            buf = ""
        buf += p + "\n\n"
        while len(buf) > 1200:
            out.append(buf[:1000])
            buf = buf[1000:]
    if buf.strip():
        out.append(buf)
    if not out:
        out = [""]
    return [f"【{name}】\n{c.strip()}"[:1600] for c in out[:20]]


def update_index(max_notes: int = 10_000) -> dict:
    """変わったメモだけ索引を作り直す。消えたメモは索引からも消す"""
    global _version
    if not _index_lock.acquire(blocking=False):
        return {"busy": True}
    try:
        root = m().ensure_root()
        with m().db() as conn:
            setup(conn)
            have = {r[0]: (r[1], r[2]) for r in conn.execute("SELECT path, MAX(mtime), MAX(size) FROM chunks GROUP BY path")}
        seen, todo = set(), []
        for rel, path in m().iter_notes(root):
            seen.add(rel)
            try:
                st = path.stat()
            except OSError:
                continue
            if have.get(rel) != (st.st_mtime, st.st_size) and len(todo) < max_notes:
                todo.append((rel, path, st))
        gone = [p for p in have if p not in seen]
        added = 0
        for i in range(0, len(todo), 25):
            group = todo[i : i + 25]
            items = []
            for rel, path, st in group:
                text = m().note_text(rel, path) or ""
                for k, c in enumerate(chunks_of(Path(rel).stem, text)):
                    items.append((rel, k, st.st_mtime, st.st_size, c))
            vecs = ai.embed([it[4] for it in items], m().db) if items else []
            with m().db() as conn:
                for rel, _, _ in group:
                    conn.execute("DELETE FROM chunks WHERE path = ?", (rel,))
                for (rel, k, mt, sz, c), v in zip(items, vecs):
                    a = np.asarray(v, dtype=np.float32)
                    a /= np.linalg.norm(a) or 1.0
                    conn.execute("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)", (rel, k, mt, sz, c, a.tobytes()))
                conn.commit()
            added += len(group)
        if gone:
            with m().db() as conn:
                conn.executemany("DELETE FROM chunks WHERE path = ?", [(p,) for p in gone])
                conn.commit()
        if added or gone:
            _version += 1
        kv_set("index_updated", datetime.now().astimezone().isoformat())
        return {"updated": added, "removed": len(gone)}
    finally:
        _index_lock.release()


def index_status() -> dict:
    with m().db() as conn:
        setup(conn)
        notes, chunks = conn.execute("SELECT COUNT(DISTINCT path), COUNT(*) FROM chunks").fetchone()
    return {"notes": notes, "chunks": chunks, "updated_at": kv_get("index_updated") or None}


def _matrix():
    if _cache["version"] != _version or _cache["matrix"] is None:
        with m().db() as conn:
            setup(conn)
            rows = conn.execute("SELECT path, idx, text, vec FROM chunks").fetchall()
        meta = [(r[0], r[1], r[2]) for r in rows]
        mat = np.frombuffer(b"".join(r[3] for r in rows), dtype=np.float32).reshape(len(rows), ai.EMBED_DIMS) if rows else np.zeros((0, ai.EMBED_DIMS), dtype=np.float32)
        _cache.update(version=_version, matrix=mat, meta=meta)
    return _cache["matrix"], _cache["meta"]


def search(question: str, k: int = 24) -> list[dict]:
    mat, meta = _matrix()
    if not len(meta):
        return []
    q = np.asarray(ai.embed([question], m().db, task="RETRIEVAL_QUERY")[0], dtype=np.float32)
    q /= np.linalg.norm(q) or 1.0
    scores = mat @ q
    # 言葉がそのまま入っているかたまりは少し上げる(名前や型番など、意味だけでは拾いにくいもの)
    words = [w for w in re.split(r"[\s、。,.?？!！]+", question) if len(w) >= 2][:6]
    if words:
        for i, (_, _, text) in enumerate(meta):
            hit = sum(1 for w in words if w.casefold() in text.casefold())
            if hit:
                scores[i] += 0.03 * hit
    top = np.argsort(-scores)[: k * 3]
    out, per = [], {}
    for i in top:
        path, idx, text = meta[i]
        if per.get(path, 0) >= 2:
            continue
        per[path] = per.get(path, 0) + 1
        out.append({"path": path, "idx": int(idx), "text": text, "score": float(scores[i])})
        if len(out) >= k:
            break
    return out


ASK_SCHEMA = {
    "type": "OBJECT",
    "properties": {"answer": {"type": "STRING"}, "notes": {"type": "ARRAY", "items": {"type": "STRING"}}},
    "required": ["answer", "notes"],
}


def ask(question: str) -> dict:
    """「あのメモどこだっけ？」「あれってどんな内容だっけ？」に、本人のメモだけを根拠に答える"""
    hits = search(question, 14)
    names = {h["path"]: Path(h["path"]).stem for h in hits}
    root = m().ensure_root()
    dates = {}
    for p in names:
        props = m().sort_props(m().note_text(p, root / p))
        dates[p] = props.get("date") or ""
    context = "\n\n".join(f"### [[{names[h['path']]}]] ({dates.get(h['path'], '')[:10]})\n{h['text'].split(chr(10), 1)[-1][:900]}" for h in hits)
    now = datetime.now().astimezone()
    prompt = f"""今日は {now.strftime('%Y-%m-%d')} です。次の質問に、下にある本人のメモの抜粋だけを根拠に答えてください。

- どのメモに書いてあるかを、本文の中で必ず [[メモ名]] の形で示す(メモ名は抜粋の見出しのとおりに)
- 内容を聞かれたら、そのメモに書いてあることを短くまとめる。書いていないことは足さない
- 見つからなければ正直に「見つかりませんでした」と言い、近そうなメモがあれば挙げる
- notes には、答えに使ったメモ名を関係の深い順に入れる
- 日本語で、短く(だいたい 5 行まで)

質問: {question}

メモの抜粋:
{context or '(メモの索引がまだありません)'}"""
    out = ai.generate_json(prompt, ASK_SCHEMA, m().db, system="あなたは本人のメモ帳の案内係です。推測で事実を作らない。")
    by_name = {v: k for k, v in names.items()}
    used = [n.strip().strip("[]") for n in out.get("notes") or []]
    order = [by_name[n] for n in used if n in by_name] or [h["path"] for h in hits[:3]]
    seen, sources = set(), []
    for p in order + [h["path"] for h in hits]:
        if p in seen or len(sources) >= 6:
            continue
        seen.add(p)
        snippet = next((h["text"].split("\n", 1)[-1][:120] for h in hits if h["path"] == p), "")
        sources.append({"path": p, "name": names.get(p, Path(p).stem), "date": dates.get(p, "")[:10], "snippet": snippet, "used": p in order})
    return {"answer": str(out.get("answer") or "").strip(), "sources": sources, "spent_yen": round(ai.spent_yen(m().db), 2)}


# ---- 雑記を自動で整える ----

def has_tag_line(text: str) -> bool:
    _, body = m().split_frontmatter(text)
    for line in body:
        t = line.strip()
        if not t:
            continue
        return bool(re.fullmatch(r"(#[^\s#]+\s*)+", t))
    return False


def add_tag_line(text: str, tags: list[str], date: str) -> str:
    """きまりどおり: 閉じ --- → 空行 → #タグ → 空行 → 本文。プロパティが無ければ date を付ける"""
    eol = "\r\n" if "\r\n" in text else "\n"
    line = " ".join("#" + t for t in tags)
    mt = re.match(r"(﻿?---\r?\n.*?\r?\n(?:---|\.\.\.))[ \t]*(\r?\n|$)", text, re.S)
    if mt:
        head, rest = mt.group(1), text[mt.end():]
    else:
        head, rest = f"---{eol}date: '{date}'{eol}---", text
    rest = rest.lstrip("\r\n")
    return head + eol + eol + line + eol + (eol + rest if rest.strip() else "")


def linked_from_others(name: str, self_rel: str) -> bool:
    root = m().ensure_root()
    pat = re.compile(r"\[\[" + re.escape(name) + r"(\||#|\]\])")
    for rel, path in m().iter_notes(root):
        if rel != self_rel and pat.search(m().note_text(rel, path) or ""):
            return True
    return False


def auto_enabled() -> bool:
    return kv_get("auto_enabled", "1") == "1"


def auto_candidates(now: float) -> list[tuple[str, Path]]:
    root = m().ensure_root()
    memo = root / m().MEMO_DIR
    with m().db() as conn:
        setup(conn)
        done = {r[0]: r[1] for r in conn.execute("SELECT path, etag FROM auto_done")}
    out = []
    for rel, path in m().iter_notes(root):
        if not path.is_relative_to(memo):
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        if not (AUTO_MIN_IDLE <= now - st.st_mtime <= AUTO_MAX_AGE) or st.st_size > 100_000:
            continue
        text = m().note_text(rel, path) or ""
        if done.get(rel) == m().etag_for(text.encode("utf-8")):
            continue
        fm, body = m().split_frontmatter(text)
        # 設定のメモ(Obsidian の並べ替え sortspec など)・記事の取りこみ・もうタグがあるメモは触らない
        if path.stem == "sortspec" or any(l.startswith(("sorting-spec", "cssclasses", "kanban-plugin", "excalidraw")) for l in fm):
            continue
        if has_tag_line(text) or len("".join(body).strip()) < 10 or "clippings" in text[:600]:
            continue
        out.append((rel, path))
    out.sort(key=lambda x: -x[1].stat().st_mtime)
    return out


def auto_run_once(now: float | None = None) -> list[dict]:
    """5分ごとに呼ばれる。条件に合う雑記を最大3件、整える"""
    if not auto_enabled() or ai.api_key() is None:
        return []
    if ai.spent_yen(m().db) >= ai.MONTHLY_YEN * AUTO_BUDGET_SHARE:
        return []
    now = now or time.time()
    results = []
    for rel, path in auto_candidates(now)[:AUTO_PER_RUN]:
        try:
            results.append(auto_tidy_one(rel, path))
        except Exception as exc:  # 1件の失敗で止めない
            results.append({"path": rel, "error": str(exc)})
            with m().db() as conn:
                conn.execute("INSERT OR REPLACE INTO auto_done VALUES (?, ?)", (rel, "error"))
                conn.commit()
    return results


def auto_tidy_one(rel: str, path: Path) -> dict:
    main = m()
    text = path.read_text(encoding="utf-8")
    etag = main.etag_for(text.encode("utf-8"))
    sug = main.tidy_suggest(rel, text)
    known = set(main.tags_known())
    tags = [t for t in sug["tags"] if t in known][:4] or sug["tags"][:1]
    day = datetime.now().astimezone().strftime("%Y-%m-%d")
    date = main.sort_props(text).get("date") or day
    root = main.ensure_root()
    name = path.stem
    # 自動で付いた名前(本文の書き出し・「メモ 日付」)で、どこからもリンクされていないときだけ名前を変える
    rename_to = None
    if sug["title"] and sug["title"] != name and (AUTO_NAME.match(name) or name == main.name_from_body("\n".join(main.split_frontmatter(text)[1]))) and not linked_from_others(name, rel):
        rename_to = main.cleanup_name(sug["title"])
    with main.lock_for(path):
        if main.etag_for(path.read_bytes()) != etag:
            return {"path": rel, "skipped": "整えている間に書きかえられました"}
        new_text = add_tag_line(text, tags, str(date)[:10]) if tags else text
        main.atomic_write(path, new_text.encode("utf-8"))
        final = path
        if rename_to:
            target = path.with_name(f"{rename_to}.md")
            k = 2
            while target.exists():
                target = path.with_name(f"{rename_to} {k}.md")
                k += 1
            import os
            os.rename(path, target)
            final = target
    final_rel = final.relative_to(root).as_posix()
    task_paths = []
    for t in sug["tasks"]:
        if t.get("due"):
            task_paths.append(main.create_memo(f"元のメモ: [[{final.stem}]]", task=True, title=t["text"], day=t["due"]))
    after_etag = main.etag_for(final.read_bytes())
    with main.db() as conn:
        setup(conn)
        conn.execute("INSERT INTO auto_log (path_before, path_after, before, after_etag, tags, tasks, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                     (rel, final_rel, text, after_etag, json.dumps(tags, ensure_ascii=False), json.dumps(task_paths, ensure_ascii=False), datetime.now().astimezone().isoformat()))
        conn.execute("INSERT OR REPLACE INTO auto_done VALUES (?, ?)", (final_rel, after_etag))
        conn.commit()
    with main._text_cache_guard:
        main._text_cache.pop(rel, None)
    return {"path": final_rel, "tags": tags, "tasks": task_paths, "renamed": final_rel != rel}


def auto_log(limit: int = 20) -> list[dict]:
    with m().db() as conn:
        setup(conn)
        rows = conn.execute("SELECT id, path_before, path_after, tags, tasks, at, undone FROM auto_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{"id": r[0], "path_before": r[1], "path": r[2], "tags": json.loads(r[3] or "[]"), "tasks": json.loads(r[4] or "[]"), "at": r[5], "undone": bool(r[6])} for r in rows]


def auto_undo(log_id: int) -> dict:
    """自動で整えたのを元に戻す。そのあと書きかえていたら戻さない(書いた分を消さないため)。作ったタスクは整理待ちへ"""
    main = m()
    with main.db() as conn:
        setup(conn)
        row = conn.execute("SELECT path_before, path_after, before, after_etag, tasks, undone FROM auto_log WHERE id = ?", (log_id,)).fetchone()
    if not row or row[5]:
        raise main.HTTPException(status_code=404, detail="戻せるものがありません")
    before_rel, after_rel, before, after_etag, tasks, _ = row
    root = main.ensure_root()
    cur = root / after_rel
    with main.lock_for(cur):
        if not cur.is_file() or main.etag_for(cur.read_bytes()) != after_etag:
            raise main.HTTPException(status_code=409, detail="整えたあとに書きかえられているので、自動では戻せません(過去の版から戻せます)")
        main.atomic_write(cur, before.encode("utf-8"))
        back = root / before_rel
        if back != cur and not back.exists():
            import os
            os.rename(cur, back)
    for t in json.loads(tasks or "[]"):
        try:
            main.trash_note(main.TrashRequest(path=t))
        except main.HTTPException:
            pass
    with main.db() as conn:
        conn.execute("UPDATE auto_log SET undone = 1 WHERE id = ?", (log_id,))
        conn.execute("INSERT OR REPLACE INTO auto_done VALUES (?, ?)", (before_rel, main.etag_for(before.encode("utf-8"))))
        conn.commit()
    return {"ok": True, "path": before_rel if (root / before_rel).exists() else after_rel}


# ---- うしろで動く見回り(5分ごとに自動で整える、30分ごとに索引を作り直す) ----

def start_background() -> None:
    def loop():
        time.sleep(60)
        n = 0
        while True:
            try:
                # 講義棚の課題 → めも のタスク(AI は使わない)
                from . import kogi
                kogi.sync()
            except Exception as exc:
                print("講義棚の取りこみでエラー:", exc)
            try:
                if ai.api_key() is not None:
                    if n % 6 == 0:
                        update_index()
                    done = auto_run_once()
                    if any("error" not in d and "skipped" not in d for d in done):
                        update_index()
            except Exception as exc:  # 見回りは止めない
                print("見回りでエラー:", exc)
            n += 1
            time.sleep(300)
    threading.Thread(target=loop, name="brain", daemon=True).start()
