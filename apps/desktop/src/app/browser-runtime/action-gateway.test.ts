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
