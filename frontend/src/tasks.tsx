// タスクの画面(OMNI メモのアプリの「タスク」タブがしていたこと):
// 未完了・今日・これまで・これから・完了・すべて・日付で しぼり、今日→期限すぎ→これから→日付なし→完了 の順にまとめる。
// 開かずに完了・日付の変更ができ、上の欄に名前を書けば(「来週水曜」なども読んで)タスクを足せる
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { Note } from './api'
import { today } from './memo'
import { findDate, shortDay } from './jdate'

const FILTERS = ['未完了', '今日', 'これまで', 'これから', '完了', 'すべて'] as const
type Filter = (typeof FILTERS)[number] | '日付'
const GROUPS = ['今日', '期限すぎ', 'これから', '日付なし', '完了'] as const

const groupOf = (n: Note, t: string) => (n.done ? 4 : !n.task_day ? 3 : n.task_day === t ? 0 : n.task_day < t ? 1 : 2)
const plusDays = (day: string, k: number) => { const d = new Date((day || today()) + 'T00:00:00'); d.setDate(d.getDate() + k); return today(d) }

export function TasksView({ notes, autoFocus, onOpen, onDone, onMove, onAdd }: {
  notes: Note[]
  autoFocus?: boolean
  onOpen: (path: string) => void
  onDone: (n: Note, done: boolean) => void
  onMove: (n: Note, day: string) => void
  onAdd: (name: string, day: string) => Promise<boolean>
}) {
  const [filter, setFilter] = useState<Filter>(() => (localStorage.getItem('tasks.filter') as Filter) || '未完了')
  const [day, setDay] = useState(today())
  const [q, setQ] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const addRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (autoFocus) addRef.current?.focus() }, [autoFocus])
  const choose = (f: Filter) => { setFilter(f); if (f !== '日付') try { localStorage.setItem('tasks.filter', f) } catch { /* 覚えなくてもよい */ } }

  const t = today()
  // テンプレート(Templater の <% %> など)は出さない。日付として読めない遂行日は「日付なし」に
  const tasks = useMemo(() => notes
    .filter((n) => n.task && n.name !== 'sortspec' && !/<%|\{\{/.test(n.task_day || ''))
    .map((n) => (n.task_day && !/^\d{4}-\d{2}-\d{2}$/.test(n.task_day) ? { ...n, task_day: null } : n)), [notes])
  const shown = useMemo(() => {
    const words = q.trim().toLowerCase()
    return tasks
      .filter((n) => !words || n.name.toLowerCase().includes(words) || (n.tags || []).some((g) => g.toLowerCase().includes(words.replace(/^#/, ''))))
      .filter((n) => {
        switch (filter) {
          case '未完了': return !n.done
          case '今日': return !n.done && n.task_day === t
          case 'これまで': return !n.done && !!n.task_day && n.task_day < t
          case 'これから': return !n.done && !!n.task_day && n.task_day > t
          case '完了': return !!n.done
          case '日付': return n.task_day === day
          default: return true
        }
      })
      .sort((a, b) => groupOf(a, t) - groupOf(b, t) || (groupOf(a, t) === 4 ? (b.task_day || '').localeCompare(a.task_day || '') : (a.task_day || '').localeCompare(b.task_day || '')) || a.name.localeCompare(b.name, 'ja'))
  }, [tasks, filter, day, q, t])
  const count = (f: Filter) => tasks.filter((n) => (f === '未完了' ? !n.done : f === '今日' ? !n.done && n.task_day === t : f === 'これまで' ? !n.done && !!n.task_day && n.task_day < t : false)).length
  const found = findDate(name.slice(0, 200))

  const add = async () => {
    const raw = name.trim()
    if (!raw || busy) return
    setBusy(true)
    // 日付のことばは名前から外す(「レポート 来週水曜」→ 名前「レポート」・遂行日 来週水曜)
    const clean = found ? (raw.slice(0, found.index) + raw.slice(found.index + found.text.length)).replace(/\s+/g, ' ').trim() || raw : raw
    const ok = await onAdd(clean, found?.day ?? (filter === '日付' ? day : t))
    setBusy(false)
    if (ok) setName('')
  }

  return (
    <div className="tasks-page">
      <h1>タスク</h1>
      <form className="task-add" onSubmit={(e) => { e.preventDefault(); void add() }}>
        <Plus size={16} />
        <input ref={addRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="タスク名(「来週水曜」「11/20」なども読みます)" aria-label="タスクを追加" enterKeyHint="done" />
        <small>{shortDay(found?.day ?? (filter === '日付' ? day : t))}</small>
        <button className="btn primary tiny" type="submit" disabled={!name.trim() || busy}>追加</button>
      </form>
      <div className="task-filters" role="tablist" aria-label="しぼりこみ">
        {FILTERS.map((f) => {
          const c = count(f)
          return <button key={f} role="tab" aria-selected={filter === f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => choose(f)}>{f}{c > 0 && <em>{c}</em>}</button>
        })}
        <label className={`chip date-chip ${filter === '日付' ? 'on' : ''}`}>
          {filter === '日付' ? shortDay(day) : '日付…'}
          <input type="date" value={day} onChange={(e) => { if (e.target.value) { setDay(e.target.value); setFilter('日付') } }} aria-label="日付でしぼる" />
        </label>
      </div>
      <div className="task-search"><Search size={14} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="タスクを探す(名前・#タグ)" aria-label="タスクを探す" /></div>
      {shown.length === 0 && <p className="tasks-empty">{filter === '今日' ? '今日のタスクはありません。上の欄から、ひとつ。' : 'ここにはタスクがありません'}</p>}
      <div className="task-list">
        {shown.map((n, i) => {
          const g = groupOf(n, t)
          const head = (filter === '未完了' || filter === 'すべて') && (i === 0 || groupOf(shown[i - 1], t) !== g)
          return (
            <div key={n.path} className="task-item">
              {head && <h2 className="task-group">{GROUPS[g]}<small>{shown.filter((x) => groupOf(x, t) === g).length}</small></h2>}
              <div className={`task-row ${n.done ? 'done' : ''}`}>
                <input type="checkbox" checked={!!n.done} onChange={(e) => onDone(n, e.target.checked)} aria-label={`${n.name} を完了にする`} />
                <button onClick={() => onOpen(n.path)}>{n.name}</button>
                <small className={!n.done && n.task_day && n.task_day < t ? 'late' : n.task_day === t ? 'today' : ''}>{n.repeat ? '↻ ' : ''}{n.task_day ? (n.task_day === t ? '今日' : shortDay(n.task_day)) : '日付なし'}{n.deadline && /\d{2}:\d{2}/.test(n.deadline) ? ' ' + n.deadline.slice(-5) : ''}</small>
                {!n.done && <span className="task-move">
                  {n.task_day !== t && <button onClick={() => onMove(n, t)} title="今日にする">今日</button>}
                  <button onClick={() => onMove(n, plusDays(t, 1))} title="明日にする">明日</button>
                  <button onClick={() => onMove(n, plusDays(n.task_day && n.task_day > t ? n.task_day : t, 7))} title="1週間後にする">+1週</button>
                  <label className="task-pick" title="日付を選ぶ">📅<input type="date" value={n.task_day || ''} onChange={(e) => { if (e.target.value) onMove(n, e.target.value) }} aria-label={`${n.name} の日付を選ぶ`} /></label>
                </span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
