// ブラウザでの通しテスト。テスト用の Vault を作って API を起動し、実際に入力・保存・停止・再送・競合などを確かめる
//   cd frontend && npm run build && npm run e2e
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'mw-e2e-'))
const vault = join(work, 'vault')
mkdirSync(join(vault, 'sub'), { recursive: true })
const FIRST = '---\ntags:\n  - test\n---\n# はじめに\n\n[[メモ]] と [外部](https://example.com/x)\n\n```js\nconst a = 1\n```\n'
writeFileSync(join(vault, 'はじめに.md'), FIRST)
writeFileSync(join(vault, 'sub', 'メモ.md'), '# メモ\r\n\r\nCRLF のノート #sample\r\n')
// めもフォルダ(きまり: date 必須、date の新しい順、sortspec は最後)
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const T = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
mkdirSync(join(vault, 'めも'))
writeFileSync(join(vault, 'めも', '古いメモ.md'), "---\ndate: '2026-01-01'\n---\n\n#古い\n\n本文\n")
writeFileSync(join(vault, 'めも', '新しいメモ.md'), "---\ndate: '2026-10-30'\n---\n\n新しい本文\n")
writeFileSync(join(vault, 'めも', 'タスクA.md'), `---\n遂行日: ${T}\n完了: false\ndate: '2026-10-01'\n---\n`)
writeFileSync(join(vault, 'めも', '日付なし.md'), 'プロパティの無いメモ\n')
writeFileSync(join(vault, 'めも', 'sortspec.md'), "---\ndate: '2026-09-13'\n---\n\n並べ替えの設定\n")
const port = 18000 + Math.floor(Math.random() * 1000)
const base = `http://127.0.0.1:${port}`
const read = (p) => readFileSync(join(vault, p), 'utf8')
let failed = false
const check = (ok, msg) => { console.log((ok ? 'OK   ' : 'NG   ') + msg); if (!ok) failed = true }

let apiProc
function startApi() {
  apiProc = spawn(join(root, 'backend/.venv/bin/uvicorn'), ['app.main:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: join(root, 'backend'),
    env: { ...process.env, VAULT_ROOT: vault, WORKSPACE_DB: join(work, 'state.sqlite3'), ALLOWED_ORIGINS: base },
    stdio: 'ignore',
  })
  return waitFor(async () => (await fetch(base + '/api/health').catch(() => null))?.ok)
}
const stopApi = () => new Promise((r) => { apiProc.once('exit', r); apiProc.kill() })
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)) }
  return false
}

