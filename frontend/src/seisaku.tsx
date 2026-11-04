// 制作カレンダー: 制作ログ(スマホのアプリの写真と記録)を月の格子に並べ、その日のメモ・つながっているメモと結ぶ。
// 制作ログのファイルは読むだけ。つながりはメモのプロパティ「制作ログ: 記録のID」に書く
import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, FilePlus2, Link2, X } from 'lucide-react'
import { api, Note } from './api'
import { today } from './memo'

export type SeisakuLog = { id: string; date: string; title: string; intention: string; memo: string; photos: { full: string; thumb: string }[] }

export const photoUrl = (p: string) => `/api/seisaku/photo?path=${encodeURIComponent(p)}`
const WEEK = '日月火水木金土'

export function SeisakuCalendar({ notes, initialDay, onOpen, onCreate, onLink }: {
  notes: Note[]
  initialDay?: string
  onOpen: (path: string) => void
  onCreate: (log: SeisakuLog) => void
  onLink: (log: SeisakuLog, path: string) => void
}) {
  const [month, setMonth] = useState((initialDay || today()).slice(0, 7))
  const [day, setDay] = useState(initialDay || today())
  const [logs, setLogs] = useState<SeisakuLog[] | null>(null)
  const [configured, setConfigured] = useState(true)
  const [viewer, setViewer] = useState<{ photos: SeisakuLog['photos']; i: number } | null>(null)
  const [linkFor, setLinkFor] = useState<SeisakuLog | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => {
    setLogs(null)
    api<{ configured: boolean; items: SeisakuLog[] }>(`/api/seisaku?month=${month}`).then((r) => { setLogs(r.items); setConfigured(r.configured) }).catch(() => setLogs([]))
  }, [month])

  // 格子(日曜はじまり。前後の月の日は薄く)
  const cells = useMemo(() => {
    const first = new Date(month + '-01T00:00:00')
    const start = new Date(first)
    start.setDate(1 - first.getDay())
    const out: string[] = []
    for (let i = 0; i < 42; i++) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      out.push(today(d))
    }
    return out.slice(0, new Date(out[35] + 'T00:00:00').getMonth() === first.getMonth() ? 42 : 35)
  }, [month])
  const byDay = useMemo(() => {
    const m = new Map<string, SeisakuLog[]>()
    for (const l of logs || []) m.set(l.date, [...(m.get(l.date) || []), l])
    return m
  }, [logs])
  const linked = (id: string) => notes.filter((n) => n.seisaku === id)
  const memosOn = (d: string) => notes.filter((n) => (n.date || '').slice(0, 10) === d)
  const move = (k: number) => {
    const d = new Date(month + '-01T00:00:00')
    d.setMonth(d.getMonth() + k)
    setMonth(today(d).slice(0, 7))
  }
  const dayLogs = byDay.get(day) || []
  const dayMemos = memosOn(day)
  const label = (d: string) => { const x = new Date(d + 'T00:00:00'); return `${x.getMonth() + 1}月${x.getDate()}日(${WEEK[x.getDay()]})` }

  return (
    <div className="seisaku">
      <div className="seisaku-head">
        <h1>制作カレンダー</h1>
        <div className="seisaku-nav">
          <button className="tool icon" onClick={() => move(-1)} aria-label="前の月"><ChevronLeft size={18} /></button>
          <b>{month.slice(0, 4)}年{Number(month.slice(5))}月</b>
          <button className="tool icon" onClick={() => move(1)} aria-label="次の月"><ChevronRight size={18} /></button>
          <button className="chip" onClick={() => { setMonth(today().slice(0, 7)); setDay(today()) }}>今日</button>
        </div>
      </div>
      {!configured && <p className="delete-info">制作ログの場所が設定されていません。</p>}
      <div className="cal-grid" role="grid">
        {WEEK.split('').map((w) => <div key={w} className="cal-week">{w}</div>)}
        {cells.map((d) => {
          const ls = byDay.get(d) || []
          const photos = ls.flatMap((l) => l.photos)
          const links = ls.reduce((n, l) => n + linked(l.id).length, 0)
          const memos = memosOn(d).length
          return (
            <button key={d} role="gridcell" className={`cal-cell ${d.slice(0, 7) !== month ? 'other' : ''} ${d === today() ? 'today' : ''} ${d === day ? 'selected' : ''}`} onClick={() => setDay(d)} aria-label={label(d)}>
              <span className="cal-day">{Number(d.slice(8))}</span>
              {photos.length > 0 && <span className="cal-thumbs">
                {photos.slice(0, 2).map((p) => <img key={p.thumb} src={photoUrl(p.thumb)} alt="" loading="lazy" />)}
                {photos.length > 2 && <em>+{photos.length - 2}</em>}
              </span>}
              <span className="cal-dots">
                {links > 0 && <i className="dot link" title={`つながっているメモ ${links}件`} />}
                {memos > 0 && <i className="dot memo" title={`この日のメモ ${memos}件`} />}
              </span>
            </button>
          )
        })}
      </div>
      {logs === null && <p className="delete-info"><span className="spinner inline" /> 制作ログを読んでいます…</p>}

      <section className="day-panel">
        <h2>{label(day)}</h2>
        {dayLogs.length === 0 && <p className="delete-info">この日の制作ログはありません</p>}
        {dayLogs.map((l) => (
          <div key={l.id} className="log-card">
            {l.photos.length > 0 && <div className="log-photos">{l.photos.map((p, i) => <button key={p.full} onClick={() => setViewer({ photos: l.photos, i })}><img src={photoUrl(p.thumb)} alt="" loading="lazy" /></button>)}</div>}
            {(l.title || l.intention || l.memo) && <div className="log-text">
              {l.title && <b>{l.title}</b>}
              {l.intention && <p><small>作った意図</small>{l.intention}</p>}
              {l.memo && <p>{l.memo}</p>}
            </div>}
            <div className="log-links">
              {linked(l.id).map((n) => <button key={n.path} className="chip on" onClick={() => onOpen(n.path)}>📝 {n.name}</button>)}
              <button className="chip" onClick={() => onCreate(l)}><FilePlus2 size={13} /> この制作のメモを作る</button>
              <button className="chip" onClick={() => { setLinkFor(l); setQ('') }}><Link2 size={13} /> メモをつなぐ</button>
            </div>
          </div>
        ))}
        {dayMemos.length > 0 && <div className="day-memos">
          <small>この日に書いたメモ</small>
          {dayMemos.map((n) => <button key={n.path} className="day-memo" onClick={() => onOpen(n.path)}>{n.seisaku ? '🔗 ' : ''}{n.name}</button>)}
        </div>}
      </section>

      {viewer && <div className="modal-backdrop viewer" onMouseDown={() => setViewer(null)}>
        <img src={photoUrl(viewer.photos[viewer.i].full)} alt="" onMouseDown={(e) => e.stopPropagation()} />
        {viewer.photos.length > 1 && <>
          <button className="viewer-prev" onMouseDown={(e) => { e.stopPropagation(); setViewer({ ...viewer, i: (viewer.i + viewer.photos.length - 1) % viewer.photos.length }) }} aria-label="前の写真"><ChevronLeft size={28} /></button>
          <button className="viewer-next" onMouseDown={(e) => { e.stopPropagation(); setViewer({ ...viewer, i: (viewer.i + 1) % viewer.photos.length }) }} aria-label="次の写真"><ChevronRight size={28} /></button>
        </>}
        <button className="viewer-close" onClick={() => setViewer(null)} aria-label="閉じる"><X size={22} /></button>
      </div>}

      {linkFor && <div className="modal-backdrop" onMouseDown={() => setLinkFor(null)}>
        <div className="modal small" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="メモをつなぐ">
          <div className="modal-head"><h2>メモをつなぐ</h2><button className="icon-button" onClick={() => setLinkFor(null)} aria-label="閉じる"><X size={16} /></button></div>
          <input className="field-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="メモの名前でさがす(空ならこの日のメモ)" />
          <div className="link-list">
            {(q.trim() ? notes.filter((n) => n.path.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 30) : memosOn(linkFor.date)).map((n) => (
              <button key={n.path} className="day-memo" disabled={n.seisaku === linkFor.id} onClick={() => { onLink(linkFor, n.path); setLinkFor(null) }}>{n.name}{n.seisaku === linkFor.id ? '(つながっている)' : ''}<small>{n.date?.slice(0, 10)}</small></button>
            ))}
          </div>
        </div>
      </div>}
    </div>
  )
}

