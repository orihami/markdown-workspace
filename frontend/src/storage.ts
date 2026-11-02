import { openDB } from 'idb'

export type Draft = {
  path: string
  content: string
  baseEtag: string | null
  updatedAt: number
  // サーバーの保存確認がまだの変更があるか(false = サーバーと同じ内容)
  dirty?: boolean
}

export type PendingSave = {
  id: string
  path: string
  content: string
  baseEtag: string | null
  createdAt: number
}

const dbPromise = openDB('markdown-workspace', 1, {
  upgrade(db) {
    db.createObjectStore('drafts', { keyPath: 'path' })
    db.createObjectStore('queue', { keyPath: 'id' })
  },
})

export async function saveDraft(draft: Draft) {
  const db = await dbPromise
  await db.put('drafts', draft)
}

export async function getDraft(path: string) {
  const db = await dbPromise
  return db.get('drafts', path) as Promise<Draft | undefined>
}

export async function enqueueSave(item: PendingSave) {
  const db = await dbPromise
  await db.put('queue', item)
}

export async function listQueue() {
  const db = await dbPromise
  const items = await db.getAll('queue') as PendingSave[]
  return items.sort((a, b) => a.createdAt - b.createdAt)
}

export async function removeQueueItem(id: string) {
  const db = await dbPromise
  await db.delete('queue', id)
}

// あるノートの、指定した時刻までの送信待ちをまとめて消す(新しい内容が保存できたので古いものは不要)
export async function removeQueueUpTo(path: string, createdAt: number) {
  const db = await dbPromise
  const items = await db.getAll('queue') as PendingSave[]
  await Promise.all(items.filter(i => i.path === path && i.createdAt <= createdAt).map(i => db.delete('queue', i.id)))
}
