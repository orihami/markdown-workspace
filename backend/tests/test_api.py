import os
import uuid

import pytest
from fastapi.testclient import TestClient

from app import main


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    root.mkdir()
    (root / "a.md").write_text("---\ntags:\n  - x\n---\n# A\n[[B]] https://example.com\n", encoding="utf-8")
    monkeypatch.setattr(main, "VAULT_ROOT", root)
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "state" / "db.sqlite3")
    return root


@pytest.fixture
def client(vault):
    return TestClient(main.app)


def put(client, path, content, etag, mid=None):
    return client.put(f"/api/notes/{path}", json={"content": content, "base_etag": etag, "mutation_id": mid or str(uuid.uuid4())})


def test_read_keeps_content_and_etag(client, vault):
    r = client.get("/api/notes/a.md")
    assert r.status_code == 200
    assert r.json()["content"] == (vault / "a.md").read_text(encoding="utf-8")
    assert r.json()["etag"].startswith("sha256:")


def test_save_then_conflict(client, vault):
    etag = client.get("/api/notes/a.md").json()["etag"]
    r = put(client, "a.md", "# new\n", etag)
    assert r.status_code == 200
    assert (vault / "a.md").read_text(encoding="utf-8") == "# new\n"
    # 古い ETag のままもう一度 → 409、ファイルは変わらない
    r = put(client, "a.md", "# stale\n", etag)
    assert r.status_code == 409
    assert r.json()["server_content"] == "# new\n"
    assert (vault / "a.md").read_text(encoding="utf-8") == "# new\n"


def test_base_etag_required(client):
    r = client.put("/api/notes/a.md", json={"content": "x", "mutation_id": str(uuid.uuid4())})
    assert r.status_code == 422


def test_same_mutation_is_not_applied_twice(client, vault):
    etag = client.get("/api/notes/a.md").json()["etag"]
    mid = str(uuid.uuid4())
    assert put(client, "a.md", "# one\n", etag, mid).status_code == 200
    r = put(client, "a.md", "# one\n", etag, mid)
    assert r.status_code == 200 and r.json()["duplicate"] is True


@pytest.mark.parametrize("bad", ["../x.md", "..%2Fx.md", "/etc/passwd.md", "a/../../x.md", "a.txt"])
def test_path_traversal_rejected(client, bad):
    r = client.get(f"/api/notes/{bad}")
    assert r.status_code in (400, 404)


def test_symlink_escape_rejected(client, vault, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "s.md").write_text("secret", encoding="utf-8")
    (vault / "link").symlink_to(outside)
    assert client.get("/api/notes/link/s.md").status_code == 400
    assert all(not i["path"].startswith("link/") for i in client.get("/api/tree").json()["items"])


def test_missing_vault_fails_instead_of_creating(client, vault, monkeypatch, tmp_path):
    gone = tmp_path / "unmounted" / "OMNI"
    monkeypatch.setattr(main, "VAULT_ROOT", gone)
    assert client.get("/api/health").status_code == 503
    r = client.post("/api/notes", json={"path": "n.md", "content": "x"})
    assert r.status_code == 503
    assert not gone.exists()


def test_crlf_and_permissions_kept(client, vault):
    p = vault / "w.md"
    p.write_bytes(b"# W\r\nline\r\n")
    os.chmod(p, 0o644)
    etag = client.get("/api/notes/w.md").json()["etag"]
    assert put(client, "w.md", "# W\nline\nmore\n", etag).status_code == 200
    assert p.read_bytes() == b"# W\r\nline\r\nmore\r\n"
    assert (p.stat().st_mode & 0o777) == 0o644
    assert not [x for x in os.listdir(vault) if x.startswith(".mw-")]


def test_create_does_not_overwrite(client, vault):
    assert client.post("/api/notes", json={"path": "new.md", "content": "1"}).status_code == 201
    assert client.post("/api/notes", json={"path": "new.md", "content": "2"}).status_code == 409
    assert (vault / "new.md").read_text(encoding="utf-8") == "1"


def test_health_writes_nothing(client, vault):
    before = sorted(os.listdir(vault))
    assert client.get("/api/health").json()["ok"] is True
    assert sorted(os.listdir(vault)) == before


