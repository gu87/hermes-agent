/**
 * BrowserSlot + PersistentBrowser — embedded browser as a right-sidebar tab.
 *
 * Follows the PersistentTerminal pattern:
 *  - BrowserSlot is a lightweight div ref (conditionally rendered per active tab).
 *  - PersistentBrowser mounts once at the layout root and manages the
 *    WebContentsView lifecycle. It tracks the slot rect via rAF and calls
 *    setBounds so the native view follows the panel; when the slot is absent
 *    (tab inactive) it sends zero-area bounds to hide the view without
 *    destroying it.
 *  - BrowserTab is the in-panel UI (URL bar, nav, Copy Context) conditionally
 *    rendered when the web tab is active. It communicates with the browser
 *    bridge but does NOT own mount/unmount.
 */

import { useStore } from '@nanostores/react'
import { atom } from 'nanostores'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Globe, Loader2 } from '@/lib/icons'

import { $pendingBrowserAction, setPendingBrowserAction } from '@/store/browser-actions'
import { $gateway } from '@/store/gateway'
import { getDesktopSnapshot } from '@/app/browser-runtime/desktop-visible-provider'

// ── Slot registry ────────────────────────────────────────────────────────────

const $browserSlot = atom<HTMLElement | null>(null)

// ── BrowserTab (in-panel UI, conditionally rendered) ─────────────────────────
//
// The viewport <div> registers its DOM ref on $browserSlot so PersistentBrowser
// can forward setBounds to the native WebContentsView. The toolbar (URL bar /
// nav) is OUTSIDE the ref div so it sits above the native view.

