# Markdown Workspace

NAS上のMarkdownを唯一の正本として扱う、個人用ブラウザMarkdownワークスペースの初期実装です。

## 今回含まれるもの

- `docs/SPEC.md`: 要件・画面・データ・API・障害時挙動をまとめた仕様書
- `backend/`: FastAPI。NAS上のMarkdownを直接読み書きし、SHA-256による競合検出と原子的保存を行う
- `frontend/`: React + Vite。Notion寄りのUI、Markdown入力、プレビュー表示、入力候補、IndexedDBの下書き・保存キュー
- `docker-compose.yml`: 開発・自宅サーバー向けの起動例

## 大事な前提

この作業環境からユーザー宅のNASやWindowsミニPCには接続できないため、実NASへの接続・既存Vaultの読み書き・実機での起動確認はまだ行っていません。最初は必ず既存Vaultのコピーをテスト用フォルダとして指定してください。

## 起動方法（Windows）

1. Python 3.11以上、Node.js 20以上を用意
2. `backend/.env.example` を `backend/.env` にコピーし、`VAULT_ROOT` をテスト用Markdownフォルダに変更
3. APIを起動

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

4. 別のターミナルでフロントエンドを起動

```powershell
cd frontend
npm install
npm run dev -- --host 0.0.0.0
```

5. PCでは `http://localhost:5173`、スマートフォンでは同じLAN内のPCのIPアドレスとポート5173にアクセス

開発時のViteプロキシは `/api` を `http://localhost:8000` に転送します。

## NASパスの設定

Windowsでは、可能ならドライブ文字よりUNCパスを推奨します。

```env
VAULT_ROOT=\\\\NAS名\\共有名\\Memo
```

`Z:` のような割り当てドライブは、APIをWindowsサービスとして起動した場合にサービスアカウントから見えないことがあります。ログインユーザーのターミナルから起動する場合は利用できることがあります。

## セキュリティ

- LAN内だけで試してください。ルーターで8000/5173をインターネットへ公開しないでください。
- 外出先から使う場合は、Tailscale等のプライベートネットワーク経由に限定してください。
- 本番公開前に認証、HTTPS、レート制限、CSRF/CORS、バックアップ、監査ログを整備してください。
- `APP_TOKEN` を設定するとAPIのBearer認証が有効になります。フロントエンド側のトークン入力UIはまだ未実装です。

## 現時点の実装範囲

これは実装の土台となるMVPです。Notionモードは現在「Markdown編集」と「レンダリング表示」の切り替えであり、Notionと同等の完全なブロックWYSIWYG編集ではありません。Markdownを壊さないことを優先して、まずソース編集とプレビューを確実に動かす構成にしています。次段階でMilkdown等を比較し、既存Markdownの往復変換テストを通してからWYSIWYG編集を追加します。