def test_tags_from_frontmatter_and_body(client, vault):
    (vault / "b.md").write_text("---\ntags: [alpha, beta]\n---\n本文 #gamma と #project/keyboard\n```\n#not-a-tag\n```\n# 見出し\n`#nope`\n", encoding="utf-8")
    items = {i["tag"]: i["count"] for i in client.get("/api/tags").json()["items"]}
    assert items["x"] == 1  # a.md の Frontmatter(リスト形式)
    assert {"alpha", "beta", "gamma", "project/keyboard"} <= set(items)
    assert "not-a-tag" not in items and "nope" not in items and "見出し" not in items


def test_search_name_first_with_snippet(client, vault):
    (vault / "検索.md").write_text("ほかの文", encoding="utf-8")
    (vault / "c.md").write_text("ここに 検索 という言葉がある", encoding="utf-8")
    items = client.get("/api/search", params={"q": "検索"}).json()["items"]
    assert items[0]["path"] == "検索.md"
    assert any(i["path"] == "c.md" and "検索" in i["snippet"] for i in items)


def test_search_by_tag(client, vault):
    (vault / "d.md").write_text("本文 #project/keyboard\n", encoding="utf-8")
    (vault / "e.md").write_text("---\ntags:\n  - project\n---\n", encoding="utf-8")
    paths = [i["path"] for i in client.get("/api/search", params={"tag": "project"}).json()["items"]]
    assert paths == ["d.md", "e.md"]


def test_tree_has_sort_props(client, vault):
    (vault / "t.md").write_text("---\n遂行日: 2026-11-02\n完了: false\ndate: '2026-11-01'\n---\n", encoding="utf-8")
    (vault / "n.md").write_text("ふつうの文\n", encoding="utf-8")
    items = {i["path"]: i for i in client.get("/api/tree").json()["items"]}
    assert items["t.md"]["date"] == "2026-11-01" and items["t.md"]["task_day"] == "2026-11-02"
    assert items["t.md"]["done"] is False and items["t.md"]["task"] is True
    assert items["n.md"]["has_props"] is False and "date" not in items["n.md"]
    assert items["a.md"]["has_props"] is True


@pytest.fixture
def trash(tmp_path, monkeypatch):
    t = tmp_path / "_整理待ち"
    t.mkdir()
    monkeypatch.setattr(main, "TRASH_ROOT", t)
    monkeypatch.setattr(main, "VAULT_LABEL", "OMNI")
    return t


def test_trash_moves_not_deletes_and_logs(client, vault, trash):
    (vault / "めも").mkdir()
    note = vault / "めも" / "消す.md"
    note.write_text("中身", encoding="utf-8")
    etag = client.get("/api/notes/めも/消す.md").json()["etag"]
    r = client.post("/api/trash", json={"path": "めも/消す.md", "base_etag": etag})
    assert r.status_code == 200, r.text
    assert not note.exists()
    moved = list(trash.rglob("消す.md"))
    assert len(moved) == 1 and moved[0].read_text(encoding="utf-8") == "中身"
    assert moved[0].relative_to(trash).parts[1:] == ("OMNI", "めも", "消す.md")
    log = (trash / "整理ログ.md").read_text(encoding="utf-8")
    assert "`OMNI/めも/消す.md` → `_整理待ち/" in log and "Markdown Workspace" in log
    # 一覧に出て、戻せる
    items = client.get("/api/trash").json()["items"]
    assert items[0]["path"] == "めも/消す.md" and items[0]["exists"]
    assert client.post(f"/api/trash/{items[0]['id']}/restore").status_code == 200
    assert note.read_text(encoding="utf-8") == "中身"
    assert client.get("/api/trash").json()["items"] == []
    assert "戻した" in (trash / "整理ログ.md").read_text(encoding="utf-8")


def test_trash_refuses_if_changed_elsewhere(client, vault, trash):
    etag = client.get("/api/notes/a.md").json()["etag"]
    (vault / "a.md").write_text("ほかで書きかえた", encoding="utf-8")
    r = client.post("/api/trash", json={"path": "a.md", "base_etag": etag})
    assert r.status_code == 409
    assert (vault / "a.md").exists()


def test_trash_same_name_twice_keeps_both(client, vault, trash):
    for text in ("1", "2"):
        (vault / "x.md").write_text(text, encoding="utf-8")
        assert client.post("/api/trash", json={"path": "x.md"}).status_code == 200
    contents = sorted(p.read_text(encoding="utf-8") for p in trash.rglob("x*.md"))
    assert contents == ["1", "2"]


