// 保存係(仕様 6)。画面(React)から切り離して、ノートごとに次の流れを受けもつ:
//   1. 入力のたびに送信待ち(IndexedDB)へ書く ← 入力は通信を待たない
//   2. 入力が止まって 600ms で API へ送る(ベースの ETag と mutation_id 付き)
//   3. サーバーが保存を確認したら送信待ちを消して「保存済み」。それまでは「保存済み」と出さない
//   4. 届かなければ間隔をのばしながら送り直す。409(競合)は送り直さず、本人に選んでもらう
import { api, ApiError, notePath } from './api'
import { clearOutbox, dropOutbox, getOutbox, listOutbox, putCopy, putOutbox } from './storage'
import { uuid } from './uuid'

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'offline' | 'conflict' | 'error'
export type Conflict = { serverContent: string | null; serverEtag: string }
export type NoteSync = { status: SaveStatus; message?: string; conflict?: Conflict; savedAt?: number }

export const STATUS_LABEL: Record<SaveStatus, string> = {
  saved: '保存済み',
  saving: '保存中',
  unsaved: '未保存',
  offline: 'オフライン',
  conflict: '競合',
  error: 'エラー',
}

const DEBOUNCE_MS = 600
// まだサーバーに無いノート(つながらないときに作った)の送信待ちは、ベースの版の代わりにこの印を持つ
export const NEW_NOTE = 'new'
const RETRY_MIN = 1000
const RETRY_MAX = 30000

export class SaveEngine {
  private base = new Map<string, string>() // ノート → 今の内容のもとにしたサーバーの ETag
  private info = new Map<string, NoteSync>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private inflight = new Set<string>()
  private again = new Set<string>()
  private writes = new Map<string, Promise<void>>() // IndexedDB への書き込みを順番に
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = RETRY_MIN
  private listeners = new Set<() => void>()
  version = 0

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  private emit() {
    this.version++
    for (const fn of this.listeners) fn()
  }
  private set(path: string, next: NoteSync) {
    this.info.set(path, next)
    this.emit()
  }

  get(path: string): NoteSync {
    return this.info.get(path) ?? { status: 'saved' }
  }

  // 送信待ちの数(競合をのぞく)
  pending() {
    let n = 0
    for (const v of this.info.values()) if (v.status !== 'saved') n++
    return n
  }

