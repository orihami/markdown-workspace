// Obsidian のライブプレビューのように、Markdown の原文はそのままで「見た目だけ」整える CodeMirror の拡張。
// ファイルの中身は1文字も変えない(Decoration で記号を隠したり、行の見た目を変えたりするだけ)。
//
//   obsidian: カーソルのある行だけ記号(# - ** > など)が見える。ほかの行は整った見た目
//   notion  : 記号はいつも隠す
//   source  : 記号はそのまま。リンクだけ Ctrl(⌘)+クリックで開けるようにする
// リンクを押すと onLink が呼ばれる(URL は新しいタブ、[[内部リンク]] はそのノートを開く)
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view'
import { Range, Text } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

export type LiveMode = 'obsidian' | 'notion' | 'source'
export type LinkHandler = (kind: 'url' | 'note', target: string) => void

class BulletWidget extends WidgetType {
  eq() { return true }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'cm-lp-bullet'
    s.textContent = '•'
    return s
  }
}

class CheckWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) { super() }
  eq(o: CheckWidget) { return o.checked === this.checked && o.pos === this.pos }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-lp-check'
    box.checked = this.checked
    // クリックで [ ] と [x] を入れかえる(本人の操作なので原文を書きかえてよい)
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      view.dispatch({ changes: { from: this.pos + 1, to: this.pos + 2, insert: this.checked ? ' ' : 'x' }, userEvent: 'input.toggle' })
    })
    return box
  }
  ignoreEvent() { return false }
}

const hidden = Decoration.replace({})
const bullet = Decoration.replace({ widget: new BulletWidget() })
const lineClass = (cls: string) => Decoration.line({ class: cls })
const markClass = (cls: string) => Decoration.mark({ class: cls })

// ファイル先頭の YAML Frontmatter(--- 〜 ---)の終わり。無ければ 0
// (Markdown の文法では見出しや区切り線に見えてしまうので、ここは別あつかいにする)
export function frontmatterEnd(doc: Text): number {
  if (doc.lines < 2 || doc.line(1).text !== '---') return 0
  for (let n = 2; n <= Math.min(doc.lines, 200); n++) {
    const t = doc.line(n).text
    if (t === '---' || t === '...') return doc.line(n).to
  }
  return 0
}

const linkMark = (cls: string, attrs: Record<string, string>) => Decoration.mark({ class: cls, attributes: attrs })

