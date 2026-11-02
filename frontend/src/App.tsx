import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView, keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { AlertTriangle, BookOpen, Check, CircleDot, CloudOff, Command, FilePlus2, Hash, Loader2, Menu, MoreHorizontal, PenLine, Search, Settings2, Sparkles, Wifi, WifiOff, X } from 'lucide-react'
import { api, ApiError, Note, NoteResponse, notePath, TagCount } from './api'
import { engine, SaveStatus, STATUS_LABEL } from './sync'
import { livePreview, LiveMode } from './livePreview'
import { workspaceCompletions } from './completions'
import { buildTree, DiffDialog, Dropdown, folderList, MenuItem, NewNoteDialog, PropsPanel, QuickSwitcher, TextChange, Tree } from './components'
import { inMemoFolder, MEMO_FOLDER, newNoteContent, parseFront, SortName, SORTS } from './memo'

// 表示(仕様 4.3)。どれも同じエディタで直接書き、ファイルの中身は変えない(見た目だけ)
//   obsidian: ライブプレビュー(カーソルの行だけ記号が見える) / notion: 記号を隠し、改行で候補 / source: 記号をそのまま
type Presentation = LiveMode
const PRESENTATIONS: { id: Presentation; label: string }[] = [
  { id: 'obsidian', label: 'Obsidian表示' },
  { id: 'notion', label: 'Notion表示' },
  { id: 'source', label: 'ソース' },
]

const commands = [
  { label: 'テキスト', hint: '', icon: 'T' },
  { label: '見出し 1', hint: '# ', icon: 'H1' },
  { label: '見出し 2', hint: '## ', icon: 'H2' },
  { label: '見出し 3', hint: '### ', icon: 'H3' },
  { label: '箇条書き', hint: '- ', icon: '•' },
  { label: '番号付きリスト', hint: '1. ', icon: '1.' },
  { label: 'チェックリスト', hint: '- [ ] ', icon: '☑' },
  { label: '引用', hint: '> ', icon: '❞' },
  { label: 'コードブロック', hint: '```\n\n```', icon: '</>' },
  { label: '区切り線', hint: '---', icon: '—' },
]

