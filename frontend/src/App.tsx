import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView, keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { livePreview } from './livePreview'
import { BookOpen, ChevronDown, FilePlus2, FileText, Hash, Menu, MoreHorizontal, Search, Settings2, Wifi, WifiOff, Sparkles, Command, PenLine } from 'lucide-react'
import { enqueueSave, getDraft, listQueue, removeQueueUpTo, saveDraft } from './storage'

type Note = { path: string; name: string; modified_at?: string; size?: number }
type NoteResponse = { path: string; content: string; etag: string }
// source: Markdown をそのまま見て書く / obsidian: Obsidian のライブプレビュー(カーソルの行だけ記号が見える)
// notion: 記号はいつも隠し、改行するたびにブロックの候補を出す。どれもファイルの中身は変えない(見た目だけ)
type Presentation = 'source' | 'obsidian' | 'notion'
const PRESENTATIONS: Presentation[] = ['obsidian', 'notion', 'source']
const PRESENTATION_KEY = 'editor.presentation'

const DEMO = `---
tags:
  - ideas
  - workspace
---

# 新しいワークスペース

Obsidianの使いやすさと、Notionの見やすさを組み合わせる。

## 設計のポイント

- **入力はローカルで即時反映**
- NAS上のMarkdownを唯一の正本にする
- 通信が切れても下書きを保持する

> 保存の遅さを、入力の遅さにしない。

## リンク

[Markdown Guide](https://www.markdownguide.org/)

\`\`\`text
/ を入力するとコマンド候補が表示される
\`\`\`
`

const notePath = (path: string) => '/api/notes/' + path.split('/').map(encodeURIComponent).join('/')

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

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    const error = new Error(body.detail || `HTTP ${response.status}`) as Error & { status?: number; body?: any }
    error.status = response.status
    error.body = body
    throw error
  }
  return response.json()
}

