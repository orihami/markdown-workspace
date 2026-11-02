// ブラウザでの通しテスト。テスト用の Vault をコピーして API を起動し、実際に入力・保存・停止・再送・競合を確かめる
//   cd frontend && npm run build && npm run e2e
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'mw-e2e-'))
const vault = join(work, 'vault')
mkdirSync(join(vault, 'sub'), { recursive: true })
writeFileSync(join(vault, 'はじめに.md'), '---\ntags:\n  - test\n---\n# はじめに\n\n[[別のノート]] https://example.com\n\n```js\nconst a = 1\n```\n')
writeFileSync(join(vault, 'sub', 'メモ.md'), '# メモ\r\n\r\nCRLF のノート\r\n')
const port = 18000 + Math.floor(Math.random() * 1000)
const base = `http://127.0.0.1:${port}`
let failed = false
const check = (ok, msg) => { console.log((ok ? 'OK   ' : 'NG   ') + msg); if (!ok) failed = true }

let api
function startApi() {
  api = spawn(join(root, 'backend/.venv/bin/uvicorn'), ['app.main:app', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: join(root, 'backend'),
    env: { ...process.env, VAULT_ROOT: vault, WORKSPACE_DB: join(work, 'state.sqlite3'), ALLOWED_ORIGINS: base },
    stdio: 'ignore',
  })
  return waitFor(async () => (await fetch(base + '/api/health').catch(() => null))?.ok)
}
const stopApi = () => new Promise((r) => { api.once('exit', r); api.kill() })
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)) }
  return false
}

