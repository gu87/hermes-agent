/**
 * BrowserSessionManager — embedded browser lifecycle for Hermes Desktop.
 *
 * Manages a WebContentsView backed by a persistent, isolated session
 * (persist:hermes-browser).  The view is created once and mounted/unmounted
 * inside the renderer's DOM via setBounds + addChildView / removeChildView.
 *
 * Phase 2A — read-only browsing with user-driven navigation only.
 * No browser-preload bridge needed: page state (title, URL, favicon, loading)
 * is derived entirely from webContents native events.
 */

const { session, WebContentsView } = require('electron')
const path = require('node:path')

// ── Constants ────────────────────────────────────────────────────────────────

const BROWSER_PARTITION = 'persist:hermes-browser'

/** Schemes we refuse to navigate to inside the embedded browser. */
const BLOCKED_SCHEMES = new Set([
  'file:',
  'javascript:',
  'data:',
  'about:',
  'chrome:',
  'chrome-extension:',
  'hermes-media:'
])

// ── Module state ─────────────────────────────────────────────────────────────

let browserSession = null
let browserView = null
/** Set of webContents event listener cleanup functions. */
let pageEventCleanups = null

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Create (or return the existing) isolated browser session.
 * @returns {import('electron').Session}
 */
function getBrowserSession() {
  if (!browserSession) {
    browserSession = session.fromPartition(BROWSER_PARTITION)
  }
  return browserSession
}

/**
 * Create (or return the existing) WebContentsView for the embedded browser.
 * Idempotent — subsequent calls return the same view.
 * @returns {import('electron').WebContentsView}
 */
function getBrowserView() {
  if (browserView) return browserView

  const sess = getBrowserSession()

  browserView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: sess,
      // No preload needed for Phase 2A — page state comes from native events.
    }
  })

  const wc = browserView.webContents

  // ── Navigation guard ────────────────────────────────────────────────────
  wc.on('will-navigate', (_event, url) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      return // let malformed URLs fail naturally
    }
    if (BLOCKED_SCHEMES.has(parsed.protocol)) {
      _event.preventDefault()
    }
    // http: / https: allowed through
  })

  // ── Popup / new-window guard ────────────────────────────────────────────
  wc.setWindowOpenHandler((details) => {
    // External links open in the system browser.
    if (details.url) {
      const { shell } = require('electron')
      try {
        const parsed = new URL(details.url)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          shell.openExternal(details.url).catch(() => {})
        }
      } catch {
        // ignore unparseable URLs
      }
    }
    return { action: 'deny' }
  })

  // ── Download guard ──────────────────────────────────────────────────────
  wc.session.on('will-download', (_event, _item) => {
    _event.preventDefault()
  })

  // ── Permission guard ────────────────────────────────────────────────────
  // Deny all sensitive permissions for embedded web content.
  sess.setPermissionRequestHandler((_wc, permission, callback) => {
    const denied = new Set([
      'camera',
      'clipboard-read',
      'clipboard-sanitized-write',
      'fullscreen',
      'geolocation',
      'media',
      'mediaKeySystem',
      'midi',
      'midiSysex',
      'notifications',
      'pointerLock',
      'openExternal',
    ])
    callback(!denied.has(permission))
  })

  sess.setPermissionCheckHandler((_wc, permission) => {
    // Only allow permissions we've explicitly granted above.
    return false
  })

  return browserView
}

/**
 * Destroy the browser view and release its resources.
 * Safe to call even if no view exists.
 */
function destroyBrowserView() {
  if (pageEventCleanups) {
    for (const cleanup of pageEventCleanups) {
      try { cleanup() } catch { /* ignore */ }
    }
    pageEventCleanups = null
  }
  if (browserView) {
    try {
      // Remove from parent window's contentView if still attached.
      if (browserView.webContents && !browserView.webContents.isDestroyed()) {
        browserView.webContents.close()
      }
    } catch { /* ignore */ }
    browserView = null
  }
  // Keep the session alive — cookies persist across view destroy/create.
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  BLOCKED_SCHEMES,
  BROWSER_PARTITION,
  destroyBrowserView,
  getBrowserSession,
  getBrowserView,
}