def test_restore_does_not_overwrite(client, vault, trash):
    assert client.post("/api/trash", json={"path": "a.md"}).status_code == 200
    (vault / "a.md").write_text("新しく作った", encoding="utf-8")
    tid = client.get("/api/trash").json()["items"][0]["id"]
    assert client.post(f"/api/trash/{tid}/restore").status_code == 409
    assert (vault / "a.md").read_text(encoding="utf-8") == "新しく作った"


def test_trash_needs_configured_place(client, vault, monkeypatch):
    monkeypatch.setattr(main, "TRASH_ROOT", None)
    assert client.post("/api/trash", json={"path": "a.md"}).status_code == 503
    assert (vault / "a.md").exists()


def test_trash_rejects_escape(client, vault, trash):
    assert client.post("/api/trash", json={"path": "../x.md"}).status_code == 400


def test_tree_skips_venv_and_hidden(client, vault):
    for d in ("venv/lib", ".git", ".obsidian", "node_modules/x"):
        (vault / d).mkdir(parents=True)
        (vault / d / "README.md").write_text("x", encoding="utf-8")
    paths = [i["path"] for i in client.get("/api/tree").json()["items"]]
    assert not any(p.startswith(("venv/", ".git/", ".obsidian/", "node_modules/")) for p in paths)


def test_favorites_roundtrip(client, vault):
    assert client.post("/api/favorites", json={"path": "めも", "kind": "folder"}).status_code == 200
    assert client.post("/api/favorites", json={"path": "a.md", "kind": "note"}).status_code == 200
    client.post("/api/favorites", json={"path": "a.md", "kind": "note"})  # 2回でも1件
    items = client.get("/api/favorites").json()["items"]
    assert items == [{"path": "めも", "kind": "folder"}, {"path": "a.md", "kind": "note"}]
    assert client.request("DELETE", "/api/favorites", params={"path": "a.md"}).status_code == 200
    assert client.get("/api/favorites").json()["items"] == [{"path": "めも", "kind": "folder"}]
    assert client.post("/api/favorites", json={"path": "../x", "kind": "note"}).status_code == 400
    assert sorted(os.listdir(vault)) == ["a.md"]  # Vault には何も書かない


def test_tree_has_excerpt_and_tags(client, vault):
    (vault / "m.md").write_text("---\ndate: '2026-11-02'\n---\n\n#学校 #電気\n\n# 見出し\n\n**太字**と[リンク](https://x)と[[ノート|別名]]\n```\nコード\n```\n", encoding="utf-8")
    item = next(i for i in client.get("/api/tree").json()["items"] if i["path"] == "m.md")
    assert item["excerpt"] == "見出し 太字とリンクと別名"
    assert item["tags"] == ["学校", "電気"]


def test_rename(client, vault):
    etag = client.get("/api/notes/a.md").json()["etag"]
    client.post("/api/favorites", json={"path": "a.md", "kind": "note"})
    r = client.post("/api/rename", json={"path": "a.md", "new_path": "b.md", "base_etag": etag})
    assert r.status_code == 200 and r.json()["path"] == "b.md"
    assert not (vault / "a.md").exists() and (vault / "b.md").exists()
    assert client.get("/api/favorites").json()["items"][0]["path"] == "b.md"
    (vault / "c.md").write_text("c", encoding="utf-8")
    assert client.post("/api/rename", json={"path": "b.md", "new_path": "c.md"}).status_code == 409
    assert (vault / "c.md").read_text(encoding="utf-8") == "c"
    assert client.post("/api/rename", json={"path": "b.md", "new_path": "../x.md"}).status_code == 400
    (vault / "b.md").write_text("changed", encoding="utf-8")
    assert client.post("/api/rename", json={"path": "b.md", "new_path": "d.md", "base_etag": etag}).status_code == 409


PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


