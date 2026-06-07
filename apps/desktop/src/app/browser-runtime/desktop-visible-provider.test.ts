/**
 * DesktopVisibleProvider — Phase 2A tests
 *
 * Verifies the descriptor, permission policies, snapshot builder,
 * and invariants without touching the real Electron bridge.
 */

import { describe, expect, it } from 'vitest'

import {
  buildSafetyContextFromElement,
  checkDesktopPermission,
  DESKTOP_VISIBLE_CAPABILITIES,
  DESKTOP_VISIBLE_DEFAULT_POLICIES,
  DESKTOP_VISIBLE_DESCRIPTOR,
  DESKTOP_VISIBLE_ID,
  type DesktopBrowserBridge,
  executeDesktopClick,
  getDesktopInteractiveSnapshot,
  getDesktopSnapshot,
  isDesktopActionAllowed,
  isDesktopActionApprovalRequired,
  isDesktopVisibleAvailable,
} from './desktop-visible-provider'
import type { BrowserSnapshot } from './types'

// ═══════════════════════════════════════════════════════════════════════
// Helpers — fake bridge
// ═══════════════════════════════════════════════════════════════════════

// Inline types so the fake bridge can construct results without importing
// the internal DesktopBridge* interfaces (which aren't exported).
interface FakeState { url: string; title: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean; error?: string }
interface FakeDomSummary { title: string; description: string; headings: Array<{ tag: string; text: string }>; textPreview: string; error?: string }
interface FakeScreenshot { dataURL: string; width: number; height: number; error?: string }
interface FakeSelectedText { text: string; error?: string }

const DEFAULT_STATE: FakeState = {
  url: 'https://github.com/gu87/trendradar',
  title: 'gu87/trendradar',
  canGoBack: true,
  canGoForward: false,
  isLoading: false,
}

const DEFAULT_DOM: FakeDomSummary = {
  title: 'gu87/trendradar',
  description: 'TrendRadar — monitor trends',
  headings: [
    { tag: 'h1', text: 'TrendRadar' },
    { tag: 'h2', text: 'Getting Started' },
  ],
  textPreview: 'Welcome to TrendRadar. This tool helps you monitor trends.',
}

const DEFAULT_SCREENSHOT: FakeScreenshot = {
  dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
  width: 1920,
  height: 1080,
}

const DEFAULT_SELECTION: FakeSelectedText = {
  text: 'Auto-merge is enabled for this PR',
}

