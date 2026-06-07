/**
 * Browser Action Gateway UI — Phase 2E
 *
 * Renders the pending action queue and action log.  Provides
 * Allow / Deny buttons for each pending action.
 *
 * Execution status by action type:
 * - navigate      → executable after user Allow (Phase 2C).
 * - click / type  → approval UI surfaces safetyContext, but executor
 *                   returns failed (Phase 2E).
 * - eval / press_key / scroll → permanently blocked, no Allow button.
 * - snapshot / vision / get_images / console → always allowed (read-only).
 *
 * The gateway is a self-contained panel intended to live inside
 * the browser workspace (either the standalone /browser route or
 * the right-sidebar tab).  It reads/writes shared nanostore atoms
 * so state survives component mount/unmount.
 *
 * @see docs/architecture/browser-runtime-provider-unification.md (Phase 2E)
 * @see docs/architecture/desktop-browser-agent-action-safety.md
 */

import { useStore } from '@nanostores/react'
import { useCallback, useState } from 'react'

import {
  AlertTriangle,
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
  AWAITING_SAFETY_ACTIONS,
  cancelAllPending,
  clearActionLog,
  denyProposal,
  EXECUTABLE_ACTIONS,
  getBlockedActionReason,
  PERMANENTLY_DENIED_ACTIONS,
} from './action-gateway'
import {
  type DesktopBrowserBridge,
  getDesktopSnapshot,
} from './desktop-visible-provider'
import type {
  BrowserActionRequest,
  BrowserActionResult,
  BrowserActionRiskLevel,
} from './types'

