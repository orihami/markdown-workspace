// Obsidian のライブプレビューのように、Markdown の原文はそのままで「見た目だけ」整える CodeMirror の拡張。
// ファイルの中身は1文字も変えない(Decoration で記号を隠したり、行の見た目を変えたりするだけ)。
//
//   obsidian: カーソルのある行だけ記号(# - ** > など)が見える。ほかの行は整った見た目
//   notion  : 記号はいつも隠す
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view'
import { Range, Text } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'

export type LiveMode = 'obsidian' | 'notion'

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

function build(view: EditorView, mode: LiveMode): DecorationSet {
  const { state } = view
  const doc = state.doc
  const decos: Range<Decoration>[] = []
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
    if (from < to && !isActive(from)) decos.push(hidden.range(from, to))
  }
  const eachLine = (from: number, to: number, cls: string) => {
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) decos.push(lineClass(cls).range(doc.line(n).from))
  }
  const codeLines = new Set<number>()

  if (fmEnd) eachLine(0, fmEnd, 'cm-lp-fm')

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
          decos.push(markClass('cm-lp-strong').range(node.from, node.to))
        } else if (name === 'Emphasis') {
          decos.push(markClass('cm-lp-em').range(node.from, node.to))
        } else if (name === 'Strikethrough') {
          decos.push(markClass('cm-lp-strike').range(node.from, node.to))
        } else if (name === 'InlineCode') {
          decos.push(markClass('cm-lp-icode').range(node.from, node.to))
        } else if (name === 'CodeMark' && node.node.parent?.name === 'InlineCode') {
          hide(node.from, node.to)
        } else if (name === 'FencedCode' || name === 'CodeBlock') {
          const first = doc.lineAt(node.from).number
          const last = doc.lineAt(node.to).number
          for (let n = first; n <= last; n++) {
            codeLines.add(n)
            const fence = name === 'FencedCode' && (n === first || n === last)
            decos.push(lineClass('cm-lp-code' + (fence ? ' cm-lp-fence' : '') + (n === first ? ' cm-lp-code-first' : '') + (n === last ? ' cm-lp-code-last' : '')).range(doc.line(n).from))
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
          if (list === 'BulletList' && !isActive(node.from)) {
            if (hasTask) hide(node.from, node.to + 1)
            else decos.push(bullet.range(node.from, node.to))
          } else if (list === 'OrderedList') decos.push(markClass('cm-lp-olmark').range(node.from, node.to))
        } else if (name === 'TaskMarker') {
          if (!isActive(node.from)) {
            const checked = /x/i.test(doc.sliceString(node.from, node.to))
            decos.push(Decoration.replace({ widget: new CheckWidget(checked, node.from) }).range(node.from, node.to))
          }
        } else if (name === 'Link') {
          decos.push(markClass('cm-lp-link').range(node.from, node.to))
          // [文字](URL) → 文字だけ見せる
          const hasUrl = !!node.node.getChild('URL')
          if (hasUrl) {
            for (let c = node.node.firstChild; c; c = c.nextSibling) {
              if (c.name === 'LinkMark' || c.name === 'URL' || c.name === 'LinkTitle') hide(c.from, c.to)
            }
          }
          return false
        } else if (name === 'URL' && node.node.parent?.name !== 'Link') {
          decos.push(markClass('cm-lp-link').range(node.from, node.to))
        } else if (name === 'HorizontalRule') {
          decos.push(lineClass('cm-lp-hr').range(doc.lineAt(node.from).from))
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
          decos.push(markClass('cm-lp-wikilink').range(s + 2, e - 2))
          hide(s, s + 2)
          hide(e - 2, e)
        }
        for (const mm of text.matchAll(/(^|\s)(#[^\s#[\]().,!?;:'"`]+)/g)) {
          const s = line.from + mm.index! + mm[1].length
          decos.push(markClass('cm-lp-tag').range(s, s + mm[2].length))
        }
      }
      pos = line.to + 1
    }
  }
  return Decoration.set(decos, true)
}

export function livePreview(mode: LiveMode) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view, mode)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.state) !== syntaxTree(u.startState)) {
          this.decorations = build(u.view, mode)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )
  // 隠した記号はカーソルで1文字ずつ通らない(まとめて飛ばす)
  return [plugin, EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none)]
}