def test_upload_and_embed(client, vault):
    r = client.post("/api/attachments", files={"file": ("x.png", PNG, "image/png")})
    assert r.status_code == 200, r.text
    name = r.json()["name"]
    assert name.startswith("Pasted image ") and name.endswith(".png") and r.json()["markdown"] == f"![[{name}]]"
    assert (vault / "etc" / name).read_bytes() == PNG
    assert client.get("/api/embed", params={"name": name}).content == PNG
    (vault / "めも" / "_attachments").mkdir(parents=True)
    (vault / "めも" / "_attachments" / "y.png").write_bytes(PNG)
    assert client.get("/api/embed", params={"src": "_attachments/y.png", "note": "めも/n.md"}).status_code == 200
    assert client.get("/api/embed", params={"name": "ない.png"}).status_code == 404
    assert client.get("/api/files/../secret.png").status_code in (400, 404)
    assert client.post("/api/attachments", files={"file": ("x.exe", b"MZ", "application/octet-stream")}).status_code == 415


def test_versions(client, vault, tmp_path, monkeypatch):
    snap = tmp_path / "backup"
    for day, text in (("2026-11-01", "一日目"), ("2026-11-02", "二日目"), ("2026-11-03", "二日目")):
        (snap / day / "めも").mkdir(parents=True)
        (snap / day / "めも" / "n.md").write_text(text, encoding="utf-8")
    # 11-02 と 11-03 は同じファイル(ハードリンク)
    (snap / "2026-11-03" / "めも" / "n.md").unlink()
    os.link(snap / "2026-11-02" / "めも" / "n.md", snap / "2026-11-03" / "めも" / "n.md")
    monkeypatch.setattr(main, "SNAPSHOT_ROOT", snap)
    days = [i["day"] for i in client.get("/api/versions/めも/n.md").json()["items"]]
    assert days == ["2026-11-03", "2026-11-01"]
    assert client.get("/api/versions/めも/n.md", params={"day": "2026-11-01"}).json()["content"] == "一日目"
    assert client.get("/api/versions/めも/n.md", params={"day": "../x"}).status_code == 400
    assert client.get("/api/versions/../etc/passwd.md").status_code in (400, 404)


def test_capture_and_share(client, vault):
    r = client.post("/api/capture", json={"text": "牛乳を買う。あと卵も", "task": True})
    path = r.json()["path"]
    assert path == "めも/牛乳を買う。あと卵も.md"  # 24文字までは切らない(画面と同じ)
    text = (vault / path).read_text(encoding="utf-8")
    assert text.startswith("---\n遂行日: ") and "完了: false\ndate: '" in text and text.endswith("---\n\n牛乳を買う。あと卵も\n")
    r = client.post("/share", data={"title": "よい記事", "text": "読みたい", "url": "https://example.com/a"}, files={"files": ("p.jpg", PNG, "image/jpeg")}, follow_redirects=False)
    assert r.status_code == 303 and "よい記事" in __import__("urllib.parse").parse.unquote(r.headers["location"])
    shared = (vault / "めも" / "よい記事.md").read_text(encoding="utf-8")
    assert "読みたい\n\nhttps://example.com/a\n\n![[Pasted image " in shared


