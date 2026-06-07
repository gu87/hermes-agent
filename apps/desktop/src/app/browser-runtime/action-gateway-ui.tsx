/**
 * Browser Action Gateway UI — Phase 2C
 *
 * Renders the pending action queue and action log.  Provides
 * Allow / Deny buttons for each pending action.  In Phase 2C it only
 * executes approved desktop-visible `navigate` actions; click/type/eval
 * remain intentionally blocked until their safety design is done.
 *
 * The gateway is a self-contained panel intended to live inside
 * the browser workspace (either the standalone /browser route or
 * the right-sidebar tab).  It reads/writes shared nanostore atoms
 * so state survives component mount/unmount.
 *
 * @see docs/architecture/browser-runtime-provider-unification.md (Phase 2C)
 */

import { useStore } from '@nanostores/react'
import { useCallback, useState } from 'react'

import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Globe,
  Pencil,
  Search,
  Terminal,
  X,
} from '@/lib/icons'
import { cn } from '@/lib/utils'

import {
  $actionLog,
  $pendingActions,
  approveProposalWithExecutor,
  cancelAllPending,
  clearActionLog,
  denyProposal,
} from './action-gateway'
import {
  type DesktopBrowserBridge,
  getDesktopSnapshot,
} from './desktop-visible-provider'
import type {
  BrowserActionRequest,
  BrowserActionResult,
} from './types'

// ═══════════════════════════════════════════════════════════════════════════
// 1. Public component
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Renders the browser action gateway panel.
 *
 * The panel contains two sections:
 *   1. **Pending Queue** — actions awaiting user approval, each with
 *      Allow / Deny buttons.
 *   2. **Action Log** — history of resolved (approved/denied) actions.
 *
 * Both sections are collapsible.
 */
type DesktopActionBridge = DesktopBrowserBridge & {
  navigate: (payload: { url: string; source: 'user' }) => Promise<{ ok?: boolean; url?: string; error?: string }>
}

