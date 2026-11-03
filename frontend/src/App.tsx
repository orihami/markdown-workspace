import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView, keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { AlertTriangle, Check, ChevronRight, CircleDot, CloudOff, FilePlus2, Hash, ListChecks, Loader2, Menu, MoreHorizontal, Plus, Search, Settings2, Star, Trash2, Wifi, WifiOff, X } from 'lucide-react'
import { api, ApiError, Note, NoteResponse, notePath, TagCount } from './api'
import { engine, SaveStatus, STATUS_LABEL } from './sync'
import { livePreview, LiveMode } from './livePreview'
import { slashSource, workspaceCompletions } from './completions'
import { buildTree, DeleteDialog, DiffDialog, Dropdown, MenuItem, MobileBar, NoteMeta, QuickSwitcher, TextChange, Toast, TrashDialog, TrashItem, Tree, useKeyboardInset } from './components'
import { applyChanges, cleanName, inMemoFolder, makeTask, MEMO_FOLDER, nameFromBody, newNoteContent, parseFront, propValue, setProp, SortName, sortNotes, SORTS, today } from './memo'
import { uuid } from './uuid'

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
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => { try { return new Set(JSON.parse(load('tree.open', '[]'))) } catch { return new Set() } })
  const [switcher, setSwitcher] = useState<string | null>(null)
  const [noteMenu, setNoteMenu] = useState(false)
  const [settings, setSettings] = useState(false)
  const [diff, setDiff] = useState<{ mine: string; server: string } | null>(null)
  const [notice, setNotice] = useState('')
  const [vaultName, setVaultName] = useState(() => load('obsidian.vault', 'OMNI'))
  // 並べ替え(OMNIメモアプリと同じ種類。めもの sortspec と同じ「日付が新しい順」が最初)
  const [sort, setSort] = useState<SortName>(() => { const v = load('tree.sort', '日付が新しい順') as SortName; return SORTS.includes(v) ? v : '日付が新しい順' })
  // プロパティの欄に出すための、ノートの先頭部分(プロパティとタグの行)
  const [head, setHead] = useState('')
  // 消す(整理待ちへ移す)
  const [del, setDel] = useState<string | null>(null)
  const [delBusy, setDelBusy] = useState(false)
  const [delLinks, setDelLinks] = useState<number | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [toast, setToast] = useState<{ text: string; action?: string; onAction?: () => void } | null>(null)
  const [ctx, setCtx] = useState<{ path: string; x: number; y: number; folder?: boolean } | null>(null)
  // お気に入り(サーバーに覚えさせ、どの端末でも同じ)
  const [favs, setFavs] = useState<{ path: string; kind: 'note' | 'folder' }[]>([])
  // 左の一覧の引き出し(ほかのフォルダ・タグはふだん閉じておく。基本は めも)
  const [secOpen, setSecOpen] = useState<Record<string, boolean>>(() => { try { return JSON.parse(load('side.sections', '{}')) } catch { return {} } })

  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const notesRef = useRef(notes)
  notesRef.current = notes
  const tagsRef = useRef(tags)
  tagsRef.current = tags
  const activeRef = useRef(active)
  activeRef.current = active
  const contentRef = useRef('')
  const openSeq = useRef(0)
  // いま開いているノートの場所(下書きのあいだは '')。エディタの入力はここを見て送る
  const docPathRef = useRef('')
  // タイトルは書いてもいいし、書かなくてもいい。書かなければ本文の書き出しを名前にする
  const [title, setTitle] = useState('')
  const titleRef = useRef(title)
  titleRef.current = title
  // 下書き: まだファイルが無い新しいメモ(書きはじめたら めも に作る)
  const [draft, setDraft] = useState<{ folder: string; kind: 'memo' | 'task' } | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  // 本文の書き出しから名前を付けている、作ったばかりのノート(タイトルを自分で書くまで、書き出しに名前を合わせる)
  const [fresh, setFresh] = useState<string | null>(null)
  const freshRef = useRef(fresh)
  freshRef.current = fresh
  const createTimer = useRef<ReturnType<typeof setTimeout>>()
  const renameTimer = useRef<ReturnType<typeof setTimeout>>()
  const creating = useRef(false)
  // ホームのすぐ書く欄
  const [capture, setCapture] = useState(() => load('capture.text', ''))
  const [captureTask, setCaptureTask] = useState(false)
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
  const loadFavs = useCallback(async () => {
    try { setFavs((await api<{ items: { path: string; kind: 'note' | 'folder' }[] }>('/api/favorites')).items) } catch { /* あとで */ }
  }, [])
  const loadTags = useCallback(async () => {
    try { setTags((await api<{ items: TagCount[] }>('/api/tags')).items) } catch { /* あとで */ }
  }, [])

  // ---- ノートを開く ----
  const openNote = useCallback(async (path: string, opts: { push?: boolean; quiet?: boolean } = {}) => {
    const seq = ++openSeq.current
    setLoading(true)
    setNoteMenu(false)
    try {
      const r = await api<NoteResponse>(notePath(path))
      const { content, restored } = await engine.open(path, r.content, r.etag)
      if (seq !== openSeq.current) return
      docPathRef.current = path
      setDraft(null)
      setFresh((f) => (f === path ? f : null))
      setTitle(nameOf(path))
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
      // 起動時に前回のノートが無くなっていたときは、知らせずに忘れる
      if (err.status === 404 && opts.quiet) store('last.note', '')
      else if (err.status === 404) setNotice(`「${path}」は見つかりませんでした(移動・削除されたかもしれません)`)
      else if (err.network) {
        // サーバーに届かないときでも、端末に残した送信待ちがあればそれを開く
        const mine = await engine.mineContent(path)
        if (mine !== null) {
          docPathRef.current = path
          setTitle(nameOf(path))
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


  // ---- 新しいメモ: 名前は聞かずに、すぐ本文を書く ----
  const memoFolder = () => (notesRef.current.some((n) => inMemoFolder(n.path)) ? MEMO_FOLDER : '')
  // 同じフォルダに同じ名前があれば「 2」「 3」…を付ける(self は名前を変えるノート自身)
  const uniqueName = (folder: string, base: string, self = '') => {
    const taken = new Set(notesRef.current.filter((n) => folderOf(n.path) === folder && n.path !== self).map((n) => n.name.toLowerCase()))
    if (!taken.has(base.toLowerCase())) return base
    for (let k = 2; ; k++) if (!taken.has(`${base} ${k}`.toLowerCase())) return `${base} ${k}`
  }
  const startDraft = useCallback((folder?: string, kind: 'memo' | 'task' = 'memo', restore?: { body: string; title: string }) => {
    setSwitcher(null)
    setNoteMenu(false)
    openSeq.current++
    docPathRef.current = ''
    setDraft({ folder: folder ?? memoFolder(), kind })
    setActive('')
    setFresh(null)
    setTitle(restore?.title ?? '')
    setHead('')
    contentRef.current = restore?.body ?? ''
    setDoc({ path: '', content: restore?.body ?? '', seq: Date.now() })
    if (hashPath()) history.pushState(null, '', '#/')
    if (isMobile()) setSidebarOpen(false)
  }, [])
  // 名前を指定して作る([[まだ無いノート]] や、探す画面の「新しく作る」)
  const createNamed = async (name: string, folder = memoFolder(), body = '') => {
    const n = uniqueName(folder, cleanName(name) || nameFromBody(body))
    const path = `${folder ? folder + '/' : ''}${n}.md`
    try {
      await api('/api/notes', { method: 'POST', body: JSON.stringify({ path, content: newNoteContent('memo') + body }) })
    } catch (e) {
      setToast({ text: `作れませんでした: ${(e as ApiError).message}` })
      return null
    }
    await loadTree()
    return path
  }
  const openNewNote = useCallback((name = '', folder?: string) => {
    if (!name) { startDraft(folder); return }
    setSwitcher(null)
    void createNamed(name, folder).then((p) => { if (p) void openNote(p) })
  }, [startDraft, openNote])

  // 下書き → ファイルにする(入力が止まって 0.7秒。サーバーに届かなければ、書いた分は端末に残して次の入力でまた試す)
  const createFromDraft = async () => {
    const d = draftRef.current
    if (!d || creating.current) return
    const body = contentRef.current
    const t = cleanName(titleRef.current)
    if (!body.trim() && !t) return
    creating.current = true
    try {
      const header = newNoteContent(d.kind, { day: today() })
      const base = t || nameFromBody(body)
      let path = ''
      let etag = ''
      for (let k = 0; k < 6 && !path; k++) {
        const p = `${d.folder ? d.folder + '/' : ''}${uniqueName(d.folder, k ? `${base} ${k + 1}` : base)}.md`
        try {
          etag = (await api<{ etag: string }>('/api/notes', { method: 'POST', body: JSON.stringify({ path: p, content: header + body }) })).etag
          path = p
        } catch (e) {
          if ((e as ApiError).status !== 409) throw e
        }
      }
      if (!path) throw new Error('同じ名前のノートが多すぎます')
      if (!draftRef.current) return
      await engine.open(path, header + body, etag)
      docPathRef.current = path
      setDraft(null)
      setActive(path)
      setDoc((cur) => (cur ? { ...cur, path } : cur))
      if (!t) setFresh(path)
      setTitle(nameOf(path))
      // エディタの先頭にもプロパティを入れる(見た目では隠れる)。作っている間に書いた分はこのあと送られる
      editorRef.current?.view?.dispatch({ changes: { from: 0, insert: header }, userEvent: 'input.props' })
      store('draft.new', '')
      store('last.note', path)
      history.replaceState(null, '', '#/' + encodeURI(path))
      void loadTree()
    } catch (e) {
      const err = e as ApiError
      setNotice(`まだ保存できていません: ${err.network ? 'サーバーにつながりません' : err.message}。書いた内容はこの端末に残っています`)
    } finally {
      creating.current = false
    }
  }

  const createFromDraftRef = useRef(createFromDraft)
  createFromDraftRef.current = createFromDraft

  // 起動: 送信待ちの再送・一覧・URL(#/パス)か前回のノートを開く
  useEffect(() => {
    void engine.start()
    void loadTree()
    void loadTags()
    void loadFavs()
    // 起動したらホーム。URL にノートが入っているとき(再読み込み・共有)だけ、そのノートを開く
    const first = hashPath()
    // 作る前の書きかけが端末に残っていれば戻す(サーバーに届く前に閉じた・止まっていたとき)
    let pendingDraft: { body: string; title: string; folder?: string; kind?: 'memo' | 'task' } | null = null
    try { pendingDraft = JSON.parse(load('draft.new', '') || 'null') } catch { pendingDraft = null }
    if (!hashPath() && pendingDraft && (pendingDraft.body.trim() || pendingDraft.title.trim())) {
      startDraft(pendingDraft.folder, pendingDraft.kind || 'memo', pendingDraft)
      setNotice('書きかけのメモを戻しました。つながりしだい めも に作ります')
      setTimeout(() => void createFromDraftRef.current(), 1500)
    } else if (first) void openNote(first, { push: false })
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
  }, [loadTree, loadTags, loadFavs, openNote, startDraft])

  // 名前を変える(保存が終わってから。上書きはしない)
  const renameTo = async (oldPath: string, newName: string, opts: { auto?: boolean } = {}) => {
    const folder = folderOf(oldPath)
    const newPath = `${folder ? folder + '/' : ''}${newName}.md`
    if (newPath === oldPath) return true
    const ok = await engine.settle(oldPath)
    if (!ok || docPathRef.current !== oldPath) {
      if (!opts.auto) setToast({ text: '保存が終わっていないので、名前はまだ変えられません' })
      return false
    }
    const snapshot = contentRef.current
    try {
      const r = await api<{ path: string; etag: string }>('/api/rename', { method: 'POST', body: JSON.stringify({ path: oldPath, new_path: newPath, base_etag: engine.baseOf(oldPath) ?? null }) })
      engine.moved(oldPath, r.path, r.etag)
      docPathRef.current = r.path
      if (freshRef.current === oldPath) setFresh(r.path)
      setActive(r.path)
      setDoc((cur) => (cur ? { ...cur, path: r.path } : cur))
      setTitle(nameOf(r.path))
      history.replaceState(null, '', '#/' + encodeURI(r.path))
      store('last.note', r.path)
      setNotes((list) => list.map((n) => (n.path === oldPath ? { ...n, path: r.path, name: nameOf(r.path) } : n)))
      setFavs((list) => list.map((f) => (f.path === oldPath ? { ...f, path: r.path } : f)))
      // 名前を変えている間に書いた分は、新しい名前で送る
      if (contentRef.current !== snapshot) engine.edit(r.path, contentRef.current)
      return true
    } catch (e) {
      const err = e as ApiError
      if (!opts.auto) setToast({ text: err.status === 409 ? (err.message.includes('同じ名前') ? '同じ名前のノートがもうあります' : 'ほかの場所で更新されています。開き直してください') : `名前を変えられませんでした: ${err.message}` })
      return false
    }
  }
  // 作ったばかりで名前を自分で書いていないノート: 書き出しが変われば名前も合わせる(まだどこからもリンクされていないので安全)
  const autoRename = async () => {
    const path = freshRef.current
    if (!path || path !== docPathRef.current) return
    const want = uniqueName(folderOf(path), nameFromBody(contentRef.current), path)
    if (want && want !== nameOf(path)) await renameTo(path, want, { auto: true })
  }
  // タイトルを書いたとき(Enter か、欄から出たとき)
  const commitTitle = async () => {
    const path = docPathRef.current
    const want = cleanName(titleRef.current)
    if (!path) { if (want) { clearTimeout(createTimer.current); createTimer.current = setTimeout(() => void createFromDraft(), 300) } return }
    if (!want) { setTitle(nameOf(path)); return }
    if (want === nameOf(path)) { setFresh(null); return }
    setFresh(null)
    if (notesRef.current.some((n) => n.path !== path && folderOf(n.path) === folderOf(path) && n.name.toLowerCase() === want.toLowerCase())) {
      setToast({ text: '同じ名前のノートがもうあります' })
      setTitle(nameOf(path))
      return
    }
    const links = (await api<{ items: { path: string }[] }>(`/api/search?q=${encodeURIComponent('[[' + nameOf(path))}&limit=200`).catch(() => ({ items: [] }))).items.filter((i) => i.path !== path).length
    if (links && !window.confirm(`ほかの ${links} 件のノートから [[${nameOf(path)}]] でリンクされています。リンクは自動では直りません。名前を変えますか？`)) { setTitle(nameOf(path)); return }
    if (!(await renameTo(path, want))) setTitle(nameOf(path))
  }

  // エディタの入力
  const onEditorChange = (v: string) => {
    const path = docPathRef.current
    contentRef.current = v
    if (!path) {
      // 下書き: 端末にも残す(サーバーが止まっていても消えない)
      store('draft.new', JSON.stringify({ body: v, title: titleRef.current, folder: draftRef.current?.folder, kind: draftRef.current?.kind }))
      clearTimeout(createTimer.current)
      createTimer.current = setTimeout(() => void createFromDraft(), 700)
      return
    }
    setText(path, v)
    engine.edit(path, v)
    if (freshRef.current === path) {
      clearTimeout(renameTimer.current)
      renameTimer.current = setTimeout(() => void autoRename(), 1500)
    }
  }

  // ホームのすぐ書く欄: 打った中身がそのままメモになる
  const saveCapture = async () => {
    const text = capture.trim()
    if (!text) return
    const folder = memoFolder()
    const name = uniqueName(folder, nameFromBody(text))
    const path = `${folder ? folder + '/' : ''}${name}.md`
    try {
      await api('/api/notes', { method: 'POST', body: JSON.stringify({ path, content: newNoteContent(captureTask ? 'task' : 'memo', { day: today() }) + text + '\n' }) })
    } catch (e) {
      setToast({ text: `まだ残せていません: ${(e as ApiError).message}(書いた内容は欄に残っています)` })
      return
    }
    clearCapture()
    setCaptureTask(false)
    await loadTree()
    setToast({ text: `「${name}」を残しました`, action: '開く', onAction: () => void openNote(path) })
  }

  // すぐ書く欄を空にする(エディタの中身も直接消す。状態だけ空にしてもエディタには残るため)
  const clearCapture = () => {
    const view = captureRef.current?.view
    if (view && view.state.doc.length) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } })
    setCapture('')
    store('capture.text', '')
  }
  // 長くなってきたら: 書いた中身をそのまま大きな画面に移す(そこで めも に作られる)
  const expandCapture = () => {
    const body = capture
    if (!body.trim()) return
    clearCapture()
    startDraft(memoFolder(), captureTask ? 'task' : 'memo', { body, title: '' })
    setCaptureTask(false)
    setTimeout(() => void createFromDraftRef.current(), 400)
  }

  // ホームのタスク: 開かずにチェックして完了にする(そのノートを開いていればエディタから)
  const setTaskDone = async (n: Note, done: boolean) => {
    if (docPathRef.current === n.path) { editHead(setProp(contentRef.current, '完了', done ? 'true' : 'false')); return }
    try {
      const r = await api<NoteResponse>(notePath(n.path))
      const next = applyChanges(r.content, setProp(r.content, '完了', done ? 'true' : 'false'))
      await api(notePath(n.path), { method: 'PUT', body: JSON.stringify({ content: next, base_etag: r.etag, mutation_id: uuid() }) })
      setNotes((list) => list.map((x) => (x.path === n.path ? { ...x, done } : x)))
      if (done) setToast({ text: `「${n.name}」を完了にしました`, action: '元に戻す', onAction: () => void setTaskDone({ ...n, done: true }, false) })
    } catch (e) {
      setToast({ text: `変えられませんでした: ${(e as ApiError).message}` })
    }
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
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, height: 340 })
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
    // 画面からはみ出さない場所に出す: 下に場所が無ければカーソルの上、左右も画面の中に(スマホは下の操作列に出す)
    if (at) {
      const H = 340
      const W = 290
      const below = window.innerHeight - at.bottom - 12
      const above = at.top - 12
      const up = below < Math.min(H, 220) && above > below
      const height = Math.min(H, Math.max(160, up ? above : below))
      setMenuPos({ top: up ? at.top - 6 - height : at.bottom + 6, left: Math.max(8, Math.min(at.left, window.innerWidth - W - 8)), height })
    }
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
  // どのエディタで書いているか(スマホの操作列をそのエディタに効かせる)
  const [focusView, setFocusView] = useState<EditorView | null>(null)
  const focusExt = useMemo(() => EditorView.updateListener.of((u) => {
    if (!u.focusChanged) return
    if (u.view.hasFocus) setFocusView(u.view)
    else setTimeout(() => setFocusView((v) => (v === u.view && !u.view.hasFocus ? null : v)), 120)
  }), [])
  const inset = useKeyboardInset()
  // ホームのすぐ書く欄も、本文と同じ書き方(# で見出し、- で点、[[ リンク、# タグ、/ で候補)
  const captureRef = useRef<ReactCodeMirrorRef>(null)
  const saveCaptureRef = useRef<() => Promise<void>>(async () => {})
  const captureExt = useMemo(() => [
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { void saveCaptureRef.current(); return true } }])),
    workspaceCompletions(() => notesRef.current, () => tagsRef.current, [slashSource(commands)]),
    livePreview('obsidian', (k, t) => linkRef.current(k, t)),
    focusExt,
  ], [focusExt])
  saveCaptureRef.current = saveCapture
  const extensions = useMemo(() => [
    markdown({ base: markdownLanguage }),
    EditorView.lineWrapping,
    commandKeys,
    menuListener,
    completions,
    focusExt,
    livePreview(presentation, (k, t) => linkRef.current(k, t)),
  ], [presentation, commandKeys, menuListener, completions, focusExt])

  // パソコン: ページを動かしたら候補は閉じる(カーソルから離れた所に残らないように)
  useEffect(() => {
    if (!showCommands || isMobile()) return
    const close = () => setShowCommands(false)
    window.addEventListener('scroll', close, { passive: true })
    return () => window.removeEventListener('scroll', close)
  }, [showCommands])

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
      // Ctrl+E: Obsidian と同じく、見た目(Obsidian表示)とソースを切りかえる
      else if (mod && k === 'e') { e.preventDefault(); setPresentation((p) => { const next = p === 'source' ? 'obsidian' : 'source'; store('editor.presentation', next); return next }) }
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
    { label: '整理待ちへ移す(消す)…', danger: true, onClick: () => askDelete(active) },
    'sep',
    ...PRESENTATIONS.map((p) => ({ label: `${presentation === p.id ? '✓ ' : '　'}${p.label}${p.id === 'source' ? '(Ctrl+E)' : ''}`, onClick: () => choosePresentation(p.id) })),
  ] : []

  const isFav = (path: string) => favs.some((f) => f.path === path)
  const toggleFav = async (path: string, kind: 'note' | 'folder') => {
    try {
      const r = isFav(path)
        ? await api<{ items: typeof favs }>(`/api/favorites?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
        : await api<{ items: typeof favs }>('/api/favorites', { method: 'POST', body: JSON.stringify({ path, kind }) })
      setFavs(r.items)
    } catch (e) { setToast({ text: `お気に入りを変えられませんでした: ${(e as Error).message}` }) }
  }
  const toggleSec = (key: string) => setSecOpen((prev) => { const next = { ...prev, [key]: !prev[key] }; store('side.sections', JSON.stringify(next)); return next })

  // プロパティの欄からの変更も、ふつうの入力と同じくエディタに書く(元に戻す・保存が同じ流れになる)
  const editHead = (changes: TextChange[]) => {
    const view = editorRef.current?.view
    if (!view) return
    view.dispatch({ changes, userEvent: 'input.props' })
  }

  // ---- 消す: 整理待ちへ移す(本当には消さない)。確認の画面を出し、あとから戻せる ----
  const askDelete = (path: string) => {
    setCtx(null)
    setNoteMenu(false)
    setDel(path)
    setDelLinks(null)
    const name = nameOf(path)
    api<{ items: { path: string }[] }>(`/api/search?q=${encodeURIComponent('[[' + name)}&limit=200`)
      .then((r) => setDelLinks(r.items.filter((i) => i.path !== path).length))
      .catch(() => setDelLinks(0))
  }
  const confirmDelete = async () => {
    const path = del
    if (!path) return
    setDelBusy(true)
    try {
      const r = await api<{ id: number; moved_to: string }>('/api/trash', { method: 'POST', body: JSON.stringify({ path, base_etag: engine.baseOf(path) ?? null }) })
      await engine.forget(path)
      setNotes((list) => list.filter((n) => n.path !== path))
      if (activeRef.current === path) {
        setActive('')
        setDoc(null)
        store('last.note', '')
        history.replaceState(null, '', '#/')
      }
      setDel(null)
      setToast({ text: `「${nameOf(path)}」を整理待ちへ移しました`, action: '元に戻す', onAction: () => void restoreNote({ id: r.id, path } as TrashItem) })
    } catch (e) {
      const err = e as ApiError
      setDel(null)
      setNotice(err.status === 409 ? 'ほかの場所でこのノートが更新されていたので、消すのをやめました。開き直して中身を確かめてください' : `消せませんでした: ${err.message}`)
    } finally {
      setDelBusy(false)
    }
  }
  const restoreNote = async (item: TrashItem): Promise<string | null> => {
    try {
      await api(`/api/trash/${item.id}/restore`, { method: 'POST' })
    } catch (e) {
      const err = e as ApiError
      setToast({ text: `戻せませんでした: ${err.message}` })
      return err.message
    }
    await loadTree()
    await openNote(item.path)
    setToast({ text: `「${nameOf(item.path)}」を元の場所に戻しました` })
    return null
  }

  const toggleFolder = (path: string) => setOpenFolders((prev) => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path); else next.add(path)
    store('tree.open', JSON.stringify([...next]))
    return next
  })
  const pending = engine.pending()
  const connected = online && apiOk !== false
  const recent = useMemo(() => sortNotes(notes.filter((n) => n.date && !n.task && (inMemoFolder(n.path) || !memoFolder())), '日付が新しい順').slice(0, 12), [notes])
  const todayTasks = useMemo(() => notes.filter((n) => n.task && !n.done && n.task_day && n.task_day <= today()).sort((a, b) => a.task_day!.localeCompare(b.task_day!)), [notes])
  const upcoming = useMemo(() => {
    const week = new Date(); week.setDate(week.getDate() + 7)
    const until = today(week)
    return notes.filter((n) => n.task && !n.done && n.task_day && n.task_day > today() && n.task_day <= until).sort((a, b) => a.task_day!.localeCompare(b.task_day!))
  }, [notes])
  const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'こんばんは' : h < 11 ? 'おはようございます' : h < 18 ? 'こんにちは' : 'こんばんは' }
  const statusMsg = sync && sync.message && sync.status !== 'saved' && sync.status !== 'conflict' ? sync.message : ''

  // 左の一覧: お気に入り → めも → (閉じた引き出し)ほかのフォルダ・タグ
  const memoNode = tree.folders.find((f) => f.path === MEMO_FOLDER)
  const othersNode = { ...tree, folders: tree.folders.filter((f) => f.path !== MEMO_FOLDER) }
  const findFolder = (path: string) => {
    let node: typeof tree | undefined = tree
    for (const part of path.split('/')) node = node?.folders.find((f) => f.name === part)
    return node
  }
  const treeProps = {
    open: openFolders,
    toggle: toggleFolder,
    active,
    onOpen: (p: string) => void openNote(p),
    onContext: (path: string, x: number, y: number) => setCtx({ path, x, y }),
    onFolderContext: (path: string, x: number, y: number) => setCtx({ path, x, y, folder: true }),
    sort,
  }
  const isTask = !!(propValue(head, '遂行日') || propValue(head, '完了'))
  const done = /^true$/i.test(propValue(head, '完了')?.value || '')
  const taskDay = propValue(head, '遂行日')?.value || ''

  return (
    <div className="app-shell">
      <div className="workspace">
        {sidebarOpen && isMobile() && <div className="drawer-backdrop" onClick={() => setSidebarOpen(false)} />}
        {sidebarOpen && <aside className="sidebar">
          <div className="side-top">
            <button className="side-search" onClick={() => { void loadTree(); setSwitcher('') }}><Search size={15} /><span>探す</span><kbd>Ctrl K</kbd></button>
            <button className="side-new" onClick={() => openNewNote()} aria-label="新しいメモ・タスク" title="新しいメモ・タスク(Alt+N)"><Plus size={18} /></button>
          </div>
          <div className="side-scroll">
            {favs.length > 0 && <section className="side-sec">
              <div className="side-head"><Star size={12} /> お気に入り</div>
              {favs.map((f) => {
                if (f.kind === 'note') {
                  const n = notes.find((x) => x.path === f.path)
                  if (!n) return null
                  return <button key={f.path} className={`note-item ${active === n.path ? 'active' : ''}`} onClick={() => void openNote(n.path)} onContextMenu={(e) => { e.preventDefault(); setCtx({ path: n.path, x: e.clientX, y: e.clientY }) }} title={n.path}><Star size={14} className="file-icon" /><span>{n.name}</span></button>
                }
                const node = findFolder(f.path)
                if (!node) return null
                const key = 'fav:' + f.path
                return <div key={f.path}>
                  <button className="tree-folder" onClick={() => toggleFolder(key)} onContextMenu={(e) => { e.preventDefault(); setCtx({ path: f.path, x: e.clientX, y: e.clientY, folder: true }) }} aria-expanded={openFolders.has(key)}>
                    <ChevronRight size={14} className={`chev ${openFolders.has(key) ? 'open' : ''}`} /><span>{node.name}</span>
                  </button>
                  {openFolders.has(key) && <Tree node={node} {...treeProps} depth={1} />}
                </div>
              })}
            </section>}
            {memoNode ? <section className="side-sec">
              <div className="side-head">
                <span>めも</span><small>{notes.filter((n) => inMemoFolder(n.path)).length}</small>
                <select className="sort-mini" value={sort} onChange={(e) => { setSort(e.target.value as SortName); store('tree.sort', e.target.value) }} aria-label="並べ替え">
                  {SORTS.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <Tree node={memoNode} {...treeProps} />
            </section> : <section className="side-sec"><Tree node={tree} {...treeProps} /></section>}
            {memoNode && <section className="side-sec">
              <button className="side-head toggle" onClick={() => toggleSec('others')} aria-expanded={!!secOpen.others}><ChevronRight size={13} className={`chev ${secOpen.others ? 'open' : ''}`} /> ほかのフォルダ</button>
              {secOpen.others && <Tree node={othersNode} {...treeProps} />}
            </section>}
            <section className="side-sec">
              <button className="side-head toggle" onClick={() => toggleSec('tags')} aria-expanded={!!secOpen.tags}><ChevronRight size={13} className={`chev ${secOpen.tags ? 'open' : ''}`} /> タグ<small>{tags.length || ''}</small></button>
              {secOpen.tags && <div className="tag-list">
                {tags.map((t) => <button key={t.tag} className="tag-row" onClick={() => setSwitcher('#' + t.tag)}><span>#{t.tag}</span><small>{t.count}</small></button>)}
                {!tags.length && <span className="empty-list">タグはまだありません</span>}
              </div>}
            </section>
            {apiOk === false && !notes.length && <div className="empty-list">サーバーにつながりません</div>}
          </div>
          <div className="side-foot">
            <button onClick={() => setTrashOpen(true)} title="整理待ち(消したノート)"><Trash2 size={14} /> 整理待ち</button>
            <span className={`conn ${connected ? 'ok' : 'down'}`} title={connected ? 'サーバーにつながっています' : 'サーバーにつながっていません。書いた分は端末に残し、つながりしだい送ります'}>{connected ? <Wifi size={13} /> : <WifiOff size={13} />}{!online ? 'オフライン' : apiOk === false ? '停止中' : ''}</span>
            <button onClick={() => setSettings((v) => !v)} aria-label="設定"><Settings2 size={15} /></button>
          </div>
        </aside>}

        <main className="main-area">
          <div className="topline">
            <button className="tool icon" onClick={() => setSidebarOpen((v) => !v)} aria-label="一覧を開く・閉じる"><Menu size={18} /></button>
            {doc && <div className="breadcrumbs" title={active}>{(draft ? draft.folder : folderOf(active)).split('/').filter(Boolean).join(' / ')}</div>}
            <div className="top-tools">
              {draft && <button className={`tool ${draft.kind === 'task' ? 'on' : ''}`} onClick={() => setDraft({ ...draft, kind: draft.kind === 'task' ? 'memo' : 'task' })} title="今日のタスクとして作る"><ListChecks size={15} /> {draft.kind === 'task' ? 'タスク(今日)' : 'タスクにする'}</button>}
              {draft && <span className="draft-hint">書くと{draft.folder ? `「${draft.folder}」` : ''}に作ります</span>}
              {doc && !draft && !isTask && <button className="tool" onClick={() => editHead(makeTask(contentRef.current))} title="遂行日・完了 を付けてタスクにする"><ListChecks size={15} /> タスクにする</button>}
              {sync && <button className={`save-indicator s-${sync.status}`} title={sync.message || STATUS_LABEL[sync.status]} onClick={() => engine.saveNow(active)} aria-live="polite">
                {STATUS_ICON[sync.status]}<span>{STATUS_LABEL[sync.status]}</span>{pending > 1 && <em>+{pending - 1}</em>}
              </button>}
              {doc && !draft && <button className={`tool icon ${isFav(active) ? 'on' : ''}`} onClick={() => void toggleFav(active, 'note')} aria-label={isFav(active) ? 'お気に入りから外す' : 'お気に入りにする'} title={isFav(active) ? 'お気に入りから外す' : 'お気に入りにする'}><Star size={17} /></button>}
              {doc && !draft && <div className="menu-anchor">
                <button className="tool icon" onClick={() => setNoteMenu((v) => !v)} aria-label="ノートのメニュー" aria-expanded={noteMenu}><MoreHorizontal size={18} /></button>
                {noteMenu && <Dropdown items={noteMenuItems} onClose={() => setNoteMenu(false)} />}
              </div>}
            </div>
          </div>

          {doc ? <>
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
              <div className="title-row">
                {isTask && <input type="checkbox" className="title-check" checked={done} onChange={(e) => editHead(setProp(contentRef.current, '完了', e.target.checked ? 'true' : 'false'))} aria-label="完了" />}
                <input
                  className={`document-title ${done ? 'done' : ''} ${fresh && fresh === active ? 'auto' : ''}`}
                  value={title}
                  placeholder="タイトル(なくてもよい)"
                  aria-label="タイトル"
                  title={fresh && fresh === active ? 'タイトルを書かなければ、本文の書き出しを名前にします' : undefined}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => void commitTitle()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); (e.target as HTMLInputElement).blur(); editorRef.current?.view?.focus() }
                    if (e.key === 'Escape') { setTitle(active ? nameOf(active) : ''); (e.target as HTMLInputElement).blur() }
                  }}
                />
              </div>
              {isTask && <div className="task-line">
                <label>遂行日<input type="date" value={/^\d{4}-\d{2}-\d{2}/.test(taskDay) ? taskDay.slice(0, 10) : ''} onChange={(e) => e.target.value && editHead(setProp(contentRef.current, '遂行日', e.target.value))} aria-label="遂行日" /></label>
                {!done && taskDay && taskDay < today() && <span className="late">期限を過ぎています</span>}
                {!done && taskDay === today() && <span className="today">今日</span>}
              </div>}
              {!draft && <NoteMeta
                text={head}
                memo={inMemoFolder(active)}
                fileDate={(() => { const m = notes.find((n) => n.path === active)?.modified_at; return m ? new Date(m).toLocaleDateString('sv-SE') : '' })()}
                onEdit={editHead}
              />}
              {draft && <div className="meta"><span className="meta-date-ro">{today().replace(/-/g, '/')}</span></div>}
              <div className={`editor-wrap mode-${presentation} ${loading ? 'loading' : ''}`} ref={wrapRef}>
                <CodeMirror
                  key={doc.seq}
                  ref={editorRef}
                  value={doc.content}
                  minHeight="60vh"
                  extensions={extensions}
                  theme="light"
                  basicSetup={{ drawSelection: false, lineNumbers: false, foldGutter: false, highlightActiveLine: presentation === 'source', autocompletion: false, searchKeymap: true }}
                  onChange={onEditorChange}
                  autoFocus={!doc.path}
                  onCreateEditor={(view) => { if (!docPathRef.current && view.state.doc.length) view.dispatch({ selection: { anchor: view.state.doc.length } }) }}
                  placeholder={draft ? '思いついたことを書く…(タイトルは書かなくてもいい)' : presentation === 'notion' ? '書きはじめる…(改行すると見出し・リストなどを選べる)' : '書きはじめる…   / で見出しやリスト、[[ でリンク'}
                />
                {showCommands && !isMobile() && <div className="command-menu" style={{ top: menuPos.top, left: menuPos.left, maxHeight: menuPos.height }}>
                  <div className="command-heading">{menuKind === 'block' ? 'ブロックにする' : '挿入'} <span>↑↓ · Enter · Esc</span></div>
                  {commands.map((cmd, i) => <button key={cmd.label} className={i === commandIndex ? 'selected' : ''} onMouseMove={() => setCommandIndex(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => applyBlock(cmd.hint)}><span className="command-icon">{cmd.icon}</span><span>{cmd.label}</span><small>{cmd.hint ? cmd.hint.replaceAll('\n', ' ↵ ') : '記号なし'}</small></button>)}
                </div>}
              </div>
            </article>
          </> : <div className="home">
            {notice && <div className="notice">{notice}<button onClick={() => setNotice('')} aria-label="閉じる"><X size={14} /></button></div>}
            <p className="home-date">{new Date().toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' })}</p>
            <h1 className="home-hello">{greeting()}</h1>
            <div className="capture">
              <div className="capture-editor mode-obsidian" aria-label="すぐ書く">
                <CodeMirror
                  ref={captureRef}
                  value={capture}
                  minHeight="96px"
                  extensions={captureExt}
                  theme="light"
                  basicSetup={{ drawSelection: false, lineNumbers: false, foldGutter: false, highlightActiveLine: false, autocompletion: false, searchKeymap: false }}
                  onChange={(v) => { setCapture(v); store('capture.text', v) }}
                  placeholder="思いついたことを書く…  (# 見出し・- 点・/ 候補もそのまま使えます)"
                />
              </div>
              <div className="capture-bar">
                <button className={`chip ${captureTask ? 'on' : ''}`} onClick={() => setCaptureTask((v) => !v)}><ListChecks size={14} /> 今日のタスク</button>
                <button className={`chip ${capture.split('\n').length > 6 ? 'on' : ''}`} onClick={expandCapture} disabled={!capture.trim()} title="大きな画面に移して続きを書く">広げて書く ↗</button>
                <span className="capture-hint">Ctrl+Enter で残す · 名前は書き出しから付きます</span>
                <button className="btn primary" disabled={!capture.trim()} onClick={() => void saveCapture()}>めもに残す</button>
              </div>
            </div>
            {apiOk === false && <p className="home-empty">サーバーにつながりません。つながると一覧が出ます。</p>}

            {(todayTasks.length > 0 || upcoming.length > 0) && <section className="home-sec">
              <h2>タスク</h2>
              <div className="task-list">
                {[...todayTasks, ...upcoming].map((n) => (
                  <div key={n.path} className={`task-row ${n.done ? 'done' : ''}`}>
                    <input type="checkbox" checked={!!n.done} onChange={(e) => void setTaskDone(n, e.target.checked)} aria-label={`${n.name} を完了にする`} />
                    <button onClick={() => void openNote(n.path)}>{n.name}</button>
                    <small className={n.task_day! < today() ? 'late' : n.task_day === today() ? 'today' : ''}>{n.task_day! < today() ? '期限すぎ ' : n.task_day === today() ? '今日' : ''}{n.task_day === today() ? '' : n.task_day!.slice(5).replace('-', '/')}</small>
                  </div>
                ))}
              </div>
            </section>}

            {favs.length > 0 && <section className="home-sec">
              <h2>お気に入り</h2>
              <div className="fav-chips">{favs.map((f) => <button key={f.path} className="chip" onClick={() => { if (f.kind === 'note') void openNote(f.path); else { setSidebarOpen(true); toggleFolder('fav:' + f.path) } }}><Star size={13} /> {f.path.split('/').pop()!.replace(/\.md$/i, '')}</button>)}</div>
            </section>}

            {recent.length > 0 && <section className="home-sec">
              <h2>新しいメモ</h2>
              <div className="cards">{recent.map((n) => (
                <button key={n.path} className="card" onClick={() => openNote(n.path)}>
                  <b>{n.name}</b>
                  {n.excerpt && <p>{n.excerpt}</p>}
                  <span className="card-foot"><small>{n.date?.slice(0, 10).replace(/-/g, '/')}</small>{(n.tags || []).slice(0, 3).map((t) => <em key={t}>#{t}</em>)}</span>
                </button>
              ))}</div>
            </section>}
            <div className="home-more">
              <button className="btn" onClick={() => openNewNote()}><FilePlus2 size={15} /> 広い画面で書く</button>
              <button className="btn" onClick={() => setSwitcher('')}><Search size={15} /> 探す</button>
            </div>
          </div>}
        </main>
      </div>

      {settings && <div className="settings-popover">
        <div className="settings-head"><span className="settings-title">設定</span><button className="icon-button" onClick={() => setSettings(false)} aria-label="閉じる"><X size={16} /></button></div>
        <div className="settings-row"><div><strong>表示</strong><small>どれも書いたまま保存。見た目だけ変わる(Ctrl+E でソースと切りかえ)</small></div><select value={presentation} onChange={(e) => choosePresentation(e.target.value as Presentation)}>{PRESENTATIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
        <div className="settings-row"><div><strong>Obsidian の保管庫名</strong><small>「Obsidian で開く」に使う</small></div><input value={vaultName} onChange={(e) => { setVaultName(e.target.value); store('obsidian.vault', e.target.value) }} /></div>
        <div className="settings-row"><div><strong>送信待ち</strong><small>端末に残っていて、サーバーの確認がまだのもの</small></div><span className="setting-value">{pending}件 {pending > 0 && <button className="btn tiny" onClick={() => engine.saveNow()}>今すぐ送る</button>}</span></div>
        <div className="settings-row"><div><strong>キー</strong><small>Ctrl+K 探す · Alt+N 新しいメモ · Ctrl+S すぐ保存 · Ctrl+E ソース · / 候補 · [[ リンク</small></div></div>
      </div>}

      {switcher !== null && <QuickSwitcher notes={notes} initial={switcher} onClose={() => setSwitcher(null)} onOpen={(p) => { setSwitcher(null); void openNote(p) }} onCreate={(name) => openNewNote(name)} />}
      {diff && <DiffDialog mine={diff.mine} server={diff.server} onClose={() => setDiff(null)} />}
      {ctx && <Dropdown at={{ x: ctx.x, y: ctx.y }} onClose={() => setCtx(null)} items={ctx.folder ? [
        { label: isFav(ctx.path) ? 'お気に入りから外す' : 'お気に入りにする', onClick: () => void toggleFav(ctx.path, 'folder') },
        { label: 'このフォルダに新しく作る', onClick: () => openNewNote('', ctx.path) },
      ] : [
        { label: '開く', onClick: () => void openNote(ctx.path) },
        { label: isFav(ctx.path) ? 'お気に入りから外す' : 'お気に入りにする', onClick: () => void toggleFav(ctx.path, 'note') },
        { label: 'パスをコピー', onClick: async () => { try { await navigator.clipboard.writeText(ctx.path); setToast({ text: 'パスをコピーしました' }) } catch { window.prompt('パス', ctx.path) } } },
        'sep',
        { label: '整理待ちへ移す(消す)…', danger: true, onClick: () => askDelete(ctx.path) },
      ]} />}
      {del && <DeleteDialog
        path={del}
        name={nameOf(del)}
        unsaved={engine.get(del).status !== 'saved'}
        busy={delBusy}
        links={delLinks}
        onSaveNow={() => engine.saveNow(del)}
        onConfirm={() => void confirmDelete()}
        onClose={() => !delBusy && setDel(null)}
      />}
      {trashOpen && <TrashDialog onClose={() => setTrashOpen(false)} onRestore={async (it) => { const err = await restoreNote(it); if (!err) setTrashOpen(false); return err }} />}
      {toast && <Toast text={toast.text} action={toast.action} onAction={toast.onAction} onClose={() => setToast(null)} />}
      {isMobile() && (focusView || (showCommands && editorRef.current?.view)) && <MobileBar
        view={showCommands ? editorRef.current?.view ?? null : focusView}
        inset={inset}
        commands={commands}
        menu={showCommands && focusView === editorRef.current?.view}
        onPick={(hint) => applyBlock(hint)}
        onClose={() => setShowCommands(false)}
      />}
    </div>
  )
}
