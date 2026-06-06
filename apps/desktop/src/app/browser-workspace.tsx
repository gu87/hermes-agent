import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Globe,
  Loader2,
  RefreshCw,
  X
} from '@/lib/icons'
import { cn } from '@/lib/utils'

import { WorkspaceLauncher } from './workspace-launcher'

// ── Types ────────────────────────────────────────────────────────────────────

interface BrowserPageState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
}

interface DomSummary {
  title: string
  description: string
  headings: Array<{ tag: string; text: string }>
  textPreview: string
}

// ── Constants ────────────────────────────────────────────────────────────────

const HOME_URL = 'about:blank'
const COPY_FEEDBACK_MS = 1800

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatUrl(raw: string): string {
  if (!raw || raw === 'about:blank') return ''
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:' && u.hostname === 'www.') {
      return raw.slice(12) // strip https://www.
    }
    return u.protocol === 'https:' ? raw.slice(8) : raw
  } catch {
    return raw
  }
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  // Already a full URL.
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  // Looks like a domain with a TLD.
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(trimmed)) {
    return `https://${trimmed}`
  }
  // Treat as search query or single word — search on Google.
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

// ── Component ────────────────────────────────────────────────────────────────

export function BrowserWorkspace() {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [launched, setLaunched] = useState(false)
  const [page, setPage] = useState<BrowserPageState>({
    url: '',
    title: '',
    canGoBack: false,
    canGoForward: false,
    isLoading: false
  })
  const [urlInput, setUrlInput] = useState('')
  const [copyLabel, setCopyLabel] = useState('Copy Context')
  const [copyDisabled, setCopyDisabled] = useState(false)

  const mountRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const mountedRef = useRef(false)

  const bridge = window.hermesDesktop?.browser

  // ── Check availability ──────────────────────────────────────────────────

  useEffect(() => {
    if (!bridge) {
      setAvailable(false)
      return
    }
    bridge.isAvailable().then(result => {
      setAvailable(result.available)
    })
  }, [bridge])

  // ── Subscribe to page events ────────────────────────────────────────────

  useEffect(() => {
    if (!bridge || !launched) return

    const unsubs = [
      bridge.onPageTitleUpdated(({ title }) => {
        setPage(prev => ({ ...prev, title }))
      }),
      bridge.onDidNavigate(({ url }) => {
        setPage(prev => ({ ...prev, url }))
        setUrlInput(url)
      }),
      bridge.onDidNavigateInPage(({ url }) => {
        setPage(prev => ({ ...prev, url }))
        setUrlInput(url)
      }),
      bridge.onDidStartLoading(() => {
        setPage(prev => ({ ...prev, isLoading: true }))
      }),
      bridge.onDidStopLoading(async () => {
        setPage(prev => ({ ...prev, isLoading: false }))
        // Refresh navigation state after load completes.
        try {
          const state = await bridge.getState()
          setPage({
            url: state.url,
            title: state.title,
            canGoBack: state.canGoBack,
            canGoForward: state.canGoForward,
            isLoading: state.isLoading
          })
        } catch { /* ignore */ }
      })
    ]

    return () => {
      for (const unsub of unsubs) unsub()
    }
  }, [bridge, launched])

  // ── ResizeObserver → setBounds ──────────────────────────────────────────

  useEffect(() => {
    if (!launched || !bridge || !mountRef.current) return

    const el = mountRef.current
    const syncBounds = () => {
      const rect = el.getBoundingClientRect()
      // Only send bounds when there's a real area to render into.
      if (rect.width < 1 || rect.height < 1) return
      bridge.setBounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    }

    // Initial bounds sync after a short delay so the layout has settled.
    const initialTimer = setTimeout(syncBounds, 100)

    observerRef.current = new ResizeObserver(() => {
      syncBounds()
    })
    observerRef.current.observe(el)

    return () => {
      clearTimeout(initialTimer)
      observerRef.current?.disconnect()
      observerRef.current = null
    }
  }, [launched, bridge])

  // ── Mount / unmount ──────────────────────────────────────────────────────

  const launch = useCallback(async () => {
    if (!bridge || mountedRef.current) return
    const result = await bridge.mount()
    if (result.ok) {
      mountedRef.current = true
      setLaunched(true)
      setPage(prev => ({ ...prev, url: HOME_URL }))
      setUrlInput('')
    }
  }, [bridge])

  const dismiss = useCallback(async () => {
    if (!bridge) return
    observerRef.current?.disconnect()
    observerRef.current = null
    await bridge.unmount()
    mountedRef.current = false
    setLaunched(false)
    setPage({ url: '', title: '', canGoBack: false, canGoForward: false, isLoading: false })
    setUrlInput('')
  }, [bridge])

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (mountedRef.current && bridge) {
        bridge.unmount().catch(() => {})
        mountedRef.current = false
      }
    }
  }, [bridge])

  // ── Navigation actions ──────────────────────────────────────────────────

  const navigate = useCallback(async (input: string) => {
    const url = normalizeUrl(input)
    if (!url) return
    if (!bridge) return
    const result = await bridge.navigate({ url, source: 'user' })
    if (result.ok && result.url) {
      setUrlInput(result.url)
    }
  }, [bridge])

  const goBack = useCallback(async () => {
    if (!bridge) return
    const result = await bridge.goBack()
    if (!result.error) {
      setPage(prev => ({ ...prev, canGoBack: result.canGoBack ?? prev.canGoBack }))
    }
  }, [bridge])

  const goForward = useCallback(async () => {
    if (!bridge) return
    const result = await bridge.goForward()
    if (!result.error) {
      setPage(prev => ({ ...prev, canGoForward: result.canGoForward ?? prev.canGoForward }))
    }
  }, [bridge])

  const reload = useCallback(async () => {
    if (!bridge) return
    await bridge.reload()
  }, [bridge])

  const stop = useCallback(async () => {
    if (!bridge) return
    await bridge.stop()
  }, [bridge])

  // ── Copy Context (renderer-only — no main process IPC) ─────────────────

  const copyContext = useCallback(async () => {
    if (!bridge || copyDisabled) return
    setCopyDisabled(true)
    setCopyLabel('Copying…')

    try {
      const [screenshot, domSummary] = await Promise.all([
        bridge.getScreenshot(),
        bridge.getDomSummary()
      ])

      const pageUrl = page.url || ''

      // Build markdown summary for clipboard.
      const summaryParts: string[] = []
      const title = domSummary.title || page.title || ''
      if (title) summaryParts.push(`**${title}**`)
      if (pageUrl) summaryParts.push(pageUrl)
      if (domSummary.description) summaryParts.push(`> ${domSummary.description}`)
      if (domSummary.textPreview) {
        summaryParts.push('')
        summaryParts.push(domSummary.textPreview.slice(0, 500))
      }

      const markdown = summaryParts.join('\n')
      await window.hermesDesktop?.writeClipboard(markdown)

      // Best-effort: save screenshot to composer-images directory.
      if (screenshot.dataURL && screenshot.dataURL.startsWith('data:')) {
        try {
          const base64 = screenshot.dataURL.split(',')[1]
          if (base64) {
            const binaryString = atob(base64)
            const bytes = new Uint8Array(binaryString.length)
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i)
            }
            await window.hermesDesktop?.saveImageBuffer(bytes, '.png')
          }
        } catch {
          // Screenshot save is best-effort.
        }
      }

      setCopyLabel('Copied!')
    } catch {
      setCopyLabel('Copy failed')
    } finally {
      setTimeout(() => {
        setCopyLabel('Copy Context')
        setCopyDisabled(false)
      }, COPY_FEEDBACK_MS)
    }
  }, [bridge, copyDisabled, page.url, page.title])

  // ── Render: launcher / placeholder ──────────────────────────────────────

  if (available === null) {
    // Still probing.
    return (
      <div className="flex h-full min-h-0 min-w-0 items-center justify-center bg-(--ui-chat-surface-background) pt-(--titlebar-height)">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!available || !bridge) {
    return <WorkspaceLauncher />
  }

  if (!launched) {
    return <WorkspaceLauncher onOpenBrowser={launch} />
  }

  // ── Render: full browser UI ─────────────────────────────────────────────

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-(--ui-chat-surface-background) pt-(--titlebar-height)">
      {/* ── Toolbar ──────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-(--ui-stroke-secondary) px-2.5 py-1.5">
        {/* Nav buttons */}
        <button
          aria-label="Go back"
          className={cn(
            'grid size-7 place-items-center rounded-md text-muted-foreground transition-colors',
            page.canGoBack
              ? 'hover:bg-(--ui-bg-secondary)/60 hover:text-foreground'
              : 'opacity-30'
          )}
          disabled={!page.canGoBack}
          onClick={goBack}
          type="button"
        >
          <ChevronLeft className="size-4" />
        </button>

        <button
          aria-label="Go forward"
          className={cn(
            'grid size-7 place-items-center rounded-md text-muted-foreground transition-colors',
            page.canGoForward
              ? 'hover:bg-(--ui-bg-secondary)/60 hover:text-foreground'
              : 'opacity-30'
          )}
          disabled={!page.canGoForward}
          onClick={goForward}
          type="button"
        >
          <ChevronRight className="size-4" />
        </button>

        <button
          aria-label={page.isLoading ? 'Stop loading' : 'Reload page'}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-(--ui-bg-secondary)/60 hover:text-foreground"
          onClick={page.isLoading ? stop : reload}
          type="button"
        >
          {page.isLoading ? (
            <X className="size-4" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </button>

        {/* URL bar */}
        <form
          className="flex flex-1 items-center"
          onSubmit={e => {
            e.preventDefault()
            navigate(urlInput)
          }}
        >
          <div className="flex flex-1 items-center rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)/30 px-2.5 py-1 ring-brand/30 transition-all focus-within:border-brand/40 focus-within:ring-2">
            {page.isLoading ? (
              <Loader2 className="mr-1.5 size-3 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Globe className="mr-1.5 size-3 shrink-0 text-muted-foreground" />
            )}
            <input
              aria-label="Page URL"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
              onChange={e => setUrlInput(e.target.value)}
              placeholder="Search or enter URL"
              spellCheck={false}
              type="text"
              value={urlInput}
            />
          </div>
        </form>

        {/* Copy Context — renderer-only composite action */}
        <button
          aria-label="Copy page context to clipboard"
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-(--ui-bg-secondary)/60 hover:text-foreground"
          disabled={copyDisabled}
          onClick={copyContext}
          type="button"
        >
          <Clipboard className="size-3.5" />
          <span className="hidden sm:inline">{copyLabel}</span>
        </button>

        {/* Close browser */}
        <button
          aria-label="Close browser workspace"
          className="ml-0.5 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-(--ui-bg-secondary)/60 hover:text-foreground"
          onClick={dismiss}
          type="button"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* ── Browser viewport ──────────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={mountRef}
          className="absolute inset-0"
          style={{ background: '#fff' }}
        />

        {/* Loading overlay for initial blank state */}
        {page.url === HOME_URL && !page.isLoading && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-(--ui-chat-surface-background)">
            <Globe className="size-10 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground/50">
              Enter a URL to start browsing
            </p>
          </div>
        )}
      </div>

      {/* ── Status bar ────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2 border-t border-(--ui-stroke-secondary) px-3 py-1">
        {page.isLoading && (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        )}
        <span className="min-w-0 truncate text-[0.65rem] leading-relaxed text-muted-foreground/70">
          {page.title || formatUrl(page.url) || 'Hermes Browser'}
        </span>
      </div>
    </div>
  )
}
