/**
 * Browser Action Gateway — Phase 2C state management
 *
 * Manages the lifecycle of BrowserActionRequest → BrowserActionResult
 * without binding the state layer to a provider.  Actions are proposed by
 * an actor (agent/system), displayed to the user for approval, then either
 * recorded directly or executed through a caller-supplied executor.
 *
 * Does NOT:
 * - Execute real webContents input (click/type/eval)
 * - Bypass the existing source:"user" navigation gate
 * - Connect to a backend agent loop (Phase 4+ concern)
 *
 * @see docs/architecture/browser-runtime-provider-unification.md (Phase 2C)
 */

import { atom } from 'nanostores'

import type {
  BrowserActionKind,
  BrowserActionRequest,
  BrowserActionResult,
  BrowserActionResultStatus,
  BrowserActionSafetyContext,
  BrowserActor,
  BrowserProviderId,
  BrowserSnapshot,
  PreActionVerification,
} from './types'

// ═══════════════════════════════════════════════════════════════════════════
// 1. Nanostores atoms
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pending action requests — actions that have been proposed but not yet
 * approved or denied by the user.
 */
export const $pendingActions = atom<BrowserActionRequest[]>([])

/**
 * Action log — the complete history of all action requests and their
 * outcomes.  Oldest first.
 */
export const $actionLog = atom<BrowserActionResult[]>([])

/**
 * Maximum number of log entries to retain in memory.
 */
const MAX_LOG_ENTRIES = 100

// ═══════════════════════════════════════════════════════════════════════════
// 2. Request ID generator
// ═══════════════════════════════════════════════════════════════════════════

let _nextId = 1

