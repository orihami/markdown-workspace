// ことばで期限: 文の中の日付のことば(「来週水曜」「明日」「11/11」など)を見つけて YYYY-MM-DD にする。
// 課題を言われたまま書く(「実習課題 来週水曜午後三時」)と、遂行日が入るように
import { today } from './memo'

const WEEK = '日月火水木金土'
const KANJI_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const num = (s: string) => {
  const z = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  if (/^\d+$/.test(z)) return parseInt(z, 10)
  // 十一・二十 など
  if (z === '十') return 10
  const m = z.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/)
  if (m) return (m[1] ? KANJI_NUM[m[1]] : 1) * 10 + (m[2] ? KANJI_NUM[m[2]] : 0)
  return KANJI_NUM[z] ?? NaN
}
const N = '([0-9０-９]{1,2}|[一二三四五六七八九十]{1,3})'

const add = (d: Date, days: number) => { const x = new Date(d); x.setDate(x.getDate() + days); return x }
// その日を含む週の、月曜はじまりの曜日 w(0=日)
function weekday(base: Date, w: number, weeksAhead: number) {
  const monday = add(base, -((base.getDay() + 6) % 7))
  return add(monday, ((w + 6) % 7) + 7 * weeksAhead)
}

export type FoundDate = { day: string; text: string; index: number }

export function findDate(text: string, now = new Date()): FoundDate | null {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const rules: [RegExp, (m: RegExpMatchArray) => Date | null][] = [
    [/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/, (m) => new Date(+m[1], +m[2] - 1, +m[3])],
    [new RegExp(`来月${N}日`), (m) => new Date(base.getFullYear(), base.getMonth() + 1, num(m[1]))],
    [new RegExp(`${N}月${N}日`), (m) => nextYearIfPast(new Date(base.getFullYear(), num(m[1]) - 1, num(m[2])), base)],
    [/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/, (m) => nextYearIfPast(new Date(base.getFullYear(), +m[1] - 1, +m[2]), base)],
    [/今日|きょう|本日/, () => base],
    [/明日|あした|あす/, () => add(base, 1)],
    [/明後日|あさって/, () => add(base, 2)],
    [new RegExp(`${N}日後`), (m) => add(base, num(m[1]))],
    [new RegExp(`${N}週間後`), (m) => add(base, 7 * num(m[1]))],
    [/再来週の?([日月火水木金土])曜?日?/, (m) => weekday(base, WEEK.indexOf(m[1]), 2)],
    [/来週の?([日月火水木金土])曜?日?/, (m) => weekday(base, WEEK.indexOf(m[1]), 1)],
    [/今週の?([日月火水木金土])曜?日?/, (m) => weekday(base, WEEK.indexOf(m[1]), 0)],
    [/(?:次の|つぎの)?([日月火水木金土])曜日?/, (m) => { const w = WEEK.indexOf(m[1]); const d = (w - base.getDay() + 7) % 7 || 7; return add(base, d) }],
    [/来週/, () => weekday(base, 1, 1)],
    [/今週末|週末/, () => weekday(base, 6, base.getDay() === 0 ? -1 : 0)],
    [/月末/, () => new Date(base.getFullYear(), base.getMonth() + 1, 0)],
    [/来月/, () => new Date(base.getFullYear(), base.getMonth() + 1, 1)],
  ]
  let best: (FoundDate & { at: number }) | null = null
  for (const [re, fn] of rules) {
    const m = text.match(re)
    if (!m || m.index === undefined) continue
    const d = fn(m)
    if (!d || isNaN(d.getTime())) continue
    // いちばん前に書かれたものを使う(同じ位置なら、上の決まりを優先)
    if (!best || m.index < best.at) best = { day: today(d), text: m[0], index: m.index, at: m.index }
  }
  return best && { day: best.day, text: best.text, index: best.index }
}

function nextYearIfPast(d: Date, base: Date) {
  // 「1/10」と書いて今が11月なら来年のこと
  return d < add(base, -60) ? new Date(d.getFullYear() + 1, d.getMonth(), d.getDate()) : d
}

// 課題・締切っぽい言葉(タスクにするか聞くとき)
export const TASK_WORDS = /課題|提出|締切|締め切り|しめきり|レポート|宿題|テスト|試験|発表|予約|申し込み|申込|までに|やる|する/

export function shortDay(day: string, now = new Date()) {
  const d = new Date(day + 'T00:00:00')
  const diff = Math.round((d.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000)
  const label = `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`
  return diff === 0 ? `今日 ${label}` : diff === 1 ? `明日 ${label}` : diff > 1 && diff < 7 ? `${diff}日後 ${label}` : label
}

// くり返すタスク(プロパティ「くり返し」): 完了にしたら、次の回の日付に進める
export const REPEATS = ['毎日', '平日', '毎週', '毎月'] as const
export function nextOccurrence(day: string, rule: string, now = new Date()) {
  const start = new Date((day && day > today(now) ? day : today(now)) + 'T00:00:00')
  const d = new Date(start)
  if (rule === '毎日') d.setDate(d.getDate() + 1)
  else if (rule === '平日') { do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6) }
  else if (rule === '毎週') d.setDate(d.getDate() + 7)
  else if (rule === '毎月') d.setMonth(d.getMonth() + 1)
  else return null
  return today(d)
}
