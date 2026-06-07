/**
 * Browser Runtime Types — Phase 1 type-level verification.
 *
 * These tests verify that the type contract is internally consistent
 * and that the built-in capability presets are valid.  No provider
 * or runtime code is involved.
 */

import { describe, expect, it } from 'vitest'

import {
  type BrowserActionKind,
  type BrowserActionRequest,
  type BrowserActionResult,
  type BrowserCapability,
  type BrowserProviderDescriptor,
  type BrowserSnapshot,
  BUILTIN_CAPABILITIES,
  BUILTIN_PROVIDER_IDS,
  isFastRetrievalProvider,
  isInteractiveProvider,
} from './types'

// ═══════════════════════════════════════════════════════════════════════
// Capability presets
// ═══════════════════════════════════════════════════════════════════════

describe('BUILTIN_CAPABILITIES', () => {
  it.each([...BUILTIN_PROVIDER_IDS])('%s has all capability keys', (id) => {
    const caps = BUILTIN_CAPABILITIES[id as keyof typeof BUILTIN_CAPABILITIES]

    expect(caps).toBeDefined()
    expect(typeof caps.visible).toBe('boolean')
    expect(typeof caps.hasLoginState).toBe('boolean')
    expect(typeof caps.canReadDom).toBe('boolean')
    expect(typeof caps.canScreenshot).toBe('boolean')
    expect(typeof caps.canNavigate).toBe('boolean')
    expect(typeof caps.canClick).toBe('boolean')
    expect(typeof caps.canType).toBe('boolean')
    expect(typeof caps.canEval).toBe('boolean')
  })

  it('desktop-visible is the only provider that is visible and has login state', () => {
    const desktopVisible = BUILTIN_CAPABILITIES['desktop-visible']
    expect(desktopVisible.visible).toBe(true)
    expect(desktopVisible.hasLoginState).toBe(true)

    for (const id of BUILTIN_PROVIDER_IDS) {
      if (id === 'desktop-visible') {continue}
      const caps = BUILTIN_CAPABILITIES[id as keyof typeof BUILTIN_CAPABILITIES]
      expect(caps.visible).toBe(false)
    }
  })

  it('desktop-visible is the only provider requiring agent action approval', () => {
    const desktopVisible = BUILTIN_CAPABILITIES['desktop-visible']
    expect(desktopVisible.requiresApprovalForAgentAction).toBe(true)

    for (const id of BUILTIN_PROVIDER_IDS) {
      if (id === 'desktop-visible') {continue}
      const caps = BUILTIN_CAPABILITIES[id as keyof typeof BUILTIN_CAPABILITIES]
      expect(caps.requiresApprovalForAgentAction).toBe(false)
    }
  })

  it('obscura is the only provider advertising fast headless', () => {
    const obscura = BUILTIN_CAPABILITIES['obscura']
    expect(obscura.supportsFastHeadless).toBe(true)

    for (const id of BUILTIN_PROVIDER_IDS) {
      if (id === 'obscura') {continue}
      const caps = BUILTIN_CAPABILITIES[id as keyof typeof BUILTIN_CAPABILITIES]
      expect(caps.supportsFastHeadless).toBe(false)
    }
  })

  it('obscura cannot click, type, eval, or screenshot', () => {
    const obscura = BUILTIN_CAPABILITIES['obscura']
    expect(obscura.canClick).toBe(false)
    expect(obscura.canType).toBe(false)
    expect(obscura.canEval).toBe(false)
    expect(obscura.canScreenshot).toBe(false)
  })

  it('agent-headless and cloud providers can click, type, and eval', () => {
    const interactiveIds = ['agent-headless', 'cloud-browserbase', 'cloud-browser-use', 'cloud-firecrawl']

    for (const id of interactiveIds) {
      const caps = BUILTIN_CAPABILITIES[id as keyof typeof BUILTIN_CAPABILITIES]
      expect(caps.canClick).toBe(true)
      expect(caps.canType).toBe(true)
      expect(caps.canEval).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════════════════════════════════

describe('isInteractiveProvider', () => {
  it('returns true for agent-headless', () => {
    expect(isInteractiveProvider(BUILTIN_CAPABILITIES['agent-headless'])).toBe(true)
  })

  it('returns true for cloud providers', () => {
    expect(isInteractiveProvider(BUILTIN_CAPABILITIES['cloud-browserbase'])).toBe(true)
    expect(isInteractiveProvider(BUILTIN_CAPABILITIES['cloud-browser-use'])).toBe(true)
    expect(isInteractiveProvider(BUILTIN_CAPABILITIES['cloud-firecrawl'])).toBe(true)
  })

  it('returns false for desktop-visible (requires approval)', () => {
    expect(isInteractiveProvider(BUILTIN_CAPABILITIES['desktop-visible'])).toBe(false)
  })

  it('returns false for obscura (non-interactive)', () => {
    expect(isInteractiveProvider(BUILTIN_CAPABILITIES['obscura'])).toBe(false)
  })
})

describe('isFastRetrievalProvider', () => {
  it('returns true only for obscura', () => {
    expect(isFastRetrievalProvider(BUILTIN_CAPABILITIES['obscura'])).toBe(true)
  })

  it('returns false for all other providers', () => {
    for (const id of BUILTIN_PROVIDER_IDS) {
      if (id === 'obscura') {continue}
      expect(isFastRetrievalProvider(BUILTIN_CAPABILITIES[id as keyof typeof BUILTIN_CAPABILITIES])).toBe(false)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Type narrowing: BrowserActionKind discriminated union
// ═══════════════════════════════════════════════════════════════════════

describe('BrowserActionKind discriminated union', () => {
  it('navigates to a url', () => {
    const action: BrowserActionKind = { type: 'navigate', url: 'https://example.com' }
    expect(action.type).toBe('navigate')

    if (action.type === 'navigate') {
      expect(action.url).toBe('https://example.com')
    }
  })

  it('clicks a ref', () => {
    const action: BrowserActionKind = { type: 'click', ref: '@e5' }

    if (action.type === 'click') {
      expect(action.ref).toBe('@e5')
    }
  })

  it('types text into a ref', () => {
    const action: BrowserActionKind = { type: 'type', ref: '@e3', text: 'hello' }

    if (action.type === 'type') {
      expect(action.text).toBe('hello')
    }
  })

  it('scrolls in a direction', () => {
    const up: BrowserActionKind = { type: 'scroll', direction: 'up' }
    const down: BrowserActionKind = { type: 'scroll', direction: 'down' }
    expect(up.direction).toBe('up')
    expect(down.direction).toBe('down')
  })

  it('goes back', () => {
    const action: BrowserActionKind = { type: 'back' }
    expect(action.type).toBe('back')
  })

  it('presses a key', () => {
    const action: BrowserActionKind = { type: 'press_key', key: 'Enter' }

    if (action.type === 'press_key') {
      expect(action.key).toBe('Enter')
    }
  })

  it('gets images', () => {
    const action: BrowserActionKind = { type: 'get_images' }
    expect(action.type).toBe('get_images')
  })

  it('takes a vision screenshot with a question', () => {
    const action: BrowserActionKind = { type: 'vision', question: 'What is on the page?', annotate: true }

    if (action.type === 'vision') {
      expect(action.question).toBe('What is on the page?')
      expect(action.annotate).toBe(true)
    }
  })

  it('reads console messages', () => {
    const action: BrowserActionKind = { type: 'console', clear: true }

    if (action.type === 'console') {
      expect(action.clear).toBe(true)
      expect(action.expression).toBeUndefined()
    }
  })

  it('evals a javascript expression (console with expression)', () => {
    const action: BrowserActionKind = { type: 'console', expression: 'document.title' }

    if (action.type === 'console') {
      expect(action.expression).toBe('document.title')
    }
  })

  it('evals a standalone javascript expression', () => {
    const action: BrowserActionKind = { type: 'eval', expression: 'window.location.href' }

    if (action.type === 'eval') {
      expect(action.expression).toBe('window.location.href')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// BrowserActionRequest construction
// ═══════════════════════════════════════════════════════════════════════

describe('BrowserActionRequest', () => {
  it('builds an agent-initiated navigate request', () => {
    const req: BrowserActionRequest = {
      requestId: 'req-001',
      requestedAt: '2026-06-06T12:00:00Z',
      actor: 'agent',
      taskId: 'task_abc',
      action: { type: 'navigate', url: 'https://example.com' },
      reason: 'User asked me to open this page',
    }

    expect(req.actor).toBe('agent')
    expect(req.action.type).toBe('navigate')
    expect(req.reason).toBeDefined()
  })

  it('builds a user-initiated navigate without reason', () => {
    const req: BrowserActionRequest = {
      requestId: 'req-002',
      requestedAt: '2026-06-06T12:00:01Z',
      actor: 'user',
      taskId: 'task_abc',
      action: { type: 'navigate', url: 'https://example.com' },
    }

    expect(req.actor).toBe('user')
    expect(req.reason).toBeUndefined()
  })

  it('includes targetProvider hint', () => {
    const req: BrowserActionRequest = {
      requestId: 'req-003',
      requestedAt: '2026-06-06T12:00:02Z',
      actor: 'agent',
      taskId: 'task_abc',
      action: { type: 'snapshot', full: true },
      targetProvider: 'agent-headless',
    }

    expect(req.targetProvider).toBe('agent-headless')
    expect(req.action.type).toBe('snapshot')

    if (req.action.type === 'snapshot') {
      expect(req.action.full).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// BrowserActionResult construction
// ═══════════════════════════════════════════════════════════════════════

describe('BrowserActionResult', () => {
  it('reports an executed action with post-action snapshot', () => {
    const snapshot: BrowserSnapshot = makeMinimalSnapshot('https://example.com')

    const result: BrowserActionResult = {
      requestId: 'req-001',
      executedAt: '2026-06-06T12:00:03Z',
      executedBy: { provider: 'agent-headless', sessionKey: 'task_abc' },
      status: 'executed',
      postActionSnapshot: snapshot,
    }

    expect(result.status).toBe('executed')
    expect(result.postActionSnapshot?.activeTab.url).toBe('https://example.com')
  })

  it('reports a denied action', () => {
    const result: BrowserActionResult = {
      requestId: 'req-002',
      executedAt: '2026-06-06T12:00:04Z',
      executedBy: { provider: 'desktop-visible', sessionKey: 'desktop-main' },
      status: 'denied',
      error: 'Agent-initiated navigation requires user approval',
    }

    expect(result.status).toBe('denied')
    expect(result.error).toBeDefined()
  })

  it('reports a pending approval', () => {
    const result: BrowserActionResult = {
      requestId: 'req-003',
      executedAt: '2026-06-06T12:00:05Z',
      executedBy: { provider: 'desktop-visible', sessionKey: 'desktop-main' },
      status: 'pending_approval',
      approvalId: 'approval-abc',
    }

    expect(result.status).toBe('pending_approval')
    expect(result.approvalId).toBe('approval-abc')
  })

  it('reports a failed action with fallback', () => {
    const result: BrowserActionResult = {
      requestId: 'req-004',
      executedAt: '2026-06-06T12:00:06Z',
      executedBy: { provider: 'agent-headless', sessionKey: 'task_abc' },
      status: 'failed',
      error: 'Lightpanda screenshot placeholder detected',
      fallback: {
        from: 'agent-headless',
        to: 'agent-headless',
        reason: 'Lightpanda returned placeholder screenshot; retried with Chrome',
      },
    }

    expect(result.status).toBe('failed')
    expect(result.fallback?.from).toBe('agent-headless')
    expect(result.fallback?.reason).toContain('Lightpanda')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// BrowserProviderDescriptor construction
// ═══════════════════════════════════════════════════════════════════════

describe('BrowserProviderDescriptor', () => {
  it('builds a descriptor for desktop-visible', () => {
    const desc: BrowserProviderDescriptor = {
      id: 'desktop-visible',
      displayName: 'Desktop Browser',
      description: 'The embedded browser in Hermes Desktop right rail',
      capabilities: BUILTIN_CAPABILITIES['desktop-visible'] as BrowserCapability,
      defaultPolicies: [
        { provider: 'desktop-visible', action: 'navigate', actor: 'user', decision: 'allow' },
        { provider: 'desktop-visible', action: 'navigate', actor: 'agent', decision: 'approval_required' },
        { provider: 'desktop-visible', action: 'snapshot', actor: 'agent', decision: 'allow' },
      ],
      builtin: true,
    }

    expect(desc.id).toBe('desktop-visible')
    expect(desc.capabilities.visible).toBe(true)
    expect(desc.capabilities.requiresApprovalForAgentAction).toBe(true)
    expect(desc.defaultPolicies).toHaveLength(3)
  })

  it('builds a descriptor for obscura', () => {
    const desc: BrowserProviderDescriptor = {
      id: 'obscura',
      displayName: 'Obscura',
      description: 'Fast headless retrieval lane for web_search / web_extract',
      capabilities: BUILTIN_CAPABILITIES['obscura'] as BrowserCapability,
      defaultPolicies: [
        { provider: 'obscura', action: '*', actor: 'agent', decision: 'allow' },
        { provider: 'obscura', action: 'click', actor: 'agent', decision: 'deny' },
      ],
      builtin: true,
    }

    expect(desc.capabilities.supportsFastHeadless).toBe(true)
    expect(desc.capabilities.canClick).toBe(false)
    expect(desc.capabilities.canScreenshot).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

function makeMinimalSnapshot(url: string): BrowserSnapshot {
  return {
    capturedAt: '2026-06-06T12:00:00Z',
    source: {
      provider: 'agent-headless',
      sessionKey: 'task_abc',
      mode: 'agent_action',
    },
    activeTab: {
      url,
      title: 'Test Page',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      navigationSource: 'agent',
    },
    dom: {
      ariaSnapshot: null,
      bodyText: 'Hello World',
      metaDescription: null,
      headings: [],
    },
    userContext: {
      selectedText: '',
      clipboardPreview: '',
    },
    screenshot: {
      ref: null,
      width: 0,
      height: 0,
      sizeBytes: 0,
    },
    console: null,
    limits: {
      maxAriaSnapshotChars: 20480,
      maxBodyTextChars: 10240,
      maxSelectionChars: 10240,
      maxClipboardChars: 2048,
      maxTotalBytes: 102400,
      actualTotalBytes: 128,
    },
    errors: [],
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 2D — Desktop Agent Action Safety contract-level tests
// ═══════════════════════════════════════════════════════════════════════

import type {
  BrowserActionSafetyContext,
  ElementFingerprint,
  PreActionVerification,
} from './types'

describe('ElementFingerprint', () => {
  it('has all required identity fields', () => {
    const fp: ElementFingerprint = {
      tagName: 'BUTTON',
      textContent: 'Submit PR',
      id: 'submit-btn',
      name: null,
      inputType: 'submit',
      ariaLabel: null,
      rect: { x: 100, y: 200, w: 120, h: 36 },
    }

    expect(fp.tagName).toBe('BUTTON')
    expect(fp.textContent).toBe('Submit PR')
    expect(fp.id).toBe('submit-btn')
    expect(fp.rect.w).toBe(120)
    expect(fp.rect.h).toBe(36)
  })

  it('allows null for optional identity fields', () => {
    const fp: ElementFingerprint = {
      tagName: 'A',
      textContent: 'Click here',
      id: null,
      name: null,
      inputType: null,
      ariaLabel: null,
      rect: { x: 0, y: 0, w: 80, h: 20 },
    }

    expect(fp.tagName).toBe('A')
    expect(fp.id).toBeNull()
    expect(fp.inputType).toBeNull()
  })
})

describe('BrowserActionSafetyContext', () => {
  it('has required fields for a click action', () => {
    const ctx: BrowserActionSafetyContext = {
      originUrl: 'https://github.com/gu/trendradar/pull/42',
      originTitle: 'Update dependencies by gu87 · Pull Request #42',
      targetDescription:
        "button 'Submit PR' (tag: button, type: submit) near heading 'Create Pull Request'",
      targetRef: '@e5',
      riskLevel: 'medium',
    }

    expect(ctx.originUrl).toBeTruthy()
    expect(ctx.targetDescription).toBeTruthy()
    expect(ctx.targetRef).toBe('@e5')
    expect(ctx.riskLevel).toBe('medium')
    expect(ctx.typeText).toBeUndefined()
  })

  it('includes typeText for a type action', () => {
    const ctx: BrowserActionSafetyContext = {
      originUrl: 'https://github.com/gu/trendradar/pull/42',
      originTitle: 'Update dependencies by gu87 · Pull Request #42',
      targetDescription:
        "input field 'PR Title' (tag: input, type: text, placeholder: 'Enter PR title')",
      targetRef: '@e3',
      typeText: 'fix: update dependencies to v3.2.1',
      riskLevel: 'medium',
    }

    expect(ctx.typeText).toBe('fix: update dependencies to v3.2.1')
  })

  it('supports all three risk levels', () => {
    const levels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high']

    for (const level of levels) {
      const ctx: BrowserActionSafetyContext = {
        originUrl: 'https://example.com',
        originTitle: 'Test',
        targetDescription: 'a link',
        targetRef: '@e1',
        riskLevel: level,
      }

      expect(ctx.riskLevel).toBe(level)
    }
  })

  it('carries optional elementFingerprint', () => {
    const ctx: BrowserActionSafetyContext = {
      originUrl: 'https://example.com',
      originTitle: 'Test',
      targetDescription: 'a button',
      targetRef: '@e5',
      riskLevel: 'high',
      elementFingerprint: {
        tagName: 'BUTTON',
        textContent: 'Delete repository',
        id: 'delete-repo-btn',
        name: null,
        inputType: 'button',
        ariaLabel: 'Delete this repository',
        rect: { x: 300, y: 500, w: 160, h: 40 },
      },
    }

    expect(ctx.riskLevel).toBe('high')
    expect(ctx.elementFingerprint?.textContent).toBe('Delete repository')
  })
})

describe('BrowserActionRequest — Phase 2D safetyContext', () => {
  it('accepts optional safetyContext', () => {
    const req: BrowserActionRequest = {
      requestId: 'req-2d-001',
      requestedAt: '2026-06-07T12:00:00Z',
      actor: 'agent',
      taskId: 'task_2d',
      action: { type: 'click', ref: '@e5' },
      reason: 'Agent wants to submit the form',
      targetProvider: 'desktop-visible',
      safetyContext: {
        originUrl: 'https://example.com/form',
        originTitle: 'Registration Form',
        targetDescription: "button 'Submit' (tag: button, type: submit)",
        targetRef: '@e5',
        riskLevel: 'high',
        elementFingerprint: {
          tagName: 'BUTTON',
          textContent: 'Submit',
          id: null,
          name: null,
          inputType: 'submit',
          ariaLabel: null,
          rect: { x: 100, y: 400, w: 120, h: 36 },
        },
      },
    }

    expect(req.safetyContext).toBeDefined()
    expect(req.safetyContext!.riskLevel).toBe('high')
    expect(req.safetyContext!.originUrl).toBe('https://example.com/form')
  })

  it('is optional (absent for headless providers)', () => {
    const req: BrowserActionRequest = {
      requestId: 'req-2d-002',
      requestedAt: '2026-06-07T12:00:01Z',
      actor: 'agent',
      taskId: 'task_2d',
      action: { type: 'snapshot', full: true },
    }

    expect(req.safetyContext).toBeUndefined()
  })
})

describe('PreActionVerification', () => {
  it('has all fields for a valid ref verification', () => {
    const snapshot: BrowserSnapshot = makeMinimalSnapshot('https://example.com')

    const pav: PreActionVerification = {
      verifiedAt: '2026-06-07T12:00:02Z',
      currentUrl: 'https://example.com',
      refValid: true,
      currentFingerprint: {
        tagName: 'BUTTON',
        textContent: 'Submit',
        id: null,
        name: null,
        inputType: 'submit',
        ariaLabel: null,
        rect: { x: 100, y: 400, w: 120, h: 36 },
      },
      snapshot,
    }

    expect(pav.refValid).toBe(true)
    expect(pav.currentUrl).toBe('https://example.com')
    expect(pav.invalidationReason).toBeUndefined()
    expect(pav.snapshot.activeTab.url).toBe('https://example.com')
  })

  it('records invalidation reason when ref is invalid', () => {
    const snapshot: BrowserSnapshot = makeMinimalSnapshot('https://example.com')

    const pav: PreActionVerification = {
      verifiedAt: '2026-06-07T12:00:03Z',
      currentUrl: 'https://example.com',
      refValid: false,
      invalidationReason: 'element_removed',
      snapshot,
    }

    expect(pav.refValid).toBe(false)
    expect(pav.invalidationReason).toBe('element_removed')
  })
})

describe('BrowserActionResult — Phase 2D preActionVerification', () => {
  it('accepts optional preActionVerification', () => {
    const snapshot: BrowserSnapshot = makeMinimalSnapshot('https://example.com')

    const result: BrowserActionResult = {
      requestId: 'req-2d-003',
      executedAt: '2026-06-07T12:00:04Z',
      executedBy: { provider: 'desktop-visible', sessionKey: 'desktop-main' },
      status: 'executed',
      preActionVerification: {
        verifiedAt: '2026-06-07T12:00:03.5Z',
        currentUrl: 'https://example.com',
        refValid: true,
        snapshot,
      },
      postActionSnapshot: snapshot,
    }

    expect(result.preActionVerification?.refValid).toBe(true)
    expect(result.postActionSnapshot).toBeDefined()
  })

  it('is optional (absent for navigate/snapshot results)', () => {
    const result: BrowserActionResult = {
      requestId: 'req-2d-004',
      executedAt: '2026-06-07T12:00:05Z',
      executedBy: { provider: 'desktop-visible', sessionKey: 'desktop-main' },
      status: 'executed',
    }

    expect(result.preActionVerification).toBeUndefined()
  })
})