  // 起動時: 前に送れなかった分を読みこんで送り直す
  private started = false
  async start() {
    if (this.started) return
    this.started = true
    for (const ob of await listOutbox()) {
      if (!this.base.has(ob.path)) this.base.set(ob.path, ob.baseEtag)
      this.set(ob.path, { status: 'unsaved', message: '前回送れなかった変更があります' })
    }
    const kick = () => { this.retryDelay = RETRY_MIN; void this.retryAll() }
    window.addEventListener('online', kick)
    window.addEventListener('focus', kick)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick() })
    window.addEventListener('offline', () => {
      for (const [p, v] of this.info) if (v.status === 'unsaved' || v.status === 'saving') this.set(p, { status: 'offline', message: '端末がオフラインです。入力は端末に残しています' })
    })
    void this.retryAll()
  }

  // ノートを開いたとき。送信待ちがあればそれを返す(サーバーより新しい自分の内容)
  async open(path: string, serverContent: string, serverEtag: string): Promise<{ content: string; restored: boolean }> {
    const ob = await getOutbox(path)
    if (ob && ob.content !== serverContent) {
      this.base.set(path, ob.baseEtag)
      if (this.get(path).status !== 'conflict') this.set(path, { status: 'unsaved', message: '送れていない変更を復元しました' })
      this.schedule(path, 0)
      return { content: ob.content, restored: true }
    }
    if (ob) await dropOutbox(path) // 中身がサーバーと同じなら送る必要はない
    if (serverEtag !== NEW_NOTE) void putCopy({ path, content: serverContent, etag: serverEtag }).catch(() => {})
    this.base.set(path, serverEtag)
    this.set(path, { status: 'saved' })
    return { content: serverContent, restored: false }
  }

  // つながらないときに作る: 送信待ちに入れておき、つながったらサーバーに作る
  async create(path: string, content: string) {
    this.base.set(path, NEW_NOTE)
    const ob = { path, content, baseEtag: NEW_NOTE, mutationId: uuid(), updatedAt: Date.now() }
    const prev = this.writes.get(path) ?? Promise.resolve()
    const done = prev.then(() => putOutbox(ob))
    this.writes.set(path, done)
    await done
    this.set(path, { status: navigator.onLine ? 'unsaved' : 'offline', message: '端末に残しました。つながりしだい作ります' })
    this.schedule(path, 0)
  }

  // まだ送れていないノートと、競合のノート(開いていないノートの分も、ホームで知らせる)
  troubles() {
    const out: { path: string; status: SaveStatus }[] = []
    for (const [path, v] of this.info) if (v.status !== 'saved' && v.status !== 'saving') out.push({ path, status: v.status })
    return out
  }

  // 入力のたび(画面からすぐ呼ばれる。通信は待たない)
  edit(path: string, content: string) {
    const baseEtag = this.base.get(path)
    if (!baseEtag) return
    const ob = { path, content, baseEtag, mutationId: uuid(), updatedAt: Date.now() }
    const prev = this.writes.get(path) ?? Promise.resolve()
    const done = prev.then(() => putOutbox(ob)).catch(() => {
      this.set(path, { status: 'error', message: '端末に下書きを保存できません(ブラウザの保存領域を確認してください)' })
    })
    this.writes.set(path, done)
    const cur = this.get(path)
    if (cur.status !== 'conflict') this.set(path, { status: navigator.onLine ? 'unsaved' : 'offline', message: cur.status === 'offline' ? cur.message : undefined })
    this.schedule(path, DEBOUNCE_MS)
  }

  // Ctrl+S: すぐ送る
  saveNow(path?: string) {
    if (path) this.schedule(path, 0)
    else void this.retryAll()
  }

  private schedule(path: string, ms: number) {
    clearTimeout(this.timers.get(path))
    this.timers.set(path, setTimeout(() => { this.timers.delete(path); void this.flush(path) }, ms))
  }

  private async flush(path: string) {
    if (this.get(path).status === 'conflict') return
    if (this.inflight.has(path)) { this.again.add(path); return }
    this.inflight.add(path)
    try {
      await this.writes.get(path)
      const ob = await getOutbox(path)
      if (!ob) return
      this.set(path, { status: 'saving' })
      try {
        const res = ob.baseEtag === NEW_NOTE ? await this.createOnServer(ob.path, ob.content) : await api<{ etag: string }>(notePath(path), {
          method: 'PUT',
          body: JSON.stringify({ content: ob.content, base_etag: ob.baseEtag, mutation_id: ob.mutationId }),
        })
        this.base.set(path, res.etag)
        void putCopy({ path, content: ob.content, etag: res.etag }).catch(() => {})
        await clearOutbox(path, ob.mutationId)
        // 送っている間にさらに書いた分は、いま保存できた版をもとにして続けて送る
        const newer = await getOutbox(path)
        if (newer) {
          await putOutbox({ ...newer, baseEtag: res.etag })
          this.again.add(path)
          this.set(path, { status: 'unsaved' })
        } else this.set(path, { status: 'saved', savedAt: Date.now() })
        this.retryDelay = RETRY_MIN
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(String(e), 0)
        if (err.status === 409) {
          this.set(path, { status: 'conflict', conflict: { serverContent: err.body?.server_content ?? null, serverEtag: err.body?.server_etag }, message: 'ほかの場所でこのノートが更新されています' })
        } else if (err.network) {
          this.set(path, navigator.onLine ? { status: 'unsaved', message: 'サーバーにつながりません。つながりしだい送ります' } : { status: 'offline', message: '端末がオフラインです。入力は端末に残しています' })
          this.scheduleRetry()
        } else if (err.status === 503 || err.status >= 500) {
          this.set(path, { status: 'unsaved', message: 'サーバーが保存できませんでした(HDD が外れているかもしれません)。送り直します' })
          this.scheduleRetry()
        } else {
          this.set(path, { status: 'error', message: `保存できません: ${err.message}(内容は端末に残しています)` })
        }
      }
    } finally {
      this.inflight.delete(path)
      if (this.again.delete(path)) this.schedule(path, 0)
    }
  }

  // 端末で作ったノートをサーバーに作る。同じ名前があれば、中身が同じ(前に送れていた)ときだけ済みにし、ちがえば競合
  private async createOnServer(path: string, content: string): Promise<{ etag: string }> {
    try {
      return await api<{ etag: string }>('/api/notes', { method: 'POST', body: JSON.stringify({ path, content }) })
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e
      const cur = await api<{ content: string; etag: string }>(notePath(path))
      if (cur.content === content) return { etag: cur.etag }
      throw new ApiError('同じ名前のノートがサーバーにあります', 409, { server_content: cur.content, server_etag: cur.etag })
    }
  }

  private scheduleRetry() {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.retryAll() }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX)
  }

  async retryAll() {
    for (const ob of await listOutbox()) {
      if (!this.base.has(ob.path)) this.base.set(ob.path, ob.baseEtag)
      if (this.get(ob.path).status !== 'conflict') void this.flush(ob.path)
    }
  }

  // 競合の解き方(どれも本人が選ぶ。勝手にどちらかを捨てない)
  async useServer(path: string) {
    const c = this.get(path).conflict
    if (!c) return null
    await dropOutbox(path)
    this.base.set(path, c.serverEtag)
    this.set(path, { status: 'saved' })
    return c.serverContent
  }

  async keepMine(path: string) {
    const c = this.get(path).conflict
    const ob = await getOutbox(path)
    if (!c || !ob) return
    await putOutbox({ ...ob, baseEtag: c.serverEtag, mutationId: uuid() })
    this.base.set(path, c.serverEtag)
    this.set(path, { status: 'unsaved' })
    this.schedule(path, 0)
  }

  // 消す前の確かめ用: いまの内容のもとにしたサーバーの版
  baseOf(path: string) {
    return this.base.get(path)
  }

  // 名前を変える前: 送信待ちが無くなる(サーバーに保存し終わる)まで待つ
  async settle(path: string, timeoutMs = 10000) {
    const end = Date.now() + timeoutMs
    this.schedule(path, 0)
    for (;;) {
      await this.writes.get(path)
      const busy = this.inflight.has(path) || this.timers.has(path) || !!(await getOutbox(path))
      if (!busy) return this.get(path).status === 'saved'
      if (this.get(path).status === 'conflict' || Date.now() > end) return false
      await new Promise((r) => setTimeout(r, 120))
    }
  }

  // 名前を変えたあと: 新しい名前で続ける
  moved(oldPath: string, newPath: string, etag: string) {
    // 古い名前に残った送信待ちは、画面の内容を新しい名前で送り直すので要らない
    clearTimeout(this.timers.get(oldPath))
    this.timers.delete(oldPath)
    void this.writes.get(oldPath)?.then(() => dropOutbox(oldPath))
    this.base.delete(oldPath)
    this.info.delete(oldPath)
    this.base.set(newPath, etag)
    this.set(newPath, { status: 'saved', savedAt: Date.now() })
  }

  // 整理待ちへ移したノート: 送信待ちと予定を片づける(もう送らない)
  async forget(path: string) {
    clearTimeout(this.timers.get(path))
    this.timers.delete(path)
    this.again.delete(path)
    await this.writes.get(path)
    await dropOutbox(path)
    this.base.delete(path)
    this.info.delete(path)
    this.emit()
  }

  async mineContent(path: string) {
    return (await getOutbox(path))?.content ?? null
  }
}

export const engine = new SaveEngine()
