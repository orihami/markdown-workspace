// ことばで期限・くり返しのテスト(npm run test:unit)
import { findDate, nextOccurrence } from '../src/jdate'

const now = new Date(2026, 10, 4) // 2026-11-04 水曜
const cases: [string, string | null][] = [
  ['実習課題 来週水曜午後三時', '2026-11-11'], ['明日までにレポート', '2026-11-05'], ['あさって発表', '2026-11-06'],
  ['金曜に提出', '2026-11-06'], ['水曜日に', '2026-11-11'], ['今週金曜', '2026-11-06'], ['再来週の月曜', '2026-11-16'],
  ['11月20日 締切', '2026-11-20'], ['十一月二十日', '2026-11-20'], ['12/3 テスト', '2026-12-03'], ['1/10', '2027-01-10'],
  ['3日後', '2026-11-07'], ['2週間後', '2026-11-18'], ['月末まで', '2026-11-30'], ['週末に', '2026-11-07'],
  ['来月5日', '2026-12-05'], ['2026-12-24', '2026-12-24'], ['ふつうのメモ', null], ['今日やる', '2026-11-04'],
]
let bad = 0
for (const [t, want] of cases) {
  const got = findDate(t, now)?.day ?? null
  if (got !== want) { bad++; console.log('NG', t, got, want) }
}
const rep: [string, string, string][] = [['2026-11-04', '毎日', '2026-11-05'], ['2026-11-06', '平日', '2026-11-09'], ['2026-11-04', '毎週', '2026-11-11'], ['2026-10-01', '毎週', '2026-11-11'], ['2026-11-04', '毎月', '2026-12-04']]
for (const [d, r, want] of rep) {
  const got = nextOccurrence(d, r, now)
  if (got !== want) { bad++; console.log('NG', d, r, got, want) }
}
console.log(bad ? `NG ${bad}件` : `OK ${cases.length + rep.length}件`)
process.exit(bad ? 1 : 0)