export function BrowserTab() {
  const viewportRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = viewportRef.current

    if (!el) {return}
    $browserSlot.set(el)

    return () => {
      if ($browserSlot.get() === el) {
        $browserSlot.set(null)
      }

      window.hermesDesktop?.browser?.setBounds({ x: 0, y: 0, width: 0, height: 0 }).catch(() => {})
    }
  }, [])
  const [urlInput, setUrlInput] = useState('')
  const [pageUrl, setPageUrl] = useState('')
  const [pageTitle, setPageTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [copyLabel, setCopyLabel] = useState('Copy')
  const [copyDisabled, setCopyDisabled] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)

  const bridge = window.hermesDesktop?.browser

  // ── Page event listeners ───────────────────────────────────────────────
  useEffect(() => {
    if (!bridge) {return}

    const unsubs = [
      bridge.onPageTitleUpdated(({ title }) => setPageTitle(title)),
      bridge.onDidNavigate(({ url }) => { setPageUrl(url); setUrlInput(url) }),
      bridge.onDidNavigateInPage(({ url }) => { setPageUrl(url); setUrlInput(url) }),
      bridge.onDidStartLoading(() => setLoading(true)),
      bridge.onDidStopLoading(async () => {
        setLoading(false)

        try {
          const s = await bridge.getState()
          setCanGoBack(s.canGoBack)
          setCanGoForward(s.canGoForward)
          setLoading(s.isLoading)
        } catch { /* ignore */ }
      })
    ]

    return () => { for (const u of unsubs) {u()} }
  }, [bridge])

  // Sync state on mount.
  useEffect(() => {
    if (!bridge) {return}
    bridge.getState().then(s => {
      setPageUrl(s.url)
      setPageTitle(s.title)
      setCanGoBack(s.canGoBack)
      setCanGoForward(s.canGoForward)
      setLoading(s.isLoading)

      if (s.url && s.url !== 'about:blank') {setUrlInput(s.url)}
    })
  }, [bridge])

  // ── Navigation ─────────────────────────────────────────────────────────
  const navigate = useCallback(async () => {
    const trimmed = urlInput.trim()

    if (!trimmed || !bridge) {return}
    let url = trimmed

    if (!/^https?:\/\//i.test(url)) {
      if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(url)) {
        url = `https://${url}`
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
      }
    }

    const r = await bridge.navigate({ url, source: 'user' })

    if (r.ok && r.url) {setUrlInput(r.url)}
  }, [urlInput, bridge])

  const goBack = useCallback(async () => {
    const r = await bridge?.goBack()

    if (r && !r.error) {setCanGoBack(r.canGoBack ?? false)}
  }, [bridge])

  const goForward = useCallback(async () => {
    const r = await bridge?.goForward()

    if (r && !r.error) {setCanGoForward(r.canGoForward ?? false)}
  }, [bridge])

  const reload = useCallback(async () => { await bridge?.reload() }, [bridge])
  const stop = useCallback(async () => { await bridge?.stop() }, [bridge])

  // ── Copy Context ───────────────────────────────────────────────────────
  const copyContext = useCallback(async () => {
    if (!bridge || copyDisabled) {return}
    setCopyDisabled(true)
    setCopyLabel('...')

    try {
      const [screenshot, domSummary] = await Promise.all([
        bridge.getScreenshot(),
        bridge.getDomSummary()
      ])

      const parts: string[] = []
      const title = domSummary.title || pageTitle

      if (title) {parts.push(`**${title}**`)}

      if (pageUrl) {parts.push(pageUrl)}

      if (domSummary.description) {parts.push(`> ${domSummary.description}`)}

      if (domSummary.textPreview) {
        parts.push('')
        parts.push(domSummary.textPreview.slice(0, 500))
      }

      await window.hermesDesktop?.writeClipboard(parts.join('\n'))

      if (screenshot.dataURL?.startsWith('data:')) {
        const b64 = screenshot.dataURL.split(',')[1]

        if (b64) {
          const bin = atob(b64)
          const bytes = new Uint8Array(bin.length)

          for (let i = 0; i < bin.length; i++) {bytes[i] = bin.charCodeAt(i)}
          window.hermesDesktop?.saveImageBuffer(bytes, '.png').catch(() => {})
        }
      }

      setCopyLabel('Copied')
    } catch {
      setCopyLabel('Fail')
    } finally {
      setTimeout(() => { setCopyLabel('Copy'); setCopyDisabled(false) }, 1500)
    }
  }, [bridge, copyDisabled, pageUrl, pageTitle])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-(--ui-stroke-secondary) px-2 py-1">
        <button aria-label="Back" className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-(--ui-bg-secondary)/60 hover:text-foreground disabled:opacity-25" disabled={!canGoBack} onClick={goBack} type="button">
          <svg aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth={2} viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <button aria-label="Forward" className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-(--ui-bg-secondary)/60 hover:text-foreground disabled:opacity-25" disabled={!canGoForward} onClick={goForward} type="button">
          <svg aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth={2} viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" /></svg>
        </button>
        <button aria-label={loading ? 'Stop' : 'Reload'} className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-(--ui-bg-secondary)/60 hover:text-foreground" onClick={loading ? stop : reload} type="button">
          {loading
            ? <svg aria-hidden="true" className="size-3" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth={2} viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" /></svg>
            : <svg aria-hidden="true" className="size-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth={2} viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-2.64-6.36" /></svg>}
        </button>
        <form className="flex flex-1 items-center" onSubmit={e => { e.preventDefault(); navigate() }}>
          <input aria-label="URL" className="min-w-0 flex-1 rounded border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)/20 px-2 py-0.5 text-[0.6875rem] text-foreground outline-none placeholder:text-muted-foreground/40" onChange={e => setUrlInput(e.target.value)} placeholder="Search or URL" spellCheck={false} type="text" value={urlInput} />
        </form>
        <button aria-label="Copy page context" className="shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] text-muted-foreground hover:bg-(--ui-bg-secondary)/60 hover:text-foreground disabled:opacity-40" disabled={copyDisabled} onClick={copyContext} type="button">{copyLabel}</button>
      </div>
      {pageError ? (
        <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[0.65rem] text-destructive">
          <span className="shrink-0">⚠</span>
          <span className="min-w-0 truncate">{pageError}</span>
          <button aria-label="Dismiss" className="ml-auto shrink-0 text-muted-foreground/70 hover:text-foreground" onClick={() => setPageError(null)} type="button">✕</button>
        </div>
      ) : null}

      {/* Viewport — WebContentsView covers this area only (toolbar above is DOM) */}
      <div className="relative min-h-0 flex-1 bg-white" ref={viewportRef}>
        {!pageUrl && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground/30">
            <Globe className="size-8" />
            <span className="text-[0.6875rem]">Enter a URL</span>
          </div>
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/60">
            <Loader2 className="size-5 animate-spin text-muted-foreground/40" />
          </div>
        )}
      </div>

      {/* Agent Action Gateway — shows pending browser actions from the agent */}
      <BrowserActionGatewayPanel />

      {/* Status bar */}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-(--ui-stroke-secondary) px-2 py-0.5">
        {loading && <Loader2 className="size-2.5 animate-spin text-muted-foreground/50" />}
        <span className="min-w-0 truncate text-[0.625rem] text-muted-foreground/60">
          {pageTitle || pageUrl || 'Hermes Browser'}
        </span>
      </div>
    </div>
  )
}


// ── Browser Action Gateway Panel (injected into BrowserTab) ─────────────────

