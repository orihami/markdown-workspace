// ブラウザの中の保存場所(IndexedDB)。サーバーが保存を確認するまで、書いた内容をここに残す
import { openDB } from 'idb'
import { uuid } from './uuid'

// 送信待ち: ノートごとに「まだサーバーに確認されていない最新の内容」1件だけ持つ
// (古い内容を後から送って新しい内容を戻すことがないように)
export type Outbox = {
  path: string
  content: string
  baseEtag: string // この内容のもとにしたサーバーの版
  mutationId: string // 同じ送信を2回処理させないための ID(内容が変わるたびに新しくする)
  updatedAt: number
}

const dbPromise = openDB('markdown-workspace', 3, {
  async upgrade(db, oldVersion, _new, tx) {
    if (oldVersion < 1) {
      db.createObjectStore('drafts', { keyPath: 'path' })
      db.createObjectStore('queue', { keyPath: 'id' })
    }
    if (oldVersion < 2) {
      const outbox = db.createObjectStore('outbox', { keyPath: 'path' })
      // 前の版の送信待ち(1回の保存ごとに1件)を、ノートごとの最新1件にまとめて引きつぐ
      const old = (await tx.objectStore('queue').getAll()) as { path: string; content: string; baseEtag: string | null; createdAt: number; id: string }[]
      old.sort((a, b) => a.createdAt - b.createdAt)
      const latest = new Map<string, (typeof old)[number]>()
      for (const item of old) latest.set(item.path, item)
      for (const item of latest.values()) {
        if (item.baseEtag) await outbox.put({ path: item.path, content: item.content, baseEtag: item.baseEtag, mutationId: item.id, updatedAt: item.createdAt })
      }
      // 送る前だった下書き(まだ送信待ちに入っていない新しい入力)も引きつぐ
      const drafts = (await tx.objectStore('drafts').getAll()) as { path: string; content: string; baseEtag: string | null; updatedAt: number; dirty?: boolean }[]
      for (const d of drafts) {
        const q = latest.get(d.path)
        if (d.dirty && d.baseEtag && (!q || d.updatedAt > q.createdAt)) {
          await outbox.put({ path: d.path, content: d.content, baseEtag: q?.baseEtag || d.baseEtag, mutationId: uuid(), updatedAt: d.updatedAt })
        }
      }
      db.deleteObjectStore('queue')
      db.deleteObjectStore('drafts')
    }
    if (oldVersion < 3) {
      // 端末に持つ写し(つながらないときに読む・書く用)と、最後に受けとった一覧
      db.createObjectStore('copies', { keyPath: 'path' })
      db.createObjectStore('meta')
    }
  },
})

export async function putOutbox(item: Outbox) {
  await (await dbPromise).put('outbox', item)
}

export async function getOutbox(path: string) {
  return (await (await dbPromise).get('outbox', path)) as Outbox | undefined
}

export async function listOutbox() {
  return (await (await dbPromise).getAll('outbox')) as Outbox[]
}

// 送ったものと同じ ID のときだけ消す(送っている間に新しく書いた分は残す)
export async function clearOutbox(path: string, mutationId: string) {
  const db = await dbPromise
  const tx = db.transaction('outbox', 'readwrite')
  const cur = (await tx.store.get(path)) as Outbox | undefined
  if (cur && cur.mutationId === mutationId) await tx.store.delete(path)
  await tx.done
}

export async function dropOutbox(path: string) {
  await (await dbPromise).delete('outbox', path)
}

// ---- 端末に持つ写し(めも の全部と、開いたことのあるノート) ----
export type Copy = { path: string; content: string; etag: string }

export async function getCopy(path: string) {
  return (await (await dbPromise).get('copies', path)) as Copy | undefined
}

export async function putCopy(item: Copy) {
  await (await dbPromise).put('copies', item)
}

export async function listCopies() {
  return (await (await dbPromise).getAll('copies')) as Copy[]
}

// まとめて入れかえる(サーバーから届いた差分)
export async function applyCopies(changed: Copy[], removed: string[]) {
  const db = await dbPromise
  const tx = db.transaction('copies', 'readwrite')
  for (const c of changed) await tx.store.put(c)
  for (const p of removed) await tx.store.delete(p)
  await tx.done
}

export async function getMeta<T>(key: string) {
  return (await (await dbPromise).get('meta', key)) as T | undefined
}

export async function putMeta(key: string, value: unknown) {
  await (await dbPromise).put('meta', value, key)
}
