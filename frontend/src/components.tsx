// 画面の部品: フォルダの木・クイック検索・新しいノート・差分・メニュー
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, FileText, Folder, FolderOpen, Search, X } from 'lucide-react'
import { api, Note, SearchHit } from './api'

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

export function Tree({ node, open, toggle, active, onOpen, depth = 0 }: {
  node: TreeNode
  open: Set<string>
  toggle: (path: string) => void
  active: string
  onOpen: (path: string) => void
  depth?: number
}) {
  return (
    <>
      {node.folders.map((f) => {
        const isOpen = open.has(f.path)
        return (
          <div key={f.path}>
            <button className="tree-folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(f.path)} aria-expanded={isOpen}>
              <ChevronRight size={14} className={`chev ${isOpen ? 'open' : ''}`} />
              {isOpen ? <FolderOpen size={15} /> : <Folder size={15} />}
              <span>{f.name}</span>
            </button>
            {isOpen && <Tree node={f} open={open} toggle={toggle} active={active} onOpen={onOpen} depth={depth + 1} />}
          </div>
        )
      })}
      {node.notes.map((n) => (
        <button key={n.path} className={`note-item ${active === n.path ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 + 16 }} onClick={() => onOpen(n.path)} title={n.path}>
          <FileText size={15} className="file-icon" />
          <span>{n.name}</span>
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
    if (!s) return [...notes].sort((a, b) => (b.modified_at || '').localeCompare(a.modified_at || '')).slice(0, 12).map((n) => ({ path: n.path, name: n.name, snippet: null as string | null }))
    return notes.filter((n) => n.path.toLowerCase().includes(s)).slice(0, 30).map((n) => ({ path: n.path, name: n.name, snippet: null as string | null }))
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
  const results = [...local, ...remote.filter((r) => !seen.has(r.path))]
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
          {!q.trim() && <div className="switcher-section">最近更新したノート</div>}
          {results.map((r, i) => (
            <button key={r.path} className={`switcher-item ${i === index ? 'selected' : ''}`} onMouseMove={() => setIndex(i)} onClick={() => choose(i)}>
              <FileText size={15} />
              <span className="switcher-main">
                <b>{r.name}</b>
                <small>{r.path}</small>
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

// ---- 新しいノート ----

export function NewNoteDialog({ folders, defaultFolder, defaultName, onCreate, onClose }: {
  folders: string[]
  defaultFolder: string
  defaultName: string
  onCreate: (folder: string, name: string) => Promise<string | null>
  onClose: () => void
}) {
  const [name, setName] = useState(defaultName)
  const [folder, setFolder] = useState(defaultFolder)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const bad = /[\\/:*?"<>|]/.test(name) || name.startsWith('.')
  const submit = async () => {
    if (!name.trim() || bad || busy) return
    setBusy(true)
    const err = await onCreate(folder, name.trim())
    setBusy(false)
    if (err) setError(err)
  }
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal small" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <h2>新しいノート</h2>
        <label className="field">名前<input autoFocus value={name} onChange={(e) => { setName(e.target.value); setError('') }} placeholder="ノートの名前" /></label>
        {bad && <p className="field-error">\ / : * ? " &lt; &gt; | は使えません</p>}
        <label className="field">フォルダ
          <select value={folder} onChange={(e) => setFolder(e.target.value)}>
            {folders.map((f) => <option key={f} value={f}>{f || '(いちばん上)'}</option>)}
          </select>
        </label>
        {error && <p className="field-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>やめる</button>
          <button type="submit" className="btn primary" disabled={!name.trim() || bad || busy}>作る</button>
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

export function Dropdown({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    setTimeout(() => document.addEventListener('mousedown', away))
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [onClose])
  return (
    <div className="dropdown" ref={ref} role="menu">
      {items.map((it, k) => it === 'sep'
        ? <div key={k} className="dropdown-sep" />
        : <button key={k} role="menuitem" disabled={it.disabled} className={it.danger ? 'danger' : ''} onClick={() => { onClose(); it.onClick() }}>{it.label}</button>)}
    </div>
  )
}
