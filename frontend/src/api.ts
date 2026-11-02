// API との通信。時間切れを付け、「つながらない」と「サーバーが断った」を区別する
export class ApiError extends Error {
  // status 0 = サーバーに届かなかった(オフライン・API 停止・時間切れ)
  constructor(message: string, readonly status: number, readonly body: any = null) {
    super(message)
  }
  get network() { return this.status === 0 }
}

export const notePath = (path: string) => '/api/notes/' + path.split('/').map(encodeURIComponent).join('/')

export async function api<T>(url: string, init: RequestInit = {}, timeoutMs = 12000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: ctrl.signal, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) } })
  } catch {
    throw new ApiError('サーバーにつながりません', 0)
  } finally {
    clearTimeout(timer)
  }
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError((body && body.detail) || `HTTP ${response.status}`, response.status, body)
  return body as T
}

export type Note = {
  path: string
  name: string
  modified_at?: string
  size?: number
  // Frontmatter から(並べ替え・タスクの表示用)
  has_props?: boolean
  date?: string | null
  task?: boolean
  task_day?: string | null
  done?: boolean
}
export type NoteResponse = { path: string; content: string; etag: string; modified_at?: string }
export type SearchHit = { path: string; name: string; snippet?: string | null }
export type TagCount = { tag: string; count: number }
