// 画面の部品: フォルダの木・クイック検索・新しいノート・差分・メニュー
import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckSquare, ChevronRight, FileText, Folder, FolderOpen, Search, Square, X } from 'lucide-react'
import type { EditorView as CMView } from '@codemirror/view'
import { undo } from '@codemirror/commands'
import { startCompletion } from '@codemirror/autocomplete'
import { api, Note, SearchHit } from './api'
import { applyBlockAt } from './completions'
import { addProps, Change, MEMO_FOLDER, parseFront, setProp, setTags, SortName, sortNotes, tagLine, today } from './memo'

// ---- フォルダの木 ----

type TreeNode = { name: string; path: string; folders: TreeNode[]; notes: Note[] }

export function buildTree(notes: Note[]): TreeNode {
  const root: TreeNode = { name: '', path: '', folders: [], notes: [] }
  for (const note of notes) {
    const parts = note.path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/')
      let next = node.folders.find((f) => f.path === path)
      if (!next) {
        next = { name: parts[i], path, folders: [], notes: [] }
        node.folders.push(next)
      }
      node = next
    }
    node.notes.push(note)
  }
  const sort = (n: TreeNode) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    n.notes.sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    n.folders.forEach(sort)
  }
  sort(root)
  return root
}

export function folderList(notes: Note[]): string[] {
  const set = new Set<string>([''])
  for (const n of notes) {
    const parts = n.path.split('/')
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'))
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'))
}

export function Tree({ node, open, toggle, active, onOpen, onContext, onFolderContext, sort, depth = 0 }: {
  node: TreeNode
  open: Set<string>
  toggle: (path: string) => void
  active: string
  onOpen: (path: string) => void
  onContext?: (path: string, x: number, y: number) => void // 右クリック・長押し
  onFolderContext?: (path: string, x: number, y: number) => void
  sort: SortName
  depth?: number
}) {
  const day = today()
  return (
    <>
      {node.folders.map((f) => {
        const isOpen = open.has(f.path)
        return (
          <div key={f.path}>
            <button className="tree-folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(f.path)} onContextMenu={(e) => { if (!onFolderContext) return; e.preventDefault(); onFolderContext(f.path, e.clientX, e.clientY) }} aria-expanded={isOpen}>
              <ChevronRight size={14} className={`chev ${isOpen ? 'open' : ''}`} />
              {isOpen ? <FolderOpen size={15} /> : <Folder size={15} />}
              <span>{f.name}</span>
            </button>
            {isOpen && <Tree node={f} open={open} toggle={toggle} active={active} onOpen={onOpen} onContext={onContext} onFolderContext={onFolderContext} sort={sort} depth={depth + 1} />}
          </div>
        )
      })}
      {sortNotes(node.notes, sort, day).map((n) => (
        <button key={n.path} className={`note-item ${active === n.path ? 'active' : ''} ${n.task ? 'task' : ''} ${n.done ? 'done' : ''}`} style={{ paddingLeft: 8 + depth * 14 + 16 }} onClick={() => onOpen(n.path)} onContextMenu={(e) => { if (!onContext) return; e.preventDefault(); onContext(n.path, e.clientX, e.clientY) }} title={`${n.path}${n.date ? `\ndate: ${n.date}` : ''}${n.task_day ? `\n遂行日: ${n.task_day}` : ''}`}>
          {n.task ? (n.done ? <CheckSquare size={15} className="file-icon" /> : <Square size={15} className="file-icon" />) : <FileText size={15} className="file-icon" />}
          <span>{n.name}</span>
          {sort.startsWith('遂行日') || sort === 'おすすめ'
            ? n.task_day && <small className={!n.done && n.task_day < day ? 'late' : n.task_day === day ? 'today' : ''}>{n.task_day.slice(5).replace('-', '/')}</small>
            : n.date && <small>{n.date.slice(0, 10).replace(/-/g, '/').slice(2)}</small>}
        </button>
      ))}
    </>
  )
}

// ---- クイック検索(Ctrl+K): 名前はすぐ、本文はサーバーで探す ----

export function QuickSwitcher({ notes, initial, onOpen, onCreate, onClose }: {
  notes: Note[]
  initial: string
  onOpen: (path: string) => void
  onCreate: (name: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState(initial)
  const [index, setIndex] = useState(0)
  const [remote, setRemote] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  const tagQuery = q.startsWith('#') && q.length > 1 ? q.slice(1) : ''
  const local = useMemo(() => {
    if (tagQuery) return []
    const s = q.trim().toLowerCase()
    // 並びは date の新しい順(ファイルの更新日時ではなく)
    if (!s) return sortNotes(notes.filter((n) => n.date), '日付が新しい順').slice(0, 12).map((n) => ({ path: n.path, name: n.name, snippet: null as string | null }))
    return sortNotes(notes.filter((n) => n.path.toLowerCase().includes(s)), '日付が新しい順').slice(0, 30).map((n) => ({ path: n.path, name: n.name, snippet: null as string | null }))
  }, [q, notes, tagQuery])

  useEffect(() => {
    const s = q.trim()
    setRemote([])
    if (!s || (s.startsWith('#') && s.length < 2)) return
    setBusy(true)
    const t = setTimeout(async () => {
      try {
        const params = tagQuery ? `tag=${encodeURIComponent(tagQuery)}` : `q=${encodeURIComponent(s)}`
        const r = await api<{ items: SearchHit[] }>(`/api/search?${params}`)
        setRemote(r.items)
      } catch {
        setRemote([])
      } finally {
        setBusy(false)
      }
    }, 250)
    return () => { clearTimeout(t); setBusy(false) }
  }, [q, tagQuery])

  const seen = new Set(local.map((l) => l.path))
  const byPath = useMemo(() => new Map(notes.map((n) => [n.path, n])), [notes])
  // 本文で見つかったものも date の新しい順に
  const remoteSorted = sortNotes(remote.filter((r) => !seen.has(r.path)).map((r) => ({ ...(byPath.get(r.path) ?? { path: r.path, name: r.name }), snippet: r.snippet } as Note & { snippet?: string | null })), '日付が新しい順') as (Note & { snippet?: string | null })[]
  const results = [...local, ...remoteSorted.map((r) => ({ path: r.path, name: r.name, snippet: r.snippet ?? null }))]
  const dateOf = (path: string) => byPath.get(path)?.date?.slice(0, 10)
  const canCreate = !!q.trim() && !tagQuery && !notes.some((n) => n.name === q.trim())
  const total = results.length + (canCreate ? 1 : 0)
  useEffect(() => { setIndex(0) }, [q])

  const choose = (i: number) => {
    if (i < results.length) onOpen(results[i].path)
    else if (canCreate) onCreate(q.trim())
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal switcher" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="ノートを探す">
        <div className="switcher-input">
          <Search size={17} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ノート名・本文を探す(#タグ でタグ)"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(total - 1, i + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)) }
              else if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); choose(index) }
              else if (e.key === 'Escape') onClose()
            }}
          />
          {busy && <span className="spinner" aria-label="探しています" />}
          <button className="icon-button" onClick={onClose} aria-label="閉じる"><X size={16} /></button>
        </div>
        <div className="switcher-list">
          {!q.trim() && <div className="switcher-section">新しいメモ(date の新しい順)</div>}
          {results.map((r, i) => (
            <button key={r.path} className={`switcher-item ${i === index ? 'selected' : ''}`} onMouseMove={() => setIndex(i)} onClick={() => choose(i)}>
              <FileText size={15} />
              <span className="switcher-main">
                <b>{r.name}</b>
                <small>{dateOf(r.path) ? `${dateOf(r.path)} · ` : ''}{r.path}</small>
                {r.snippet && <em>{r.snippet}</em>}
              </span>
            </button>
          ))}
          {canCreate && (
            <button className={`switcher-item create ${index === results.length ? 'selected' : ''}`} onMouseMove={() => setIndex(results.length)} onClick={() => choose(results.length)}>
              <span className="plus">＋</span><span className="switcher-main"><b>「{q.trim()}」を新しく作る</b></span>
            </button>
          )}
          {q.trim() && !busy && total === 0 && <div className="switcher-empty">見つかりませんでした</div>}
        </div>
        <div className="switcher-foot">↑↓ 選ぶ · Enter 開く · Esc 閉じる</div>
      </div>
    </div>
  )
}