def test_ai_tidy_sanitizes_and_writes_nothing(client, vault, monkeypatch):
    from app import ai
    monkeypatch.setattr(ai, "api_key", lambda: "dummy")
    monkeypatch.setattr(ai, "generate_json", lambda *a, **k: {"title": "名前/に:記号", "tags": ["#学校", "123", "新タグ", "学校"], "tasks": [{"text": "出す", "due": "来週"}, {"text": "読む", "due": "2026-11-11"}, {"text": ""}], "summary": "要約"})
    before = (vault / "a.md").read_text(encoding="utf-8")
    r = client.post("/api/ai/tidy", json={"path": "a.md"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert "/" not in j["title"] and ":" not in j["title"]
    # テストの Vault にあるタグは x だけなので、学校 も 新タグ も「新しいタグ」
    assert j["tags"] == ["学校", "新タグ"] and j["new_tags"] == ["学校", "新タグ"]
    assert j["tasks"] == [{"text": "出す", "due": None}, {"text": "読む", "due": "2026-11-11"}]
    assert (vault / "a.md").read_text(encoding="utf-8") == before


def test_ai_disabled_without_key(client, vault, monkeypatch):
    from app import ai
    monkeypatch.setattr(ai, "KEY_FILE", None)
    assert client.get("/api/ai/status").json()["enabled"] is False
    assert client.post("/api/ai/tidy", json={"path": "a.md"}).status_code == 503


# ---- 頭(索引・聞く・自動で整える)。AI は偽物(文字の並びから決まるベクトル・決まった答え) ----

def fake_embed(texts, db, task="RETRIEVAL_DOCUMENT"):
    import numpy as np
    out = []
    for t in texts:
        v = np.zeros(768, dtype=np.float32)
        for a, b in zip(t, t[1:]):
            v[hash(a + b) % 768] += 1
        out.append(list(v))
    return out


@pytest.fixture
def brainy(client, vault, monkeypatch, tmp_path):
    from app import ai, brain
    monkeypatch.setattr(ai, "api_key", lambda: "dummy")
    monkeypatch.setattr(ai, "embed", fake_embed)
    monkeypatch.setattr(ai, "spent_yen", lambda db: 0.0)
    monkeypatch.setattr(main, "TRASH_ROOT", tmp_path / "_整理待ち")
    (tmp_path / "_整理待ち").mkdir()
    (vault / "めも").mkdir(exist_ok=True)
    return brain


def test_index_and_ask(brainy, client, vault, monkeypatch):
    from app import ai
    (vault / "めも" / "オシロ.md").write_text("---\ndate: '2026-10-01'\n---\n\nオシロスコープの使い方: トリガーを合わせる\n", encoding="utf-8")
    (vault / "めも" / "料理.md").write_text("---\ndate: '2026-10-02'\n---\n\nカレーの作り方\n", encoding="utf-8")
    assert brainy.update_index()["updated"] >= 3
    hits = brainy.search("オシロスコープのトリガー")
    assert hits[0]["path"] == "めも/オシロ.md"
    monkeypatch.setattr(ai, "generate_json", lambda prompt, *a, **k: {"answer": "[[オシロ]] に書いてあります" if "オシロ" in prompt else "?", "notes": ["オシロ"]})
    r = client.post("/api/ai/ask", json={"question": "オシロの使い方どこに書いたっけ"}).json()
    assert "[[オシロ]]" in r["answer"] and r["sources"][0]["path"] == "めも/オシロ.md"
    (vault / "めも" / "料理.md").unlink()
    assert brainy.update_index()["removed"] == 1


def test_auto_tidy_and_undo(brainy, vault, monkeypatch):
    import os, time
    monkeypatch.setattr(main, "tidy_suggest", lambda rel, text: {"title": "RLC回路の授業", "tags": ["x", "新"], "tasks": [{"text": "演習を出す", "due": "2026-11-11"}, {"text": "期限なし", "due": None}], "summary": ""})
    raw = "---\ndate: '2026-11-04'\n---\n\nメモ\n今日の授業 RLC 回路\n"
    name = "メモ 2026-11-04 1030"
    p = vault / "めも" / f"{name}.md"
    p.write_text(raw, encoding="utf-8")
    fresh = vault / "めも" / "書いたばかり.md"
    fresh.write_text("---\ndate: '2026-11-04'\n---\n\nいま書いている途中の雑記\n", encoding="utf-8")
    tagged = vault / "めも" / "タグあり.md"
    tagged.write_text("---\ndate: '2026-11-04'\n---\n\n#x\n\nもうタグがある雑記です\n", encoding="utf-8")
    old = time.time() - 20 * 60
    os.utime(p, (old, old))
    os.utime(tagged, (old, old))
    done = brainy.auto_run_once()
    assert [d["path"] for d in done] == ["めも/RLC回路の授業.md"]  # 書いたばかり・タグありは触らない
    new = vault / "めも" / "RLC回路の授業.md"
    assert not p.exists() and new.read_text(encoding="utf-8") == "---\ndate: '2026-11-04'\n---\n\n#x\n\nメモ\n今日の授業 RLC 回路\n"
    task = (vault / "めも" / "演習を出す.md").read_text(encoding="utf-8")
    assert "遂行日: 2026-11-11" in task and "元のメモ: [[RLC回路の授業]]" in task
    assert not (vault / "めも" / "期限なし.md").exists()
    assert brainy.auto_run_once() == []  # 同じものは2回整えない
    log = brainy.auto_log()
    brainy.auto_undo(log[0]["id"])
    assert p.read_text(encoding="utf-8") == raw and not new.exists()
    assert not (vault / "めも" / "演習を出す.md").exists()  # 作ったタスクは整理待ちへ
    assert list((main.TRASH_ROOT).rglob("演習を出す.md"))


def test_auto_undo_refuses_after_edit(brainy, vault, monkeypatch):
    import os, time
    monkeypatch.setattr(main, "tidy_suggest", lambda rel, text: {"title": "", "tags": ["x"], "tasks": [], "summary": ""})
    p = vault / "めも" / "自分で付けた名前.md"
    p.write_text("---\ndate: '2026-11-04'\n---\n\n今日の授業のメモの本文です\n", encoding="utf-8")
    old = time.time() - 20 * 60
    os.utime(p, (old, old))
    brainy.auto_run_once()
    assert p.exists() and "#x" in p.read_text(encoding="utf-8")  # 自分で付けた名前は変えない
    p.write_text(p.read_text(encoding="utf-8") + "あとから書き足した\n", encoding="utf-8")
    with pytest.raises(main.HTTPException) as e:
        brainy.auto_undo(brainy.auto_log()[0]["id"])
    assert e.value.status_code == 409 and "あとから書き足した" in p.read_text(encoding="utf-8")


def test_auto_respects_switch(brainy, vault):
    import os, time
    brainy.kv_set("auto_enabled", "0")
    p = vault / "めも" / "メモ 2026-11-04 1100.md"
    p.write_text("---\ndate: '2026-11-04'\n---\n\n今日の授業のメモの本文です\n", encoding="utf-8")
    old = time.time() - 20 * 60
    os.utime(p, (old, old))
    assert brainy.auto_run_once() == []
    brainy.kv_set("auto_enabled", "1")


def test_auto_skips_settings_notes(brainy, vault):
    import os, time
    for name, text in (("sortspec", "---\ndate: '2026-09-13'\nsorting-spec: |\n  /folders\n---\n\nめも フォルダの並べ替え設定\n"), ("設定っぽい", "---\nsorting-spec: x\n---\n\nこれは並べ替えの設定です\n")):
        p = vault / "めも" / f"{name}.md"
        p.write_text(text, encoding="utf-8")
        old = time.time() - 20 * 60
        os.utime(p, (old, old))
    assert brainy.auto_candidates(time.time()) == []


# ---- 講義棚の課題 → めも のタスク ----

def test_kogi_sync(client, vault, tmp_path, monkeypatch):
    import json, time
    from app import kogi
    (vault / "めも").mkdir(exist_ok=True)
    now_ms = int(time.time() * 1000)
    day = 86400000
    ev = {
        "a@x": {"uid": "a@x", "summary": "「提出：§27の章末問題(上にあるレポート用紙…upload提出)」の提出期限", "category": "2026_99F2130", "start": now_ms + 2 * day, "removed": False},
        "b@x": {"uid": "b@x", "summary": "「提出：昔の課題」の提出期限", "category": "", "start": now_ms - 30 * day, "removed": False},
        "c@x": {"uid": "c@x", "summary": "「提出：済んだ課題」の提出期限", "category": "", "start": now_ms + day, "removed": False, "done": True},
        "m1": {"uid": "m1", "source": "manual", "summary": "心理学のレポート", "course": "心理学", "start": now_ms + 3 * day, "description": "A4 2枚"},
    }
    f = tmp_path / "deadlines.json"
    f.write_text(json.dumps({"events": ev}), encoding="utf-8")
    st = tmp_path / "settings.json"
    st.write_text(json.dumps({"term_courses": {"2026-second": ["電気回路2", "心理学"]}}), encoding="utf-8")
    monkeypatch.setattr(kogi, "DEADLINES", f)
    monkeypatch.setattr(kogi, "SETTINGS", st)
    s0 = client.get("/api/kogi").json()
    assert s0["courses"] == ["電気回路2", "心理学"] and s0["codes"] == [{"code": "2026_99F2130", "count": 1, "course": ""}] and s0["waiting"] == 1
    assert client.post("/api/kogi/sync").json()["created"] == 1  # 授業の番号のままの課題は、授業名を選ぶまで作らない
    assert not list((vault / "めも").glob("§27*"))
    client.post("/api/kogi/map", json={"code": "2026_99F2130", "course": "電気回路2"})
    assert client.post("/api/kogi/sync").json() == {"created": 1, "updated": 0}  # 昔の課題・済んだ課題は作らない
    t = (vault / "めも" / "§27の章末問題(電気回路2).md").read_text(encoding="utf-8")
    assert t.startswith("---\n遂行日: ") and "完了: false" in t and "講義棚: 'a@x'" in t and "\n\n#課題 #学校\n\n" in t and "授業: 電気回路2" in t
    assert "A4 2枚" in (vault / "めも" / "心理学のレポート(心理学).md").read_text(encoding="utf-8")
    assert client.post("/api/kogi/sync").json() == {"created": 0, "updated": 0}  # 2回目は作らない
    # 講義棚で締切が動いた・済みにした → 合わせる
    ev["a@x"]["start"] = now_ms + 5 * day
    ev["a@x"]["done"] = True
    f.write_text(json.dumps({"events": ev}), encoding="utf-8")
    assert client.post("/api/kogi/sync").json()["updated"] == 1
    t2 = (vault / "めも" / "§27の章末問題(電気回路2).md").read_text(encoding="utf-8")
    assert "完了: true" in t2 and t2.split("\n")[1] != t.split("\n")[1] and "授業: 電気回路2" in t2
    item = next(i for i in client.get("/api/tree").json()["items"] if i["path"] == "めも/心理学のレポート(心理学).md")
    assert item["task"] and item["deadline"]


# ---- 制作ログ ----

def test_seisaku_logs(client, vault, tmp_path, monkeypatch):
    import json
    from app import seisaku
    root = tmp_path / "制作ログ"
    d = root / "2026" / "11" / "2026-11-03" / "aaaaaaaa-1111-2222-3333-444444444444"
    d.mkdir(parents=True)
    (d / "01_x.jpg").write_bytes(PNG)
    (d / "thumb_01_x.jpg").write_bytes(PNG)
    (d / "02_gone.jpg").write_bytes(PNG)
    (d / "log.json").write_text(json.dumps({"id": "aaaaaaaa-1111-2222-3333-444444444444", "date": "2026-11-03", "title": "キーボードの試作", "intention": "左手だけ", "memo": "", "photos": [{"name": "01_x.jpg"}, {"name": "02_gone.jpg", "deleted": True}], "createdAt": 1}), encoding="utf-8")
    legacy = root / "2026" / "11" / "2026-11-01"
    legacy.mkdir(parents=True)
    (legacy / "old.jpg").write_bytes(PNG)
    monkeypatch.setattr(seisaku, "ROOT", root)
    items = client.get("/api/seisaku", params={"month": "2026-11"}).json()["items"]
    assert [i["id"] for i in items] == ["legacy-2026-11-01", "aaaaaaaa-1111-2222-3333-444444444444"]
    log = items[1]
    assert log["title"] == "キーボードの試作" and len(log["photos"]) == 1 and log["photos"][0]["thumb"].endswith("thumb_01_x.jpg")
    assert client.get("/api/seisaku/photo", params={"path": log["photos"][0]["full"]}).content == PNG
    assert client.get("/api/seisaku/photo", params={"path": "../secret.jpg"}).status_code == 404
    assert client.get("/api/seisaku/log/aaaaaaaa-1111-2222-3333-444444444444").json()["title"] == "キーボードの試作"
    (vault / "めも").mkdir(exist_ok=True)
    (vault / "めも" / "作り方.md").write_text("---\ndate: '2026-11-03'\n制作ログ: 'aaaaaaaa-1111-2222-3333-444444444444'\n---\n\n本文\n", encoding="utf-8")
    item = next(i for i in client.get("/api/tree").json()["items"] if i["path"] == "めも/作り方.md")
    assert item["seisaku"] == "aaaaaaaa-1111-2222-3333-444444444444"


def test_offline_copy_sends_only_changes(client, vault):
    (vault / "めも").mkdir()
    (vault / "めも" / "x.md").write_text("---\ndate: '2026-11-06'\n---\n\nx\n", encoding="utf-8")
    (vault / "めも" / "y.md").write_text("y\n", encoding="utf-8")
    r = client.post("/api/offline", json={}).json()
    assert {c["path"] for c in r["changed"]} == {"めも/x.md", "めも/y.md"}  # めも の外(a.md)は入れない
    known = {c["path"]: c["etag"] for c in r["changed"]}
    (vault / "めも" / "y.md").write_text("y2\n", encoding="utf-8")
    known["めも/gone.md"] = "sha256:old"
    r = client.post("/api/offline", json={"known": known}).json()
    assert [c["path"] for c in r["changed"]] == ["めも/y.md"] and r["changed"][0]["content"] == "y2\n"
    assert r["removed"] == ["めも/gone.md"]