function fakeBridge(overrides: Partial<{
  available: boolean
  state: Partial<FakeState>
  domSummary: Partial<FakeDomSummary>
  screenshot: Partial<FakeScreenshot>
  selectedText: Partial<FakeSelectedText>
  rejectWith: Error
}> = {}): DesktopBrowserBridge {
  const shouldReject = overrides.rejectWith

  return {
    isAvailable: async () => {
      if (shouldReject) {throw shouldReject}

      return { available: overrides.available ?? true }
    },
    getState: async () => {
      if (shouldReject) {throw shouldReject}

      return { ...DEFAULT_STATE, ...overrides.state }
    },
    getDomSummary: async () => {
      if (shouldReject) {throw shouldReject}

      return { ...DEFAULT_DOM, ...overrides.domSummary }
    },
    getScreenshot: async () => {
      if (shouldReject) {throw shouldReject}

      return { ...DEFAULT_SCREENSHOT, ...overrides.screenshot }
    },
    getSelectedText: async () => {
      if (shouldReject) {throw shouldReject}

      return { ...DEFAULT_SELECTION, ...overrides.selectedText }
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Descriptor
// ═══════════════════════════════════════════════════════════════════════

describe('DESKTOP_VISIBLE_DESCRIPTOR', () => {
  it('has the correct id', () => {
    expect(DESKTOP_VISIBLE_DESCRIPTOR.id).toBe(DESKTOP_VISIBLE_ID)
    expect(DESKTOP_VISIBLE_ID).toBe('desktop-visible')
  })

  it('has a display name and description', () => {
    expect(DESKTOP_VISIBLE_DESCRIPTOR.displayName).toBeTruthy()
    expect(DESKTOP_VISIBLE_DESCRIPTOR.description).toBeTruthy()
  })

  it('is marked as builtin', () => {
    expect(DESKTOP_VISIBLE_DESCRIPTOR.builtin).toBe(true)
  })

  it('advertises visibility and login state', () => {
    expect(DESKTOP_VISIBLE_CAPABILITIES.visible).toBe(true)
    expect(DESKTOP_VISIBLE_CAPABILITIES.hasLoginState).toBe(true)
  })

  it('does NOT advertise interactive capabilities', () => {
    expect(DESKTOP_VISIBLE_CAPABILITIES.canClick).toBe(false)
    expect(DESKTOP_VISIBLE_CAPABILITIES.canType).toBe(false)
    expect(DESKTOP_VISIBLE_CAPABILITIES.canEval).toBe(false)
  })

  it('advertises read capabilities', () => {
    expect(DESKTOP_VISIBLE_CAPABILITIES.canReadDom).toBe(true)
    expect(DESKTOP_VISIBLE_CAPABILITIES.canScreenshot).toBe(true)
    expect(DESKTOP_VISIBLE_CAPABILITIES.canNavigate).toBe(true)
  })

  it('requires agent action approval', () => {
    expect(DESKTOP_VISIBLE_CAPABILITIES.requiresApprovalForAgentAction).toBe(true)
  })

  it('is not a fast headless provider', () => {
    expect(DESKTOP_VISIBLE_CAPABILITIES.supportsFastHeadless).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2. Policy invariants
// ═══════════════════════════════════════════════════════════════════════

describe('policy invariants', () => {
  describe('agent actions', () => {
    it('interactive agent actions (type, eval, press_key, scroll) are DENIED', () => {
      const interactiveActions = ['type', 'eval', 'press_key', 'scroll']

      for (const action of interactiveActions) {
        expect(checkDesktopPermission(action, 'agent')).toBe('deny')
      }
    })

    it('navigation agent actions (navigate, back) require APPROVAL', () => {
      expect(checkDesktopPermission('navigate', 'agent')).toBe('approval_required')
      expect(checkDesktopPermission('back', 'agent')).toBe('approval_required')
    })

    it('read-only agent actions (snapshot, vision, get_images, console) are ALLOWED', () => {
      expect(checkDesktopPermission('snapshot', 'agent')).toBe('allow')
      expect(checkDesktopPermission('vision', 'agent')).toBe('allow')
      expect(checkDesktopPermission('get_images', 'agent')).toBe('allow')
      expect(checkDesktopPermission('console', 'agent')).toBe('allow')
    })

    it('no policy explicitly sets agent decision to allow for interactive or nav actions', () => {
      const restrictedActions = new Set(['click', 'type', 'eval', 'press_key', 'scroll', 'navigate', 'back'])

      for (const p of DESKTOP_VISIBLE_DEFAULT_POLICIES) {
        if (p.actor === 'agent' && restrictedActions.has(p.action as string)) {
          expect(p.decision).not.toBe('allow')
        }
      }
    })
  })

  describe('user actions', () => {
    it('all user actions are allowed (catch-all)', () => {
      expect(checkDesktopPermission('navigate', 'user')).toBe('allow')
      expect(checkDesktopPermission('click', 'user')).toBe('allow')
      expect(checkDesktopPermission('eval', 'user')).toBe('allow')
      expect(checkDesktopPermission('snapshot', 'user')).toBe('allow')
    })
  })

  describe('system actions', () => {
    it('system read actions are allowed', () => {
      expect(checkDesktopPermission('snapshot', 'system')).toBe('allow')
      expect(checkDesktopPermission('vision', 'system')).toBe('allow')
      expect(checkDesktopPermission('console', 'system')).toBe('allow')
    })

    it('system interactive actions (type, eval) are denied (click is approval_required)', () => {
      expect(checkDesktopPermission('click', 'system')).toBe('approval_required')
      expect(checkDesktopPermission('type', 'system')).toBe('deny')
      expect(checkDesktopPermission('eval', 'system')).toBe('deny')
    })

    it('system navigation requires approval', () => {
      expect(checkDesktopPermission('navigate', 'system')).toBe('approval_required')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3. Permission checker
// ═══════════════════════════════════════════════════════════════════════

describe('checkDesktopPermission', () => {
  it('user can navigate', () => {
    expect(checkDesktopPermission('navigate', 'user')).toBe('allow')
  })

  it('user can do any action', () => {
    expect(checkDesktopPermission('click', 'user')).toBe('allow')
    expect(checkDesktopPermission('eval', 'user')).toBe('allow')
    expect(checkDesktopPermission('back', 'user')).toBe('allow')
  })

  it('agent cannot type or eval (click is approval_required)', () => {
    expect(checkDesktopPermission('click', 'agent')).toBe('approval_required')
    expect(checkDesktopPermission('type', 'agent')).toBe('deny')
    expect(checkDesktopPermission('eval', 'agent')).toBe('deny')
  })

  it('agent can snapshot and screenshot', () => {
    expect(checkDesktopPermission('snapshot', 'agent')).toBe('allow')
    expect(checkDesktopPermission('vision', 'agent')).toBe('allow')
    expect(checkDesktopPermission('get_images', 'agent')).toBe('allow')
    expect(checkDesktopPermission('console', 'agent')).toBe('allow')
  })

  it('system can read, click requires approval, navigate requires approval', () => {
    expect(checkDesktopPermission('snapshot', 'system')).toBe('allow')
    expect(checkDesktopPermission('navigate', 'system')).toBe('approval_required')
    expect(checkDesktopPermission('click', 'system')).toBe('approval_required')
  })

  it('returns deny for unknown agent action, allow for system (catch-all)', () => {
    // agent has no catch-all — unknown action falls through to the safety default
    expect(checkDesktopPermission('unknown_action', 'agent')).toBe('deny')
    // system has a '*' catch-all at the end of the policy list → allow
    expect(checkDesktopPermission('unknown_action', 'system')).toBe('allow')
    // user has a '*' catch-all → allow
    expect(checkDesktopPermission('unknown_action', 'user')).toBe('allow')
  })
})

describe('isDesktopActionAllowed', () => {
  it('returns true for user navigate', () => {
    expect(isDesktopActionAllowed('navigate', 'user')).toBe(true)
  })

  it('returns false for agent navigate', () => {
    expect(isDesktopActionAllowed('navigate', 'agent')).toBe(false)
  })

  it('returns true for agent snapshot', () => {
    expect(isDesktopActionAllowed('snapshot', 'agent')).toBe(true)
  })
})

describe('isDesktopActionApprovalRequired', () => {
  it('returns true for agent navigate', () => {
    expect(isDesktopActionApprovalRequired('navigate', 'agent')).toBe(true)
  })

  it('returns false for agent snapshot', () => {
    expect(isDesktopActionApprovalRequired('snapshot', 'agent')).toBe(false)
  })

  it('returns false for user navigate', () => {
    expect(isDesktopActionApprovalRequired('navigate', 'user')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4. Snapshot builder — happy path
// ═══════════════════════════════════════════════════════════════════════

describe('getDesktopSnapshot — happy path', () => {
  it('returns a complete snapshot when all bridge calls succeed', async () => {
    const bridge = fakeBridge()
    const snapshot = await getDesktopSnapshot(bridge)

    // Identity
    expect(snapshot.capturedAt).toBeTruthy()
    expect(snapshot.source.provider).toBe('desktop-visible')
    expect(snapshot.source.mode).toBe('read_only')
    expect(snapshot.source.sessionKey).toBe('desktop-main')

    // Active tab
    expect(snapshot.activeTab.url).toBe('https://github.com/gu87/trendradar')
    expect(snapshot.activeTab.title).toBe('gu87/trendradar')
    expect(snapshot.activeTab.isLoading).toBe(false)
    expect(snapshot.activeTab.canGoBack).toBe(true)
    expect(snapshot.activeTab.canGoForward).toBe(false)
    expect(snapshot.activeTab.navigationSource).toBe('user')

    // DOM
    expect(snapshot.dom.bodyText).toBe('Welcome to TrendRadar. This tool helps you monitor trends.')
    expect(snapshot.dom.metaDescription).toBe('TrendRadar — monitor trends')
    expect(snapshot.dom.headings).toHaveLength(2)
    expect(snapshot.dom.headings[0].tag).toBe('h1')
    expect(snapshot.dom.headings[0].text).toBe('TrendRadar')
    expect(snapshot.dom.ariaSnapshot).toBeNull() // desktop has no aria tree

    // User context
    expect(snapshot.userContext.selectedText).toBe('Auto-merge is enabled for this PR')
    expect(snapshot.userContext.clipboardPreview).toBe('') // not yet implemented

    // Screenshot
    expect(snapshot.screenshot.ref).toContain('data:image/png;base64,')
    expect(snapshot.screenshot.width).toBe(1920)
    expect(snapshot.screenshot.height).toBe(1080)
    expect(snapshot.screenshot.sizeBytes).toBeGreaterThan(0)

    // Console — not available on desktop
    expect(snapshot.console).toBeNull()

    // Limits
    expect(snapshot.limits.maxBodyTextChars).toBe(3000)
    expect(snapshot.limits.actualTotalBytes).toBeGreaterThan(0)

    // No errors
    expect(snapshot.errors).toHaveLength(0)
  })

  it('uses custom sessionKey', async () => {
    const snapshot = await getDesktopSnapshot(fakeBridge(), 'my-custom-key')
    expect(snapshot.source.sessionKey).toBe('my-custom-key')
  })

  it('handles empty page state gracefully', async () => {
    const bridge = fakeBridge({
      state: { url: '', title: '', canGoBack: false, canGoForward: false, isLoading: false },
    })

    const snapshot = await getDesktopSnapshot(bridge)
    expect(snapshot.activeTab.url).toBe('')
    expect(snapshot.activeTab.title).toBe('')
  })

  it('handles empty dom summary', async () => {
    const bridge = fakeBridge({
      domSummary: { title: '', description: '', headings: [], textPreview: '' },
    })

    const snapshot = await getDesktopSnapshot(bridge)
    expect(snapshot.dom.bodyText).toBe('')
    expect(snapshot.dom.headings).toHaveLength(0)
    expect(snapshot.dom.metaDescription).toBeNull()
  })

  it('handles empty selected text', async () => {
    const bridge = fakeBridge({ selectedText: { text: '' } })
    const snapshot = await getDesktopSnapshot(bridge)
    expect(snapshot.userContext.selectedText).toBe('')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5. Snapshot builder — error paths
// ═══════════════════════════════════════════════════════════════════════

describe('getDesktopSnapshot — error paths', () => {
  it('captures state failure in errors[]', async () => {
    const bridge = fakeBridge({ state: { error: 'connection lost' } })
    const snapshot = await getDesktopSnapshot(bridge)

    expect(snapshot.activeTab.url).toBe('') // fallback empty
    expect(snapshot.errors.some(e => e.field === 'activeTab')).toBe(true)
  })

  it('captures dom summary failure in errors[]', async () => {
    const bridge = fakeBridge({ domSummary: { error: 'executeJavaScript rejected' } })
    const snapshot = await getDesktopSnapshot(bridge)

    expect(snapshot.dom.bodyText).toBeNull()
    expect(snapshot.errors.some(e => e.field === 'dom')).toBe(true)
  })

  it('captures screenshot failure in errors[]', async () => {
    const bridge = fakeBridge({ screenshot: { dataURL: '', width: 0, height: 0, error: 'capturePage failed' } })
    const snapshot = await getDesktopSnapshot(bridge)

    expect(snapshot.screenshot.ref).toBeNull()
    expect(snapshot.errors.some(e => e.field === 'screenshot')).toBe(true)
  })

  it('captures selected text failure in errors[]', async () => {
    const bridge = fakeBridge({ selectedText: { text: '', error: 'permission denied' } })
    const snapshot = await getDesktopSnapshot(bridge)

    expect(snapshot.userContext.selectedText).toBe('')
    expect(snapshot.errors.some(e => e.field === 'selectedText')).toBe(true)
  })

  it('does not surface error for selectedText when empty is legit', async () => {
    // Empty text without an error field is a valid state (nothing selected),
    // not an error.
    const bridge = fakeBridge({ selectedText: { text: '' } })
    const snapshot = await getDesktopSnapshot(bridge)

    expect(snapshot.userContext.selectedText).toBe('')
    expect(snapshot.errors.some(e => e.field === 'selectedText')).toBe(false)
  })

  it('captures all errors when bridge rejects entirely', async () => {
    const bridge = fakeBridge({ rejectWith: new Error('IPC bridge unavailable') })
    const snapshot = await getDesktopSnapshot(bridge)

    // All four fields should have errors
    const errorFields = snapshot.errors.map(e => e.field)
    expect(errorFields).toContain('activeTab')
    expect(errorFields).toContain('dom')
    expect(errorFields).toContain('screenshot')
    expect(errorFields).toContain('selectedText')

    // Fallback values should be safe
    expect(snapshot.activeTab.url).toBe('')
    expect(snapshot.dom.bodyText).toBeNull()
    expect(snapshot.screenshot.ref).toBeNull()
    expect(snapshot.userContext.selectedText).toBe('')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 6. isDesktopVisibleAvailable
// ═══════════════════════════════════════════════════════════════════════

describe('isDesktopVisibleAvailable', () => {
  it('returns available:true when bridge reports available', async () => {
    const bridge = fakeBridge({ available: true })
    const result = await isDesktopVisibleAvailable(bridge)
    expect(result.available).toBe(true)
  })

  it('returns available:false with reason when bridge reports unavailable', async () => {
    const bridge = fakeBridge({ available: false })
    const result = await isDesktopVisibleAvailable(bridge)
    expect(result.available).toBe(false)
  })

  it('returns available:false when isAvailable IPC throws', async () => {
    const bridge = fakeBridge({ rejectWith: new Error('IPC disconnected') })
    const result = await isDesktopVisibleAvailable(bridge)
    expect(result.available).toBe(false)
    expect(result.reason).toContain('IPC disconnected')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 7. Snapshot shape — type-level verification
// ═══════════════════════════════════════════════════════════════════════

describe('getDesktopSnapshot — shape compliance', () => {
  it('returns an object conforming to BrowserSnapshot shape', async () => {
    const snapshot: BrowserSnapshot = await getDesktopSnapshot(fakeBridge())

    // Top-level keys — type-check verifies the rest
    expect(typeof snapshot.capturedAt).toBe('string')
    expect(typeof snapshot.source.provider).toBe('string')
    expect(typeof snapshot.activeTab.url).toBe('string')
    expect(Array.isArray(snapshot.dom.headings)).toBe(true)
    expect(typeof snapshot.screenshot.sizeBytes).toBe('number')
    expect(Array.isArray(snapshot.errors)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 8. Phase 2D — Permanent deny policies
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 2D — permanent deny policies', () => {
  describe('eval is permanently denied for all non-user actors', () => {
    it('agent eval → deny', () => {
      expect(checkDesktopPermission('eval', 'agent')).toBe('deny')
    })
    it('system eval → deny', () => {
      expect(checkDesktopPermission('eval', 'system')).toBe('deny')
    })
    it('user eval → allow (existing UI contract)', () => {
      expect(checkDesktopPermission('eval', 'user')).toBe('allow')
    })
  })

  describe('press_key is permanently denied for all non-user actors', () => {
    it('agent press_key → deny', () => {
      expect(checkDesktopPermission('press_key', 'agent')).toBe('deny')
    })
    it('system press_key → deny', () => {
      expect(checkDesktopPermission('press_key', 'system')).toBe('deny')
    })
  })

  describe('scroll is permanently denied for all non-user actors', () => {
    it('agent scroll → deny', () => {
      expect(checkDesktopPermission('scroll', 'agent')).toBe('deny')
    })
    it('system scroll → deny', () => {
      expect(checkDesktopPermission('scroll', 'system')).toBe('deny')
    })
  })

  describe('click and type are denied (awaiting Phase 2F safety implementation)', () => {
    it('agent click → approval_required (Phase 2F-B1)', () => {
      expect(checkDesktopPermission('click', 'agent')).toBe('approval_required')
    })
    it('agent type → deny (will become approval_required in Phase 2F)', () => {
      expect(checkDesktopPermission('type', 'agent')).toBe('deny')
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 9. Phase 2F-A2 — Stable ref mapping contract
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 2F-A2 — stable ref mapping', () => {
  it('buildSafetyContextFromElement produces valid safetyContext with targetRef', () => {
    
    const el = {
      ref: '@e1',
      tagName: 'button',
      role: null,
      semanticRole: 'submit_button' as const,
      highRisk: true,
      isDestructive: false,
      isMediumRisk: false,
      href: null,
      textContent: 'Submit PR',
      ariaLabel: null,
      id: 'submit-btn',
      name: null,
      inputType: 'submit',
      placeholder: null,
      valuePreview: null,
      boundingBox: { x: 100, y: 200, w: 120, h: 36 },
      visible: true,
      disabled: false,
      readOnly: false,
      fingerprint: {
        tagName: 'button',
        textContent: 'Submit PR',
        id: 'submit-btn',
        name: null,
        inputType: 'submit',
        ariaLabel: null,
        rect: { x: 100, y: 200, w: 120, h: 36 },
      },
    }

    const ctx = buildSafetyContextFromElement(
      el,
      'https://example.com',
      'Example Page',
      'click',
    )

    expect(ctx.targetRef).toBe('@e1')
    expect(ctx.originUrl).toBe('https://example.com')
    expect(ctx.targetDescription).toContain('button')
    expect(ctx.targetDescription).toContain('Submit PR')
    expect(ctx.riskLevel).toBe('medium')
    expect(ctx.elementFingerprint).toEqual(el.fingerprint)
    expect(ctx.typeText).toBeUndefined() // click, not type
  })

  it('buildSafetyContextFromElement includes typeText for type action', () => {
    
    const el = {
      ref: '@e3',
      tagName: 'input',
      role: null,
      semanticRole: 'text_input' as const,
      highRisk: false,
      isDestructive: false,
      isMediumRisk: false,
      href: null,
      textContent: '',
      ariaLabel: null,
      id: null,
      name: 'q',
      inputType: 'text',
      placeholder: 'Search…',
      valuePreview: 'current query',
      boundingBox: { x: 100, y: 200, w: 200, h: 28 },
      visible: true,
      disabled: false,
      readOnly: false,
      fingerprint: {
        tagName: 'input',
        textContent: '',
        id: null,
        name: 'q',
        inputType: 'text',
        ariaLabel: null,
        rect: { x: 100, y: 200, w: 200, h: 28 },
      },
    }

    const ctx = buildSafetyContextFromElement(
      el,
      'https://example.com',
      'Example Page',
      'type',
    )

    expect(ctx.targetRef).toBe('@e3')
    expect(ctx.typeText).toBe('current query')
  })
})

describe('Phase 2F-A2 — getDesktopInteractiveSnapshot', () => {
  it('returns null when bridge has no getInteractiveSnapshot', async () => {
    
    const bridge = fakeBridge()
    const result = await getDesktopInteractiveSnapshot(bridge)
    expect(result).toBeNull()
  })

  it('returns null when IPC returns ok:false', async () => {
    
    const bridge = {
      ...fakeBridge(),
      getInteractiveSnapshot: async () => ({
        ok: false,
        capturedAt: new Date().toISOString(),
        currentUrl: '',
        elements: [],
        error: 'not mounted',
      }),
    }

    const result = await getDesktopInteractiveSnapshot(bridge)
    expect(result).toBeNull()
  })

  it('returns snapshot when IPC succeeds', async () => {
    
    const el = {
      ref: '@e1',
      tagName: 'button',
      role: null,
      semanticRole: 'button' as const,
      highRisk: false,
      isDestructive: false,
      isMediumRisk: false,
      href: null,
      textContent: 'Click me',
      ariaLabel: null,
      id: null,
      name: null,
      inputType: null,
      placeholder: null,
      valuePreview: null,
      boundingBox: { x: 0, y: 0, w: 100, h: 40 },
      visible: true,
      disabled: false,
      readOnly: false,
      fingerprint: {
        tagName: 'button',
        textContent: 'Click me',
        id: null,
        name: null,
        inputType: null,
        ariaLabel: null,
        rect: { x: 0, y: 0, w: 100, h: 40 },
      },
    }

    const bridge = {
      ...fakeBridge(),
      getInteractiveSnapshot: async () => ({
        ok: true,
        capturedAt: new Date().toISOString(),
        currentUrl: 'https://example.com',
        elements: [el],
      }),
    }

    const result = await getDesktopInteractiveSnapshot(bridge)
    expect(result).not.toBeNull()
    expect(result!.elements).toHaveLength(1)
    expect(result!.elements[0].ref).toBe('@e1')
    expect(result!.elements[0].tagName).toBe('button')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 10. Phase 2F-B — Semantic click safety guards
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 2F-B — semantic click guards', () => {
  const mockSnapshot = (overrides: Record<string, unknown> = {}) => ({
    ok: true as const,
    capturedAt: new Date().toISOString(),
    currentUrl: 'https://example.com',
    elements: [{
      ref: '@e1',
      tagName: 'button',
      role: null,
      semanticRole: 'button',
      highRisk: false,
      isDestructive: false,
      isMediumRisk: false,
      href: null,
      textContent: 'Click me',
      ariaLabel: null,
      id: null,
      name: null,
      inputType: null,
      placeholder: null,
      valuePreview: null,
      boundingBox: { x: 0, y: 0, w: 100, h: 40 },
      visible: true,
      disabled: false,
      readOnly: false,
      fingerprint: {
        tagName: 'button',
        textContent: 'Click me',
        id: null,
        name: null,
        inputType: null,
        ariaLabel: null,
        rect: { x: 0, y: 0, w: 100, h: 40 },
      },
      ...overrides,
    }],
  })

  it('executeClick rejects submit_button', async () => {
    const bridge = {
      ...fakeBridge(),
      executeClick: async (payload: { targetRef: string }) => {
        // Simulate IPC returning blocked for highRisk submit_button
        return {
          ok: false,
          reason: `Click rejected: target has semanticRole "submit_button"`,
          currentUrl: 'https://example.com',
          verification: { refValid: false, invalidationReason: 'semantic_guard_blocked' },
        }
      },
    }

    const result = await executeDesktopClick(bridge, {
      targetRef: '@e1',
      originUrl: 'https://example.com',
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('submit_button')
  })

  it('executeClick rejects destructive labels', async () => {
    const bridge = {
      ...fakeBridge(),
      executeClick: async () => ({
        ok: false,
        reason: 'Click rejected: target "Delete account" matches destructive keyword filter.',
        currentUrl: 'https://example.com',
        verification: { refValid: false, invalidationReason: 'semantic_guard_blocked' },
      }),
    }

    const result = await executeDesktopClick(bridge, {
      targetRef: '@e2',
      originUrl: 'https://example.com',
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('destructive')
  })

  it('executeClick rejects file_input', async () => {
    const bridge = {
      ...fakeBridge(),
      executeClick: async () => ({
        ok: false,
        reason: 'Click rejected: target has semanticRole "file_input" which is blocked for safety.',
        currentUrl: 'https://example.com',
        verification: { refValid: false, invalidationReason: 'semantic_guard_blocked' },
      }),
    }

    const result = await executeDesktopClick(bridge, {
      targetRef: '@e3',
      originUrl: 'https://example.com',
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('file_input')
  })

  it('executeClick rejects external_link', async () => {
    const bridge = {
      ...fakeBridge(),
      executeClick: async () => ({
        ok: false,
        reason: 'Click rejected: target has semanticRole "external_link" which is blocked for safety.',
        currentUrl: 'https://example.com',
        verification: { refValid: false, invalidationReason: 'semantic_guard_blocked' },
      }),
    }

    const result = await executeDesktopClick(bridge, {
      targetRef: '@e4',
      originUrl: 'https://example.com',
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('external_link')
  })

  it('executeClick still rejects stale targetRef', async () => {
    const bridge = {
      ...fakeBridge(),
      executeClick: async () => ({
        ok: false,
        reason: 'target_not_found',
        currentUrl: 'https://example.com',
        verification: { refValid: false, invalidationReason: 'target_not_found' },
      }),
    }

    const result = await executeDesktopClick(bridge, {
      targetRef: '@e99',
      originUrl: 'https://example.com',
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('target_not_found')
  })

  it('executeClick rejects invalid @e ref', async () => {
    const bridge = {
      ...fakeBridge(),
      executeClick: async () => ({
        ok: false,
        reason: 'invalid_target_ref',
        verification: { refValid: false, invalidationReason: 'invalid_target_ref' },
      }),
    }

    const result = await executeDesktopClick(bridge, {
      targetRef: 'bad-ref',
      originUrl: 'https://example.com',
    })

    expect(result.ok).toBe(false)
  })

  it('executeClick rejects password_input', async () => {
    const bridge = {
      ...fakeBridge(),
      executeClick: async () => ({
        ok: false,
        reason: 'Click rejected: target has semanticRole "password_input" which is blocked for safety.',
        currentUrl: 'https://example.com',
        verification: { refValid: false, invalidationReason: 'semantic_guard_blocked' },
      }),
    }

    const result = await executeDesktopClick(bridge, {
      targetRef: '@e5',
      originUrl: 'https://example.com',
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('password_input')
  })

  it('executeClick rejects reset_button', async () => {
    const bridge = {
      ...fakeBridge(),
      executeClick: async () => ({
        ok: false,
        reason: 'Click rejected: target has semanticRole "reset_button" which is blocked for safety.',
        currentUrl: 'https://example.com',
        verification: { refValid: false, invalidationReason: 'semantic_guard_blocked' },
      }),
    }

    const result = await executeDesktopClick(bridge, {
      targetRef: '@e6',
      originUrl: 'https://example.com',
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('reset_button')
  })
})
