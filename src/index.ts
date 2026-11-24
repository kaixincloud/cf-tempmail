// cf-tempmail — public temporary email in the style of tempmail.plus,
// built on Cloudflare Workers + Email Routing + D1.
//
// Flow: Email Routing catch-all -> email() handler -> parse MIME -> D1.
// The same Worker serves the web UI and the public JSON API.
//
// API — read-only by known address (the pages never expose domains or
// addresses; a mailbox appears automatically when mail arrives):
//   GET    /api/mails?email=<addr>&epin=<pin>            -> list (metadata only)
//   GET    /api/mails/:id?email=<addr>&epin=<pin>        -> full mail
//   DELETE /api/mails/:id?email=<addr>&epin=<pin>        -> delete one mail
//   GET    /api/latest?email=<addr>  (Authorization: Bearer <API_KEY> or
//          X-API-Key header) -> newest mail, full content; 404 when none
//   POST   /api/test-inject (only when ALLOW_TEST_INJECT="1", for local demo/testing)
// Reading is restricted to addresses under the configured DOMAINS
// (the domain list itself is not served anywhere).
//
// A mailbox is protected when it was created with an `epin` (PIN): every API
// call for that address must then carry the same epin. Only a SHA-256 hash
// of the PIN is stored.

import PostalMime from 'postal-mime'
import { FRONTEND_HTML } from './frontend'
import { OTP_HTML } from './otp-frontend'
import { FAVICON_SVG } from './favicon'

export interface Env {
  DB: D1Database
  DOMAINS?: string
  ALLOW_TEST_INJECT?: string
  /** Secret for the authenticated /api/latest endpoint. Fail-closed when unset. */
  API_KEY?: string
  /** Max number of mails kept in storage (oldest deleted first). Default 1000. */
  MAX_MAILS?: string
  /** "1" enables the full inbox page at /inbox. Anything else (incl. unset) keeps it closed. */
  INBOX_ENABLED?: string
}

const DEFAULT_LIFETIME_MIN = 60
const MAX_LIFETIME_MIN = 7 * 24 * 60 // 1 week, like tempmail.plus
const NAME_RE = /^[a-z0-9._-]{1,64}$/

// ---------- helpers ----------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)))
}

/**
 * Bearer / X-API-Key auth for the machine-facing endpoints.
 * Returns an error Response when access is denied, null when allowed.
 * Comparison is constant-time over SHA-256 hashes; when API_KEY is not
 * configured the endpoint fails closed (503).
 */