const load = (key: string, def: string) => { try { return localStorage.getItem(key) ?? def } catch { return def } }
const store = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* 保存できなくても動く */ } }
const isMobile = () => window.matchMedia('(max-width: 760px)').matches
const folderOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const nameOf = (path: string) => path.split('/').pop()!.replace(/\.md$/i, '')
const hashPath = () => { try { return decodeURIComponent(location.hash.replace(/^#\/?/, '')) } catch { return '' } }

const STATUS_ICON: Record<SaveStatus, JSX.Element> = {
  saved: <Check size={13} />,
  saving: <Loader2 size={13} className="spin" />,
  unsaved: <CircleDot size={13} />,
  offline: <CloudOff size={13} />,
  conflict: <AlertTriangle size={13} />,
  error: <AlertTriangle size={13} />,
}

export default function App() {
  useSyncExternalStore(engine.subscribe, () => engine.version)
  const [notes, setNotes] = useState<Note[]>([])
  const [tags, setTags] = useState<TagCount[]>([])
  const [apiOk, setApiOk] = useState<boolean | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [active, setActive] = useState('')
  const [doc, setDoc] = useState<{ path: string; content: string; seq: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [presentation, setPresentation] = useState<Presentation>(() => {
    const saved = load('editor.presentation', 'obsidian') as Presentation
    return PRESENTATIONS.some((p) => p.id === saved) ? saved : 'obsidian'
  })
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobile())
  const [filter, setFilter] = useState('')
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => { try { return new Set(JSON.parse(load('tree.open', '[]'))) } catch { return new Set() } })
  const [tagsOpen, setTagsOpen] = useState(() => load('tags.open', '1') === '1')
  const [switcher, setSwitcher] = useState<string | null>(null)
  const [newNote, setNewNote] = useState<{ folder: string; name: string } | null>(null)
  const [noteMenu, setNoteMenu] = useState(false)
  const [settings, setSettings] = useState(false)
  const [diff, setDiff] = useState<{ mine: string; server: string } | null>(null)
  const [notice, setNotice] = useState('')
  const [vaultName, setVaultName] = useState(() => load('obsidian.vault', 'OMNI'))
  // 並べ替え(OMNIメモアプリと同じ種類。めもの sortspec と同じ「日付が新しい順」が最初)
  const [sort, setSort] = useState<SortName>(() => { const v = load('tree.sort', '日付が新しい順') as SortName; return SORTS.includes(v) ? v : '日付が新しい順' })
  // プロパティの欄に出すための、ノートの先頭部分(プロパティとタグの行)
  const [head, setHead] = useState('')

  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const notesRef = useRef(notes)
  notesRef.current = notes
  const tagsRef = useRef(tags)
  tagsRef.current = tags
  const activeRef = useRef(active)
  activeRef.current = active
  const contentRef = useRef('')
  const openSeq = useRef(0)
  const headOf = (text: string) => {
    const fm = parseFront(text)
    const start = fm ? fm.to : 0
    // プロパティと、そのあとのタグの行まで(本文を打つたびに画面全体を描き直さないため)。
    // 本文があるかどうかが分かるよう、もう1文字ふくめる
    const m = text.slice(start).match(/^(\r?\n)*(#[^\n]*)?/)
    return text.slice(0, start + (m ? m[0].length : 0) + 1)
  }
  const setText = (path: string, text: string) => {
    contentRef.current = text
    const h = headOf(text)
    setHead((prev) => {
      if (prev === h) return prev
      // 一覧の印・並び(date・遂行日・完了)もすぐ合わせる
      const props = parseFront(text)?.props ?? []
      const get = (k: string) => props.find((p) => p.key === k)?.value
      setNotes((list) => list.map((n) => n.path !== path ? n : {
        ...n,
        has_props: !!parseFront(text),
        date: get('date') || null,
        task_day: get('遂行日') || null,
        done: /^true$/i.test(get('完了') || ''),
        task: get('遂行日') !== undefined || get('完了') !== undefined,
      }))
      return h
    })
  }

  const sync = active ? engine.get(active) : null
  const tree = useMemo(() => buildTree(notes), [notes])
  const folders = useMemo(() => folderList(notes), [notes])

  // ---- サーバーから一覧・タグ ----
  const loadTree = useCallback(async () => {
    try {
      const r = await api<{ items: Note[] }>('/api/tree')
      setNotes(r.items)
      setApiOk(true)
    } catch {
      setApiOk(false)
    }
  }, [])
  const loadTags = useCallback(async () => {
    try { setTags((await api<{ items: TagCount[] }>('/api/tags')).items) } catch { /* あとで */ }
  }, [])

  // ---- ノートを開く ----
  const openNote = useCallback(async (path: string, opts: { push?: boolean } = {}) => {
    const seq = ++openSeq.current
    setLoading(true)
    setNoteMenu(false)
    try {
      const r = await api<NoteResponse>(notePath(path))
      const { content, restored } = await engine.open(path, r.content, r.etag)
      if (seq !== openSeq.current) return
      setActive(path)
      setText(path, content)
      setDoc({ path, content, seq: Date.now() })
      setNotice(restored ? '送れていなかった変更を復元しました。つながりしだい送ります' : '')
      store('last.note', path)
      if (opts.push !== false && hashPath() !== path) history.pushState(null, '', '#/' + encodeURI(path))
      // そのノートのフォルダを開いておく
      setOpenFolders((prev) => {
        const next = new Set(prev)
        const parts = path.split('/')
        for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'))
        return next
      })
      if (isMobile()) setSidebarOpen(false)
    } catch (e) {
      if (seq !== openSeq.current) return
      const err = e as ApiError
      if (err.status === 404) setNotice(`「${path}」は見つかりませんでした(移動・削除されたかもしれません)`)
      else if (err.network) {
        // サーバーに届かないときでも、端末に残した送信待ちがあればそれを開く
        const mine = await engine.mineContent(path)
        if (mine !== null) {
          setActive(path)
          setText(path, mine)
          setDoc({ path, content: mine, seq: Date.now() })
          setNotice('サーバーにつながらないので、端末に残っている内容を開きました。書いた分はつながりしだい送ります')
        } else setNotice('サーバーにつながらないので、ノートを開けません')
      } else setNotice(`ノートを開けません: ${err.message}`)
    } finally {
      if (seq === openSeq.current) setLoading(false)
    }
  }, [])

  // 起動: 送信待ちの再送・一覧・URL(#/パス)か前回のノートを開く
  useEffect(() => {
    void engine.start()
    void loadTree()
    void loadTags()
    const first = hashPath() || load('last.note', '')
    if (first) void openNote(first, { push: !hashPath() })
    const onHash = () => { const p = hashPath(); if (p && p !== activeRef.current) void openNote(p, { push: false }) }
    window.addEventListener('popstate', onHash)
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    // つながっているかを時々確かめる
    const health = setInterval(async () => {
      try { await api('/api/health', {}, 6000); setApiOk(true) } catch { setApiOk(false) }
    }, 20000)
    return () => {
      window.removeEventListener('popstate', onHash)
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
      clearInterval(health)
    }
  }, [loadTree, loadTags, openNote])

  // ---- 新しいノート ----
  // 新しいメモは ふだん「めも」に作る(Obsidian の設定と同じ)
  const openNewNote = useCallback((name = '', folder?: string) => {
    setSwitcher(null)
    const memo = notesRef.current.some((n) => inMemoFolder(n.path))
    setNewNote({ folder: folder ?? (memo ? MEMO_FOLDER : folderOf(activeRef.current)), name })
  }, [])
  const createNote = async (folder: string, name: string, content: string): Promise<string | null> => {
    const path = `${folder ? folder + '/' : ''}${name}.md`
    try {
      await api('/api/notes', { method: 'POST', body: JSON.stringify({ path, content }) })
    } catch (e) {
      const err = e as ApiError
      return err.status === 409 ? '同じ名前のノートがもうあります' : err.network ? 'サーバーにつながりません' : `作れませんでした: ${err.message}`
    }
    setNewNote(null)
    await loadTree()
    await openNote(path)
    return null
  }

  // ---- リンクを押したとき ----
  const resolveNote = (target: string): Note | undefined => {
    const t = target.replace(/\.md$/i, '').toLowerCase()
    const list = notesRef.current
    const here = folderOf(activeRef.current)
    return list.find((n) => n.path.replace(/\.md$/i, '').toLowerCase() === t)
      || list.find((n) => folderOf(n.path) === here && n.name.toLowerCase() === t)
      || list.find((n) => n.name.toLowerCase() === t)
  }
  const linkRef = useRef<(kind: 'url' | 'note', target: string) => void>(() => {})
  linkRef.current = (kind, target) => {
    if (kind === 'url') {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) { window.open(target, '_blank', 'noopener'); return }
      // 相対パスの .md リンクは、このワークスペースのノートとして開く
      const rel = decodeURIComponent(target.split('#')[0])
      const base = folderOf(activeRef.current)
      const joined = (base ? base + '/' : '') + rel
      const parts: string[] = []
      for (const p of joined.split('/')) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p) }
      const found = resolveNote(parts.join('/'))
      if (found) void openNote(found.path)
      else setNotice(`リンク先が見つかりません: ${target}`)
      return
    }
    const found = resolveNote(target)
    if (found) void openNote(found.path)
    else openNewNote(target.split('/').pop() || target)
  }

  // ---- ブロックの候補(/ と、Notion表示の改行) ----
  const [showCommands, setShowCommands] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  const [menuKind, setMenuKind] = useState<'slash' | 'block'>('slash')
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuLineRef = useRef(-1)
  const enterRef = useRef(false)
  const menuRef = useRef({ open: false, index: 0, kind: 'slash' as 'slash' | 'block' })
  menuRef.current = { open: showCommands, index: commandIndex, kind: menuKind }

  const applyBlock = (hint: string) => {
    const view = editorRef.current?.view
    if (!view) return
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    let body = line.text
    let at = head - line.from
    if (menuRef.current.kind === 'slash') {
      const slash = body.lastIndexOf('/', at - 1)
      if (slash >= 0) { body = body.slice(0, slash) + body.slice(at); at = slash }
    }
    let insert: string
    let cursor: number
    if (hint === '' || (hint.endsWith(' ') && !hint.includes('\n'))) {
      // 行の頭の記号(# - > 1. - [ ])を入れかえる
      const old = body.match(/^(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+\. |> )/)?.[0].length ?? 0
      insert = hint + body.slice(old)
      cursor = hint.length + Math.max(0, at - old)
    } else if (hint === '---') {
      insert = body ? body + '\n---\n' : '---\n'
      cursor = insert.length
    } else {
      const before = body ? body + '\n' : ''
      insert = before + hint
      cursor = before.length + hint.indexOf('\n') + 1
    }
    view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + cursor }, userEvent: 'input.block' })
    view.focus()
    setShowCommands(false)
  }
  const openMenu = (view: EditorView, kind: 'slash' | 'block') => {
    const head = view.state.selection.main.head
    const at = view.coordsAtPos(head)
    const box = wrapRef.current?.getBoundingClientRect()
    if (at && box) setMenuPos({ top: at.bottom - box.top + 6, left: Math.max(0, Math.min(at.left - box.left, box.width - 290)) })
    menuLineRef.current = view.state.doc.lineAt(head).number
    setMenuKind(kind)
    setCommandIndex(kind === 'slash' ? 0 : -1)
    setShowCommands(true)
  }
  const menuListener = useMemo(() => EditorView.updateListener.of((u) => {
    if (!u.docChanged) {
      if (u.selectionSet && menuRef.current.open && u.state.doc.lineAt(u.state.selection.main.head).number !== menuLineRef.current) setShowCommands(false)
      return
    }
    if (!u.transactions.some((t) => t.isUserEvent('input') && !t.isUserEvent('input.block') && !t.isUserEvent('input.props'))) return
    const head = u.state.selection.main.head
    const line = u.state.doc.lineAt(head)
    const before = u.state.doc.sliceString(line.from, head)
    const entered = enterRef.current
    enterRef.current = false
    if (/(^|\s)\/$/.test(before)) openMenu(u.view, 'slash')
    else if (presentation === 'notion' && entered && line.text.trim() === '') openMenu(u.view, 'block')
    else setShowCommands(false)
  }), [presentation])
  const pick = () => {
    const { open, index } = menuRef.current
    enterRef.current = true
    if (!open) return false
    if (index < 0) { setShowCommands(false); return false }
    applyBlock(commands[index].hint)
    return true
  }
  const commandKeys = useMemo(() => Prec.highest(keymap.of([
    { key: 'ArrowDown', run: () => { if (!menuRef.current.open) return false; setCommandIndex((i) => (i + 1) % commands.length); return true } },
    { key: 'ArrowUp', run: () => { if (!menuRef.current.open) return false; setCommandIndex((i) => (i <= 0 ? commands.length - 1 : i - 1)); return true } },
    { key: 'Enter', run: () => pick() },
    { key: 'Tab', run: () => { if (!menuRef.current.open || menuRef.current.index < 0) return false; return pick() } },
    { key: 'Escape', run: () => { if (!menuRef.current.open) return false; setShowCommands(false); return true } },
  ])), [])
  const completions = useMemo(() => workspaceCompletions(() => notesRef.current, () => tagsRef.current), [])
  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    commandKeys,
    menuListener,
    completions,
    livePreview(presentation, (k, t) => linkRef.current(k, t)),
  ], [presentation, commandKeys, menuListener, completions])

  const choosePresentation = (p: Presentation) => {
    setPresentation(p)
    setShowCommands(false)
    store('editor.presentation', p)
  }

  // ---- キーボード(仕様 4.5) ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (mod && k === 'k') { e.preventDefault(); void loadTree(); setSwitcher('') }
      // Ctrl+N はブラウザが新しいウィンドウに使うことがあるので Alt+N でも
      else if ((mod || e.altKey) && k === 'n') { e.preventDefault(); openNewNote() }
      else if (mod && k === 's') { e.preventDefault(); engine.saveNow(activeRef.current || undefined) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [loadTree, openNewNote])

  // ---- 競合(仕様 6.4): 勝手にどちらかを捨てない ----
  const showDiff = async () => {
    const c = sync?.conflict
    if (!c) return
    setDiff({ mine: (await engine.mineContent(active)) ?? contentRef.current, server: c.serverContent ?? '' })
  }
  const copyMineThenUseServer = async () => {
    const mine = (await engine.mineContent(active)) ?? contentRef.current
    const stamp = new Date().toLocaleString('sv-SE').slice(0, 16).replace(/[-:]/g, '').replace(' ', '-')
    const copyName = `${nameOf(active)} (競合 ${stamp})`
    const err = await createNoteRaw(folderOf(active), copyName, mine)
    if (err) { setNotice(`自分の版を別名で保存できませんでした: ${err}。ノートはそのままです`); return }
    const server = await engine.useServer(active)
    setText(active, server ?? '')
    setDoc({ path: active, content: server ?? '', seq: Date.now() })
    setNotice(`自分の版を「${copyName}」として保存し、このノートはサーバーの版にしました`)
    void loadTree()
  }
  const keepMine = async () => {
    if (!window.confirm('サーバーの版を、いま画面にある自分の版で上書きします。サーバー側の変更は消えます。よいですか？')) return
    await engine.keepMine(active)
  }
  const createNoteRaw = async (folder: string, name: string, content: string) => {
    try {
      await api('/api/notes', { method: 'POST', body: JSON.stringify({ path: `${folder ? folder + '/' : ''}${name}.md`, content }) })
      return null
    } catch (e) { return (e as ApiError).message }
  }

  // ---- 三点メニュー ----
  const noteMenuItems: MenuItem[] = active ? [
    { label: 'Obsidian で開く', onClick: () => { location.href = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(active.replace(/\.md$/i, ''))}` } },
    { label: 'パスをコピー', onClick: async () => { try { await navigator.clipboard.writeText(active); setNotice('パスをコピーしました') } catch { window.prompt('パス', active) } } },
    { label: 'Markdown をダウンロード', onClick: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([contentRef.current], { type: 'text/markdown' })); a.download = active.split('/').pop()!; a.click(); URL.revokeObjectURL(a.href) } },
    { label: 'サーバーから読み直す', onClick: () => void openNote(active, { push: false }) },
    'sep',
    { label: 'このフォルダに新しく作る', onClick: () => openNewNote('', folderOf(active)) },
    'sep',
    ...PRESENTATIONS.map((p) => ({ label: `${presentation === p.id ? '✓ ' : '　'}${p.label}`, onClick: () => choosePresentation(p.id) })),
  ] : []

  // プロパティの欄からの変更も、ふつうの入力と同じくエディタに書く(元に戻す・保存が同じ流れになる)
  const editHead = (changes: TextChange[]) => {
    const view = editorRef.current?.view
    if (!view) return
    view.dispatch({ changes, userEvent: 'input.props' })
  }

  const toggleFolder = (path: string) => setOpenFolders((prev) => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path); else next.add(path)
    store('tree.open', JSON.stringify([...next]))
    return next
  })
  const filtered = useMemo(() => {
    const s = filter.trim().toLowerCase()
    return s ? notes.filter((n) => n.path.toLowerCase().includes(s)).slice(0, 200) : []
  }, [filter, notes])
  const pending = engine.pending()
  const connected = online && apiOk !== false
  const recent = useMemo(() => [...notes].sort((a, b) => (b.modified_at || '').localeCompare(a.modified_at || '')).slice(0, 8), [notes])
  const statusMsg = sync && sync.message && sync.status !== 'saved' && sync.status !== 'conflict' ? sync.message : ''

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <button className="icon-button" onClick={() => setSidebarOpen((v) => !v)} aria-label="一覧を開く・閉じる"><Menu size={19} /></button>
          <div className="brand-mark"><BookOpen size={17} /></div><span>memo</span>
        </div>
        <button className="top-search" onClick={() => { void loadTree(); setSwitcher('') }}><Search size={15} /><span>ノートを探す</span><kbd>Ctrl K</kbd></button>
        <div className="top-actions">
          <span className={`connection ${connected ? 'ok' : 'down'}`} title={connected ? 'サーバーにつながっています' : 'サーバーにつながっていません。書いた分は端末に残し、つながりしだい送ります'}>
            {connected ? <Wifi size={14} /> : <WifiOff size={14} />}<span>{!online ? 'オフライン' : apiOk === false ? 'サーバー停止中' : '接続中'}</span>
          </span>
          <button className="icon-button" onClick={() => setSettings((v) => !v)} aria-label="設定"><Settings2 size={18} /></button>
        </div>
      </header>

      <div className="workspace">
        {sidebarOpen && isMobile() && <div className="drawer-backdrop" onClick={() => setSidebarOpen(false)} />}
        {sidebarOpen && <aside className="sidebar">
          <button className="side-action" onClick={() => openNewNote()}><FilePlus2 size={16} />新しいメモ・タスク</button>
          <div className="search-box">
            <Search size={15} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="名前でしぼりこむ" onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { setSwitcher(filter); setFilter('') } }} />
            {filter && <button className="icon-button tiny" onClick={() => setFilter('')} aria-label="消す"><X size={14} /></button>}
          </div>
          <label className="sort-box">並べ替え
            <select value={sort} onChange={(e) => { setSort(e.target.value as SortName); store('tree.sort', e.target.value) }}>
              {SORTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <div className="note-list">
            {filter.trim()
              ? <>
                  {filtered.map((n) => <button key={n.path} className={`note-item ${active === n.path ? 'active' : ''}`} onClick={() => openNote(n.path)} title={n.path}><span>{n.name}</span><small>{folderOf(n.path)}</small></button>)}
                  <button className="note-item more" onClick={() => { setSwitcher(filter); setFilter('') }}><Search size={14} /><span>本文からも探す(Enter)</span></button>
                </>
              : <Tree node={tree} open={openFolders} toggle={toggleFolder} active={active} onOpen={(p) => void openNote(p)} sort={sort} />}
            {apiOk === false && !notes.length && <div className="empty-list">サーバーにつながりません</div>}
            {apiOk && !notes.length && <div className="empty-list">ノートがありません</div>}
          </div>
          <div className="sidebar-bottom">
            <button className="section-toggle" onClick={() => { setTagsOpen((v) => !v); store('tags.open', tagsOpen ? '0' : '1') }}><Hash size={13} />タグ {tags.length ? `(${tags.length})` : ''}</button>
            {tagsOpen && <div className="tag-cloud">
              {tags.slice(0, 40).map((t) => <button key={t.tag} className="tag-chip" onClick={() => setSwitcher('#' + t.tag)}>#{t.tag}<small>{t.count}</small></button>)}
              {!tags.length && <span className="empty-list">タグはまだありません</span>}
            </div>}
          </div>
        </aside>}

        <main className="main-area">
          {doc ? <>
            <div className="document-toolbar">
              <div className="breadcrumbs" title={active}>
                {folderOf(active).split('/').filter(Boolean).map((f, k) => <span key={k} className="crumb">{f}<span className="crumb-sep">/</span></span>)}
                <strong>{nameOf(active)}</strong>
              </div>
              <div className="document-actions">
                {sync && <button className={`save-indicator s-${sync.status}`} title={sync.message || STATUS_LABEL[sync.status]} onClick={() => engine.saveNow(active)} aria-live="polite">
                  {STATUS_ICON[sync.status]}<span>{STATUS_LABEL[sync.status]}</span>
                </button>}
                <div className="menu-anchor">
                  <button className="icon-button" onClick={() => setNoteMenu((v) => !v)} aria-label="ノートのメニュー" aria-expanded={noteMenu}><MoreHorizontal size={18} /></button>
                  {noteMenu && <Dropdown items={noteMenuItems} onClose={() => setNoteMenu(false)} />}
                </div>
              </div>
            </div>

            {statusMsg && <div className={`status-strip s-${sync!.status}`}>{statusMsg}</div>}
            {notice && <div className="notice">{notice}<button onClick={() => setNotice('')} aria-label="閉じる"><X size={14} /></button></div>}
            {sync?.status === 'conflict' && <div className="conflict-banner">
              <strong>このノートは、ほかの場所(Obsidian・別の端末など)で更新されています。</strong>
              <span>どちらの内容も消さずに置いてあります。どうするか選んでください。</span>
              <div>
                <button onClick={showDiff}>差分を見る</button>
                <button onClick={copyMineThenUseServer}>自分の版を別名で保存して、サーバーの版にする</button>
                <button onClick={keepMine}>自分の版で上書きする</button>
              </div>
            </div>}

            <article className="document">
              <h1 className="document-title">{nameOf(active)}</h1>
              <div className="mode-switch" role="tablist" aria-label="表示">
                <button className={presentation === 'obsidian' ? 'selected' : ''} onClick={() => choosePresentation('obsidian')}><PenLine size={14} /> Obsidian</button>
                <button className={presentation === 'notion' ? 'selected' : ''} onClick={() => choosePresentation('notion')}><Sparkles size={14} /> Notion</button>
                <button className={presentation === 'source' ? 'selected' : ''} onClick={() => choosePresentation('source')}><Command size={14} /> ソース</button>
              </div>
              <PropsPanel
                text={head}
                memo={inMemoFolder(active)}
                fileDate={(() => { const m = notes.find((n) => n.path === active)?.modified_at; return m ? new Date(m).toLocaleDateString('sv-SE') : '' })()}
                onEdit={editHead}
              />
              <div className={`editor-wrap mode-${presentation} ${loading ? 'loading' : ''}`} ref={wrapRef}>
                <CodeMirror
                  key={doc.path + ':' + doc.seq}
                  ref={editorRef}
                  value={doc.content}
                  minHeight="55vh"
                  extensions={extensions}
                  theme="light"
                  basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: presentation === 'source', autocompletion: false, searchKeymap: true }}
                  onChange={(v) => { setText(doc.path, v); engine.edit(doc.path, v) }}
                  placeholder={presentation === 'notion' ? '書きはじめる…(改行すると見出し・リストなどを選べる)' : 'ここから書きはじめる…  / で見出しやリスト、[[ でノートへのリンク'}
                />
                {showCommands && <div className="command-menu" style={{ top: menuPos.top, left: menuPos.left }}>
                  <div className="command-heading">{menuKind === 'block' ? 'ブロックにする' : '挿入'} <span>↑↓ · Enter · Esc</span></div>
                  {commands.map((cmd, i) => <button key={cmd.label} className={i === commandIndex ? 'selected' : ''} onMouseMove={() => setCommandIndex(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => applyBlock(cmd.hint)}><span className="command-icon">{cmd.icon}</span><span>{cmd.label}</span><small>{cmd.hint ? cmd.hint.replaceAll('\n', ' ↵ ') : '記号なし'}</small></button>)}
                </div>}
              </div>
            </article>
          </> : <div className="welcome">
            {notice && <div className="notice">{notice}<button onClick={() => setNotice('')} aria-label="閉じる"><X size={14} /></button></div>}
            <h1>memo</h1>
            <p>{loading ? '開いています…' : apiOk === false ? 'サーバーにつながりません。つながると一覧が出ます。' : '左の一覧からノートを選ぶか、探してください。'}</p>
            <div className="welcome-actions">
              <button className="btn primary" onClick={() => setSwitcher('')}><Search size={15} /> ノートを探す</button>
              <button className="btn" onClick={() => openNewNote()}><FilePlus2 size={15} /> 新しいメモ・タスク</button>
            </div>
            {recent.length > 0 && <><h2>最近更新したノート</h2>
              <div className="recent">{recent.map((n) => <button key={n.path} onClick={() => openNote(n.path)}><b>{n.name}</b><small>{n.path}</small></button>)}</div></>}
          </div>}
        </main>
      </div>

      {settings && <div className="settings-popover">
        <div className="settings-head"><span className="settings-title">設定</span><button className="icon-button" onClick={() => setSettings(false)} aria-label="閉じる"><X size={16} /></button></div>
        <div className="settings-row"><div><strong>表示</strong><small>どれも書いたまま保存。見た目だけ変わる</small></div><select value={presentation} onChange={(e) => choosePresentation(e.target.value as Presentation)}>{PRESENTATIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
        <div className="settings-row"><div><strong>Obsidian の保管庫名</strong><small>「Obsidian で開く」に使う</small></div><input value={vaultName} onChange={(e) => { setVaultName(e.target.value); store('obsidian.vault', e.target.value) }} /></div>
        <div className="settings-row"><div><strong>送信待ち</strong><small>端末に残っていて、サーバーの確認がまだのもの</small></div><span className="setting-value">{pending}件 {pending > 0 && <button className="btn tiny" onClick={() => engine.saveNow()}>今すぐ送る</button>}</span></div>
        <div className="settings-row"><div><strong>キー</strong><small>Ctrl+K 探す · Alt+N 新しいノート · Ctrl+S すぐ保存 · / 候補 · [[ リンク</small></div></div>
      </div>}

      <footer className="bottom-status">
        <span>{sync ? <>{STATUS_ICON[sync.status]} {STATUS_LABEL[sync.status]}</> : ''}{pending > 0 && <em> · 送信待ち {pending}件</em>}</span>
        <span>{active}</span>
        <span>UTF-8 · Markdown</span>
      </footer>

      {switcher !== null && <QuickSwitcher notes={notes} initial={switcher} onClose={() => setSwitcher(null)} onOpen={(p) => { setSwitcher(null); void openNote(p) }} onCreate={(name) => openNewNote(name)} />}
      {newNote && <NewNoteDialog folders={folders} defaultFolder={newNote.folder} defaultName={newNote.name} onClose={() => setNewNote(null)} onCreate={(f, n, kind, day, tags) => createNote(f, n, newNoteContent(kind, { day, tags }))} />}
      {diff && <DiffDialog mine={diff.mine} server={diff.server} onClose={() => setDiff(null)} />}
    </div>
  )
}
