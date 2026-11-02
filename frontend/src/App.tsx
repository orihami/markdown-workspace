import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BookOpen, ChevronDown, FilePlus2, Folder, Hash, Menu, MoreHorizontal, Search, Settings2, Wifi, WifiOff, PanelLeftClose, Sparkles, Command } from 'lucide-react'
import { enqueueSave, getDraft, listQueue, removeQueueItem, saveDraft } from './storage'

type Note = { path: string; name: string; modified_at?: string; size?: number }
type NoteResponse = { path: string; content: string; etag: string }
type Presentation = 'source' | 'notion'

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

const commands = [
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
  const [presentation, setPresentation] = useState<Presentation>(() => (localStorage.getItem('presentation') as Presentation) || 'source')
  const [saveState, setSaveState] = useState('デモ表示')
  const [online, setOnline] = useState(navigator.onLine)
  const [query, setQuery] = useState('')
  const [showCommands, setShowCommands] = useState(false)
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
      const result = await api<NoteResponse>(`/api/notes/${encodeURIComponent(path).replaceAll('%2F', '/')}`)
      const local = await getDraft(path)
      setActivePath(path)
      const restoredContent = local && local.updatedAt > Date.now() - 1000 * 60 * 60 * 24 ? local.content : result.content
      const hasLocalChanges = restoredContent !== result.content
      // Preserve the draft's original server ETag. If the server changed while this
      // draft was offline, the next PUT must conflict instead of overwriting it.
      const baseEtag = hasLocalChanges ? (local?.baseEtag ?? null) : result.etag
      setEtag(result.etag)
      etagRef.current = baseEtag
      etagsRef.current[path] = baseEtag
      skipNextSaveRef.current = !hasLocalChanges
      setContent(restoredContent)
      setSaveState(local ? 'ローカル下書き' : '保存済み')
      setConflict(null)
      if (local && local.content !== result.content) setNotice('未送信のローカル下書きを復元しました')
      else setNotice('')
    } catch (error) {
      setNotice('ノートを開けませんでした。API接続を確認してください。')
    }
  }, [])

  useEffect(() => {
    if (!activePath) return
    void saveDraft({ path: activePath, content, baseEtag: etagsRef.current[activePath] ?? etagRef.current, updatedAt: Date.now() })
    if (skipNextSaveRef.current) { skipNextSaveRef.current = false; return }
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
    await enqueueSave({ id: mutationId, path, content: nextContent, baseEtag, createdAt: Date.now() })
    if (!navigator.onLine) {
      setSaveState('オフライン・未保存')
      return
    }
    setSaveState('保存中')
    try {
      const result = await api<{ etag: string }>('/api/notes/' + path.split('/').map(encodeURIComponent).join('/'), {
        method: 'PUT',
        body: JSON.stringify({ content: nextContent, base_etag: baseEtag, mutation_id: mutationId }),
      })
      await removeQueueItem(mutationId)
      setEtag(result.etag)
      etagRef.current = result.etag
      etagsRef.current[path] = result.etag
      setSaveState('保存済み')
      setNotice('')
      void refreshTree()
    } catch (error: any) {
      if (error.status === 409) {
        setConflict(error.body)
        setSaveState('競合')
      } else {
        setSaveState('未保存・再送待ち')
      }
    }
  }

  const retryQueue = useCallback(async () => {
    if (!navigator.onLine) return
    const queue = await listQueue()
    const queueEtags: Record<string, string | null> = {}
    for (const item of queue) {
      try {
        const result = await api<{ etag: string }>('/api/notes/' + item.path.split('/').map(encodeURIComponent).join('/'), {
          method: 'PUT',
          body: JSON.stringify({ content: item.content, base_etag: queueEtags[item.path] ?? etagsRef.current[item.path] ?? item.baseEtag, mutation_id: item.id }),
        })
        await removeQueueItem(item.id)
        queueEtags[item.path] = result.etag
        etagsRef.current[item.path] = result.etag
        if (activePathRef.current === item.path) { setEtag(result.etag); etagRef.current = result.etag }
      } catch (error: any) {
        if (error.status === 409) {
          setConflict(error.body)
          setSaveState('競合')
          break
        }
        break
      }
    }
    if ((await listQueue()).length === 0) setSaveState('保存済み')
  }, [])

  useEffect(() => {
    if (online) void retryQueue()
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

  const insertCommand = (hint: string) => {
    const view = editorRef.current?.view
    if (!view) return
    const { from, to } = view.state.selection.main
    const line = view.state.doc.lineAt(from)
    const start = line.from
    const prefix = view.state.doc.sliceString(start, from)
    const slashAt = prefix.lastIndexOf('/')
    const replaceFrom = slashAt >= 0 ? start + slashAt : from
    view.dispatch({ changes: { from: replaceFrom, to, insert: hint }, selection: { anchor: replaceFrom + hint.length } })
    view.focus()
    setShowCommands(false)
  }

  const handleEditorChange = (value: string) => {
    setContent(value)
    const view = editorRef.current?.view
    if (view) {
      const cursor = view.state.selection.main.head
      const line = view.state.doc.lineAt(cursor)
      const before = view.state.doc.sliceString(line.from, cursor)
      setShowCommands(/(^|\\s)\\/$/.test(before))
    }
  }

  const togglePresentation = (value: Presentation) => {
    setPresentation(value)
    localStorage.setItem('presentation', value)
  }

  const title = activePath ? activePath.split('/').pop()?.replace(/\\.md$/i, '') : 'ワークスペースのプレビュー'
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
          {conflict && <div className="conflict-banner"><strong>このノートは別の場所で更新されています。</strong><span>上書きせず、サーバー版を確認するか、自分の下書きを別名保存してください。</span><div><button onClick={() => { setContent(conflict.server_content || content); setEtag(conflict.server_etag); setConflict(null); setSaveState('サーバー版を読み込み'); }}>サーバー版を読み込む</button><button onClick={() => { const blob = new Blob([content], { type: 'text/markdown' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${title}-local-conflict.md`; a.click(); URL.revokeObjectURL(a.href); }}>自分の下書きを保存</button></div></div>}

          <article className="document">
            <div className="eyebrow">PERSONAL KNOWLEDGE BASE</div>
            <h1 className="document-title">{title}</h1>
            <div className="meta-row"><span>Markdown</span><span>·</span><span>{activePath || 'デモコンテンツ'}</span></div>
            <div className="mode-switch">
              <button className={presentation === 'source' ? 'selected' : ''} onClick={() => togglePresentation('source')}><Command size={14}/> Markdown編集</button>
              <button className={presentation === 'notion' ? 'selected' : ''} onClick={() => togglePresentation('notion')}><Sparkles size={14}/> Notion表示</button>
            </div>
            {presentation === 'source' ? <div className="editor-wrap">
              <CodeMirror
                ref={editorRef}
                value={content}
                height="calc(100vh - 300px)"
                extensions={[markdown()]}
                theme="light"
                basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: true, autocompletion: true }}
                onChange={handleEditorChange}
                placeholder="ここから書き始める..."
              />
              {showCommands && <div className="command-menu">
                <div className="command-heading">INSERT BLOCK <span>↑↓で選択 · Enterで挿入</span></div>
                {commands.map((cmd, i) => <button key={cmd.label} onMouseDown={e => e.preventDefault()} onClick={() => insertCommand(cmd.hint)}><span className="command-icon">{cmd.icon}</span><span>{cmd.label}</span><small>{cmd.hint.replaceAll('\n', ' ↵ ')}</small></button>)}
              </div>}
            </div> : <div className="rendered-document">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              <button className="edit-from-preview" onClick={() => togglePresentation('source')}>編集に戻る</button>
            </div>}
          </article>
        </main>
      </div>

      {showSettings && <div className="settings-popover">
        <div className="settings-title">表示設定</div>
        <div className="settings-row"><div><strong>編集時の表示</strong><small>Markdown記号を表示するか選択</small></div><select value={presentation} onChange={e => togglePresentation(e.target.value as Presentation)}><option value="source">Markdown編集</option><option value="notion">Notion表示</option></select></div>
        <div className="settings-row"><div><strong>自動保存</strong><small>入力停止後 550ms</small></div><span className="setting-value">ON</span></div>
        <div className="settings-row"><div><strong>ローカル下書き</strong><small>IndexedDBに保持</small></div><span className="setting-value">ON</span></div>
      </div>}
      <footer className="bottom-status"><span><span className="status-dot"/> {saveLabel}</span><span>{activePath || 'デモ表示 · APIを接続するとNAS上のノートを開けます'}</span><span>UTF-8 · Markdown</span></footer>
    </div>
  )
}

function FileIcon() {
  return <span className="file-icon"><Folder size={14}/></span>
}