async function requireApiKey(req: Request, env: Env): Promise<Response | null> {
  if (!env.API_KEY) return json({ error: 'api_key_not_configured' }, 503)
  const auth = req.headers.get('authorization') || ''
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  const token = bearer || (req.headers.get('x-api-key') || '').trim()
  if (!token) return json({ error: 'unauthorized' }, 401)
  const [a, b] = await Promise.all([sha256(token), sha256(env.API_KEY)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  if (diff !== 0) return json({ error: 'unauthorized' }, 401)
  return null
}

function domains(env: Env): string[] {
  return (env.DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
}

function randomName(): string {
  const words = ['swift', 'bright', 'quiet', 'happy', 'lucky', 'rapid', 'solar', 'velvet']
  const w = words[Math.floor(Math.random() * words.length)]
  const n = Math.floor(1000 + Math.random() * 9000)
  return `${w}${n}`
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time-ish string compare for equal-length hex digests. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

interface MailboxRow {
  address: string
  epin_hash: string | null
  created_at: number
  expires_at: number
}

async function getMailbox(env: Env, address: string): Promise<MailboxRow | null> {
  return env.DB.prepare('SELECT * FROM mailboxes WHERE address = ?')
    .bind(address)
    .first<MailboxRow>()
}

/** Returns an error Response when the epin check fails, otherwise null. */
async function checkAccess(
  env: Env,
  address: string,
  epin: string | null,
): Promise<{ box: MailboxRow | null; error: Response | null }> {
  const box = await getMailbox(env, address)
  if (box && box.expires_at <= Date.now()) {
    return { box: null, error: json({ error: 'mailbox_expired' }, 410) }
  }
  if (box?.epin_hash) {
    if (!epin) return { box, error: json({ error: 'epin_required' }, 401) }
    const hash = await sha256Hex(epin)
    if (!safeEqual(hash, box.epin_hash))
      return { box, error: json({ error: 'epin_invalid' }, 403) }
  }
  return { box, error: null }
}

function parseAddress(raw: string | null): string | null {
  if (!raw) return null
  const addr = raw.trim().toLowerCase()
  const at = addr.lastIndexOf('@')
  if (at <= 0) return null
  const name = addr.slice(0, at)
  const domain = addr.slice(at + 1)
  if (!NAME_RE.test(name) || !domain.includes('.')) return null
  return addr
}

/**
 * Reading is only allowed for addresses under the configured DOMAINS.
 * The domain list itself is never exposed through the API or the pages.
 */
function isAllowedAddress(env: Env, address: string): boolean {
  const domain = address.slice(address.lastIndexOf('@') + 1)
  return domains(env).includes(domain)
}

// ---------- API handlers ----------

async function createMailbox(req: Request, env: Env): Promise<Response> {
  let body: { name?: string; domain?: string; lifetime?: number; epin?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  const list = domains(env)
  const domain = (body.domain || list[0] || '').toLowerCase()
  if (!list.includes(domain)) return json({ error: 'domain_not_allowed' }, 400)

  const name = (body.name || '').trim().toLowerCase() || randomName()
  if (!NAME_RE.test(name)) return json({ error: 'invalid_name' }, 400)
  const address = `${name}@${domain}`

  const lifetimeMin = Math.min(
    Math.max(Math.floor(body.lifetime || DEFAULT_LIFETIME_MIN), 1),
    MAX_LIFETIME_MIN,
  )
  const epin = (body.epin || '').trim()
  if (epin && (epin.length < 4 || epin.length > 32))
    return json({ error: 'epin_length_4_32' }, 400)

  const existing = await getMailbox(env, address)
  if (existing && existing.expires_at > Date.now()) {
    // Re-opening an existing mailbox requires its PIN when it has one.
    const { error } = await checkAccess(env, address, epin || null)
    if (error) return error
    return json({
      result: {
        email: address,
        created_at: existing.created_at,
        expires_at: existing.expires_at,
        protected: !!existing.epin_hash,
      },
    })
  }

  const now = Date.now()
  const expires = now + lifetimeMin * 60_000
  const epinHash = epin ? await sha256Hex(epin) : null
  await env.DB.prepare(
    'INSERT OR REPLACE INTO mailboxes (address, epin_hash, created_at, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(address, epinHash, now, expires)
    .run()
  return json({
    result: { email: address, created_at: now, expires_at: expires, protected: !!epinHash },
  })
}

async function listMails(url: URL, env: Env): Promise<Response> {
  const address = parseAddress(url.searchParams.get('email'))
  if (!address) return json({ error: 'invalid_email' }, 400)
  if (!isAllowedAddress(env, address)) return json({ error: 'domain_not_allowed' }, 403)
  const { box, error } = await checkAccess(env, address, url.searchParams.get('epin'))
  if (error) return error
  if (!box) return json({ result: [], mail_list: [] })
  const { results } = await env.DB.prepare(
    `SELECT id, sender, sender_name, subject, received_at,
            substr(text_body, 1, 140) AS preview
       FROM mails WHERE address = ? ORDER BY id DESC LIMIT 100`,
  )
    .bind(address)
    .all()
  return json({ result: results, mail_list: results })
}

async function getMail(id: string, url: URL, env: Env): Promise<Response> {
  const address = parseAddress(url.searchParams.get('email'))
  if (!address) return json({ error: 'invalid_email' }, 400)
  if (!isAllowedAddress(env, address)) return json({ error: 'domain_not_allowed' }, 403)
  const { error } = await checkAccess(env, address, url.searchParams.get('epin'))
  if (error) return error
  const mail = await env.DB.prepare('SELECT * FROM mails WHERE id = ? AND address = ?')
    .bind(Number(id), address)
    .first()
  if (!mail) return json({ error: 'not_found' }, 404)
  return json({ result: mail })
}

/**
 * Authenticated machine endpoint: GET /api/latest?email=<addr>
 * Returns the newest mail (full content) for the given address.
 * Auth is enforced by the router via requireApiKey before this runs.
 */
async function latestMail(url: URL, env: Env): Promise<Response> {
  const address = parseAddress(url.searchParams.get('email'))
  if (!address) return json({ error: 'invalid_email' }, 400)
  if (!isAllowedAddress(env, address)) return json({ error: 'domain_not_allowed' }, 403)
  // Optional ?since=<epoch ms>: only mails received at/after that moment.
  const sinceRaw = Number(url.searchParams.get('since') || '')
  const hasSince = Number.isFinite(sinceRaw) && sinceRaw > 0
  const mail = hasSince
    ? await env.DB.prepare(
        'SELECT * FROM mails WHERE address = ? AND received_at >= ? ORDER BY received_at DESC, id DESC LIMIT 1',
      )
        .bind(address, Math.floor(sinceRaw))
        .first()
    : await env.DB.prepare(
        'SELECT * FROM mails WHERE address = ? ORDER BY received_at DESC, id DESC LIMIT 1',
      )
        .bind(address)
        .first()
  if (!mail) return json({ error: 'no_mail' }, 404)
  return json({ result: mail })
}

async function deleteMail(id: string, url: URL, env: Env): Promise<Response> {
  const address = parseAddress(url.searchParams.get('email'))
  if (!address) return json({ error: 'invalid_email' }, 400)
  if (!isAllowedAddress(env, address)) return json({ error: 'domain_not_allowed' }, 403)
  const { error } = await checkAccess(env, address, url.searchParams.get('epin'))
  if (error) return error
  await env.DB.prepare('DELETE FROM mails WHERE id = ? AND address = ?')
    .bind(Number(id), address)
    .run()
  return json({ result: true })
}

async function destroyMailbox(url: URL, env: Env): Promise<Response> {
  const address = parseAddress(url.searchParams.get('email'))
  if (!address) return json({ error: 'invalid_email' }, 400)
  if (!isAllowedAddress(env, address)) return json({ error: 'domain_not_allowed' }, 403)
  const { error } = await checkAccess(env, address, url.searchParams.get('epin'))
  if (error) return error
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mails WHERE address = ?').bind(address),
    env.DB.prepare('DELETE FROM mailboxes WHERE address = ?').bind(address),
  ])
  return json({ result: true })
}

async function testInject(req: Request, env: Env): Promise<Response> {
  if (env.ALLOW_TEST_INJECT !== '1') return json({ error: 'disabled' }, 404)
  const body = (await req.json().catch(() => null)) as {
    to?: string
    from?: string
    subject?: string
    text?: string
  } | null
  const address = parseAddress(body?.to || null)
  if (!address) return json({ error: 'invalid_to' }, 400)
  await ensureMailbox(env, address)
  await env.DB.prepare(
    'INSERT INTO mails (address, sender, sender_name, subject, text_body, html_body, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(
      address,
      body?.from || 'demo@example.com',
      '',
      body?.subject || '(no subject)',
      body?.text || '',
      '',
      Date.now(),
    )
    .run()
  return json({ result: true })
}

/** Auto-create a mailbox on first incoming mail (catch-all semantics). */
async function ensureMailbox(env: Env, address: string): Promise<void> {
  const existing = await getMailbox(env, address)
  if (existing && existing.expires_at > Date.now()) return
  const now = Date.now()
  await env.DB.prepare(
    'INSERT OR REPLACE INTO mailboxes (address, epin_hash, created_at, expires_at) VALUES (?, NULL, ?, ?)',
  )
    .bind(address, now, now + 7 * 24 * 60 * 60_000)
    .run()
}

const DEFAULT_MAX_MAILS = 1000

function maxMails(env: Env): number {
  const n = parseInt(env.MAX_MAILS || '', 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MAILS
}

async function cleanup(env: Env): Promise<void> {
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM mails WHERE address IN (SELECT address FROM mailboxes WHERE expires_at <= ?)').bind(now),
    env.DB.prepare('DELETE FROM mailboxes WHERE expires_at <= ?').bind(now),
  ])
  // Storage cap: never keep more than MAX_MAILS mails; oldest go first.
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM mails').first<{ c: number }>()
  const total = row?.c ?? 0
  const cap = maxMails(env)
  if (total > cap) {
    await env.DB.prepare(
      'DELETE FROM mails WHERE id IN (SELECT id FROM mails ORDER BY received_at ASC, id ASC LIMIT ?)',
    )
      .bind(total - cap)
      .run()
  }
}

// ---------- Worker entry ----------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    if (path === '/favicon.svg' || path === '/favicon.ico') {
      return new Response(FAVICON_SVG, {
        headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' },
      })
    }
    if (path === '/' || path === '/otp' || path === '/index.html') {
      // Homepage: OTP viewer — paste email, get latest 6-digit code.
      // When the inbox page is disabled, its entry link is hidden too.
      const html =
        env.INBOX_ENABLED === '1'
          ? OTP_HTML
          : OTP_HTML.replace('<div class="foot"><a href="/inbox">打开完整收件箱 →</a></div>', '')
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (path === '/inbox') {
      // Full inbox page — behind the INBOX_ENABLED switch, closed by default
      // so the service cannot be free-ridden as a public mailbox viewer.
      if (env.INBOX_ENABLED !== '1') {
        return new Response('页面不存在', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      return new Response(FRONTEND_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (path === '/api/health') return json({ ok: true })
    // Domains are never listed publicly, and mailboxes cannot be created or
    // destroyed through the API: a mailbox appears automatically when mail
    // arrives via Email Routing, and reading requires knowing the full address.
    if (path === '/api/mailboxes' && (req.method === 'POST' || req.method === 'DELETE'))
      return json({ error: 'mailbox_write_disabled' }, 403)
    if (path === '/api/mails' && req.method === 'GET') {
      // Opportunistic cleanup: the account cron quota may be full, so expiry
      // cleanup also rides on reads and on incoming mail (see email()).
      ctx.waitUntil(cleanup(env).catch(() => {}))
      return listMails(url, env)
    }
    if (path === '/api/latest' && req.method === 'GET') {
      const denied = await requireApiKey(req, env)
      if (denied) return denied
      return latestMail(url, env)
    }
    if (path === '/api/test-inject' && req.method === 'POST') return testInject(req, env)
    const mailMatch = path.match(/^\/api\/mails\/(\d+)$/)
    if (mailMatch && req.method === 'GET') return getMail(mailMatch[1], url, env)
    if (mailMatch && req.method === 'DELETE') return deleteMail(mailMatch[1], url, env)

    return json({ error: 'not_found' }, 404)
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const address = message.to.toLowerCase()
    const raw = await new Response(message.raw).arrayBuffer()
    let sender = message.from
    let senderName = ''
    let subject = ''
    let text = ''
    let html = ''
    try {
      const parsed = await PostalMime.parse(raw)
      sender = parsed.from?.address || message.from
      senderName = parsed.from?.name || ''
      subject = parsed.subject || ''
      text = parsed.text || ''
      html = parsed.html || ''
    } catch {
      // Unparseable mail: still store an envelope-only record.
      subject = '(unparseable message)'
    }
    await ensureMailbox(env, address)
    await env.DB.prepare(
      'INSERT INTO mails (address, sender, sender_name, subject, text_body, html_body, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(address, sender, senderName, subject, text.slice(0, 200_000), html.slice(0, 400_000), Date.now())
      .run()
    await cleanup(env).catch(() => {})
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await cleanup(env)
  },
}