export default function App() {
  const [notes, setNotes] = useState<Note[]>([])
  const [activePath, setActivePath] = useState('')
  const [content, setContent] = useState(DEMO)
  const [etag, setEtag] = useState<string | null>(null)
  const [presentation, setPresentation] = useState<Presentation>(() => {
    const saved = localStorage.getItem(PRESENTATION_KEY) as Presentation
    return PRESENTATIONS.includes(saved) ? saved : 'obsidian'
  })
  const [saveState, setSaveState] = useState('デモ表示')
  const [online, setOnline] = useState(navigator.onLine)
  const [query, setQuery] = useState('')
  const [showCommands, setShowCommands] = useState(false)
  const [commandIndex, setCommandIndex] = useState(0)
  // slash: / を打ったとき / block: Notion表示で改行したとき(何も選ばずに書きはじめてもよい)
  const [menuKind, setMenuKind] = useState<'slash' | 'block'>('slash')
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuLineRef = useRef(-1) // 候補を開いた行(ほかの行へ移ったら閉じる)
  const enterRef = useRef(false) // いま Enter が押された(リストを抜けたときも候補を出すため)
  const [showSettings, setShowSettings] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [apiReady, setApiReady] = useState(false)
  const [conflict, setConflict] = useState<any>(null)
  const [notice, setNotice] = useState('')
  const editorRef = useRef<any>(null)
  const timerRef = useRef<number | undefined>(undefined)
  const skipNextSaveRef = useRef(false)
  const etagRef = useRef<string | null>(null)
  const etagsRef = useRef<Record<string, string | null>>({})
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const activePathRef = useRef(activePath)
  activePathRef.current = activePath
  const retryingRef = useRef(false)
  const retryDelayRef = useRef(2000)

  const filteredNotes = useMemo(() => notes.filter(n => `${n.name} ${n.path}`.toLowerCase().includes(query.toLowerCase())), [notes, query])

  const refreshTree = useCallback(async () => {
    try {
      const result = await api<{ items: Note[] }>('/api/tree')
      setNotes(result.items)
      setApiReady(true)
    } catch {
      setApiReady(false)
    }
  }, [])

  useEffect(() => {
    refreshTree()
    const onlineHandler = () => setOnline(true)
    const offlineHandler = () => setOnline(false)
    window.addEventListener('online', onlineHandler)
    window.addEventListener('offline', offlineHandler)
    return () => {
      window.removeEventListener('online', onlineHandler)
      window.removeEventListener('offline', offlineHandler)
    }
  }, [refreshTree])

  const openNote = useCallback(async (path: string) => {
    try {
      const result = await api<NoteResponse>(notePath(path))
      const local = await getDraft(path)
      setActivePath(path)
      // スマホ幅では一覧が本文の上にかぶるので、ノートを開いたら閉じる
      if (window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(false)
      // サーバーの保存確認がまだの下書きは、古くても必ず復元する(仕様 6.5)。
      // 保存済みの下書きは使わない(ほかの端末・Obsidian での変更を古い内容で戻さないため)
      const restoredContent = local && local.dirty !== false ? local.content : result.content
      const hasLocalChanges = restoredContent !== result.content
      // Preserve the draft's original server ETag. If the server changed while this
      // draft was offline, the next PUT must conflict instead of overwriting it.
      const baseEtag = hasLocalChanges ? (local?.baseEtag ?? null) : result.etag
      setEtag(result.etag)
      etagRef.current = baseEtag
      etagsRef.current[path] = baseEtag
      skipNextSaveRef.current = !hasLocalChanges
      setContent(restoredContent)
      setSaveState(hasLocalChanges ? 'ローカル下書き' : '保存済み')
      setConflict(null)
      if (hasLocalChanges) setNotice('未送信のローカル下書きを復元しました')
      else setNotice('')
    } catch (error) {
      setNotice('ノートを開けませんでした。API接続を確認してください。')
    }
  }, [])

  useEffect(() => {
    if (!activePath) return
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false
      void saveDraft({ path: activePath, content, baseEtag: etagsRef.current[activePath] ?? etagRef.current, updatedAt: Date.now(), dirty: false })
      return
    }
    void saveDraft({ path: activePath, content, baseEtag: etagsRef.current[activePath] ?? etagRef.current, updatedAt: Date.now(), dirty: true })
    setSaveState('未保存')
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      saveChainRef.current = saveChainRef.current.then(() => sendSave(activePath, content)).catch(() => undefined)
    }, 550)
    return () => window.clearTimeout(timerRef.current)
  }, [content, activePath]) // save is deliberately debounced after local draft persistence

  const sendSave = async (path: string, nextContent: string) => {
    if (!path) return
    const mutationId = crypto.randomUUID()
    const baseEtag = etagsRef.current[path] ?? etagRef.current
    const createdAt = Date.now()
    await enqueueSave({ id: mutationId, path, content: nextContent, baseEtag, createdAt })
    if (!navigator.onLine) {
      setSaveState('オフライン・未保存')
      return
    }
    setSaveState('保存中')
    try {
      const result = await api<{ etag: string }>(notePath(path), {
        method: 'PUT',
        body: JSON.stringify({ content: nextContent, base_etag: baseEtag, mutation_id: mutationId }),
      })
      // これより古い送信待ちは、あとから送ると新しい内容を古い内容で戻してしまうので消す
      await removeQueueUpTo(path, createdAt)
      etagsRef.current[path] = result.etag
      await markSaved(path, nextContent, result.etag)
      if (activePathRef.current !== path) return
      setEtag(result.etag)
      etagRef.current = result.etag
      setSaveState('保存済み')
      setNotice('')
      void refreshTree()
    } catch (error: any) {
      if (error.status === 409) {
        setConflict(error.body)
        setSaveState('競合')
      } else {
        setSaveState(error.status ? `エラー(${error.status})・再送待ち` : '未保存・再送待ち')
      }
    }
  }

  // サーバーが保存を確認した内容は、下書きを「保存済み」にする(まだ入力が続いていれば dirty のまま)
  const markSaved = async (path: string, savedContent: string, savedEtag: string) => {
    const local = await getDraft(path)
    if (!local || local.content === savedContent) await saveDraft({ path, content: savedContent, baseEtag: savedEtag, updatedAt: Date.now(), dirty: false })
    else await saveDraft({ ...local, baseEtag: savedEtag })
  }

  // 送信待ちを再送する。ノートごとにいちばん新しい内容だけを送る(古い内容で上書きしないため)
  const retryQueue = useCallback(async () => {
    if (!navigator.onLine || retryingRef.current) return
    retryingRef.current = true
    try {
      const queue = await listQueue()
      const latest = new Map<string, (typeof queue)[number]>()
      for (const item of queue) latest.set(item.path, item)
      let failed = false
      for (const item of latest.values()) {
        try {
          const result = await api<{ etag: string }>(notePath(item.path), {
            method: 'PUT',
            body: JSON.stringify({ content: item.content, base_etag: etagsRef.current[item.path] ?? item.baseEtag, mutation_id: item.id }),
          })
          await removeQueueUpTo(item.path, item.createdAt)
          etagsRef.current[item.path] = result.etag
          await markSaved(item.path, item.content, result.etag)
          if (activePathRef.current === item.path) { setEtag(result.etag); etagRef.current = result.etag }
        } catch (error: any) {
          failed = true
          if (error.status === 409 && activePathRef.current === item.path) {
            setConflict(error.body)
            setSaveState('競合')
          }
          if (!error.status) break
        }
      }
      if (!failed) {
        retryDelayRef.current = 2000
        if (queue.length && (await listQueue()).length === 0) { setSaveState('保存済み'); void refreshTree() }
      } else retryDelayRef.current = Math.min(retryDelayRef.current * 2, 60000)
    } finally {
      retryingRef.current = false
    }
  }, [refreshTree])

  // 起動時・通信が戻ったとき、そのあとも送信待ちがあれば間隔をのばしながら再送する(仕様 6.1 の 7)
  useEffect(() => {
    if (!online) return
    let timer: number | undefined
    const loop = async () => {
      await retryQueue()
      if (!(await listQueue()).length) retryDelayRef.current = 2000
      timer = window.setTimeout(loop, retryDelayRef.current)
    }
    void loop()
    return () => window.clearTimeout(timer)
  }, [online, retryQueue])

  const createNote = async () => {
    const title = window.prompt('ノート名')
    if (!title?.trim()) return
    const path = `${title.trim().replace(/[\\/:*?"<>|]/g, '-')}.md`
    try {
      await api('/api/notes', { method: 'POST', body: JSON.stringify({ path, content: `# ${title.trim()}\n\n` }) })
      await refreshTree()
      await openNote(path)
    } catch {
      setNotice('作成できませんでした。同名ノートがないか確認してください。')
    }
  }

  // 競合: 自分の下書きを同じフォルダに別名のノートとして保存する(どちらの内容も消さない)
  const saveConflictCopy = async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
    const dir = activePath.includes('/') ? activePath.slice(0, activePath.lastIndexOf('/') + 1) : ''
    const path = `${dir}${title} (競合 ${stamp}).md`
    try {
      await api('/api/notes', { method: 'POST', body: JSON.stringify({ path, content }) })
      await refreshTree()
      setNotice(`自分の下書きを「${path}」として保存しました`)
      loadServerVersion()
    } catch {
      const blob = new Blob([content], { type: 'text/markdown' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${title}-local-conflict.md`
      a.click()
      URL.revokeObjectURL(a.href)
      setNotice('サーバーに別名保存できなかったので、下書きをファイルとしてダウンロードしました')
    }
  }

  const loadServerVersion = () => {
    if (!conflict) return
    etagRef.current = conflict.server_etag
    etagsRef.current[activePath] = conflict.server_etag
    setEtag(conflict.server_etag)
    skipNextSaveRef.current = true
    setContent(conflict.server_content ?? content)
    setConflict(null)
    setSaveState('保存済み')
    void removeQueueUpTo(activePath, Date.now())
  }

  // 候補を選んだとき: 今の行を見出し・リストなどにする(/ で開いたときはその / を消す)
  const applyBlock = (hint: string) => {
    const view: EditorView | undefined = editorRef.current?.view
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
      // コードブロック: 中の行にカーソルを置く
      const before = body ? body + '\n' : ''
      insert = before + hint
      cursor = before.length + hint.indexOf('\n') + 1
    }
    view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + cursor }, userEvent: 'input.block' })
    view.focus()
    setShowCommands(false)
  }

  const handleEditorChange = (value: string) => {
    setContent(value)
  }

  // 入力のたびに、候補を出すかどうかを決める
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
    if (!u.transactions.some(t => t.isUserEvent('input') && !t.isUserEvent('input.block'))) return
    const state = u.state
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    const before = state.doc.sliceString(line.from, head)
    const entered = enterRef.current
    enterRef.current = false
    if (/(^|\s)\/$/.test(before)) openMenu(u.view, 'slash')
    else if (presentation === 'notion' && entered && line.text.trim() === '') openMenu(u.view, 'block')
    else setShowCommands(false)
  }), [presentation])

  const togglePresentation = (value: Presentation) => {
    setPresentation(value)
    setShowCommands(false)
    localStorage.setItem(PRESENTATION_KEY, value)
  }

  const title = activePath ? activePath.split('/').pop()?.replace(/\.md$/i, '') : 'ワークスペースのプレビュー'

  // 候補はキーボードで選べる(↑↓で選択、Enter/Tabで確定、Escで閉じる)。
  // Notion表示で改行したときの候補は何も選んでいない状態で出るので、そのまま Enter や文字を打てば普通に書ける
  const menuRef = useRef({ open: false, index: 0, kind: 'slash' as 'slash' | 'block' })
  menuRef.current = { open: showCommands, index: commandIndex, kind: menuKind }
  const pick = () => {
    const { open, index } = menuRef.current
    enterRef.current = true
    if (!open) return false
    if (index < 0) { setShowCommands(false); return false }
    applyBlock(commands[index].hint)
    return true
  }
  const commandKeys = useMemo(() => Prec.highest(keymap.of([
    { key: 'ArrowDown', run: () => { if (!menuRef.current.open) return false; setCommandIndex(i => (i + 1) % commands.length); return true } },
    { key: 'ArrowUp', run: () => { if (!menuRef.current.open) return false; setCommandIndex(i => (i <= 0 ? commands.length - 1 : i - 1)); return true } },
    { key: 'Enter', run: () => pick() },
    { key: 'Tab', run: () => pick() },
    { key: 'Escape', run: () => { if (!menuRef.current.open) return false; setShowCommands(false); return true } },
  ])), [])
  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    commandKeys,
    menuListener,
    ...(presentation === 'source' ? [] : [livePreview(presentation)]),
  ], [presentation, commandKeys, menuListener])
  const saveLabel = saveState === '保存済み' ? '保存済み' : saveState

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><BookOpen size={17} /></div><span>memo</span><span className="brand-sub">workspace</span></div>
        <div className="top-actions">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(v => !v)} aria-label="メニュー"><Menu size={18}/></button>
          <div className="connection">{online && apiReady ? <Wifi size={14}/> : <WifiOff size={14}/>}<span>{apiReady ? (online ? '接続中' : 'オフライン') : 'API未接続'}</span></div>
          <button className="icon-button" onClick={() => setShowSettings(v => !v)} aria-label="設定"><Settings2 size={18}/></button>
          <button className="avatar">H</button>
        </div>
      </header>

      <div className="workspace">
        {sidebarOpen && <aside className="sidebar">
          <div className="workspace-label">WORKSPACE <ChevronDown size={13}/></div>
          <button className="side-action" onClick={createNote}><FilePlus2 size={16}/>新しいノート</button>
          <div className="search-box"><Search size={15}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="ノートを検索..." /></div>
          <div className="section-label">ページ</div>
          <div className="note-list">
            {filteredNotes.map(note => <button key={note.path} className={`note-item ${activePath === note.path ? 'active' : ''}`} onClick={() => openNote(note.path)}><FileIcon/><span>{note.name}</span></button>)}
            {filteredNotes.length === 0 && <div className="empty-list">{apiReady ? 'ノートがありません' : 'API接続後にノートを表示'}</div>}
          </div>
          <div className="sidebar-bottom"><div className="section-label">タグ</div><div className="tag-placeholder"><Hash size={14}/>タグ管理は次の実装段階</div></div>
        </aside>}

        <main className="main-area">
          <div className="document-toolbar">
            <div className="breadcrumbs"><span>Memo</span><span className="crumb-sep">/</span><strong>{title}</strong></div>
            <div className="document-actions"><span className={`save-indicator ${saveState === '保存済み' ? 'saved' : ''}`}><i/>{saveLabel}</span><button className="icon-button" aria-label="その他"><MoreHorizontal size={18}/></button></div>
          </div>

          {notice && <div className="notice">{notice}<button onClick={() => setNotice('')}>閉じる</button></div>}
          {conflict && <div className="conflict-banner"><strong>このノートは別の場所で更新されています。</strong><span>上書きせず、サーバー版を確認するか、自分の下書きを別名保存してください。</span><div><button onClick={saveConflictCopy}>自分の下書きを別名で保存</button><button onClick={() => { if (window.confirm('自分の下書きを捨てて、サーバー版を読み込みますか？')) loadServerVersion() }}>サーバー版を読み込む(下書きは捨てる)</button></div></div>}

          <article className="document">
            <div className="eyebrow">PERSONAL KNOWLEDGE BASE</div>
            <h1 className="document-title">{title}</h1>
            <div className="meta-row"><span>Markdown</span><span>·</span><span>{activePath || 'デモコンテンツ'}</span></div>
            <div className="mode-switch" role="tablist" aria-label="表示">
              <button className={presentation === 'obsidian' ? 'selected' : ''} onClick={() => togglePresentation('obsidian')}><PenLine size={14}/> Obsidian表示</button>
              <button className={presentation === 'notion' ? 'selected' : ''} onClick={() => togglePresentation('notion')}><Sparkles size={14}/> Notion表示</button>
              <button className={presentation === 'source' ? 'selected' : ''} onClick={() => togglePresentation('source')}><Command size={14}/> ソース</button>
            </div>
            <div className={`editor-wrap mode-${presentation}`} ref={wrapRef}>
              <CodeMirror
                ref={editorRef}
                value={content}
                minHeight="50vh"
                extensions={extensions}
                theme="light"
                basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: presentation === 'source', autocompletion: false }}
                onChange={handleEditorChange}
                placeholder={presentation === 'notion' ? '書きはじめる…(改行すると見出し・リストなどを選べる)' : 'ここから書き始める…'}
              />
              {showCommands && <div className="command-menu" style={{ top: menuPos.top, left: menuPos.left }}>
                <div className="command-heading">{menuKind === 'block' ? 'ブロックにする' : '挿入'} <span>↑↓で選択 · Enterで決定 · Escで閉じる</span></div>
                {commands.map((cmd, i) => <button key={cmd.label} className={i === commandIndex ? 'selected' : ''} onMouseMove={() => setCommandIndex(i)} onMouseDown={e => e.preventDefault()} onClick={() => applyBlock(cmd.hint)}><span className="command-icon">{cmd.icon}</span><span>{cmd.label}</span><small>{cmd.hint ? cmd.hint.replaceAll('\n', ' ↵ ') : '記号なし'}</small></button>)}
              </div>}
            </div>
          </article>
        </main>
      </div>

      {showSettings && <div className="settings-popover">
        <div className="settings-title">表示設定</div>
        <div className="settings-row"><div><strong>編集時の表示</strong><small>どれも書いたまま保存。見た目だけ変わる</small></div><select value={presentation} onChange={e => togglePresentation(e.target.value as Presentation)}><option value="obsidian">Obsidian表示</option><option value="notion">Notion表示</option><option value="source">ソース</option></select></div>
        <div className="settings-row"><div><strong>自動保存</strong><small>入力停止後 550ms</small></div><span className="setting-value">ON</span></div>
        <div className="settings-row"><div><strong>ローカル下書き</strong><small>IndexedDBに保持</small></div><span className="setting-value">ON</span></div>
      </div>}
      <footer className="bottom-status"><span><span className="status-dot"/> {saveLabel}</span><span>{activePath || 'デモ表示 · APIを接続するとNAS上のノートを開けます'}</span><span>UTF-8 · Markdown</span></footer>
    </div>
  )
}

function FileIcon() {
  return <span className="file-icon"><FileText size={15}/></span>
}