function build(view: EditorView, mode: LiveMode): { all: DecorationSet; atomic: DecorationSet } {
  const source = mode === 'source'
  const { state } = view
  const doc = state.doc
  const decos: Range<Decoration>[] = []
  const atomic: Range<Decoration>[] = [] // 隠した記号・置きかえた部品(カーソルはまとめて飛ばす)
  const fmEnd = frontmatterEnd(doc)
  // obsidian: カーソル(選択)のある行は原文を見せる
  const active = new Set<number>()
  if (mode === 'obsidian') {
    for (const r of state.selection.ranges) {
      for (let n = doc.lineAt(r.from).number; n <= doc.lineAt(r.to).number; n++) active.add(n)
    }
  }
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number)
  const hide = (from: number, to: number) => {
    if (!source && from < to && !isActive(from)) atomic.push(hidden.range(from, to))
  }
  const eachLine = (from: number, to: number, cls: string) => {
    if (source) return
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) decos.push(lineClass(cls).range(doc.line(n).from))
  }
  const codeLines = new Set<number>()

  if (fmEnd) eachLine(0, fmEnd, 'cm-lp-fm')
  const look = (d: Range<Decoration>) => { if (!source) decos.push(d) }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        if (node.to <= fmEnd) return false
        if (node.from < fmEnd) return
        const name = node.name
        let m: RegExpMatchArray | null
        if ((m = name.match(/^(ATX|Setext)Heading(\d)$/))) {
          eachLine(node.from, node.to, `cm-lp-h cm-lp-h${m[2]}`)
        } else if (name === 'HeaderMark') {
          const parent = node.node.parent?.name || ''
          if (parent.startsWith('ATX')) {
            // "## " の記号と後ろの空白を隠す
            const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
            if (node.from === doc.lineAt(node.from).from) hide(node.from, end)
            else hide(node.from, node.to) // 行末の閉じ #
          } else hide(node.from, node.to)
        } else if (name === 'EmphasisMark' || name === 'StrikethroughMark') {
          hide(node.from, node.to)
        } else if (name === 'StrongEmphasis') {
          look(markClass('cm-lp-strong').range(node.from, node.to))
        } else if (name === 'Emphasis') {
          look(markClass('cm-lp-em').range(node.from, node.to))
        } else if (name === 'Strikethrough') {
          look(markClass('cm-lp-strike').range(node.from, node.to))
        } else if (name === 'InlineCode') {
          look(markClass('cm-lp-icode').range(node.from, node.to))
        } else if (name === 'CodeMark' && node.node.parent?.name === 'InlineCode') {
          hide(node.from, node.to)
        } else if (name === 'FencedCode' || name === 'CodeBlock') {
          const first = doc.lineAt(node.from).number
          const last = doc.lineAt(node.to).number
          for (let n = first; n <= last; n++) {
            codeLines.add(n)
            const fence = name === 'FencedCode' && (n === first || n === last)
            look(lineClass('cm-lp-code' + (fence ? ' cm-lp-fence' : '') + (n === first ? ' cm-lp-code-first' : '') + (n === last ? ' cm-lp-code-last' : '')).range(doc.line(n).from))
          }
          return false
        } else if (name === 'Blockquote') {
          eachLine(node.from, node.to, 'cm-lp-quote')
        } else if (name === 'QuoteMark') {
          const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
          hide(node.from, end)
        } else if (name === 'ListMark') {
          const item = node.node.parent
          const list = item?.parent?.name
          const hasTask = !!item?.getChild('Task')
          if (source) return
          if (list === 'BulletList' && !isActive(node.from)) {
            if (hasTask) hide(node.from, node.to + 1)
            else atomic.push(bullet.range(node.from, node.to))
          } else if (list === 'OrderedList') look(markClass('cm-lp-olmark').range(node.from, node.to))
        } else if (name === 'TaskMarker') {
          if (!source && !isActive(node.from)) {
            const checked = /x/i.test(doc.sliceString(node.from, node.to))
            atomic.push(Decoration.replace({ widget: new CheckWidget(checked, node.from) }).range(node.from, node.to))
          }
        } else if (name === 'Link') {
          // [文字](URL) → 文字だけ見せる。押すと URL を開く
          const url = node.node.getChild('URL')
          if (url) decos.push(linkMark('cm-lp-link', { 'data-href': doc.sliceString(url.from, url.to) }).range(node.from, node.to))
          if (url) {
            for (let c = node.node.firstChild; c; c = c.nextSibling) {
              if (c.name === 'LinkMark' || c.name === 'URL' || c.name === 'LinkTitle') hide(c.from, c.to)
            }
          }
          return false
        } else if (name === 'URL' && node.node.parent?.name !== 'Link') {
          // <https://…> や、そのまま書いた https://…
          decos.push(linkMark('cm-lp-link', { 'data-href': doc.sliceString(node.from, node.to) }).range(node.from, node.to))
        } else if (name === 'HorizontalRule') {
          look(lineClass('cm-lp-hr').range(doc.lineAt(node.from).from))
          hide(node.from, node.to)
        }
      },
    })

    // [[内部リンク]] と #タグ(Markdown の文法に無いので文字で探す)
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos)
      if (!codeLines.has(line.number) && line.from >= fmEnd) {
        const text = line.text
        for (const mm of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
          const s = line.from + mm.index!
          const e = s + mm[0].length
          // [[ノート#見出し|表示名]] → 表示名(なければノート名)だけ見せる
          const inner = mm[1]
          const bar = inner.indexOf('|')
          const target = (bar >= 0 ? inner.slice(0, bar) : inner).split('#')[0].trim()
          decos.push(linkMark('cm-lp-wikilink', { 'data-note': target }).range(s + 2, e - 2))
          hide(s, s + 2)
          if (bar >= 0) hide(s + 2, s + 3 + bar)
          hide(e - 2, e)
        }
        for (const mm of text.matchAll(/(^|\s)(#[^\s#[\]().,!?;:'"`]+)/g)) {
          const s = line.from + mm.index! + mm[1].length
          look(markClass('cm-lp-tag').range(s, s + mm[2].length))
        }
      }
      pos = line.to + 1
    }
  }
  return { all: Decoration.set([...decos, ...atomic], true), atomic: Decoration.set(atomic, true) }
}

export function livePreview(mode: LiveMode, onLink: LinkHandler) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      atomic: DecorationSet
      constructor(view: EditorView) {
        ;({ all: this.decorations, atomic: this.atomic } = build(view, mode))
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.state) !== syntaxTree(u.startState)) {
          ;({ all: this.decorations, atomic: this.atomic } = build(u.view, mode))
        }
      }
    },
    { decorations: (v) => v.decorations },
  )
  // リンクを押したとき。Obsidian表示ではカーソルのある行(記号が見えて編集中の行)は開かずに編集させる
  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = (e.target as HTMLElement).closest('[data-href],[data-note]') as HTMLElement | null
      if (!el || e.button !== 0) return false
      const modifier = e.ctrlKey || e.metaKey
      if (mode === 'source' && !modifier) return false
      if (mode === 'obsidian' && !modifier) {
        const pos = view.posAtDOM(el)
        const line = view.state.doc.lineAt(pos).number
        if (view.state.selection.ranges.some((r) => view.state.doc.lineAt(r.head).number === line)) return false
      }
      e.preventDefault()
      if (el.dataset.href) onLink('url', el.dataset.href)
      else if (el.dataset.note) onLink('note', el.dataset.note)
      return true
    },
  })
  // 隠した記号はカーソルで1文字ずつ通らない(まとめて飛ばす)
  return [plugin, clicks, EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none)]
}
