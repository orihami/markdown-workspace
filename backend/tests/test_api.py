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