function nextRequestId(): string {
  return `baq_${String(_nextId++)}_${Date.now().toString(36)}`
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Propose a browser action for user approval.
 *
 * The action is added to `$pendingActions`.  It stays there until
 * `approveProposal()` or `denyProposal()` is called.
 *
 * @param action     The action the actor wants to perform.
 * @param actor      Who is requesting this action.
 * @param taskId     Task context (for future agent loop integration).
 * @param reason     Why the action is needed (shown in approval UI).
 * @param provider   Which provider this action targets.
 * @returns          The request ID (can be used to track the result).
 */
export function proposeAction(
  action: BrowserActionKind,
  actor: BrowserActor,
  taskId: string,
  reason?: string,
  provider?: BrowserProviderId,
  safetyContext?: BrowserActionSafetyContext,
): string {
  const requestId = nextRequestId()

  const request: BrowserActionRequest = {
    requestId,
    requestedAt: new Date().toISOString(),
    actor,
    taskId,
    action,
    reason,
    targetProvider: provider,
    safetyContext,
  }

  const current = $pendingActions.get()
  $pendingActions.set([...current, request])

  return requestId
}

/**
 * Approve a pending action.
 *
 * Moves the action from `$pendingActions` to `$actionLog` with
 * status `'executed'`.  Does NOT perform real page operations.
 *
 * @param requestId  The request ID to approve.
 * @param sessionKey Provider session key (for log metadata).
 * @returns          The result, or null if the request was not found.
 */
export function approveProposal(
  requestId: string,
  sessionKey = 'desktop-main',
): BrowserActionResult | null {
  return _resolveProposal(requestId, 'executed', sessionKey)
}

/**
 * Execute callback used by `approveProposalWithExecutor`.
 *
 * Phase 2C intentionally only wires real execution for safe, explicit
 * approvals supplied by the UI. The gateway remains provider-agnostic:
 * callers decide how to execute a given request and return the final status.
 */
export type BrowserActionExecutor = (
  request: BrowserActionRequest,
) => Promise<{
  status: Extract<BrowserActionResultStatus, 'executed' | 'failed'>
  error?: string
  postActionSnapshot?: BrowserSnapshot
  /** Phase 2F-A: Read-only pre-action verification result. */
  preActionVerification?: PreActionVerification
  /** Phase 2F-A: Screenshot ref (for vision action). */
  screenshotRef?: string
}>

/**
 * Approve a pending action and execute it through the supplied callback.
 *
 * Moves the action from `$pendingActions` to `$actionLog` after execution.
 * If the callback throws, the action is logged as `failed`.
 */
export async function approveProposalWithExecutor(
  requestId: string,
  execute: BrowserActionExecutor,
  sessionKey = 'desktop-main',
): Promise<BrowserActionResult | null> {
  const request = getPending(requestId)

  if (!request) {return null}

  try {
    const execution = await execute(request)

    return _resolveProposal(
      requestId,
      execution.status,
      sessionKey,
      execution.error,
      execution.postActionSnapshot,
      execution.preActionVerification,
      execution.screenshotRef,
    )
  } catch (error) {
    return _resolveProposal(
      requestId,
      'failed',
      sessionKey,
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Deny a pending action.
 *
 * Moves the action from `$pendingActions` to `$actionLog` with
 * status `'denied'`.
 *
 * @param requestId  The request ID to deny.
 * @param reason     Why the action was denied.
 * @param sessionKey Provider session key (for log metadata).
 * @returns          The result, or null if the request was not found.
 */
export function denyProposal(
  requestId: string,
  reason?: string,
  sessionKey = 'desktop-main',
): BrowserActionResult | null {
  return _resolveProposal(requestId, 'denied', sessionKey, reason)
}

/**
 * Clear the action log.
 */
export function clearActionLog(): void {
  $actionLog.set([])
}

/**
 * Remove all pending actions without logging them (cancels silently).
 */
export function cancelAllPending(): void {
  $pendingActions.set([])
}

/**
 * Get a pending action by requestId.
 */
export function getPending(requestId: string): BrowserActionRequest | undefined {
  return $pendingActions.get().find(r => r.requestId === requestId)
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Action classification (Phase 2E)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Action kinds that are permanently denied on the Desktop browser.
 *
 * These MUST NOT transition to approval_required — there is no safe
 * execution path for them on a user-visible, login-state-bearing
 * WebContentsView.
 *
 * @see docs/architecture/desktop-browser-agent-action-safety.md §7.1
 */
export const PERMANENTLY_DENIED_ACTIONS: ReadonlySet<string> = new Set([
  'eval',
  'press_key',
  'scroll',
])

/**
 * Action kinds that await safety implementation before they can be
 * executed on Desktop.  The approval UI shows them but the executor
 * returns `failed`.
 *
 * @see docs/architecture/desktop-browser-agent-action-safety.md §7.3
 */
export const AWAITING_SAFETY_ACTIONS: ReadonlySet<string> = new Set([
  'click',
])

/**
 * Action kinds that are currently executable on Desktop after user
 * approval (Phase 2C).
 */
export const EXECUTABLE_ACTIONS: ReadonlySet<string> = new Set([
  'navigate',
  'type',
])

/**
 * Return a human-readable blocked reason for actions the Desktop
 * executor cannot run, or ``null`` when the action can be executed.
 */
export function getBlockedActionReason(
  actionType: string,
): string | null {
  if (PERMANENTLY_DENIED_ACTIONS.has(actionType)) {
    return `"${actionType}" is permanently blocked on the Desktop browser. There is no safe execution path for this action on a user-visible page with login state.`
  }

  if (AWAITING_SAFETY_ACTIONS.has(actionType)) {
    return `"${actionType}" execution is not yet implemented for the Desktop browser. `
      + 'Phase 2E captures the approval decision but does not perform the real page operation. '
      + 'Full safety model (pre-action verification + executor) is planned for Phase 2F.'
  }

  if (!EXECUTABLE_ACTIONS.has(actionType)) {
    return `"${actionType}" is not in the Desktop executable action set.`
  }

  return null
}

/**
 * Return true when the Desktop executor can execute this action type
 * (navigate only in Phase 2C/2E).
 */
export function isActionExecutable(actionType: string): boolean {
  return EXECUTABLE_ACTIONS.has(actionType)
}

/**
 * Return true when the action is permanently blocked on Desktop
 * (eval, press_key, scroll).
 */
export function isActionPermanentlyBlocked(actionType: string): boolean {
  return PERMANENTLY_DENIED_ACTIONS.has(actionType)
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Internal helpers
// ═══════════════════════════════════════════════════════════════════════════

function _resolveProposal(
  requestId: string,
  status: BrowserActionResultStatus,
  sessionKey: string,
  error?: string,
  postActionSnapshot?: BrowserSnapshot,
  preActionVerification?: PreActionVerification,
  screenshotRef?: string,
): BrowserActionResult | null {
  const pending = $pendingActions.get()
  const idx = pending.findIndex(r => r.requestId === requestId)

  if (idx === -1) {return null}

  const [request] = pending.splice(idx, 1)
  $pendingActions.set([...pending])

  const result: BrowserActionResult & { actionType?: string } = {
    requestId: request.requestId,
    executedAt: new Date().toISOString(),
    executedBy: {
      provider: request.targetProvider || 'desktop-visible',
      sessionKey,
    },
    status,
    error,
    postActionSnapshot,
    preActionVerification,
    screenshotRef,
    actionType: request.action.type,
  }

  const log = $actionLog.get()
  const newLog = [...log, result].slice(-MAX_LOG_ENTRIES)
  $actionLog.set(newLog)

  return result
}