const browser = await chromium.launch()
try {
  check(await startApi(), 'API が起動')
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  // http で開いたときと同じく crypto.randomUUID が無い状態にする(2026-11-02 に保存が1回も送られなかった原因)
  await ctx.addInitScript(() => { try { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined }) } catch {} })
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  await ctx.route(/example\.com/, (r) => r.fulfill({ body: 'ok' }))
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.accept())
  const puts = []
  page.on('request', (r) => { if (r.method() === 'PUT') puts.push(r.url()) })

  await page.goto(base)
  check(await page.isVisible('.welcome'), 'はじめは「最近のノート」の画面')
  await page.waitForSelector('.tree-folder')
  check((await page.locator('.tree-folder').count()) === 2 && (await page.locator('.note-item').count()) === 1, 'フォルダの木: めも・sub フォルダとノート1件')
  // めもの並び: date の新しい順、date 無しはそのあと、sortspec は最後
  await page.click('.tree-folder:has-text("めも")')
  const order = async () => (await page.locator('.tree-folder:has-text("めも") + .note-item, .note-item').allTextContents()).filter((t) => /メモ|タスクA|日付なし|sortspec/.test(t) && !t.startsWith('メモ')).map((t) => t.replace(/\d\d\/\d\d.*$/, '').replace(/\d+\/\d+$/, ''))
  const o1 = await order()
  check(JSON.stringify(o1) === JSON.stringify(['新しいメモ', 'タスクA', '古いメモ', '日付なし', 'sortspec']), `めも: 日付が新しい順(sortspec は最後) ${o1.join(' > ')}`)
  await page.selectOption('.sort-box select', 'おすすめ')
  const o2 = await order()
  check(o2[0] === 'タスクA' && o2[o2.length - 1] === 'sortspec', `並べ替え「おすすめ」: 今日のタスクが先頭 ${o2.join(' > ')}`)
  check(await page.isVisible('.note-item.task:has-text("タスクA") small.today'), 'タスクには印と遂行日が出る')
  await page.selectOption('.sort-box select', '日付が新しい順')
  await page.click('.tree-folder:has-text("めも")')
  await page.click('.tree-folder:has-text("sub")')
  check(await page.isVisible('.note-item:has-text("メモ")'), 'フォルダを開くと中のノートが出る')
  await page.click('.note-item:has-text("はじめに")')
  await page.waitForSelector('.cm-content')
  check((await page.textContent('.document-title')) === 'はじめに', 'ノートを開く(タイトルに .md が付かない)')
  check(decodeURIComponent(new URL(page.url()).hash) === '#/はじめに.md', 'URL にノートの場所が入る')

  // 入力 → 保存済み(randomUUID が無くても送られる)
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('追記した行')
  await page.waitForSelector('.save-indicator.s-saved', { timeout: 10000 })
  const saved = read('はじめに.md')
  check(puts.length > 0 && saved.includes('追記した行'), `randomUUID が使えない(http と同じ)状態でも保存が送られる(PUT ${puts.length}回)`)
  check(saved.startsWith('---\ntags:\n  - test\n---\n') && saved.includes('[[メモ]]') && saved.includes('```js'), '保存しても Frontmatter・リンク・コードはそのまま')

  // / の候補
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  check(await page.isVisible('.command-menu'), '/ で候補が出る')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.keyboard.type('見出しのテスト')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- 箇条書きの行')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('とても長い行'.repeat(40))
  await page.waitForSelector('.save-indicator.s-saved', { timeout: 10000 })
  check(read('はじめに.md').includes('\n## 見出しのテスト\n- 箇条書きの行'), '↓↓ Enter で「見出し 2」、- で箇条書き(ファイルは Markdown のまま)')

  // Obsidian表示の見た目
  const h2line = page.locator('.cm-line.cm-lp-h2', { hasText: '見出しのテスト' })
  check((await h2line.count()) === 1 && !(await h2line.textContent()).includes('#'), 'Obsidian表示: 見出しは大きく、# はカーソルが無いと隠れる')
  check((await page.locator('.cm-line', { hasText: '箇条書きの行' }).locator('.cm-lp-bullet').count()) === 1, 'Obsidian表示: - は点(•)')
  check(await page.evaluate(() => { const c = document.querySelector('.cm-scroller'); return c.scrollWidth <= c.clientWidth + 1 }), '長い行は折り返す')
  // 太字の途中にもカーソルを置ける(前の版は太字・リンク全体を飛ばしていた)
  await page.keyboard.press('Enter')
  await page.keyboard.type('前**太字**後')
  // 後 → ** → ** と戻ると「字」のうしろ(記号の見えている行なので1文字ずつ動ける)
  for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.type('X')
  await page.waitForSelector('.save-indicator.s-saved', { timeout: 10000 })
  check(read('はじめに.md').includes('前**太字X**後'), '太字の文字の途中にもカーソルを置いて書ける')

  // リンク: [[メモ]] はそのノートを開く、URL は新しいタブ
  const popup = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null)
  await page.click('.cm-lp-link[data-href="https://example.com/x"]')
  const tab = await popup
  check(tab && tab.url().startsWith('https://example.com/x'), 'URL を押すと新しいタブで開く')
  if (tab) await tab.close()
  await page.click('.cm-lp-wikilink[data-note="メモ"]')
  await page.waitForFunction(() => document.querySelector('.document-title')?.textContent === 'メモ')
  check(true, '[[メモ]] を押すと、そのノート(sub/メモ.md)を開く')
  await page.goBack()
  await page.waitForFunction(() => document.querySelector('.document-title')?.textContent === 'はじめに')
  check(true, 'ブラウザの「戻る」で前のノートへ')

  // 三点メニュー
  await page.click('button[aria-label="ノートのメニュー"]')
  check(await page.isVisible('.dropdown button:has-text("Obsidian で開く")'), '三点メニューが開く(Obsidian で開く・パスをコピー など)')
  await page.click('.dropdown button:has-text("Notion表示")')
  check((await page.locator('.mode-switch button.selected').textContent()).includes('Notion'), '三点メニューから表示を切りかえ')

  // Notion表示: 改行すると候補
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  check(await page.isVisible('.command-menu'), 'Notion表示: 改行すると候補が出る')
  await page.keyboard.type('ふつうの文')
  check(!(await page.isVisible('.command-menu')), 'Notion表示: そのまま書くと候補は消える')
  await page.keyboard.press('Enter')
  for (let k = 0; k < 8; k++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.keyboard.type('引用にした')
  await page.waitForSelector('.save-indicator.s-saved', { timeout: 10000 })
  check(read('はじめに.md').includes('ふつうの文\n> 引用にした'), 'Notion表示: 候補から「引用」を選ぶと > になる')
  await page.click('.mode-switch button:has-text("Obsidian")')

  // [[ でノート名の候補
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('[[')
  await page.waitForSelector('.cm-tooltip-autocomplete', { timeout: 5000 })
  await page.keyboard.type('メ')
  await page.waitForSelector('.cm-completionLabel:has-text("メモ")', { timeout: 5000 })
  await page.waitForTimeout(200) // 出た直後(75ms)は確定できない作り
  await page.keyboard.press('Enter')
  await page.waitForSelector('.save-indicator.s-saved', { timeout: 10000 })
  check(read('はじめに.md').trimEnd().endsWith('[[メモ]]'), '[[ でノート名の候補が出て、選ぶと [[メモ]] になる')

  // Ctrl+K で本文を探す
  await page.keyboard.press('Control+k')
  await page.fill('.switcher-input input', 'CRLF')
  await page.waitForSelector('.switcher-item em', { timeout: 5000 })
  check((await page.textContent('.switcher-item em')).includes('CRLF'), 'Ctrl+K: 本文から探せて、前後の文が出る')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.document-title')?.textContent === 'メモ')

  // タグ
  await page.waitForSelector('.tag-chip:has-text("#test")')
  await page.click('.tag-chip:has-text("#test")')
  await page.waitForSelector('.switcher-item:has-text("はじめに")', { timeout: 5000 })
  check(true, 'タグを押すと、そのタグのノートが出る(Frontmatter のタグ)')
  await page.keyboard.press('Escape')

  // CRLF のノートは CRLF のまま
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('追加')
  await page.waitForSelector('.save-indicator.s-saved', { timeout: 10000 })
  const crlf = read('sub/メモ.md')
  check(crlf.includes('追加') && !/[^\r]\n/.test(crlf), 'CRLF のノートは CRLF のまま')

  // 新しいメモ(Alt+N): ふだんは めも に、date 付きで作る
  await page.keyboard.press('Alt+n')
  check((await page.inputValue('.modal select')) === 'めも', '新しく作る場所は、ふだん「めも」')
  await page.fill('.modal input[placeholder="メモの名前"]', '新規ノート')
  await page.click('.modal button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.document-title')?.textContent === '新規ノート')
  check(read('めも/新規ノート.md') === `---\ndate: '${T}'\n---\n\n`, `新しいメモには date: '${T}' が付く`)
  // タスク: 遂行日・完了・date の順、タグは閉じ --- のあと空行をはさんで本文の前
  await page.keyboard.press('Alt+n')
  await page.click('.modal .seg button:has-text("タスク")')
  await page.fill('.modal input[placeholder="タスクの名前"]', '新しいタスク')
  await page.fill('.modal input[placeholder^="例"]', 'AI 学校')
  await page.click('.modal button[type="submit"]')
  await page.waitForFunction(() => document.querySelector('.document-title')?.textContent === '新しいタスク')
  check(read('めも/新しいタスク.md') === `---\n遂行日: ${T}\n完了: false\ndate: '${T}'\n---\n\n#AI #学校\n\n`, 'タスクは 遂行日・完了: false・date、タグは空行のあと')
  check(!(await page.textContent('.cm-content')).includes('遂行日'), 'Obsidian表示ではプロパティはエディタに出さず、上の欄に出す')
  // プロパティの欄で 完了 にする → ファイルと一覧の印
  await page.check('.prop input[aria-label="完了"]')
  await page.waitForSelector('.save-indicator.s-saved', { timeout: 10000 })
  check(read('めも/新しいタスク.md').includes('完了: true'), 'プロパティの欄で 完了 にするとファイルも true')
  check(await page.isVisible('.note-item.done:has-text("新しいタスク")'), '完了したタスクは一覧で線が引かれる')
  // date の無いメモ → 知らせて、1回押せば付く
  await page.click('.note-item:has-text("日付なし")')
  await page.waitForSelector('.props.warn')
  await page.click('.props button:has-text("今日の日付で付ける")')
  await page.waitForSelector('.save-indicator.s-saved', { timeout: 10000 })
  check(read('めも/日付なし.md') === `---\ndate: '${T}'\n---\n\nプロパティの無いメモ\n`, 'date の無いメモは知らせて、押すと date を付ける(本文の前は空行1行)')
  // タグを足す: 閉じ --- → 空行 → #タグ → 空行 → 本文
  await page.click('.note-item:has-text("新しいメモ")')
  await page.waitForSelector('.tag-input')
  await page.fill('.tag-input', '追加タグ')
  await page.press('.tag-input', 'Enter')
  await page.waitForSelector('.save-indicator.s-saved', { timeout: 10000 })
  check(read('めも/新しいメモ.md') === "---\ndate: '2026-10-30'\n---\n\n#追加タグ\n\n新しい本文\n", 'プロパティの欄でタグを足すと、きまりの位置に入る')

  // API を止めても書ける → 保存済みにならない → 戻ると自動で送る
  await page.click('.note-item:has-text("はじめに")')
  await page.waitForFunction(() => document.querySelector('.document-title')?.textContent === 'はじめに')
  await stopApi()
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('止まっている間の入力')
  await page.waitForSelector('.save-indicator.s-unsaved, .save-indicator.s-offline', { timeout: 10000 })
  check(!(await page.isVisible('.save-indicator.s-saved')), `API 停止中は保存済みにならない(${(await page.textContent('.save-indicator')).trim()})`)
  check(await page.waitForSelector('.status-strip', { timeout: 10000 }).then(() => true, () => false), 'つながらないことを文で知らせる')
  check(await startApi(), 'API を再起動')
  check(await waitFor(() => read('はじめに.md').includes('止まっている間の入力'), 30000), '再接続後、自動で送り直す')
  await page.waitForSelector('.save-indicator.s-saved', { timeout: 30000 })

  // 再読み込みしても同じノート
  await page.reload()
  await page.waitForFunction(() => document.querySelector('.document-title')?.textContent === 'はじめに')
  check((await page.textContent('.cm-content')).includes('止まっている間の入力'), '再読み込みしても同じノートが開き、内容も最新')

  // ほかの場所での変更 → 競合。どちらも消えない
  writeFileSync(join(vault, 'はじめに.md'), '# はじめに\n\nObsidian で書きかえた\n')
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('ブラウザ側の入力')
  await page.waitForSelector('.conflict-banner', { timeout: 10000 })
  check(read('はじめに.md') === '# はじめに\n\nObsidian で書きかえた\n', '競合: サーバーのファイルは上書きされない')
  await page.click('.conflict-banner button:has-text("差分を見る")')
  check((await page.textContent('.diff')).includes('+ ') && (await page.textContent('.diff')).includes('Obsidian で書きかえた'), '競合: 差分が見られる')
  await page.click('.modal button[aria-label="閉じる"]')
  await page.click('.conflict-banner button:has-text("別名で保存")')
  await page.waitForFunction(() => (document.querySelector('.cm-content')?.textContent || '').includes('Obsidian で書きかえた'))
  const copy = readdirSync(vault).find((f) => f.includes('競合'))
  check(copy && read(copy).includes('ブラウザ側の入力'), `競合: 自分の版を別名で保存(${copy})し、ノートはサーバーの版に`)
  await page.screenshot({ path: join(work, 'desktop.png') })

  // スマホ幅: 一覧は閉じていて、開いてノートを選ぶと閉じる
  const m = await browser.newPage({ viewport: { width: 390, height: 844 } })
  m.on('pageerror', (e) => errors.push(e.message))
  await m.route(/fonts\./, (r) => r.abort())
  await m.goto(base + '/#/' + encodeURI('はじめに.md'))
  await m.waitForSelector('.cm-content')
  check(!(await m.isVisible('.sidebar')), 'スマホ幅: はじめは一覧を閉じている')
  await m.click('button[aria-label="一覧を開く・閉じる"]')
  await m.click('.tree-folder:has-text("sub")').catch(() => {})
  await m.click('.note-item:has-text("メモ")')
  await m.waitForFunction(() => document.querySelector('.document-title')?.textContent === 'メモ')
  check(!(await m.isVisible('.sidebar')), 'スマホ幅: ノートを選ぶと一覧が閉じる')
  await m.screenshot({ path: join(work, 'mobile.png') })
  console.log('スクショ: ' + work)
  check(errors.length === 0, `ブラウザのエラーなし ${errors.slice(0, 3).join(' / ')}`)
} catch (e) {
  console.error(e)
  failed = true
} finally {
  await browser.close()
  if (apiProc && apiProc.exitCode === null) await stopApi()
  if (!failed && !process.env.KEEP) rmSync(work, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
