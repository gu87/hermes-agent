/**
 * Browser Action Gateway — Phase 2B tests
 *
 * Verifies the action proposal → approval/denial → log lifecycle.
 * No real browser operations are involved.
 */

import { describe, expect, it } from 'vitest'

import {
  $actionLog,
  $pendingActions,
  approveProposal,
  approveProposalWithExecutor,
  cancelAllPending,
  clearActionLog,
  denyProposal,
  getPending,
  proposeAction,
} from './action-gateway'

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function resetAll() {
  $pendingActions.set([])
  $actionLog.set([])
}

// ═══════════════════════════════════════════════════════════════════════
// Propose
// ═══════════════════════════════════════════════════════════════════════

describe('proposeAction', () => {
  it('adds a request to the pending queue', () => {
    resetAll()

    const id = proposeAction(
      { type: 'navigate', url: 'https://example.com' },
      'agent',
      'task_001',
      'User asked to open this page',
      'desktop-visible',
    )

    expect(id).toBeTruthy()
    expect(id).toMatch(/^baq_/)
    const pending = $pendingActions.get()
    expect(pending).toHaveLength(1)
    expect(pending[0].action.type).toBe('navigate')
    // Narrow the type
    const action = pending[0].action

    if (action.type === 'navigate') {
      expect(action.url).toBe('https://example.com')
    }
  })

  it('sets actor, taskId, reason, and targetProvider', () => {
    resetAll()

    const id = proposeAction(
      { type: 'click', ref: '@e5' },
      'agent',
      'task_002',
      'Need to click the submit button',
    )

    const pending = $pendingActions.get()
    expect(pending).toHaveLength(1)
    expect(pending[0].actor).toBe('agent')
    expect(pending[0].taskId).toBe('task_002')
    expect(pending[0].reason).toBe('Need to click the submit button')
    expect(pending[0].targetProvider).toBeUndefined()
  })

  it('supports multiple pending actions', () => {
    resetAll()
    proposeAction({ type: 'navigate', url: 'https://a.com' }, 'agent', 't1')
    proposeAction({ type: 'click', ref: '@e1' }, 'agent', 't1')
    proposeAction({ type: 'type', ref: '@e2', text: 'hello' }, 'agent', 't1')

    expect($pendingActions.get()).toHaveLength(3)
  })

  it('generates unique request IDs', () => {
    resetAll()
    const id1 = proposeAction({ type: 'snapshot' }, 'agent', 't1')
    const id2 = proposeAction({ type: 'snapshot' }, 'agent', 't1')
    expect(id1).not.toBe(id2)
  })

  it('supports all action types', () => {
    resetAll()

    const actions = [
      { type: 'navigate', url: 'https://x.com' } as const,
      { type: 'snapshot' } as const,
      { type: 'click', ref: '@e1' } as const,
      { type: 'type', ref: '@e1', text: 'hi' } as const,
      { type: 'scroll', direction: 'down' as const } as const,
      { type: 'back' } as const,
      { type: 'press_key', key: 'Enter' } as const,
      { type: 'get_images' } as const,
      { type: 'vision', question: 'what?' } as const,
      { type: 'console' } as const,
      { type: 'eval', expression: '1+1' } as const,
    ]

    for (const action of actions) {
      const id = proposeAction(action, 'agent', 't1')
      expect(id).toBeTruthy()
    }

    expect($pendingActions.get()).toHaveLength(actions.length)
  })

  it('supports system actor', () => {
    resetAll()
    proposeAction({ type: 'snapshot' }, 'system', 'sys_001')
    expect($pendingActions.get()[0].actor).toBe('system')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Approve
// ═══════════════════════════════════════════════════════════════════════

describe('approveProposal', () => {
  it('moves action from pending to log with executed status', () => {
    resetAll()
    const id = proposeAction({ type: 'navigate', url: 'https://example.com' }, 'agent', 't1')

    const result = approveProposal(id, 'desktop-main')

    expect(result).not.toBeNull()
    expect(result!.status).toBe('executed')
    expect(result!.requestId).toBe(id)
    expect(result!.executedBy.provider).toBe('desktop-visible')
    expect(result!.executedBy.sessionKey).toBe('desktop-main')

    // Pending should be empty
    expect($pendingActions.get()).toHaveLength(0)
    // Log should have one entry
    expect($actionLog.get()).toHaveLength(1)
  })

  it('returns null for unknown requestId', () => {
    resetAll()
    const result = approveProposal('nonexistent')
    expect(result).toBeNull()
  })

  it('only resolves the matching request (FIFO order)', () => {
    resetAll()
    const id1 = proposeAction({ type: 'navigate', url: 'https://a.com' }, 'agent', 't1')
    const id2 = proposeAction({ type: 'click', ref: '@e1' }, 'agent', 't1')
    const id3 = proposeAction({ type: 'type', ref: '@e2', text: 'x' }, 'agent', 't1')

    // Approve the middle one first
    approveProposal(id2)

    const pending = $pendingActions.get()
    expect(pending).toHaveLength(2)
    expect(pending[0].requestId).toBe(id1)
    expect(pending[1].requestId).toBe(id3)

    const log = $actionLog.get()
    expect(log).toHaveLength(1)
    expect(log[0].requestId).toBe(id2)
  })
})

describe('approveProposalWithExecutor', () => {
  it('executes through the supplied callback and logs executed status', async () => {
    resetAll()
    const id = proposeAction({ type: 'navigate', url: 'https://example.com' }, 'agent', 't1')
    const calls: string[] = []

    const result = await approveProposalWithExecutor(id, async request => {
      calls.push(request.requestId)

      return { status: 'executed' }
    })

    expect(calls).toEqual([id])
    expect(result).not.toBeNull()
    expect(result!.status).toBe('executed')
    expect($pendingActions.get()).toHaveLength(0)
    expect($actionLog.get()).toHaveLength(1)
    expect($actionLog.get()[0].status).toBe('executed')
  })

  it('logs failed status when the executor returns failed', async () => {
    resetAll()
    const id = proposeAction({ type: 'navigate', url: 'https://example.com' }, 'agent', 't1')

    const result = await approveProposalWithExecutor(id, async () => ({
      status: 'failed',
      error: 'navigation failed',
    }))

    expect(result).not.toBeNull()
    expect(result!.status).toBe('failed')
    expect(result!.error).toBe('navigation failed')
    expect($pendingActions.get()).toHaveLength(0)
    expect($actionLog.get()).toHaveLength(1)
    expect($actionLog.get()[0].status).toBe('failed')
  })

  it('logs thrown executor errors as failed', async () => {
    resetAll()
    const id = proposeAction({ type: 'navigate', url: 'https://example.com' }, 'agent', 't1')

    const result = await approveProposalWithExecutor(id, async () => {
      throw new Error('boom')
    })

    expect(result).not.toBeNull()
    expect(result!.status).toBe('failed')
    expect(result!.error).toBe('boom')
    expect($pendingActions.get()).toHaveLength(0)
  })

  it('returns null and does not call executor for unknown requestId', async () => {
    resetAll()
    let called = false

    const result = await approveProposalWithExecutor('missing', async () => {
      called = true

      return { status: 'executed' }
    })

    expect(result).toBeNull()
    expect(called).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Deny
// ═══════════════════════════════════════════════════════════════════════

describe('denyProposal', () => {
  it('moves action from pending to log with denied status', () => {
    resetAll()
    const id = proposeAction({ type: 'navigate', url: 'https://example.com' }, 'agent', 't1')

    const result = denyProposal(id, 'User does not want to navigate away')

    expect(result).not.toBeNull()
    expect(result!.status).toBe('denied')
    expect(result!.error).toBe('User does not want to navigate away')

    expect($pendingActions.get()).toHaveLength(0)
    expect($actionLog.get()).toHaveLength(1)
    expect($actionLog.get()[0].status).toBe('denied')
  })

  it('deny reason is optional', () => {
    resetAll()
    const id = proposeAction({ type: 'snapshot' }, 'agent', 't1')
    const result = denyProposal(id)
    expect(result).not.toBeNull()
    expect(result!.status).toBe('denied')
    expect(result!.error).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Cancel all pending
// ═══════════════════════════════════════════════════════════════════════

describe('cancelAllPending', () => {
  it('clears the pending queue without adding to log', () => {
    resetAll()
    proposeAction({ type: 'navigate', url: 'https://a.com' }, 'agent', 't1')
    proposeAction({ type: 'click', ref: '@e1' }, 'agent', 't1')

    cancelAllPending()

    expect($pendingActions.get()).toHaveLength(0)
    expect($actionLog.get()).toHaveLength(0) // NOT added to log
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Clear log
// ═══════════════════════════════════════════════════════════════════════

describe('clearActionLog', () => {
  it('clears the action log', () => {
    resetAll()
    const id = proposeAction({ type: 'snapshot' }, 'agent', 't1')
    approveProposal(id)

    expect($actionLog.get()).toHaveLength(1)

    clearActionLog()
    expect($actionLog.get()).toHaveLength(0)
  })

  it('does not affect pending queue', () => {
    resetAll()
    proposeAction({ type: 'snapshot' }, 'agent', 't1')

    clearActionLog()

    expect($pendingActions.get()).toHaveLength(1) // untouched
  })
})

// ═══════════════════════════════════════════════════════════════════════
// getPending
// ═══════════════════════════════════════════════════════════════════════

describe('getPending', () => {
  it('returns the request by id', () => {
    resetAll()
    const id = proposeAction({ type: 'navigate', url: 'https://x.com' }, 'agent', 't1')

    const found = getPending(id)
    expect(found).toBeDefined()
    expect(found!.requestId).toBe(id)
  })

  it('returns undefined for unknown id', () => {
    resetAll()
    expect(getPending('nonexistent')).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Log capacity
// ═══════════════════════════════════════════════════════════════════════

describe('action log capacity', () => {
  it('caps at MAX_LOG_ENTRIES (100)', () => {
    resetAll()

    for (let i = 0; i < 150; i++) {
      const id = proposeAction({ type: 'snapshot' }, 'agent', 't1')
      approveProposal(id)
    }

    expect($actionLog.get().length).toBeLessThanOrEqual(100)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Full lifecycle: propose → approve → log
// ═══════════════════════════════════════════════════════════════════════

describe('full lifecycle', () => {
  it('propose → approve creates executed log entry', () => {
    resetAll()

    const id = proposeAction(
      { type: 'navigate', url: 'https://github.com' },
      'agent',
      'task_gh',
      'User wants to see GitHub',
      'desktop-visible',
    )

    // Before approval
    expect($pendingActions.get()).toHaveLength(1)
    expect($actionLog.get()).toHaveLength(0)

    // Approve
    const result = approveProposal(id)
    expect(result!.status).toBe('executed')
    expect(result!.executedAt).toBeTruthy()

    // After approval
    expect($pendingActions.get()).toHaveLength(0)
    expect($actionLog.get()).toHaveLength(1)

    const entry = $actionLog.get()[0]
    expect(entry.status).toBe('executed')
    expect(entry.executedBy.provider).toBe('desktop-visible')
    expect(entry.executedBy.sessionKey).toBe('desktop-main')
    expect(entry.error).toBeUndefined()
  })

  it('propose → deny creates denied log entry', () => {
    resetAll()

    const id = proposeAction(
      { type: 'click', ref: '@e5' },
      'agent',
      'task_click',
      'Agent wants to click the PR button',
    )

    denyProposal(id, 'User did not approve')

    const entry = $actionLog.get()[0]
    expect(entry.status).toBe('denied')
    expect(entry.error).toBe('User did not approve')
  })

  it('mixed approve and deny keeps log in order', () => {
    resetAll()

    const id1 = proposeAction({ type: 'navigate', url: 'https://a.com' }, 'agent', 't1')
    const id2 = proposeAction({ type: 'snapshot' }, 'agent', 't1')
    const id3 = proposeAction({ type: 'click', ref: '@e1' }, 'agent', 't1')

    approveProposal(id1)
    denyProposal(id2, 'no')
    approveProposal(id3)

    const log = $actionLog.get()
    expect(log).toHaveLength(3)
    expect(log[0].requestId).toBe(id1)
    expect(log[0].status).toBe('executed')
    expect(log[1].requestId).toBe(id2)
    expect(log[1].status).toBe('denied')
    expect(log[2].requestId).toBe(id3)
    expect(log[2].status).toBe('executed')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Phase 2E — Action classification & non-execution contract
// ═══════════════════════════════════════════════════════════════════════

import {
  AWAITING_SAFETY_ACTIONS,
  EXECUTABLE_ACTIONS,
  getBlockedActionReason,
  isActionExecutable,
  isActionPermanentlyBlocked,
  PERMANENTLY_DENIED_ACTIONS,
} from './action-gateway'

describe('Phase 2E — action classification sets', () => {
  it('PERMANENTLY_DENIED_ACTIONS contains eval, press_key, scroll', () => {
    expect(PERMANENTLY_DENIED_ACTIONS.has('eval')).toBe(true)
    expect(PERMANENTLY_DENIED_ACTIONS.has('press_key')).toBe(true)
    expect(PERMANENTLY_DENIED_ACTIONS.has('scroll')).toBe(true)
  })

  it('PERMANENTLY_DENIED_ACTIONS does NOT contain click or type', () => {
    expect(PERMANENTLY_DENIED_ACTIONS.has('click')).toBe(false)
    expect(PERMANENTLY_DENIED_ACTIONS.has('type')).toBe(false)
  })

  it('PERMANENTLY_DENIED_ACTIONS does NOT contain navigate', () => {
    expect(PERMANENTLY_DENIED_ACTIONS.has('navigate')).toBe(false)
  })

  it('AWAITING_SAFETY_ACTIONS contains only type', () => {
    expect(AWAITING_SAFETY_ACTIONS.has('type')).toBe(true)
    expect(AWAITING_SAFETY_ACTIONS.has('type')).toBe(true)
  })

  it('AWAITING_SAFETY_ACTIONS does NOT contain navigate or eval', () => {
    expect(AWAITING_SAFETY_ACTIONS.has('navigate')).toBe(false)
    expect(AWAITING_SAFETY_ACTIONS.has('eval')).toBe(false)
  })

  it('EXECUTABLE_ACTIONS contains click and navigate', () => {
    expect(EXECUTABLE_ACTIONS.has('click')).toBe(true)
    expect(EXECUTABLE_ACTIONS.has('type')).toBe(false)
    expect(EXECUTABLE_ACTIONS.has('eval')).toBe(false)
    expect(EXECUTABLE_ACTIONS.has('snapshot')).toBe(false)
  })
})

describe('Phase 2E — isActionExecutable', () => {
  it('returns true for navigate', () => {
    expect(isActionExecutable('navigate')).toBe(true)
  })

  it('returns true for click, false for type, eval, scroll, press_key', () => {
    expect(isActionExecutable('click')).toBe(true)
    expect(isActionExecutable('type')).toBe(false)
    expect(isActionExecutable('eval')).toBe(false)
    expect(isActionExecutable('scroll')).toBe(false)
    expect(isActionExecutable('press_key')).toBe(false)
  })
})

describe('Phase 2E — isActionPermanentlyBlocked', () => {
  it('returns true for eval, press_key, scroll', () => {
    expect(isActionPermanentlyBlocked('eval')).toBe(true)
    expect(isActionPermanentlyBlocked('press_key')).toBe(true)
    expect(isActionPermanentlyBlocked('scroll')).toBe(true)
  })

  it('returns false for click, type, navigate', () => {
    expect(isActionPermanentlyBlocked('click')).toBe(false)
    expect(isActionPermanentlyBlocked('type')).toBe(false)
    expect(isActionPermanentlyBlocked('navigate')).toBe(false)
  })
})

describe('Phase 2E — getBlockedActionReason', () => {
  it('returns a reason for permanently denied actions', () => {
    const reason = getBlockedActionReason('eval')
    expect(reason).toBeTruthy()
    expect(reason).toContain('permanently blocked')
  })

  it('returns a reason for awaiting-safety actions', () => {
    const reason = getBlockedActionReason('type')
    expect(reason).toBeTruthy()
    expect(reason).toContain('Phase 2E')
    expect(reason).toContain('Phase 2F')
  })

  it('returns null for executable actions', () => {
    expect(getBlockedActionReason('navigate')).toBeNull()
  })

  it('returns a reason for unknown action types', () => {
    expect(getBlockedActionReason('unknown')).toContain('not in the Desktop executable action set')
  })
})

describe('Phase 2E — proposeAction accepts safetyContext', () => {
  it('stores safetyContext on the pending request', () => {
    resetAll()

    const id = proposeAction(
      { type: 'click', ref: '@e5' },
      'agent',
      'task_2e',
      'Agent wants to click a button',
      'desktop-visible',
      {
        originUrl: 'https://github.com/gu/trendradar/pull/42',
        originTitle: 'PR #42',
        targetDescription: "button 'Submit PR' (tag: button, type: submit)",
        targetRef: '@e5',
        riskLevel: 'high',
      },
    )

    const pending = getPending(id)
    expect(pending?.safetyContext).toBeDefined()
    expect(pending?.safetyContext?.originUrl).toBe('https://github.com/gu/trendradar/pull/42')
    expect(pending?.safetyContext?.targetRef).toBe('@e5')
    expect(pending?.safetyContext?.riskLevel).toBe('high')
  })

  it('safetyContext remains optional (backward compat)', () => {
    resetAll()

    const id = proposeAction(
      { type: 'snapshot' },
      'agent',
      'task_plain',
    )

    expect(getPending(id)?.safetyContext).toBeUndefined()
  })

  it('stores typeText for type actions', () => {
    resetAll()

    const id = proposeAction(
      { type: 'type', ref: '@e3', text: 'fix: update deps' },
      'agent',
      'task_type',
      'Agent wants to fill a field',
      'desktop-visible',
      {
        originUrl: 'https://example.com',
        originTitle: 'Example',
        targetDescription: "input field 'Title'",
        targetRef: '@e3',
        typeText: 'fix: update deps',
        riskLevel: 'medium',
      },
    )

    expect(getPending(id)?.safetyContext?.typeText).toBe('fix: update deps')
  })
})

describe('Phase 2E — click/type non-execution contract', () => {
  it('click IS in EXECUTABLE_ACTIONS', () => {
    expect(EXECUTABLE_ACTIONS.has('click')).toBe(true)
  })

  it('type is NOT in EXECUTABLE_ACTIONS', () => {
    expect(EXECUTABLE_ACTIONS.has('type')).toBe(false)
  })

  it('eval is PERMANENTLY denied, not just awaiting safety', () => {
    expect(PERMANENTLY_DENIED_ACTIONS.has('eval')).toBe(true)
    expect(AWAITING_SAFETY_ACTIONS.has('eval')).toBe(false)
  })

  it('click and navigate are the only executable actions', () => {
    expect([...EXECUTABLE_ACTIONS].sort()).toEqual(['click', 'navigate'])
  })
})

describe('Phase 2E — action log carries actionType', () => {
  it('approved navigate creates a log entry with readable actionType', () => {
    resetAll()

    const id = proposeAction(
      { type: 'navigate', url: 'https://example.com' },
      'agent',
      'task_log',
    )

    approveProposal(id)

    const entry = $actionLog.get()[0]
    // actionType is stored by _resolveProposal for UI display
    expect((entry as unknown as Record<string, unknown>).actionType).toBe('navigate')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Phase 2F-A — Read-only verification contract
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 2F-A — read-only actions produce real data', () => {
  it('snapshot is not in AWAITING_SAFETY_ACTIONS', () => {
    expect(AWAITING_SAFETY_ACTIONS.has('snapshot')).toBe(false)
  })

  it('snapshot is not in PERMANENTLY_DENIED_ACTIONS', () => {
    expect(PERMANENTLY_DENIED_ACTIONS.has('snapshot')).toBe(false)
  })

  it('snapshot is not the only executable (it is read-only handled in executor)', () => {
    // Phase 2F-A executor handles snapshot explicitly with getDesktopSnapshot()
    expect(EXECUTABLE_ACTIONS.has('snapshot')).toBe(false)
  })
})

describe('Phase 2F-A — EXECUTABLE_ACTIONS still only contains navigate', () => {
  it('click and navigate are directly executable', () => {
    expect([...EXECUTABLE_ACTIONS].sort()).toEqual(['click', 'navigate'])
  })

  it('type is STILL not executable', () => {
    expect(EXECUTABLE_ACTIONS.has('click')).toBe(true)
    expect(EXECUTABLE_ACTIONS.has('type')).toBe(false); expect(EXECUTABLE_ACTIONS.has('click')).toBe(true)
  })

  it('type is STILL in AWAITING_SAFETY_ACTIONS', () => {
    expect(AWAITING_SAFETY_ACTIONS.has('type')).toBe(true)
    expect(AWAITING_SAFETY_ACTIONS.has('type')).toBe(true)
  })
})

describe('Phase 2F-A — proposeAction with safetyContext for verification', () => {
  it('safetyContext with elementFingerprint can be proposed', () => {
    resetAll()

    const id = proposeAction(
      { type: 'click', ref: '@e5' },
      'agent',
      'task_vfy',
      'Click the submit button',
      'desktop-visible',
      {
        originUrl: 'https://github.com/gu/trendradar/pull/42',
        originTitle: 'PR #42',
        targetDescription: "button 'Submit PR'",
        targetRef: '@e5',
        riskLevel: 'medium',
        elementFingerprint: {
          tagName: 'BUTTON',
          textContent: 'Submit PR',
          id: 'submit-btn',
          name: null,
          inputType: 'submit',
          ariaLabel: null,
          rect: { x: 200, y: 400, w: 120, h: 36 },
        },
      },
    )

    const pending = getPending(id)
    expect(pending?.safetyContext?.elementFingerprint).toBeDefined()
    expect(pending?.safetyContext?.elementFingerprint?.tagName).toBe('BUTTON')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Phase 2F-B1 — Real click execution contract
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 2F-B1 — click execution contract', () => {
  it('EXECUTABLE_ACTIONS contains click', () => {
    expect(EXECUTABLE_ACTIONS.has('click')).toBe(true)
  })

  it('EXECUTABLE_ACTIONS contains navigate', () => {
    expect(EXECUTABLE_ACTIONS.has('navigate')).toBe(true)
  })

  it('EXECUTABLE_ACTIONS does NOT contain type', () => {
    expect(EXECUTABLE_ACTIONS.has('type')).toBe(false)
  })

  it('AWAITING_SAFETY_ACTIONS only contains type', () => {
    expect(AWAITING_SAFETY_ACTIONS.has('type')).toBe(true)
    expect(AWAITING_SAFETY_ACTIONS.has('click')).toBe(false)
  })

  it('PERMANENTLY_DENIED_ACTIONS unchanged', () => {
    expect(PERMANENTLY_DENIED_ACTIONS.has('eval')).toBe(true)
    expect(PERMANENTLY_DENIED_ACTIONS.has('press_key')).toBe(true)
    expect(PERMANENTLY_DENIED_ACTIONS.has('scroll')).toBe(true)
    expect(PERMANENTLY_DENIED_ACTIONS.has('click')).toBe(false)
  })

  it('getBlockedActionReason returns null for click (executable)', () => {
    expect(getBlockedActionReason('click')).toBeNull()
  })

  it('getBlockedActionReason returns a reason for type (awaiting)', () => {
    const reason = getBlockedActionReason('type')
    expect(reason).toBeTruthy()
    expect(reason).toContain('type')
  })
})