// ---- 新しいノート(メモ・タスク)。きまりどおりのプロパティを付けて作る ----

export function NewNoteDialog({ folders, defaultFolder, defaultName, onCreate, onClose }: {
  folders: string[]
  defaultFolder: string
  defaultName: string
  onCreate: (folder: string, name: string, kind: 'memo' | 'task', day: string, tags: string[]) => Promise<string | null>
  onClose: () => void
}) {
  const [name, setName] = useState(defaultName)
  const [folder, setFolder] = useState(defaultFolder)
  const [kind, setKind] = useState<'memo' | 'task'>('memo')
  const [day, setDay] = useState(today())
  const [tags, setTags] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const bad = /[\\/:*?"<>|]/.test(name) || name.startsWith('.')
  const tagList = tags.split(/[\s,、]+/).map((t) => t.replace(/^#/, '')).filter(Boolean)
  const badTag = tagList.some((t) => /^\d+$/.test(t.replace(/\//g, '')))
  const submit = async () => {
    if (!name.trim() || bad || badTag || busy) return
    setBusy(true)
    const err = await onCreate(folder, name.trim(), kind, day, tagList)
    setBusy(false)
    if (err) setError(err)
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal small" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <h2>新しく作る</h2>
        <div className="seg" role="radiogroup" aria-label="種類">
          <button type="button" className={kind === 'memo' ? 'on' : ''} onClick={() => setKind('memo')}>メモ</button>
          <button type="button" className={kind === 'task' ? 'on' : ''} onClick={() => setKind('task')}>タスク</button>
        </div>
        <label className="field">名前<input autoFocus value={name} onChange={(e) => { setName(e.target.value); setError('') }} placeholder={kind === 'task' ? 'タスクの名前' : 'メモの名前'} /></label>
        {bad && <p className="field-error">\ / : * ? " &lt; &gt; | は使えません</p>}
        {kind === 'task' && <label className="field">遂行日<input type="date" value={day} onChange={(e) => setDay(e.target.value)} required /></label>}
        <label className="field">タグ(空白で区切る・なくてもよい)<input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="例: ものづくり 電子工作" /></label>
        {badTag && <p className="field-error">数字だけのタグは使えません</p>}
        <label className="field">フォルダ
          <select value={folder} onChange={(e) => setFolder(e.target.value)}>
            {folders.map((f) => <option key={f} value={f}>{f || '(いちばん上)'}{f === MEMO_FOLDER ? '(ふだんはここ)' : ''}</option>)}
          </select>
        </label>
        <p className="field-note">プロパティ: {kind === 'task' ? `遂行日: ${day} / 完了: false / ` : ''}date: '{today()}'{tagList.length ? ` ・タグ: ${tagList.map((t) => '#' + t).join(' ')}` : ''}</p>
        {error && <p className="field-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>やめる</button>
          <button type="submit" className="btn primary" disabled={!name.trim() || bad || badTag || busy}>作る</button>
        </div>
      </form>
    </div>
  )
}

// ---- 競合の差分(行ごと) ----

type DiffLine = { kind: 'same' | 'mine' | 'server'; text: string }

export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n')
  const y = b.split('\n')
  if (x.length * y.length > 4_000_000) {
    return [...x.map((t) => ({ kind: 'mine' as const, text: t })), ...y.map((t) => ({ kind: 'server' as const, text: t }))]
  }
  // 最長共通部分列(LCS)で、同じ行・自分だけ・サーバーだけに分ける
  const n = x.length
  const m = y.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ kind: 'same', text: x[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'mine', text: x[i++] })
    else out.push({ kind: 'server', text: y[j++] })
  }
  while (i < n) out.push({ kind: 'mine', text: x[i++] })
  while (j < m) out.push({ kind: 'server', text: y[j++] })
  return out
}

export function DiffDialog({ mine, server, onClose }: { mine: string; server: string; onClose: () => void }) {
  const lines = useMemo(() => lineDiff(mine, server), [mine, server])
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="差分">
        <div className="modal-head"><h2>差分</h2><button className="icon-button" onClick={onClose} aria-label="閉じる"><X size={16} /></button></div>
        <p className="diff-legend"><span className="mine">＋ 自分の版だけにある行</span><span className="server">− サーバーの版だけにある行</span></p>
        <pre className="diff">{lines.map((l, k) => <div key={k} className={`diff-${l.kind}`}>{l.kind === 'mine' ? '+ ' : l.kind === 'server' ? '- ' : '  '}{l.text || ' '}</div>)}</pre>
      </div>
    </div>
  )
}

// ---- 小さなメニュー(三点リーダーなど) ----

export type MenuItem = { label: string; onClick: () => void; disabled?: boolean; danger?: boolean } | 'sep'

export function Dropdown({ items, onClose, at }: { items: MenuItem[]; onClose: () => void; at?: { x: number; y: number } }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    setTimeout(() => document.addEventListener('mousedown', away))
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [onClose])
  return (
    <div className={`dropdown ${at ? 'floating' : ''}`} ref={ref} role="menu" style={at ? { left: Math.min(at.x, window.innerWidth - 250), top: Math.min(at.y, window.innerHeight - 160) } : undefined}>
      {items.map((it, k) => it === 'sep'
        ? <div key={k} className="dropdown-sep" />
        : <button key={k} role="menuitem" disabled={it.disabled} className={it.danger ? 'danger' : ''} onClick={() => { onClose(); it.onClick() }}>{it.label}</button>)}
    </div>
  )
}

// ---- タイトルの下の小さな1行(日付・タグ)。プロパティは本文ではないので控えめに。
//      ほかのプロパティは「詳しく」で広げる。どれも原文の値の部分だけを書きかえる ----

export type TextChange = Change

export function NoteMeta({ text, memo, fileDate, onEdit }: {
  text: string
  memo: boolean // めもフォルダのノートか(date が必須)
  fileDate: string
  onEdit: (changes: TextChange[]) => void
}) {
  const fm = parseFront(text)
  const tl = tagLine(text)
  const props = fm?.props ?? []
  const date = props.find((p) => p.key === 'date')
  const others = props.filter((p) => !['date', '遂行日', '完了'].includes(p.key))
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [newTag, setNewTag] = useState('')
  const tags = tl?.tags ?? []
  const addTag = () => {
    const t = newTag.trim().replace(/^#/, '')
    setNewTag('')
    setAdding(false)
    if (!t || /\s/.test(t) || /^\d+$/.test(t.replace(/\//g, '')) || tags.includes(t)) return
    onEdit(setTags(text, [...tags, t]))
  }
  const dateValue = date && /^\d{4}-\d{2}-\d{2}/.test(date.value) ? date.value.slice(0, 10) : ''
  return (
    <div className="meta">
      {date
        ? <label className="meta-date" title="date(並べ替えに使う日付)">
            <input type="date" value={dateValue} onChange={(e) => e.target.value && onEdit(setProp(text, 'date', e.target.value))} aria-label="date" />
          </label>
        : memo && <span className="meta-warn">date がありません
            <button onClick={() => onEdit(addProps(text, [`date: '${today()}'`]))}>今日で付ける</button>
            {fileDate && fileDate !== today() && <button onClick={() => onEdit(addProps(text, [`date: '${fileDate}'`]))}>{fileDate} で付ける</button>}
          </span>}
      {tags.map((t) => <span key={t} className="meta-tag">#{t}<button onClick={() => onEdit(setTags(text, tags.filter((x) => x !== t)))} aria-label={`#${t} を外す`}>×</button></span>)}
      {adding
        ? <input className="meta-tag-input" autoFocus value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder="タグ" onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); addTag() } if (e.key === 'Escape') { setAdding(false); setNewTag('') } }} onBlur={addTag} />
        : <button className="meta-add" onClick={() => setAdding(true)}>+ タグ</button>}
      {others.length > 0 && <button className="meta-more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? '閉じる' : `詳しく(${others.length})`}</button>}
      {open && <div className="meta-props">
        {others.map((p) => (
          <div className="prop" key={p.line}>
            <span className="prop-key">{p.key}</span>
            {p.complex
              ? <span className="prop-ro" title="この値はソース表示で編集してください">{fm!.lines.slice(p.line + 1).filter((l, i, a) => /^\s/.test(l) && a.slice(0, i).every((x) => /^\s/.test(x))).map((l) => l.trim().replace(/^-\s*/, '')).join(', ') || '(ソースで編集)'}</span>
              : /^(true|false)$/i.test(p.value)
                ? <input type="checkbox" checked={/^true$/i.test(p.value)} onChange={(e) => onEdit(setProp(text, p.key, e.target.checked ? 'true' : 'false'))} aria-label={p.key} />
                : <PropText value={p.value} onCommit={(v) => onEdit(setProp(text, p.key, v))} />}
          </div>
        ))}
      </div>}
    </div>
  )
}

function PropText({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return <input className="prop-text" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onCommit(v)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) (e.target as HTMLInputElement).blur() }} />
}

// ---- 消す(整理待ちへ移す)。本当には消さず、あとから戻せる ----

export function DeleteDialog({ path, name, unsaved, busy, links, onSaveNow, onConfirm, onClose }: {
  path: string
  name: string
  unsaved: boolean // 保存がまだ終わっていない
  busy: boolean
  links: number | null // このノートへのリンクの数(調べ中は null)
  onSaveNow: () => void
  onConfirm: () => void
  onClose: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { cancelRef.current?.focus() }, [])
  return (
    <div className="modal-backdrop" onMouseDown={onClose} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="modal small" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-label="ノートを消す">
        <h2>「{name}」を消しますか？</h2>
        <p className="delete-where">本当には消しません。<b>整理待ち</b>(<code>_整理待ち/今日の日付/</code>)へ元の場所のまま移し、整理ログに書きます。あとから「整理待ち」から戻せます。</p>
        <p className="delete-path">{path}</p>
        {links === null ? <p className="delete-info">このノートへのリンクを調べています…</p>
          : links > 0 ? <p className="delete-warn">ほかの {links} 件のノートからリンクされています(リンクの文字はそのまま残ります)</p>
          : <p className="delete-info">このノートへのリンクはありません</p>}
        {unsaved && <p className="delete-warn">まだサーバーに保存されていない変更があります。保存が終わってから消せます。 <button type="button" className="btn tiny" onClick={onSaveNow}>今すぐ保存</button></p>}
        <div className="modal-actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onClose}>やめる</button>
          <button type="button" className="btn danger" disabled={unsaved || busy} onClick={onConfirm}>{busy ? '移しています…' : '整理待ちへ移す'}</button>
        </div>
      </div>
    </div>
  )
}

export type TrashItem = { id: number; path: string; name: string; moved_to: string; moved_at: string; exists: boolean }

export function TrashDialog({ onRestore, onClose }: { onRestore: (item: TrashItem) => Promise<string | null>; onClose: () => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null)
  const [error, setError] = useState('')
  const load = async () => {
    try { setItems((await api<{ items: TrashItem[] }>('/api/trash')).items) } catch (e) { setError((e as Error).message); setItems([]) }
  }
  useEffect(() => { void load() }, [])
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="整理待ち">
        <div className="modal-head"><h2>整理待ち</h2><button className="icon-button" onClick={onClose} aria-label="閉じる"><X size={16} /></button></div>
        <p className="delete-info">このアプリで消したノートです。本当に消すときは、ファイルの整理のときに整理待ちから消してください(ここからは消しません)。</p>
        {error && <p className="field-error">{error}</p>}
        <div className="trash-list">
          {items === null && <p className="delete-info">読みこんでいます…</p>}
          {items?.length === 0 && !error && <p className="delete-info">整理待ちはありません</p>}
          {items?.map((it) => (
            <div key={it.id} className="trash-row">
              <div><b>{it.name}</b><small>{it.path} · {new Date(it.moved_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small><small>→ {it.moved_to}</small></div>
              <button className="btn tiny" disabled={!it.exists} onClick={async () => { const err = await onRestore(it); if (err) setError(err); else void load() }}>{it.exists ? '戻す' : '見つかりません'}</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function Toast({ text, action, onAction, onClose }: { text: string; action?: string; onAction?: () => void; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 10000); return () => clearTimeout(t) }, [text, onClose])
  return (
    <div className="toast" role="status">
      <span>{text}</span>
      {action && <button onClick={() => { onAction?.(); onClose() }}>{action}</button>}
      <button className="icon-button tiny" onClick={onClose} aria-label="閉じる"><X size={14} /></button>
    </div>
  )
}

// ---- スマホ: 書いているあいだ、キーボードの真上に出す操作列。Notion表示・/ の候補もここに出す(画面の外に消えない) ----


// キーボードの高さ(画面の下からどれだけ隠れているか)
export function useKeyboardInset() {
  const [inset, setInset] = useState(0)
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = () => setInset(Math.max(0, Math.round(window.innerHeight - (vv.height + vv.offsetTop))))
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update) }
  }, [])
  return inset
}

export type BlockCmd = { label: string; hint: string; icon: string }

export function MobileBar({ view, inset, commands, menu, onPick, onClose }: {
  view: CMView | null
  inset: number
  commands: BlockCmd[]
  menu: boolean // Notion表示の改行・/ の候補を出しているとき(全部の種類を出す)
  onPick: (hint: string) => void
  onClose: () => void
}) {
  if (!view) return null
  const keep = (e: React.MouseEvent | React.PointerEvent) => e.preventDefault() // 押してもキーボードを閉じない
  const block = (hint: string) => {
    if (menu) { onPick(hint); return }
    const pos = view.state.selection.main.head
    applyBlockAt(view, hint, pos, pos)
    view.focus()
  }
  const insert = (text: string, complete = false) => {
    const { from, to } = view.state.selection.main
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: 'input.type' })
    view.focus()
    if (complete) startCompletion(view)
  }
  const quick = menu ? commands : commands.filter((c) => ['見出し 2', '箇条書き', 'チェックリスト', '番号付きリスト', '引用'].includes(c.label))
  return (
    <div className={`mobile-bar ${menu ? 'menu' : ''}`} style={{ bottom: inset }} onPointerDown={keep} onMouseDown={keep}>
      {menu && <span className="mobile-bar-label">ブロックにする</span>}
      <div className="mobile-bar-scroll">
        {quick.map((c) => <button key={c.label} onClick={() => block(c.hint)} aria-label={c.label}><b>{c.icon}</b>{menu && <small>{c.label}</small>}</button>)}
        {!menu && <>
          <button onClick={() => insert('[[', true)} aria-label="リンク"><b>[[</b></button>
          <button onClick={() => insert('#', false)} aria-label="タグ"><b>#</b></button>
          <button onClick={() => { undo(view); view.focus() }} aria-label="元に戻す"><b>↶</b></button>
        </>}
      </div>
      <button className="mobile-bar-close" onClick={() => (menu ? onClose() : view.contentDOM.blur())} aria-label={menu ? '候補を閉じる' : 'キーボードを閉じる'}>{menu ? '×' : '⌄'}</button>
    </div>
  )
}
