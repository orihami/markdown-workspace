// 端末に持つ写し(OMNI メモのアプリがしていたこと): めも の全部を端末の IndexedDB に持ち、
// サーバーにつながらないときも一覧を出し、読んで、書けるようにする。書いた分は保存係(sync.ts)の送信待ちに入り、
// つながったときにサーバーの版(ETag)とくらべて送る(ちがえば競合として本人に選んでもらう。黙って上書きしない)
import { api, Note } from './api'
import { applyCopies, getMeta, listCopies, listOutbox, putMeta } from './storage'
import { parseFront, tagLine } from './memo'

// 届いた写しの差分を入れる。返り値: 写しを持っているノートの数
export async function syncCopies(): Promise<number> {
  const copies = await listCopies()
  const known: Record<string, string> = {}
  for (const c of copies) known[c.path] = c.etag
  const r = await api<{ changed: { path: string; etag: string; content: string }[]; removed: string[] }>('/api/offline', { method: 'POST', body: JSON.stringify({ known }) }, 60000)
  await applyCopies(r.changed, r.removed)
  await putMeta('copies.at', Date.now())
  return copies.length + r.changed.filter((c) => !(c.path in known)).length - r.removed.length
}

export const copiesAt = () => getMeta<number>('copies.at')

// 一覧: サーバーから届いたら覚える。つながらないときは覚えた一覧に、端末で書いた分(送信待ち)を重ねて出す
export async function rememberTree(items: Note[]) {
  await putMeta('tree', items)
}

export async function offlineTree(): Promise<Note[] | null> {
  const items = await getMeta<Note[]>('tree')
  const pending = await listOutbox()
  if (!items && !pending.length) return null
  const byPath = new Map((items || []).map((n) => [n.path, n]))
  for (const ob of pending) byPath.set(ob.path, { ...(byPath.get(ob.path) || {}), ...noteFromText(ob.path, ob.content) })
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

// 中身から一覧用の情報を作る(サーバーの sort_props・excerpt_of と同じ考え方の簡易版)
export function noteFromText(path: string, text: string): Note {
  const name = path.split('/').pop()!.replace(/\.md$/i, '')
  const fm = parseFront(text)
  const n: Note = { path, name, has_props: !!fm }
  const val = (k: string) => fm?.props.find((p) => p.key === k)?.value.trim() || null
  if (fm) {
    n.date = val('date')
    const day = val('遂行日'), done = val('完了')
    if (day !== null || done !== null) { n.task = true; n.task_day = day; n.done = (done || '').toLowerCase() === 'true' }
    n.repeat = val('くり返し')
    n.deadline = val('締切')
    n.seisaku = val('制作ログ')
  }
  const tl = tagLine(text)
  n.tags = tl ? tl.tags.slice(0, 6) : []
  const start = tl ? tl.to : fm ? fm.to : 0
  const line = text.slice(start).split('\n').map((l) => l.trim()).find((l) => l && !/^(#[^\s#]+\s*)+$/.test(l)) || ''
  n.excerpt = line.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)/, '').replace(/[*_`~]/g, '').slice(0, 110)
  return n
}