function BrowserActionGatewayPanel() {
  const pendingAction = useStore($pendingBrowserAction)
  const gateway = useStore($gateway)

  // Local Desktop mode: execute visible-browser proposals directly. This app
  // runs on the user's own machine, and the old approval queue was too easy to
  // miss, causing the agent to wait until the 2-minute timeout.
  useEffect(() => {
    if (!pendingAction || !gateway) {return}

    const { proposalId, actionType, actionParams } = pendingAction
    const bridge = window.hermesDesktop?.browser

    const respond = async (approved: boolean, result: Record<string, unknown>) => {
      await gateway.request<{ resolved?: boolean }>('browser.action.respond', {
        proposal_id: proposalId,
        approved,
        result: JSON.stringify(result),
      })
    }

    setPendingBrowserAction(null)

    void (async () => {
      if (!bridge) {
        await respond(false, { status: 'failed', error: 'Desktop browser bridge is unavailable' })

        return
      }

      try {
        if (actionType === 'navigate') {
          const url = String(actionParams.url ?? 'about:blank')
          const nav = await bridge.navigate({ url, source: 'user' })

          if (!nav.ok) {
            await respond(false, {
              status: 'failed',
              error: nav.error || 'Desktop navigation failed',
              url: nav.url || url,
            })

            return
          }

          const snapshot = await getDesktopSnapshot(bridge)

          await respond(true, {
            status: 'executed',
            url: nav.url || snapshot.url,
            title: snapshot.title,
            bodyText: snapshot.dom.bodyText,
            headings: snapshot.dom.headings,
            metaDescription: snapshot.dom.metaDescription,
          })

          return
        }

        if (actionType === 'snapshot') {
          const snapshot = await getDesktopSnapshot(bridge)

          await respond(true, {
            status: 'executed',
            url: snapshot.url,
            title: snapshot.title,
            bodyText: snapshot.dom.bodyText,
            headings: snapshot.dom.headings,
            metaDescription: snapshot.dom.metaDescription,
          })

          return
        }

        if (actionType === 'type') {
          const text = String(actionParams.text ?? '')
          if (!text) {
            await respond(false, { status: 'failed', error: 'text is required for type action' })
            return
          }

          const typeResult = await bridge.typeText({ text, ref: typeof actionParams.ref === 'string' ? actionParams.ref : undefined })
          if (!typeResult.ok) {
            await respond(false, { status: 'failed', error: typeResult.error || 'Desktop type failed' })
            return
          }

          const snapshot = await getDesktopSnapshot(bridge)
          await respond(true, {
            status: 'executed',
            url: snapshot.url,
            title: snapshot.title,
            bodyText: snapshot.dom.bodyText,
            headings: snapshot.dom.headings,
            metaDescription: snapshot.dom.metaDescription,
          })

          return
        }

        await respond(false, {
          status: 'failed',
          error: `Desktop visible browser ${actionType} is not implemented yet`,
        })
      } catch (error) {
        await respond(false, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })().catch(error => {
      console.error('[browser] visible action failed:', error)
    })
  }, [gateway, pendingAction])

  return null
}

// ── Persistent browser overlay (layout root, owns WebContentsView lifecycle) ─

export function PersistentBrowser() {
  const slot = useStore($browserSlot)

  // ── Mount WebContentsView once ─────────────────────────────────────────
  const bridge = window.hermesDesktop?.browser

  useEffect(() => {
    if (!bridge) {return}
    let cancelled = false
    // Defer until the slot container is present so WebContentsView
    // has valid initial bounds — avoids a 0×0 round-trip.
    const tryMount = () => {
      if (cancelled) return
      bridge.mount().then(r => {
        if (!cancelled && !r.ok) {
          console.warn('[browser] mount failed:', r.error)
        }
      })
    }
    // If slot is already in the DOM, mount immediately.
    if (slot) { tryMount(); return }
    // Otherwise poll briefly for the slot to appear.
    let attempts = 0
    const id = setInterval(() => {
      attempts++
      if (slot) { clearInterval(id); tryMount(); return }
      if (attempts > 20) { clearInterval(id) }
    }, 100)
    return () => { cancelled = true; clearInterval(id) }
  }, [bridge, slot])

  // Unmount on final cleanup — app quit only.
  useEffect(() => () => {
    bridge?.unmount().catch(() => {})
  }, [bridge])

  // ── Track slot rect → setBounds ────────────────────────────────────────
  return <BrowserOverlay slot={slot} />
}

// ── Rect tracking ────────────────────────────────────────────────────────────

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

const sameRect = (a: Rect | null, b: Rect) =>
  !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height

function BrowserOverlay({ slot }: { slot: HTMLElement | null }) {
  const lastRect = useRef<Rect | null>(null)

  useLayoutEffect(() => {
    if (!slot) {
      // Tab inactive — hide WebContentsView by sending zero-area bounds.
      if (lastRect.current) {
        lastRect.current = null
        window.hermesDesktop?.browser?.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      }

      return
    }

    let frame = 0

    const tick = () => {
      const r = slot.getBoundingClientRect()
      const top = Math.floor(r.top)
      const left = Math.floor(r.left)
      const next: Rect = { top, left, width: Math.ceil(r.right) - left, height: Math.ceil(r.bottom) - top }

      if (!sameRect(lastRect.current, next) && next.width > 1 && next.height > 1) {
        lastRect.current = next
        window.hermesDesktop?.browser?.setBounds({
          x: next.left,
          y: next.top,
          width: next.width,
          height: next.height
        })
      }

      frame = requestAnimationFrame(tick)
    }

    tick()

    return () => {
      cancelAnimationFrame(frame)
      lastRect.current = null
      window.hermesDesktop?.browser?.setBounds({ x: 0, y: 0, width: 0, height: 0 }).catch(() => {})
    }
  }, [slot])

  return null
}