const browser = await chromium.launch()
try {
  check(await startApi(), 'API が起動')
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  await page.goto(base)
  await page.waitForSelector('.note-item')
  check((await page.locator('.note-item').count()) === 2, 'ノート一覧に2件')
  await page.click('.note-item:has-text("はじめに")')
  await page.waitForSelector('.cm-content')
  check((await page.textContent('.document-title')) === 'はじめに', 'タイトルに .md が付かない')

  // 入力 → 保存済み → ファイルに反映(Frontmatter・リンク・コードはそのまま)
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('追記した行')
  await page.waitForSelector('.save-indicator.saved', { timeout: 10000 })
  const saved = readFileSync(join(vault, 'はじめに.md'), 'utf8')
  check(saved.includes('追記した行') && saved.startsWith('---\ntags:\n  - test\n---\n') && saved.includes('[[別のノート]]') && saved.includes('```js'), '保存するとファイルに反映され、Frontmatter・リンク・コードが残る')

  // / の候補をキーボードで選ぶ
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  check(await page.isVisible('.command-menu'), '/ で候補が出る')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.keyboard.type('見出しのテスト')
  await page.waitForSelector('.save-indicator.saved', { timeout: 10000 })
  const h2 = readFileSync(join(vault, 'はじめに.md'), 'utf8')
  check(h2.includes('\n## 見出しのテスト'), '↓ Enter で「見出し 2」が入る')

  // Obsidian表示: # は見出しの大きさに、- は点に。記号はカーソルの行だけ見える。ファイルの中身は変わらない
  check((await page.locator('.mode-switch button.selected').textContent()).includes('Obsidian'), 'はじめは Obsidian表示')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- 箇条書きの行')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('とても長い行'.repeat(30))
  await page.waitForSelector('.save-indicator.saved', { timeout: 10000 })
  const h2line = page.locator('.cm-line.cm-lp-h2', { hasText: '見出しのテスト' })
  check((await h2line.count()) === 1 && !(await h2line.textContent()).includes('#'), '見出しの行は大きく、# はカーソルが無いと隠れる')
  check((await page.locator('.cm-line', { hasText: '箇条書きの行' }).locator('.cm-lp-bullet').count()) === 1, '- は点(•)で表示')
  const wrap = await page.evaluate(() => { const c = document.querySelector('.cm-scroller'); return c.scrollWidth <= c.clientWidth + 1 })
  check(wrap, '長い行は折り返す(横にはみ出さない)')
  const raw = readFileSync(join(vault, 'はじめに.md'), 'utf8')
  check(raw.includes('\n## 見出しのテスト') && raw.includes('\n- 箇条書きの行') && raw.startsWith('---\ntags:'), 'ファイルには Markdown がそのまま保存される')

  // Notion表示: 改行すると候補が出る。そのまま書けば普通の文、選べばブロックになる
  await page.click('.mode-switch button:has-text("Notion")')
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  // (前の行はリストの続きなので、1回目の Enter は「- 」が続き、2回目でリストを抜けて空の行になる)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  check(await page.isVisible('.command-menu'), 'Notion表示: 改行して空の行になると候補が出る(リストを抜けたときも)')
  await page.keyboard.type('ふつうの文')
  check(!(await page.isVisible('.command-menu')), 'Notion表示: そのまま書くと候補は消える')
  await page.keyboard.press('Enter')
  for (let k = 0; k < 8; k++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await page.keyboard.type('引用にした')
  await page.waitForSelector('.save-indicator.saved', { timeout: 10000 })
  check(readFileSync(join(vault, 'はじめに.md'), 'utf8').includes('ふつうの文\n> 引用にした'), 'Notion表示: 候補から「引用」を選ぶと > になる')
  check((await page.locator('.cm-line.cm-lp-quote', { hasText: '引用にした' }).textContent()).includes('>') === false, 'Notion表示: 記号はいつも隠す')
  await page.screenshot({ path: join(work, 'live.png'), fullPage: true })
  console.log('スクショ: ' + join(work, 'live.png'))
  await page.click('.mode-switch button:has-text("Obsidian")')

  // API を止めても入力でき、保存済みにならない → 再起動で自動で再送される
  await stopApi()
  await page.keyboard.press('Enter')
  await page.keyboard.type('止まっている間の入力')
  await page.waitForTimeout(1500)
  const label = await page.textContent('.save-indicator')
  check(!/保存済み/.test(label), `API 停止中は保存済みにならない(${label.trim()})`)
  // (画面も API が配っているので、止まっている間は再読み込みできない。開いたまま待つ)
  check(await startApi(), 'API を再起動')
  const resent = await waitFor(() => readFileSync(join(vault, 'はじめに.md'), 'utf8').includes('止まっている間の入力'), 30000)
  check(resent, '再接続後、送信待ちが自動で再送される')

  // 開き直すと最新が表示される
  await page.reload()
  await page.click('.note-item:has-text("はじめに")')
  await page.waitForSelector('.cm-content')
  check(!(await page.isVisible('.sidebar')), 'スマホ幅ではノートを開くと一覧が閉じる')
  check((await page.textContent('.cm-content')).includes('止まっている間の入力'), '開き直しても内容が残る')

  // ほかの場所(Obsidian など)での変更 → 競合、どちらも消えない
  writeFileSync(join(vault, 'はじめに.md'), '# はじめに\n\nObsidian で書きかえた\n')
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('ブラウザ側の入力')
  await page.waitForSelector('.conflict-banner', { timeout: 10000 })
  check(readFileSync(join(vault, 'はじめに.md'), 'utf8') === '# はじめに\n\nObsidian で書きかえた\n', '競合: サーバーのファイルは上書きされない')
  await page.click('.conflict-banner button:has-text("別名で保存")')
  await page.waitForSelector('.notice')
  const copy = readdirSync(vault).find((f) => f.includes('競合'))
  check(copy && readFileSync(join(vault, copy), 'utf8').includes('ブラウザ側の入力'), `競合: 自分の下書きを別名で保存(${copy})`)

  // CRLF のノートは CRLF のまま
  await page.click('.mobile-menu')
  await page.click('.note-item:has-text("メモ")')
  await page.waitForSelector('.cm-content')
  await page.click('.cm-content')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('追加')
  await page.waitForSelector('.save-indicator.saved', { timeout: 10000 })
  const crlf = readFileSync(join(vault, 'sub', 'メモ.md'), 'utf8')
  check(crlf.includes('追加') && !/[^\r]\n/.test(crlf), 'CRLF のノートは CRLF のまま保存')
  await page.screenshot({ path: join(work, 'mobile.png') })
  console.log('スクショ: ' + join(work, 'mobile.png'))
  check(errors.length === 0, `ブラウザのエラーなし ${errors.slice(0, 3).join(' / ')}`)
} catch (e) {
  console.error(e)
  failed = true
} finally {
  await browser.close()
  if (api && api.exitCode === null) await stopApi()
}
process.exit(failed ? 1 : 0)