// ═══════════════════════════════════════════════════════════════════════════
// 1. Public component
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Renders the browser action gateway panel.
 *
 * The panel contains two sections:
 *   1. **Pending Queue** — actions awaiting user approval, each with
 *      Allow / Deny buttons (unless permanently blocked).
 *   2. **Action Log** — history of resolved (approved/denied/failed) actions.
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
  // Per-request secondary confirmation for type actions
  const [typeConfirms, setTypeConfirms] = useState<Set<string>>(() => new Set())

  const hasPending = pending.length > 0
  const hasLog = log.length > 0

  const executeApprovedAction = useCallback(async (request: BrowserActionRequest) => {
    const actionType = request.action.type

    // ── Permanently blocked actions ──────────────────────────────────
    const blockedReason = getBlockedActionReason(actionType)

    if (blockedReason) {
      return {
        status: 'failed' as const,
        error: blockedReason,
      }
    }

    // ── Navigate (Phase 2C) ─────────────────────────────────────────
    if (actionType === 'navigate') {
      if (!desktopBridge) {
        return {
          status: 'failed' as const,
          error: 'Desktop browser bridge is unavailable.',
        }
      }

      const url = (request.action as { url?: string }).url?.trim()

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
    }

    // ── Read-only actions — mark executed (no side effects) ──────────
    if (actionType === 'snapshot' || actionType === 'vision' || actionType === 'get_images' || actionType === 'console') {
      return { status: 'executed' as const }
    }

    // ── Everything else: not executable ─────────────────────────────
    return {
      status: 'failed' as const,
      error: `Desktop execution for "${actionType}" is not implemented.`,
    }
  }, [desktopBridge])

  const handleApprove = useCallback(async (requestId: string): Promise<BrowserActionResult | null> => {
    // Clear type confirmation on approve
    setTypeConfirms(prev => {
      const next = new Set(prev)
      next.delete(requestId)

      return next
    })

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
                  onConfirmType={() => setTypeConfirms(prev => new Set(prev).add(req.requestId))}
                  request={req}
                  typeConfirmed={typeConfirms.has(req.requestId)}
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
  onConfirmType,
  request,
  typeConfirmed,
}: {
  busy?: boolean
  onApprove: () => void
  onConfirmType?: () => void
  request: BrowserActionRequestLike
  typeConfirmed?: boolean
}) {
  const actionType = request.action.type
  const permanentlyBlocked = PERMANENTLY_DENIED_ACTIONS.has(actionType)
  const awaitingSafety = AWAITING_SAFETY_ACTIONS.has(actionType)
  const executable = EXECUTABLE_ACTIONS.has(actionType)
  const blockedReason = getBlockedActionReason(actionType)
  const needsTypeConfirm = actionType === 'type' && !typeConfirmed

  const icon = actionIcon(actionType)
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

          {/* ── Safety context (Phase 2E) ──────────────────────────── */}
          {request.safetyContext && (
            <div className="mt-1.5 space-y-0.5">
              <div className="text-[0.625rem] text-muted-foreground/70">
                <span className="font-medium">Target:</span>{' '}
                {request.safetyContext.targetDescription}
              </div>
              {request.safetyContext.typeText && (
                <div className="rounded bg-(--ui-bg-secondary)/30 px-1.5 py-0.5 font-mono text-[0.5625rem] text-foreground/80 break-all">
                  {request.safetyContext.typeText.length > 120
                    ? request.safetyContext.typeText.slice(0, 120) + '…'
                    : request.safetyContext.typeText}
                </div>
              )}
              <div className="flex items-center gap-2 text-[0.5625rem] text-muted-foreground/40">
                <span className="truncate">{request.safetyContext.originUrl}</span>
                <RiskBadge level={request.safetyContext.riskLevel} />
              </div>
            </div>
          )}

          {/* ── Status badge row ────────────────────────────────────── */}
          <div className="mt-1 flex items-center gap-2 text-[0.5625rem]">
            <span className="rounded bg-(--ui-bg-secondary)/50 px-1 py-0 text-muted-foreground/40">
              {actionType}
            </span>
            <span className="text-muted-foreground/40">
              {new Date(request.requestedAt).toLocaleTimeString()}
            </span>
            {permanentlyBlocked && (
              <span className="rounded bg-red-500/10 px-1 py-0 font-medium text-red-600">
                Permanently Blocked
              </span>
            )}
            {awaitingSafety && (
              <span className="rounded bg-amber-500/10 px-1 py-0 font-medium text-amber-600">
                Safety Required — Not Executed
              </span>
            )}
            {executable && !permanentlyBlocked && (
              <span className="rounded bg-emerald-500/10 px-1 py-0 font-medium text-emerald-600">
                Ready
              </span>
            )}
            {!permanentlyBlocked && !awaitingSafety && !executable && (
              <span className="rounded bg-(--ui-bg-secondary)/40 px-1 py-0 text-muted-foreground/40">
                Read-only
              </span>
            )}
          </div>

          {/* ── Permanent block explanation ─────────────────────────── */}
          {permanentlyBlocked && blockedReason && (
            <div className="mt-1 flex items-start gap-1 rounded bg-red-500/5 px-1.5 py-1 text-[0.5625rem] text-red-600/70">
              <AlertTriangle className="mt-0.5 size-2.5 shrink-0" />
              <span>{blockedReason}</span>
            </div>
          )}

          {/* ── Awaiting safety explanation ─────────────────────────── */}
          {awaitingSafety && blockedReason && (
            <div className="mt-1 flex items-start gap-1 rounded bg-amber-500/5 px-1.5 py-1 text-[0.5625rem] text-amber-600/70">
              <AlertTriangle className="mt-0.5 size-2.5 shrink-0" />
              <span>{blockedReason}</span>
            </div>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div className="mt-2 flex items-center gap-1.5">
        {typeConfirmed !== undefined && (
          needsTypeConfirm ? (
            <button
              className="flex items-center gap-1 rounded-md bg-brand/10 px-2.5 py-1 text-[0.6875rem] font-medium text-brand hover:bg-brand/20 transition-colors"
              onClick={onConfirmType}
              type="button"
            >
              <Check className="size-3" /> Confirm Text
            </button>
          ) : (
            <span className="rounded-md bg-brand/5 px-2 py-1 text-[0.625rem] text-brand/70">
              Text confirmed
            </span>
          )
        )}

        {!permanentlyBlocked && (
          <ApprovalButton
            disabled={busy || needsTypeConfirm}
            onClick={onApprove}
            variant="allow"
          >
            {busy ? 'Running...' : awaitingSafety ? 'Allow (Will Not Execute)' : 'Allow'}
          </ApprovalButton>
        )}
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
  const statusBadge = entry.status === 'executed'
    ? 'OK'
    : entry.status === 'denied' ? 'NO' : entry.status === 'failed' ? 'ERR' : '…'

  const statusColor = entry.status === 'executed'
    ? 'bg-emerald-500/10 text-emerald-600'
    : entry.status === 'denied'
      ? 'bg-red-500/10 text-red-600'
      : entry.status === 'failed'
        ? 'bg-amber-500/10 text-amber-600'
        : 'bg-blue-500/10 text-blue-600'

  return (
    <div className="rounded px-1.5 py-0.5 text-[0.625rem]">
      <div className="flex items-center gap-1.5">
        <span className={cn('shrink-0 rounded-full px-1 py-0 text-[0.5rem] font-semibold', statusColor)}>
          {statusBadge}
        </span>
        <span className="rounded bg-(--ui-bg-secondary)/40 px-0.5 py-0 text-[0.5rem] text-muted-foreground/50">
          {entry.actionType || '?'}
        </span>
        <span className="min-w-0 truncate text-foreground/80">
          {entry.error || entry.executedBy.provider}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground/40">
          {new Date(entry.executedAt).toLocaleTimeString()}
        </span>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Risk badge
// ═══════════════════════════════════════════════════════════════════════════

function RiskBadge({ level }: { level: BrowserActionRiskLevel }) {
  const colors: Record<BrowserActionRiskLevel, string> = {
    low: 'bg-emerald-500/10 text-emerald-600',
    medium: 'bg-amber-500/10 text-amber-600',
    high: 'bg-red-500/10 text-red-600',
  }

  return (
    <span className={cn('rounded-full px-1.5 py-0 text-[0.5rem] font-semibold', colors[level])}>
      {level.toUpperCase()}
    </span>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Helpers
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
      return `type "${(a.text || '').length > 60 ? (a.text || '').slice(0, 60) + '…' : (a.text || 'text')}" into ${a.ref || 'a field'}`

    case 'scroll':
      return `scroll ${a.direction || 'down'}`

    case 'back':
      return 'go back'

    case 'press_key':
      return `press ${a.key || 'a key'}`

    case 'eval':
      return `evaluate JS`

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
// 5. Re-exported type shims for the UI layer
// ═══════════════════════════════════════════════════════════════════════════

export type BrowserActionRequestLike = {
  requestId: string
  requestedAt: string
  actor: string
  taskId: string
  action: {
    type: string
    url?: string
    ref?: string
    text?: string
    key?: string
    direction?: string
  }
  reason?: string
  /** Phase 2E safety context (may be absent for headless providers). */
  safetyContext?: {
    originUrl: string
    originTitle: string
    targetDescription: string
    targetRef: string
    typeText?: string
    riskLevel: BrowserActionRiskLevel
  }
}

export type BrowserActionResultLike = {
  requestId: string
  executedAt: string
  executedBy: { provider: string; sessionKey: string }
  status: string
  error?: string
  /** Action type for display (filled at log time). */
  actionType?: string
}
