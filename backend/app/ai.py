"""AI(Gemini)を呼ぶところ。鍵は なんでも博士 の設定ファイルから GEMINI_API_KEY の行だけを読む(写さない・表示しない)。
博士と同じ前払いのクレジットを使うので、このアプリにも月の上限を付ける(使った分は SQLite に記録)。"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

KEY_FILE = Path(os.getenv("GEMINI_KEY_FILE", "")).expanduser() if os.getenv("GEMINI_KEY_FILE") else None
MODELS = [m.strip() for m in os.getenv("AI_MODELS", "gemini-3.6-flash,gemini-3.5-flash-lite").split(",") if m.strip()]
MONTHLY_YEN = float(os.getenv("AI_MONTHLY_YEN", "300"))
USD_JPY = float(os.getenv("USD_JPY", "155"))  # 博士と同じく、少し高めにして安全側に数える


class AIError(Exception):
    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.status = status


def api_key() -> str | None:
    if KEY_FILE is None or not KEY_FILE.is_file():
        return None
    for line in KEY_FILE.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("GEMINI_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"") or None
    return None


def price(model: str) -> tuple[float, float]:
    """(入力, 出力) USD/100万トークン(博士の hakase_budget.py と同じ表。料金表に無いものは高めに)"""
    if model.startswith("gemini-embedding"):
        return (0.15, 0.0)
    if model.startswith("gemini-3.5-flash-lite"):
        return (0.30, 2.50)
    if model.startswith("gemini-3.1-flash-lite"):
        return (0.25, 1.50)
    if model.startswith(("gemini-3.6-flash", "gemini-3.8-flash")):
        return (0.75, 3.75) if datetime.now() < datetime(2027, 1, 1) else (1.50, 7.50)
    return (1.5, 7.5)


def month() -> str:
    return datetime.now().astimezone().strftime("%Y-%m")


def generate_json(prompt: str, schema: dict, db: Callable, system: str = "", timeout: float = 40) -> dict[str, Any]:
    """JSON で答えてもらう。上限を超えていたら呼ばない。使った分を記録する"""
    key = api_key()
    if not key:
        raise AIError("AI の鍵が見つかりません(GEMINI_KEY_FILE の設定を確かめてください)")
    spent = spent_yen(db)
    if spent >= MONTHLY_YEN:
        raise AIError(f"今月の AI の上限({MONTHLY_YEN:.0f}円)に達しました", status=429)
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema, "temperature": 0.3},
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    last = ""
    for model in MODELS:
        req = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last = f"{model}: HTTP {exc.code}"
            if exc.code == 402:
                raise AIError("AI のクレジットが残っていません(AI Studio の Billing で足してください)", status=402) from exc
            continue  # 混んでいる・モデルが無い → 次の候補へ
        except (urllib.error.URLError, TimeoutError) as exc:
            last = f"{model}: {exc}"
            continue
        usage = data.get("usageMetadata", {})
        record(db, model, usage.get("promptTokenCount", 0) or 0, (usage.get("candidatesTokenCount", 0) or 0) + (usage.get("thoughtsTokenCount", 0) or 0))
        try:
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text)
        except (KeyError, IndexError, json.JSONDecodeError) as exc:
            last = f"{model}: 答えを読めませんでした"
            continue
    raise AIError(f"AI につながりませんでした({last})")


EMBED_MODEL = os.getenv("AI_EMBED_MODEL", "gemini-embedding-001")
EMBED_DIMS = 768


def embed(texts: list[str], db: Callable, task: str = "RETRIEVAL_DOCUMENT") -> list[list[float]]:
    """文を意味のベクトルにする(メモを探すための索引用)。100件ずつ送る"""
    key = api_key()
    if not key:
        raise AIError("AI の鍵が見つかりません")
    if spent_yen(db) >= MONTHLY_YEN:
        raise AIError(f"今月の AI の上限({MONTHLY_YEN:.0f}円)に達しました", status=429)
    out: list[list[float]] = []
    for i in range(0, len(texts), 100):
        batch = texts[i : i + 100]
        body = {"requests": [{"model": f"models/{EMBED_MODEL}", "content": {"parts": [{"text": t[:8000]}]}, "taskType": task, "outputDimensionality": EMBED_DIMS} for t in batch]}
        req = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{EMBED_MODEL}:batchEmbedContents",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-goog-api-key": key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise AIError(f"索引を作れませんでした(HTTP {exc.code})", status=402 if exc.code == 402 else 503) from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise AIError(f"AI につながりませんでした({exc})") from exc
        out += [e["values"] for e in data["embeddings"]]
        # 埋めこみは数えるトークンが返らないので、文字数から多めに見積もる(日本語は 1文字 ≒ 1トークン)
        record(db, EMBED_MODEL, sum(len(t[:8000]) for t in batch), 0)
    return out


def record(db: Callable, model: str, tokens_in: int, tokens_out: int) -> None:
    pin, pout = price(model)
    usd = tokens_in * pin / 1e6 + tokens_out * pout / 1e6
    with db() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS ai_usage (month TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, usd REAL, at TEXT)")
        conn.execute("INSERT INTO ai_usage VALUES (?, ?, ?, ?, ?, ?)", (month(), model, tokens_in, tokens_out, usd, datetime.now().astimezone().isoformat()))
        conn.commit()


def spent_yen(db: Callable) -> float:
    with db() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS ai_usage (month TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, usd REAL, at TEXT)")
        row = conn.execute("SELECT COALESCE(SUM(usd), 0) FROM ai_usage WHERE month = ?", (month(),)).fetchone()
    return float(row[0]) * USD_JPY