export function BrowserActionGateway({ desktopBridge }: { desktopBridge?: DesktopActionBridge }) {
  const pending = useStore($pendingActions)
  const log = useStore($actionLog)

  const [pendingOpen, setPendingOpen] = useState(true)
  const [logOpen, setLogOpen] = useState(true)
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(() => new Set())

  const hasPending = pending.length > 0
  const hasLog = log.length > 0

  const executeApprovedAction = useCallback(async (request: BrowserActionRequest) => {
    if (request.action.type !== 'navigate') {
      return {
        status: 'failed' as const,
        error: `Desktop execution for "${request.action.type}" is not implemented in Phase 2C.`,
      }
    }

    if (!desktopBridge) {
      return {
        status: 'failed' as const,
        error: 'Desktop browser bridge is unavailable.',
      }
    }

    const url = request.action.url.trim()

    if (!url) {
      return {
        status: 'failed' as const,
        error: 'Navigate action is missing a URL.',
      }
    }

    const result = await desktopBridge.navigate({ url, source: 'user' })

    if (!result.ok) {
      return {
        status: 'failed' as const,
        error: result.error || 'Desktop navigation failed.',
      }
    }

    try {
      return {
        status: 'executed' as const,
        postActionSnapshot: await getDesktopSnapshot(desktopBridge),
      }
    } catch (error) {
      return {
        status: 'executed' as const,
        error: `Navigation succeeded, but post-action snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }, [desktopBridge])

  const handleApprove = useCallback(async (requestId: string): Promise<BrowserActionResult | null> => {
    setResolvingIds(prev => new Set(prev).add(requestId))

    try {
      return await approveProposalWithExecutor(requestId, executeApprovedAction)
    } finally {
      setResolvingIds(prev => {
        const next = new Set(prev)
        next.delete(requestId)

        return next
      })
    }
  }, [executeApprovedAction])

  if (!hasPending && !hasLog) {
    return (
      <div className="border-t border-(--ui-stroke-secondary) px-3 py-4">
        <p className="text-center text-[0.6875rem] text-muted-foreground/50">
          No pending or past agent browser actions
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-col border-t border-(--ui-stroke-secondary)">
      {/* ── Pending Queue ───────────────────────────────────────────── */}
      {hasPending && (
        <div className="shrink-0">
          <GatewaySectionHeader
            badge={pending.length > 1 ? String(pending.length) : undefined}
            label={`Pending (${pending.length})`}
            onToggle={() => setPendingOpen(v => !v)}
            open={pendingOpen}
          />
          {pendingOpen && (
            <div className="space-y-1.5 px-2 pb-2">
              {pending.map(req => (
                <PendingActionCard
                  busy={resolvingIds.has(req.requestId)}
                  key={req.requestId}
                  onApprove={() => void handleApprove(req.requestId)}
                  request={req}
                />
              ))}
              <div className="flex justify-end">
                <button
                  className="rounded px-2 py-0.5 text-[0.625rem] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                  onClick={cancelAllPending}
                  type="button"
                >
                  Dismiss all
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Action Log ──────────────────────────────────────────────── */}
      {hasLog && (
        <div className={cn('shrink-0', hasPending && 'border-t border-(--ui-stroke-secondary)')}>
          <GatewaySectionHeader
            label={`Action Log (${log.length})`}
            onToggle={() => setLogOpen(v => !v)}
            open={logOpen}
            trailing={
              <button
                aria-label="Clear action log"
                className="grid size-5 place-items-center rounded text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors"
                onClick={clearActionLog}
                type="button"
              >
                <X className="size-3" />
              </button>
            }
          />
          {logOpen && (
            <div className="max-h-48 overflow-y-auto px-2 pb-2 space-y-0.5">
              {[...log].reverse().map(entry => (
                <ActionLogEntry entry={entry} key={entry.requestId} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Sub-components
// ═══════════════════════════════════════════════════════════════════════════

function GatewaySectionHeader({
  label,
  open,
  onToggle,
  badge,
  trailing,
}: {
  label: string
  open: boolean
  onToggle: () => void
  badge?: string
  trailing?: React.ReactNode
}) {
  return (
    <button
      className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-(--ui-bg-secondary)/30 transition-colors"
      onClick={onToggle}
      type="button"
    >
      {open ? (
        <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
      ) : (
        <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
      )}
      <span className="text-[0.6875rem] font-medium text-muted-foreground">{label}</span>
      {badge && (
        <span className="ml-auto rounded-full bg-brand/15 px-1.5 py-0 text-[0.5625rem] font-semibold text-brand">
          {badge}
        </span>
      )}
      {trailing && <span className="ml-auto">{trailing}</span>}
    </button>
  )
}

function PendingActionCard({
  busy,
  onApprove,
  request,
}: {
  busy?: boolean
  onApprove: () => void
  request: BrowserActionRequestLike
}) {
  const icon = actionIcon(request.action.type)
  const description = actionDescription(request)

  return (
    <div className="rounded-lg border border-(--ui-stroke-secondary) bg-(--ui-chat-surface-background) p-2">
      {/* Header */}
      <div className="flex items-start gap-2">
        <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded bg-brand/10 text-brand">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[0.6875rem] font-medium text-foreground leading-snug">
            Agent wants to {description}
          </p>
          {request.reason && (
            <p className="mt-0.5 text-[0.625rem] text-muted-foreground/70 line-clamp-2">
              {request.reason}
            </p>
          )}
          <div className="mt-1 flex items-center gap-2 text-[0.5625rem] text-muted-foreground/40">
            <span className="rounded bg-(--ui-bg-secondary)/50 px-1 py-0">{request.action.type}</span>
            <span>{new Date(request.requestedAt).toLocaleTimeString()}</span>
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="mt-2 flex items-center gap-1.5">
        <ApprovalButton
          disabled={busy}
          onClick={onApprove}
          variant="allow"
        >
          {busy ? 'Running...' : 'Allow'}
        </ApprovalButton>
        <ApprovalButton
          disabled={busy}
          onClick={() => denyProposal(request.requestId)}
          variant="deny"
        >
          Deny
        </ApprovalButton>
      </div>
    </div>
  )
}

function ApprovalButton({
  disabled,
  variant,
  onClick,
  children,
}: {
  disabled?: boolean
  variant: 'allow' | 'deny'
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      className={cn(
        'flex items-center gap-1 rounded-md px-2.5 py-1 text-[0.6875rem] font-medium transition-colors',
        variant === 'allow'
          ? 'bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20'
          : 'bg-red-500/10 text-red-600 hover:bg-red-500/20',
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {variant === 'allow' ? <Check className="size-3" /> : <X className="size-3" />}
      {children}
    </button>
  )
}

function ActionLogEntry({ entry }: { entry: BrowserActionResultLike }) {
  return (
    <div className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[0.625rem]">
      <span
        className={cn(
          'shrink-0 rounded-full px-1 py-0 text-[0.5rem] font-semibold',
          entry.status === 'executed' && 'bg-emerald-500/10 text-emerald-600',
          entry.status === 'denied' && 'bg-red-500/10 text-red-600',
          entry.status === 'failed' && 'bg-amber-500/10 text-amber-600',
          entry.status === 'pending_approval' && 'bg-blue-500/10 text-blue-600',
        )}
      >
        {entry.status === 'executed' ? 'OK' : entry.status === 'denied' ? 'NO' : entry.status === 'failed' ? 'ERR' : '…'}
      </span>
      <span className="min-w-0 truncate text-foreground/80">
        {entry.executedBy.provider}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground/40">
        {new Date(entry.executedAt).toLocaleTimeString()}
      </span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Helpers
// ═══════════════════════════════════════════════════════════════════════════

function actionIcon(type: string): React.ReactNode {
  switch (type) {
    case 'navigate':
      return <Globe className="size-3" />

    case 'click':
      return <ArrowUpRight className="size-3" />

    case 'type':
      return <Pencil className="size-3" />

    case 'scroll':
      return <ChevronDown className="size-3" />

    case 'snapshot':

    case 'vision':
      return <Search className="size-3" />

    case 'console':

    case 'eval':
      return <Terminal className="size-3" />

    case 'back':
      return <ChevronDown className="size-3 rotate-90" />

    case 'press_key':
      return <Clipboard className="size-3" />

    case 'get_images':
      return <Search className="size-3" />

    default:
      return <Globe className="size-3" />
  }
}

function actionDescription(request: {
  action: { type: string; url?: string; ref?: string; text?: string; key?: string; direction?: string }
  reason?: string
}): string {
  const a = request.action

  switch (a.type) {
    case 'navigate':
      return `navigate to ${a.url || 'a page'}`

    case 'click':
      return `click ${a.ref || 'an element'}`

    case 'type':
      return `type "${a.text || 'text'}" into ${a.ref || 'a field'}`

    case 'scroll':
      return `scroll ${a.direction || 'down'}`

    case 'back':
      return 'go back'

    case 'press_key':
      return `press ${a.key || 'a key'}`

    case 'eval':
      return `evaluate JS: ${(a.text || '').slice(0, 60)}`

    case 'console':
      return a.text
        ? `evaluate JS: ${a.text.slice(0, 60)}`
        : 'read console output'

    case 'snapshot':
      return 'capture page snapshot'

    case 'vision':
      return 'take screenshot'

    case 'get_images':
      return 'get page images'

    default:
      return `perform ${a.type}`
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Re-exported type shims for the UI layer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Minimal action-request shape needed by the UI.
 * This avoids importing the full BrowserActionRequest from types.ts
 * in the UI component (the actual store already validates the shape).
 */
export type BrowserActionRequestLike = {
  requestId: string
  requestedAt: string
  actor: string
  taskId: string
  action: { type: string; url?: string; ref?: string; text?: string; key?: string; direction?: string }
  reason?: string
}

export type BrowserActionResultLike = {
  requestId: string
  executedAt: string
  executedBy: { provider: string; sessionKey: string }
  status: string
  error?: string
}
