// OMNI の「めも」のきまり(NAS の共有記憶・全体像、OMNI/めも/sortspec.md、OMNIメモアプリと同じ)
//   - 新しいメモは めも フォルダに作る(Obsidian の newFileFolderPath)
//   - メモには必ず date: 'YYYY-MM-DD'(引用符つき)。タスクは 遂行日・完了: false・date の順
//   - タグはプロパティを閉じる --- のあとに空行1行、本文の前に #タグ #タグ
//   - 並びはフォルダが先、そのあとメモもタスクもまとめて date の新しい順。sortspec はいちばん下
import type { Note } from './api'

export const MEMO_FOLDER = 'めも'

export function today(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function inMemoFolder(path: string) {
  return path === MEMO_FOLDER || path.startsWith(MEMO_FOLDER + '/')
}

export function newNoteContent(kind: 'memo' | 'task', opts: { day?: string; tags?: string[]; date?: string } = {}) {
  const date = opts.date ?? today()
  const head = kind === 'task'
    ? `---\n遂行日: ${opts.day || date}\n完了: false\ndate: '${date}'\n---\n`
    : `---\ndate: '${date}'\n---\n`
  const tags = (opts.tags || []).map((t) => t.trim().replace(/^#/, '')).filter(Boolean)
  return head + '\n' + (tags.length ? tags.map((t) => '#' + t).join(' ') + '\n\n' : '')
}

// ---- 並べ替え(OMNIメモアプリと同じ種類) ----

export const SORTS = ['日付が新しい順', '日付が古い順', '名前順', 'おすすめ', '遂行日が古い順', '遂行日が新しい順'] as const
export type SortName = (typeof SORTS)[number]

const byName = (a: Note, b: Note) => a.name.localeCompare(b.name, 'ja')
// date が無いものは最後。同じ日はファイルが新しいもの順
const dateKey = (n: Note) => n.date || ''
function taskGroup(n: Note, day: string) {
  if (!n.task) return 4
  if (n.done) return 4
  if (!n.task_day) return 3
  return n.task_day === day ? 0 : n.task_day < day ? 1 : 2
}
export const GROUP_LABEL = ['今日のタスク', 'これまでのタスク(未完了)', 'これからのタスク', '日付未設定のタスク', 'メモ・完了したタスク']

export function sortNotes(list: Note[], sort: SortName, day = today()): Note[] {
  const out = [...list]
  const cmp: Record<SortName, (a: Note, b: Note) => number> = {
    日付が新しい順: (a, b) => (!a.date ? 1 : 0) - (!b.date ? 1 : 0) || dateKey(b).localeCompare(dateKey(a)) || (b.modified_at || '').localeCompare(a.modified_at || ''),
    日付が古い順: (a, b) => (!a.date ? 1 : 0) - (!b.date ? 1 : 0) || dateKey(a).localeCompare(dateKey(b)) || (a.modified_at || '').localeCompare(b.modified_at || ''),
    名前順: byName,
    遂行日が古い順: (a, b) => (a.task_day || '9999').localeCompare(b.task_day || '9999'),
    遂行日が新しい順: (a, b) => (b.task_day || '0000').localeCompare(a.task_day || '0000'),
    おすすめ: (a, b) => taskGroup(a, day) - taskGroup(b, day) || (a.task_day || '9999').localeCompare(b.task_day || '9999') || dateKey(b).localeCompare(dateKey(a)),
  }
  out.sort((a, b) => {
    // sortspec(並べ替えの設定メモ)はいちばん下
    const s = Number(a.name === 'sortspec') - Number(b.name === 'sortspec')
    return s || cmp[sort](a, b) || a.path.localeCompare(b.path, 'ja')
  })
  return out
}

// ---- プロパティ(Frontmatter)の読み書き。分からない行はそのまま残す ----

export type Prop = { key: string; value: string; complex: boolean; line: number; valueFrom: number; valueTo: number; quote: string }
export type Front = { from: number; to: number; closeLine: number; props: Prop[]; lines: string[] } // to = 閉じ --- の行末

export function parseFront(text: string): Front | null {
  const lines = text.split('\n')
  if (lines.length < 2 || lines[0].replace(/\r$/, '').replace(/^﻿/, '') !== '---') return null
  let close = -1
  for (let i = 1; i < Math.min(lines.length, 200); i++) {
    const t = lines[i].replace(/\r$/, '')
    if (t === '---' || t === '...') { close = i; break }
  }
  if (close < 0) return null
  const starts: number[] = []
  let pos = 0
  for (const l of lines) { starts.push(pos); pos += l.length + 1 }
  const props: Prop[] = []
  for (let i = 1; i < close; i++) {
    const raw = lines[i].replace(/\r$/, '')
    const m = raw.match(/^([^\s#:-][^:]*):(\s*)(.*)$/)
    if (!m) {
      if (/^\s/.test(raw) && props.length) props[props.length - 1].complex = true
      continue
    }
    const rawValue = m[3]
    const vFrom = starts[i] + m[1].length + 1 + m[2].length
    const quote = /^'.*'$/.test(rawValue) ? "'" : /^".*"$/.test(rawValue) ? '"' : ''
    props.push({ key: m[1], value: quote ? rawValue.slice(1, -1) : rawValue, complex: false, line: i, valueFrom: vFrom, valueTo: vFrom + rawValue.length, quote })
  }
  // 値が次の行に続くもの(リストなど)は「複雑」として、画面では読むだけにする
  for (const p of props) if (p.value === '' && lines[p.line + 1] && /^\s/.test(lines[p.line + 1])) p.complex = true
  return { from: 0, to: starts[close] + lines[close].replace(/\r$/, '').length, closeLine: close, props, lines }
}

// タグの行(閉じ --- のあと、空行をはさんだ最初の行が #タグ だけのとき)
export function tagLine(text: string): { from: number; to: number; tags: string[] } | null {
  const fm = parseFront(text)
  let pos = fm ? fm.to + 1 : 0
  const rest = text.slice(pos)
  const m = rest.match(/^(\r?\n)*/)
  pos += m ? m[0].length : 0
  const end = text.indexOf('\n', pos)
  const line = text.slice(pos, end < 0 ? text.length : end).replace(/\r$/, '')
  if (!/^#[^\s#]/.test(line) || !/^(#[^\s#]+\s*)+$/.test(line.trim())) return null
  return { from: pos, to: pos + line.length, tags: line.trim().split(/\s+/).map((t) => t.slice(1)) }
}

// ---- プロパティを書きかえる(エディタに渡す変更を作るだけ。値の部分だけを置きかえる) ----

export type Change = { from: number; to?: number; insert: string }
const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')

export function propValue(text: string, key: string) {
  return parseFront(text)?.props.find((p) => p.key === key)
}

export function setProp(text: string, key: string, value: string): Change[] {
  const p = propValue(text, key)
  if (!p) return addProps(text, [`${key}: ${key === 'date' ? `'${value}'` : value}`])
  const q = p.quote || (key === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? "'" : '')
  return [{ from: p.valueFrom, to: p.valueTo, insert: q + value + q }]
}

// 閉じ --- の前に足す。プロパティが無ければ先頭に作る(本文の前は空行1行)
export function addProps(text: string, lines: string[]): Change[] {
  const eol = eolOf(text)
  const fm = parseFront(text)
  if (fm) {
    const closeStart = fm.to - fm.lines[fm.closeLine].replace(/\r$/, '').length
    return [{ from: closeStart, insert: lines.map((l) => l + eol).join('') }]
  }
  return [{ from: 0, insert: `---${eol}${lines.map((l) => l + eol).join('')}---${eol}${text.startsWith('\n') || text.startsWith('\r\n') ? '' : eol}` }]
}

// タスクにする: 遂行日・完了 を date の前に(タスクの並び 遂行日・完了・date)
export function makeTask(text: string, day = today()): Change[] {
  const eol = eolOf(text)
  const date = propValue(text, 'date')
  const add = [`遂行日: ${day}`, '完了: false']
  if (date) return [{ from: text.lastIndexOf('\n', date.valueFrom) + 1, insert: add.map((l) => l + eol).join('') }]
  return addProps(text, [...add, `date: '${today()}'`])
}

// タグの行: 閉じ --- → 空行 → #タグ → 空行 → 本文
export function setTags(text: string, tags: string[]): Change[] {
  const eol = eolOf(text)
  const line = tags.map((t) => '#' + t).join(' ')
  const tl = tagLine(text)
  if (tl) {
    if (tags.length) return [{ from: tl.from, to: tl.to, insert: line }]
    // タグを全部外したら、タグの行とそのあとの空行1行をなくす(閉じ --- のあとの空行は残る)
    const after = text.slice(tl.to).match(/^(\r?\n){0,2}/)![0]
    return [{ from: tl.from, to: tl.to + after.length, insert: '' }]
  }
  if (!tags.length) return []
  const fm = parseFront(text)
  if (!fm) return [{ from: 0, insert: line + eol + eol }]
  const ws = text.slice(fm.to).match(/^(\r?\n)*/)![0]
  const body = text.length > fm.to + ws.length
  return [{ from: fm.to, to: fm.to + ws.length, insert: eol + eol + line + eol + (body ? eol : '') }]
}

// ---- タイトルを書かなかったときの名前: 本文の書き出しから(プロパティ・タグの行・記号はのぞく) ----

export function cleanName(name: string) {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80)
}

export function nameFromBody(text: string, now = new Date()) {
  const fm = parseFront(text)
  const tl = tagLine(text)
  const start = tl ? tl.to : fm ? fm.to : 0
  for (const raw of text.slice(start).split('\n')) {
    let t = raw.replace(/\r$/, '').trim()
    if (!t || /^(#[^\s#]+\s*)+$/.test(t) || /^(```|~~~|---|\*\*\*)/.test(t)) continue
    t = t.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+\.\s+)/, '')
      .replace(/!?\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_m, a, _b, c) => c || a)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_`~]/g, '')
    t = cleanName(t)
    if (!t) continue
    // 長いときは句読点・空白のところで切る(だいたい24文字まで)
    if (t.length > 24) {
      const cut = t.slice(0, 28).search(/[。．.!！?？、,，]\s*[^。．.!！?？、,，]*$/)
      t = cut >= 8 ? t.slice(0, cut) : t.slice(0, 24)
    }
    return t.replace(/[。．、,，\s]+$/, '')
  }
  const p = (n: number) => String(n).padStart(2, '0')
  return `メモ ${today(now)} ${p(now.getHours())}${p(now.getMinutes())}`
}

// 変更をまとめて文字列に当てる(後ろから当てるので位置がずれない)
export function applyChanges(text: string, changes: Change[]) {
  let out = text
  for (const c of [...changes].sort((a, b) => b.from - a.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to ?? c.from)
  return out
}

// プロパティを1行消す(値がリストなど次の行に続くものは、その行も)
export function removeProp(text: string, key: string): Change[] {
  const fm = parseFront(text)
  const p = fm?.props.find((x) => x.key === key)
  if (!fm || !p) return []
  const lines = fm.lines
  let end = p.line + 1
  while (end < fm.closeLine && /^\s/.test(lines[end])) end++
  let from = 0
  for (let i = 0; i < p.line; i++) from += lines[i].length + 1
  let to = from
  for (let i = p.line; i < end; i++) to += lines[i].length + 1
  return [{ from, to, insert: '' }]
}
