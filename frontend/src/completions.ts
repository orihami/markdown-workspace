// 入力候補(仕様 4.4): [[ でノート名、# でタグ
import { autocompletion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { Note, TagCount } from './api'

// 行の頭の記号(# - > 1. - [ ])を入れかえて、見出し・リストなどにする(/ の候補を選んだとき)
export function applyBlockAt(view: EditorView, hint: string, slashFrom: number, slashTo: number) {
  const line = view.state.doc.lineAt(slashFrom)
  let body = line.text.slice(0, slashFrom - line.from) + line.text.slice(slashTo - line.from)
  const at = slashFrom - line.from
  let insert: string
  let cursor: number
  if (hint === '' || (hint.endsWith(' ') && !hint.includes('\n'))) {
    const old = body.match(/^(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+\. |> )/)?.[0].length ?? 0
    insert = hint + body.slice(old)
    cursor = hint.length + Math.max(0, at - old)
  } else if (hint === '---') {
    body = body.trimEnd()
    insert = body ? body + '\n---\n' : '---\n'
    cursor = insert.length
  } else {
    const before = body.trim() ? body + '\n' : ''
    insert = before + hint
    cursor = before.length + hint.indexOf('\n') + 1
  }
  view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + cursor }, userEvent: 'input.block' })
}

// / で見出し・リストなどの候補(CodeMirror の候補として出す。ホームのすぐ書く欄で使う)
export function slashSource(cmds: { label: string; hint: string }[]): CompletionSource {
  return (ctx) => {
    const m = ctx.matchBefore(/(?:^|\s)\/[^\s/]*$/)
    if (!m) return null
    const from = m.from + m.text.indexOf('/')
    return {
      from,
      options: cmds.map((c) => ({
        label: '/' + c.label,
        displayLabel: c.label,
        detail: c.hint ? c.hint.replace(/\n/g, ' ↵ ') : '記号なし',
        apply: (view: EditorView, _c: unknown, f: number, t: number) => applyBlockAt(view, c.hint, f, t),
      })),
      validFor: /^\/[^\s/]*$/,
    }
  }
}

export function workspaceCompletions(getNotes: () => Note[], getTags: () => TagCount[], extra: CompletionSource[] = []) {
  const wiki = (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\[\[[^\]|#\n]*$/)
    if (!m) return null
    const closed = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === ']]'
    return {
      from: m.from + 2,
      options: getNotes().map((n) => {
        const folder = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : ''
        return { label: n.name, detail: folder, apply: closed ? n.name : n.name + ']]', type: 'text' }
      }),
      validFor: /^[^\]|#\n]*$/,
    }
  }
  const tag = (ctx: CompletionContext): CompletionResult | null => {
    // 見出しの「# 」と区別するため、# のあとに1文字以上打ってから出す
    const m = ctx.matchBefore(/(?:^|\s)#[^\s#]+$/)
    if (!m) return null
    const from = m.from + m.text.indexOf('#') + 1
    return {
      from,
      options: getTags().map((t) => ({ label: t.tag, detail: `${t.count}`, type: 'keyword' })),
      validFor: /^[^\s#]*$/,
    }
  }
  return autocompletion({ override: [wiki, tag, ...extra], icons: false, closeOnBlur: true })
}