// メモの上に出す、つながっている制作ログの写真
export function SeisakuStrip({ logId, onDay }: { logId: string; onDay: (day: string) => void }) {
  const [log, setLog] = useState<SeisakuLog | null>(null)
  const [viewer, setViewer] = useState<number | null>(null)
  useEffect(() => { setLog(null); api<SeisakuLog>(`/api/seisaku/log/${encodeURIComponent(logId)}`).then(setLog).catch(() => setLog(null)) }, [logId])
  if (!log) return null
  return (
    <div className="seisaku-strip">
      <button className="chip" onClick={() => onDay(log.date)}>📅 制作ログ {log.date.slice(5).replace('-', '/')}{log.title ? ` · ${log.title}` : ''}</button>
      <div className="log-photos">{log.photos.map((p, i) => <button key={p.full} onClick={() => setViewer(i)}><img src={photoUrl(p.thumb)} alt="" loading="lazy" /></button>)}</div>
      {viewer !== null && <div className="modal-backdrop viewer" onMouseDown={() => setViewer(null)}>
        <img src={photoUrl(log.photos[viewer].full)} alt="" onMouseDown={(e) => e.stopPropagation()} />
        <button className="viewer-close" onClick={() => setViewer(null)} aria-label="閉じる"><X size={22} /></button>
      </div>}
    </div>
  )
}

// 「この制作のメモを作る」のひな形(プロパティ・タグはきまりどおり。鍵は中身ではなく、どこにあるかを書く)
export function seisakuTemplate(log: SeisakuLog) {
  return `---\ndate: '${log.date}'\n制作ログ: '${log.id}'\n---\n\n#ものづくり\n\n## 作ったもの\n${log.title || ''}${log.intention ? `\n${log.intention}` : ''}\n\n## こう作った\n- \n\n## 使うときは\n- URL: \n- \n\n## 使っている鍵・アカウント\n- (パスワードそのものは書かず、どこにあるかを書く)\n\n## 次にやること\n- [ ] \n`
}
