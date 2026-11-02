# CLAUDE.md — Markdown Workspace

NAS（ko-pi の HDD）上の Markdown を唯一の正本として、ブラウザから編集するアプリ。仕様は `docs/SPEC.md`、現状と次の作業は `HANDOFF.md`。

- 返事・報告は日本語、時刻は日本時間。
- 仕様の「常時稼働WindowsミニPC」= ko-pi（同じマシン、今は Debian）。
- いちばん大事なのは **既存の Markdown を壊さないこと**（Frontmatter・リンク・未知の構文を正規化しない、改行コードを保つ、保存確認前に「保存済み」と出さない、競合で片方を黙って捨てない）。
- 変更したら `backend` で `pytest`、`frontend` で `npm run build && npm run e2e`。通ったら `sudo systemctl restart markdown-workspace`。
- サーバーの設定（Vault の場所・待ち受けアドレス・トークン）は `/etc/markdown-workspace/env`。アドレス・IP・トークンはリポジトリに書かない。
- 区切りごとに HANDOFF.md を更新して commit・push。
