/**
 * Store atom for pending visible-browser action proposals arriving from the
 * Python agent via gateway events.
 *
 * The message-stream handler captures ``browser.action.proposed`` events and
 * parks them here.  The Action Gateway UI reads from this atom and calls
 * ``proposeAction()`` from ``browser-runtime/action-gateway`` to surface the
 * approval card.
 */
import { atom } from 'nanostores'

export interface PendingBrowserAction {
  proposalId: string
  actionType: string // 'navigate' | 'click' | 'type' | 'snapshot'
  actionParams: Record<string, unknown>
  reason?: string
  sessionId: string | null
}

export const $pendingBrowserAction = atom<PendingBrowserAction | null>(null)

export function setPendingBrowserAction(action: PendingBrowserAction | null): void {
  $pendingBrowserAction.set(action)
}
