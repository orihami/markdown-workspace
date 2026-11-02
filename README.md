# Markdown Workspace

NAS上のMarkdownを唯一の正本として扱う、個人用ブラウザMarkdownワークスペースの初期実装です。

## 今回含まれるもの

- `docs/SPEC.md`: 要件・画面・データ・API・障害時挙動をまとめた仕様書
- `backend/`: FastAPI。NAS上のMarkdownを直接読み書きし、SHA-256による競合検出と原子的保存を行う
- `frontend/`: React + Vite。Notion寄りのUI、Markdown入力、プレビュー表示、入力候補、IndexedDBの下書き・保存キュー
- `docker-compose.yml`: 開発・自宅サーバー向けの起動例

## 動かしている場所

サーバーは **ko-pi**（以前の仕様書でいう「常時稼働WindowsミニPC」と同じマシン。今は Debian）で動かしている。HDD が ko-pi に直接つながっているので、NAS 越しの遅さがない。

- systemd の `markdown-workspace.service` で常時起動。設定（Vault の場所・待ち受け先など）は `/etc/markdown-workspace/env`（リポジトリには入れない）
- アプリは ko-pi の中だけで待ち受け、`tailscale serve` の https（Tailscale 内だけ。Funnel なし）から入る。Tailscale につながった PC・スマホから `https://ko-pi.<tailnet>.ts.net:<ポート>/` で開く。インターネットには出していない
- **https で開く必要がある**（http だと `crypto.randomUUID`・Service Worker・クリップボードが使えない。2026-11-02 に http で保存が1回も送られなかった）
- 画面（frontend をビルドした `frontend/dist`）も API と同じポートで配る
- 2026-11-02 から本番（HDD の OMNI が正本）。「消す」は HDD の `_整理待ち/日付/OMNI/元のパス` へ移す。OMNI は毎日 SSD に写している（`kopi-omni-snapshot`）

## 開発・テスト（ko-pi / Linux）

```sh
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest httpx
.venv/bin/python -m pytest -q tests          # パスの安全・競合・原子的保存・改行コード・権限
cd ../frontend && npm ci && npm run build      # 画面をビルド(サービスはこの dist を配る)
npm run e2e                                    # ブラウザで通し(http と同じ条件の保存・表示・リンク・検索・停止→再送・競合・CRLF など38項目)
sudo systemctl restart markdown-workspace      # 変更を反映
```

開発中は `npm run dev` で Vite を使ってもよい（`/api` は `http://127.0.0.1:8000` へ転送）。

## セキュリティ

- インターネットへは公開しない（Tailscale 内だけ）。Tailscale Funnel などで外に出さない。
- 本番公開前に認証、HTTPS、レート制限、CSRF/CORS、バックアップ、監査ログを整備してください。
- `APP_TOKEN` を設定するとAPIのBearer認証が有効になります。フロントエンド側のトークン入力UIはまだ未実装です。

## 現時点の実装範囲

ソース編集（CodeMirror）と、読みやすい表示（Notion表示）の切り替え。Notion表示は見るだけで、原文は変換しない。
WYSIWYG 編集は仕様の Phase 3（Markdown の往復テストに合格してから）。
