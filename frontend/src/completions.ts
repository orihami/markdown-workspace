// 入力候補(仕様 4.4): [[ でノート名、# でタグ
import { autocompletion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { Note, TagCount } from './api'

export function workspaceCompletions(getNotes: () => Note[], getTags: () => TagCount[]) {
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
  return autocompletion({ override: [wiki, tag], icons: false, closeOnBlur: true })
}
