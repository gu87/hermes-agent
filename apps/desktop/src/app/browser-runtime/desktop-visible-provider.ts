/**
 * DesktopVisibleProvider — Phase 2A adapter
 *
 * Wraps the existing Desktop Browser Workspace (Electron WebContentsView)
 * behind the Phase 1 BrowserRuntime type contract.  Read-only, no agent
 * action implementation — all agent-initiated actions are gated behind
 * `approval_required` or `deny`.
 *
 * Does NOT change existing browser behaviour:
 * - Existing `source:"user"` navigation protection in main.cjs is preserved.
 * - Existing `browser-workspace.tsx` UI continues to work unchanged.
 * - No click/type/agent-navigate code path exists here.
 *
 * @see docs/architecture/browser-runtime-provider-unification.md (Phase 2)
 * @see apps/desktop/electron/main.cjs:5399-5405  (requireUserSource gate)
 * @see apps/desktop/electron/preload.cjs:119-161  (bridge API)
 */

import type {
  BrowserActionSafetyContext,
  BrowserActiveTabContext,
  BrowserCapability,
  BrowserConsoleSnapshot,
  BrowserDomContent,
  BrowserPermissionDecision,
  BrowserPermissionPolicy,
  BrowserProviderDescriptor,
  BrowserScreenshotRef,
  BrowserSnapshot,
  BrowserSnapshotError,
  BrowserSnapshotLimits,
  BrowserSnapshotSource,
  BrowserUserContext,
  PreActionVerification,
} from './types'

// ═══════════════════════════════════════════════════════════════════════════
// 1. Bridge type (subset of global.d.ts — no runtime import needed)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The subset of the Desktop browser bridge that this adapter reads from.
 *
 * Mirrors the preload API defined in:
 *   - apps/desktop/electron/preload.cjs:119-161
 *   - apps/desktop/src/global.d.ts:84-104
 */
export interface DesktopBrowserBridge {
  isAvailable(): Promise<{ available: boolean; reason?: string }>
  getState(): Promise<DesktopBridgeState>
  getDomSummary(): Promise<DesktopBridgeDomSummary>
  getScreenshot(): Promise<DesktopBridgeScreenshot>
  getSelectedText(): Promise<DesktopBridgeSelectedText>
  /** Phase 2F-A2: Enumerate interactive elements. */
  getInteractiveSnapshot?(): Promise<DesktopInteractiveSnapshotResult>
  /** Phase 2F-B1: Execute real click (re-verifies before clicking). */
  executeClick?(payload: { targetRef: string; originUrl: string; expectedFingerprint?: Record<string, unknown> }): Promise<DesktopExecuteClickResult>
  /** Phase 2F-A: Read-only target resolution IPC. */
  verifyActionTarget?(payload: { targetRef: string; originUrl: string }): Promise<DesktopVerifyTargetResult>
}

interface DesktopBridgeState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  error?: string
}

interface DesktopBridgeDomSummary {
  title: string
  description: string
  headings: Array<{ tag: string; text: string }>
  textPreview: string
  error?: string
}

interface DesktopBridgeScreenshot {
  dataURL: string
  width: number
  height: number
  error?: string
}

interface DesktopBridgeSelectedText {
  text: string
  error?: string
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Static provider descriptor
// ═══════════════════════════════════════════════════════════════════════════

export const DESKTOP_VISIBLE_ID = 'desktop-visible' as const

/**
 * Static capabilities for the Desktop embedded browser.
 *
 * The desktop browser is visible, carries login state, supports read-only
 * DOM/screenshot, and allows navigation — but ONLY when initiated by the
 * user through the right-rail UI.  Agent-initiated interactive actions
 * (click, type, eval) are NOT supported.
 */
export const DESKTOP_VISIBLE_CAPABILITIES: BrowserCapability = {
  visible: true,
  hasLoginState: true,
  canReadDom: true,
  canScreenshot: true,
  canNavigate: true,
  canClick: false,
  canType: false,
  canEval: false,
  requiresApprovalForAgentAction: true,
  supportsFastHeadless: false,
}

/**
 * Default permission policies for the Desktop embedded browser.
 *
 * Rules are evaluated in order; the first match wins.
 *
 * Key invariants:
 * - AGENT-initiated actions are NEVER `allow`.
 * - Interactive actions currently DENIED:
 *   - click, type    → deny for now (awaiting Phase 2F safety implementation;
 *                      will move to approval_required when execution code exists)
 *   - eval           → PERMANENTLY denied (arbitrary JS in user's logged-in page)
 *   - press_key      → PERMANENTLY denied (opaque; can trigger form submit)
 *   - scroll         → PERMANENTLY denied (user should control visible viewport)
 * - Navigation actions from agent → `approval_required` (user must confirm).
 * - Read-only actions (snapshot, vision, get_images, console) → `allow`.
 * - USER-initiated actions → `allow` (existing right-rail UI behaviour).
 *
 * @see docs/architecture/desktop-browser-agent-action-safety.md §7
 */
export const DESKTOP_VISIBLE_DEFAULT_POLICIES: BrowserPermissionPolicy[] = [
  // ── Agent actor ──────────────────────────────────────────────────
  // Permanently denied (no safety margin on Desktop):
  { provider: 'desktop-visible', action: 'eval',        actor: 'agent', decision: 'deny' },
  { provider: 'desktop-visible', action: 'press_key',   actor: 'agent', decision: 'deny' },
  { provider: 'desktop-visible', action: 'scroll',      actor: 'agent', decision: 'deny' },
  // click — executable after approval (Phase 2F-B1):
  { provider: 'desktop-visible', action: 'click',       actor: 'agent', decision: 'approval_required' },
  // type — denied until Phase 2F-B2:
  { provider: 'desktop-visible', action: 'type',        actor: 'agent', decision: 'deny' },
  // Navigation — user must approve:
  { provider: 'desktop-visible', action: 'navigate',    actor: 'agent', decision: 'approval_required' },
  { provider: 'desktop-visible', action: 'back',        actor: 'agent', decision: 'approval_required' },
  // Read-only — always safe:
  { provider: 'desktop-visible', action: 'snapshot',    actor: 'agent', decision: 'allow' },
  { provider: 'desktop-visible', action: 'vision',      actor: 'agent', decision: 'allow' },
  { provider: 'desktop-visible', action: 'get_images',  actor: 'agent', decision: 'allow' },
  { provider: 'desktop-visible', action: 'console',     actor: 'agent', decision: 'allow' },

  // ── User actor ───────────────────────────────────────────────────
  { provider: 'desktop-visible', action: '*', actor: 'user', decision: 'allow' },

  // ── System actor ─────────────────────────────────────────────────
  // System reads are always allowed. System writes (navigate) require
  // approval because the desktop browser is user-visible.
  // Permanently denied (same as agent — no safety margin):
  { provider: 'desktop-visible', action: 'eval',        actor: 'system', decision: 'deny' },
  { provider: 'desktop-visible', action: 'press_key',   actor: 'system', decision: 'deny' },
  { provider: 'desktop-visible', action: 'scroll',      actor: 'system', decision: 'deny' },
  { provider: 'desktop-visible', action: 'click',       actor: 'system', decision: 'approval_required' },
  { provider: 'desktop-visible', action: 'type',        actor: 'system', decision: 'deny' },
  { provider: 'desktop-visible', action: 'navigate',    actor: 'system', decision: 'approval_required' },
  { provider: 'desktop-visible', action: 'back',        actor: 'system', decision: 'approval_required' },
  { provider: 'desktop-visible', action: '*',           actor: 'system', decision: 'allow' },
]

/**
 * Full static descriptor for the DesktopVisibleProvider.
 *
 * This is the single source of truth for the desktop browser's identity
 * and capabilities.  The router (Phase 4) consumes this to decide
 * whether a given action can be routed here.
 */
export const DESKTOP_VISIBLE_DESCRIPTOR: BrowserProviderDescriptor = {
  id: DESKTOP_VISIBLE_ID,
  displayName: 'Desktop Browser',
  description: 'The embedded browser in Hermes Desktop right rail — user-visible, login-state persistent, read-only for agents.',
  capabilities: DESKTOP_VISIBLE_CAPABILITIES,
  defaultPolicies: DESKTOP_VISIBLE_DEFAULT_POLICIES,
  builtin: true,
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Permission checker
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check whether an action is permitted for the given actor on the desktop
 * visible provider.
 *
 * Evaluates `DESKTOP_VISIBLE_DEFAULT_POLICIES` in order; returns the first
 * matching decision.
 *
 * @returns The decision, or `'deny'` if no policy matched (safe default).
 */
export function checkDesktopPermission(
  action: string,
  actor: 'user' | 'agent' | 'system',
): BrowserPermissionDecision {
  for (const policy of DESKTOP_VISIBLE_DEFAULT_POLICIES) {
    const actionMatch = policy.action === '*' || policy.action === action
    const actorMatch = policy.actor === '*' || policy.actor === actor

    if (actionMatch && actorMatch) {
      return policy.decision
    }
  }

  // Safe default: if nothing matched, deny.
  return 'deny'
}

/**
 * Convenience: returns true when the given action is permitted (allowed).
 */
export function isDesktopActionAllowed(
  action: string,
  actor: 'user' | 'agent' | 'system',
): boolean {
  return checkDesktopPermission(action, actor) === 'allow'
}

/**
 * Convenience: returns true when the given action requires user approval.
 */
export function isDesktopActionApprovalRequired(
  action: string,
  actor: 'user' | 'agent' | 'system',
): boolean {
  return checkDesktopPermission(action, actor) === 'approval_required'
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Snapshot builder
// ═══════════════════════════════════════════════════════════════════════════

/** Hard limits for the desktop browser snapshot (matching current IPC caps). */
const DESKTOP_SNAPSHOT_LIMITS: BrowserSnapshotLimits = {
  maxAriaSnapshotChars: 0,       // desktop has no accessibility tree
  maxBodyTextChars: 3000,        // matches main.cjs:5541 — textPreview.slice(0, 3000)
  maxSelectionChars: 10240,      // 10 KB
  maxClipboardChars: 0,          // clipboard preview not yet implemented on desktop
  maxTotalBytes: 512000,         // 500 KB (screenshot)
  actualTotalBytes: 0,           // filled at capture time
}

/**
 * Compose a BrowserSnapshot from the desktop browser bridge.
 *
 * Calls `getState()`, `getDomSummary()`, `getScreenshot()`, and
 * `getSelectedText()` in parallel, then maps the results into the
 * unified BrowserSnapshot shape.
 *
 * Errors in individual bridge calls are captured in `snapshot.errors[]`
 * rather than failing the entire snapshot — the Agent gets whichever
 * fields succeeded.
 *
 * @param bridge  The desktop browser bridge (usually `window.hermesDesktop.browser`).
 * @param sessionKey  Identifier for this snapshot — typically `'desktop-main'`.
 */
export async function getDesktopSnapshot(
  bridge: DesktopBrowserBridge,
  sessionKey = 'desktop-main',
): Promise<BrowserSnapshot> {
  const capturedAt = new Date().toISOString()
  const errors: BrowserSnapshotError[] = []

  // ── Fire all bridge calls in parallel ────────────────────────────
  const [stateResult, domResult, screenshotResult, selectionResult] =
    await Promise.allSettled([
      bridge.getState(),
      bridge.getDomSummary(),
      bridge.getScreenshot(),
      bridge.getSelectedText(),
    ])

  // ── Unwrap results, collecting errors ────────────────────────────

  let activeTab: BrowserActiveTabContext

  if (stateResult.status === 'fulfilled' && !stateResult.value.error) {
    const s = stateResult.value
    activeTab = {
      url: s.url || '',
      title: s.title || '',
      isLoading: s.isLoading ?? false,
      canGoBack: s.canGoBack ?? false,
      canGoForward: s.canGoForward ?? false,
      navigationSource: 'user', // desktop browser is always user-driven
    }
  } else {
    const errMsg =
      stateResult.status === 'fulfilled'
        ? stateResult.value.error || 'getState returned empty'
        : `getState failed: ${String(stateResult.reason)}`

    activeTab = {
      url: '',
      title: '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      navigationSource: null,
    }
    errors.push({ field: 'activeTab', message: errMsg })
  }

  let dom: BrowserDomContent

  if (domResult.status === 'fulfilled' && !domResult.value.error) {
    const d = domResult.value
    dom = {
      ariaSnapshot: null, // desktop has no accessibility tree
      bodyText: d.textPreview || '',
      metaDescription: d.description || null,
      headings: d.headings || [],
    }
  } else {
    const errMsg =
      domResult.status === 'fulfilled'
        ? domResult.value.error || 'getDomSummary returned empty'
        : `getDomSummary failed: ${String(domResult.reason)}`

    dom = { ariaSnapshot: null, bodyText: null, metaDescription: null, headings: [] }
    errors.push({ field: 'dom', message: errMsg })
  }

  let screenshot: BrowserScreenshotRef

  if (screenshotResult.status === 'fulfilled' && !screenshotResult.value.error) {
    const sc = screenshotResult.value
    const sizeBytes = sc.dataURL ? Math.round((sc.dataURL.length * 3) / 4) : 0
    screenshot = {
      ref: sc.dataURL || null,
      width: sc.width || 0,
      height: sc.height || 0,
      sizeBytes,
    }
  } else {
    const errMsg =
      screenshotResult.status === 'fulfilled'
        ? screenshotResult.value.error || 'getScreenshot returned empty'
        : `getScreenshot failed: ${String(screenshotResult.reason)}`

    screenshot = { ref: null, width: 0, height: 0, sizeBytes: 0 }
    errors.push({ field: 'screenshot', message: errMsg })
  }

  let userContext: BrowserUserContext

  if (selectionResult.status === 'fulfilled' && !selectionResult.value.error) {
    userContext = {
      selectedText: selectionResult.value.text || '',
      clipboardPreview: '', // clipboard preview not yet implemented on desktop
    }
  } else {
    userContext = { selectedText: '', clipboardPreview: '' }

    const errMsg =
      selectionResult.status === 'fulfilled'
        ? selectionResult.value.error || 'getSelectedText returned empty'
        : `getSelectedText failed: ${String(selectionResult.reason)}`

    errors.push({ field: 'selectedText', message: errMsg })
  }

  // ── Console — not available on desktop browser ──────────────────
  const consoleSnapshot: BrowserConsoleSnapshot | null = null

  // ── Source metadata ─────────────────────────────────────────────
  const source: BrowserSnapshotSource = {
    provider: DESKTOP_VISIBLE_ID,
    sessionKey,
    mode: 'read_only',
  }

  // ── Compute actual total bytes ──────────────────────────────────
  let actualTotalBytes = 0

  if (dom.bodyText) {actualTotalBytes += dom.bodyText.length}

  if (dom.ariaSnapshot) {actualTotalBytes += dom.ariaSnapshot.length}

  if (userContext.selectedText) {actualTotalBytes += userContext.selectedText.length}

  if (userContext.clipboardPreview) {actualTotalBytes += userContext.clipboardPreview.length}

  if (screenshot.ref && screenshot.sizeBytes) {actualTotalBytes += screenshot.sizeBytes}

  const limits: BrowserSnapshotLimits = {
    ...DESKTOP_SNAPSHOT_LIMITS,
    actualTotalBytes,
  }

  return {
    capturedAt,
    source,
    activeTab,
    dom,
    userContext,
    screenshot,
    console: consoleSnapshot,
    limits,
    errors,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Phase 2F-A: Read-only target verification
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Shape returned by the `hermes:browser:get-interactive-snapshot` IPC.
 * Mirrors `DesktopInteractiveSnapshotResult` in global.d.ts.
 */
export interface DesktopInteractiveSnapshotResult {
  ok: boolean
  capturedAt: string
  currentUrl: string
  elements: DesktopInteractiveSnapshotElement[]
  error?: string
}

export interface DesktopInteractiveSnapshotElement {
  ref: string
  tagName: string
  role: string | null
  semanticRole: string
  highRisk: boolean
  isDestructive: boolean
  isMediumRisk: boolean
  textContent: string
  ariaLabel: string | null
  id: string | null
  name: string | null
  inputType: string | null
  placeholder: string | null
  valuePreview: string | null
  href: string | null
  boundingBox: { x: number; y: number; w: number; h: number }
  visible: boolean
  disabled: boolean
  readOnly: boolean
  fingerprint: {
    tagName: string
    textContent: string
    id: string | null
    name: string | null
    inputType: string | null
    ariaLabel: string | null
    rect: { x: number; y: number; w: number; h: number }
  }
}

/**
 * Shape returned by the `hermes:browser:verify-action-target` IPC.
 * Mirrors `DesktopVerifyTargetResult` in global.d.ts.
 */
export interface DesktopVerifyTargetResult {
  found: boolean
  reason: string | null
  currentUrl: string
  urlMatchesOrigin: boolean
  elementFingerprint?: {
    tagName: string
    textContent: string
    id: string | null
    name: string | null
    inputType: string | null
    ariaLabel: string | null
    rect: { x: number; y: number; w: number; h: number }
  }
  boundingBox?: { x: number; y: number; w: number; h: number }
  visible?: boolean
  disabled?: boolean
  readOnly?: boolean
  value?: string | null
  placeholder?: string | null
  tagName?: string
  detail?: string
}

/**
 * Shape returned by the ``hermes:browser:execute-click`` IPC.
 */
export interface DesktopExecuteClickResult {
  ok: boolean
  reason?: string
  detail?: string
  currentUrl?: string
  clickedAt?: { x: number; y: number }
  verification?: {
    refValid: boolean
    invalidationReason?: string
    currentUrl?: string
    currentFingerprint?: {
      tagName: string
      textContent: string
      id: string | null
      name: string | null
      inputType: string | null
      ariaLabel: string | null
    }
  }
}

/**
 * Pure function: compare an expected element fingerprint against an actual
 * one.  Returns null when they match, or a mismatch reason string.
 *
 * IMPORTANT: uses ``!== undefined`` guards, NOT falsy checks — an empty
 * string in the expected fingerprint MUST be compared, not skipped.
 * Kept in sync with the equivalent logic in ``main.cjs`` execute-click.
 */
export function compareElementFingerprint(
  expected: {
    tagName?: string | null
    textContent?: string | null
    id?: string | null
    name?: string | null
    inputType?: string | null
    ariaLabel?: string | null
  },
  actual: {
    tagName?: string | null
    textContent?: string | null
    id?: string | null
    name?: string | null
    inputType?: string | null
    ariaLabel?: string | null
  },
): string | null {
  if (expected.tagName !== undefined && expected.tagName !== null
      && (actual.tagName == null || expected.tagName.toLowerCase() !== String(actual.tagName).toLowerCase())) {
    return 'tagName'
  }

  if (expected.textContent !== undefined && expected.textContent !== null
      && expected.textContent !== String(actual.textContent ?? '')) {
    return 'textContent'
  }

  if (expected.id !== undefined && expected.id !== null
      && expected.id !== actual.id) {
    return 'id'
  }

  if (expected.name !== undefined && expected.name !== null
      && expected.name !== actual.name) {
    return 'name'
  }

  if (expected.inputType !== undefined && expected.inputType !== null
      && expected.inputType !== actual.inputType) {
    return 'inputType'
  }

  if (expected.ariaLabel !== undefined && expected.ariaLabel !== null
      && expected.ariaLabel !== actual.ariaLabel) {
    return 'ariaLabel'
  }

  return null
}

/**
 * Known verification failure reasons (readable constants).
 */
export const VERIFICATION_FAILURE_REASONS = {
  missing_safety_context: 'missing_safety_context',
  invalid_target_ref: 'invalid_target_ref',
  origin_url_mismatch: 'origin_url_mismatch',
  target_not_found: 'target_not_found',
  fingerprint_mismatch: 'fingerprint_mismatch',
  target_not_visible: 'target_not_visible',
  target_disabled: 'target_disabled',
  target_readonly: 'target_readonly',
  ipc_error: 'ipc_error',
  bridge_unavailable: 'bridge_unavailable',
} as const

/**
 * Run a read-only pre-action verification for click/type actions.
 *
 * Calls the `hermes:browser:verify-action-target` IPC to resolve the
 * target ref against the live DOM.  Returns a PreActionVerification
 * that the caller can attach to the BrowserActionResult.
 *
 * Does NOT click, type, focus, or mutate the page.
 *
 * @param bridge        The desktop browser bridge.
 * @param safetyContext The action's safety context (must have targetRef + originUrl).
 * @returns             A PreActionVerification with refValid and details.
 */
export async function verifyDesktopActionTarget(
  bridge: DesktopBrowserBridge,
  safetyContext: {
    targetRef: string
    originUrl: string
    elementFingerprint?: {
      tagName: string
      textContent: string
      id: string | null
      name: string | null
      inputType: string | null
      ariaLabel: string | null
    }
  },
): Promise<PreActionVerification> {
  const verifiedAt = new Date().toISOString()

  // ── Bridge guard ────────────────────────────────────────────────────
  if (!bridge.verifyActionTarget) {
    return {
      verifiedAt,
      currentUrl: '',
      refValid: false,
      invalidationReason: VERIFICATION_FAILURE_REASONS.bridge_unavailable,
      snapshot: await getDesktopSnapshot(bridge).catch(() => ({
        capturedAt: verifiedAt,
        source: { provider: 'desktop-visible' as const, sessionKey: 'desktop-main', mode: 'read_only' as const },
        activeTab: { url: '', title: '', isLoading: false, canGoBack: false, canGoForward: false, navigationSource: null },
        dom: { ariaSnapshot: null, bodyText: null, metaDescription: null, headings: [] },
        userContext: { selectedText: '', clipboardPreview: '' },
        screenshot: { ref: null, width: 0, height: 0, sizeBytes: 0 },
        console: null,
        limits: { maxAriaSnapshotChars: 0, maxBodyTextChars: 0, maxSelectionChars: 0, maxClipboardChars: 0, maxTotalBytes: 0, actualTotalBytes: 0 },
        errors: [{ field: 'snapshot', message: 'Bridge unavailable' }],
      })),
    }
  }

  let ipcResult: DesktopVerifyTargetResult

  try {
    ipcResult = await bridge.verifyActionTarget({
      targetRef: safetyContext.targetRef,
      originUrl: safetyContext.originUrl,
    })
  } catch (error) {
    return {
      verifiedAt,
      currentUrl: '',
      refValid: false,
      invalidationReason: VERIFICATION_FAILURE_REASONS.ipc_error,
      snapshot: await getDesktopSnapshot(bridge).catch(() => null as unknown as BrowserSnapshot),
    }
  }

  const snapshot = await getDesktopSnapshot(bridge).catch(() => null as unknown as BrowserSnapshot)

  // ── Invalid target ref ──────────────────────────────────────────────
  if (!ipcResult.found) {
    return {
      verifiedAt,
      currentUrl: ipcResult.currentUrl || '',
      refValid: false,
      invalidationReason: ipcResult.reason || VERIFICATION_FAILURE_REASONS.target_not_found,
      snapshot,
    }
  }

  // ── URL mismatch ────────────────────────────────────────────────────
  if (!ipcResult.urlMatchesOrigin) {
    return {
      verifiedAt,
      currentUrl: ipcResult.currentUrl,
      refValid: false,
      invalidationReason: VERIFICATION_FAILURE_REASONS.origin_url_mismatch,
      currentFingerprint: ipcResult.elementFingerprint,
      snapshot,
    }
  }

  // ── Fingerprint mismatch ────────────────────────────────────────────
  if (safetyContext.elementFingerprint && ipcResult.elementFingerprint) {
    const mismatchField = compareElementFingerprint(
      safetyContext.elementFingerprint,
      ipcResult.elementFingerprint,
    )

    if (mismatchField) {
      return {
        verifiedAt,
        currentUrl: ipcResult.currentUrl,
        refValid: false,
        invalidationReason: VERIFICATION_FAILURE_REASONS.fingerprint_mismatch,
        currentFingerprint: ipcResult.elementFingerprint,
        snapshot,
      }
    }
  }

  // ── Visibility check ────────────────────────────────────────────────
  if (ipcResult.visible === false) {
    return {
      verifiedAt,
      currentUrl: ipcResult.currentUrl,
      refValid: false,
      invalidationReason: VERIFICATION_FAILURE_REASONS.target_not_visible,
      currentFingerprint: ipcResult.elementFingerprint,
      snapshot,
    }
  }

  // ── Disabled check ──────────────────────────────────────────────────
  if (ipcResult.disabled === true) {
    return {
      verifiedAt,
      currentUrl: ipcResult.currentUrl,
      refValid: false,
      invalidationReason: VERIFICATION_FAILURE_REASONS.target_disabled,
      currentFingerprint: ipcResult.elementFingerprint,
      snapshot,
    }
  }

  // ── Passed all checks ───────────────────────────────────────────────
  return {
    verifiedAt,
    currentUrl: ipcResult.currentUrl,
    refValid: true,
    currentFingerprint: ipcResult.elementFingerprint,
    snapshot,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Execute click (Phase 2F-B1)
// ═══════════════════════════════════════════════════════════════════════════

/**
 *
 * Calls `hermes:browser:execute-click` which re-runs the interactive
 * candidate enumeration and checks URL match, fingerprint match, visibility,
 * and disabled status *in the main process* before sending mouseDown/mouseUp.
 *
 * Does NOT execute type, eval, press_key, or scroll.
 *
 * @param bridge        The desktop browser bridge.
 * @param safetyContext The verified safety context (must have targetRef, originUrl, elementFingerprint).
 * @returns             Partial BrowserActionResult fields for the gateway.
 */
export async function executeDesktopClick(
  bridge: DesktopBrowserBridge,
  safetyContext: {
    targetRef: string
    originUrl: string
    elementFingerprint?: {
      tagName: string
      textContent: string
      id: string | null
      name: string | null
      inputType: string | null
      ariaLabel: string | null
    }
  },
): Promise<{
  ok: boolean
  reason?: string
  clickedAt?: { x: number; y: number }
  currentUrl?: string
  verification?: DesktopExecuteClickResult['verification']
  postActionSnapshot?: BrowserSnapshot
}> {
  if (!bridge.executeClick) {
    return { ok: false, reason: 'bridge_unavailable' }
  }

  let result: DesktopExecuteClickResult

  try {
    result = await bridge.executeClick({
      targetRef: safetyContext.targetRef,
      originUrl: safetyContext.originUrl,
      expectedFingerprint: safetyContext.elementFingerprint as Record<string, unknown> | undefined,
    })
  } catch (error) {
    return { ok: false, reason: `executeClick IPC failed: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason || 'click_failed',
      currentUrl: result.currentUrl,
      verification: result.verification,
    }
  }

  // Capture post-click snapshot
  let postActionSnapshot: BrowserSnapshot | undefined

  try {
    postActionSnapshot = await getDesktopSnapshot(bridge)
  } catch {
    // best-effort
  }

  return {
    ok: true,
    clickedAt: result.clickedAt,
    currentUrl: result.currentUrl,
    verification: result.verification,
    postActionSnapshot,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Availability check
// 6. Availability check
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check whether the DesktopVisibleProvider is available.
 *
 * Delegates to the bridge's `isAvailable()` IPC call, which checks:
 *   1. `HERMES_DESKTOP_DISABLE_BROWSER` env var is not set to `'1'`.
 *   2. `getBrowserView()` does not throw (Electron + session available).
 *
 * @see apps/desktop/electron/main.cjs:5669-5679
 */
export async function isDesktopVisibleAvailable(
  bridge: DesktopBrowserBridge,
): Promise<{ available: boolean; reason?: string }> {
  try {
    return await bridge.isAvailable()
  } catch (error) {
    return { available: false, reason: `isAvailable IPC failed: ${String(error)}` }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6b. Phase 2F-A2: Interactive snapshot helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the interactive element snapshot from the Desktop browser.
 *
 * Calls the `hermes:browser:get-interactive-snapshot` IPC to enumerate
 * all interactive elements on the current page with stable `@eN` refs.
 * Returns null when the bridge or IPC is unavailable.
 */
export async function getDesktopInteractiveSnapshot(
  bridge: DesktopBrowserBridge,
): Promise<DesktopInteractiveSnapshotResult | null> {
  if (!bridge.getInteractiveSnapshot) {return null}

  try {
    const result = await bridge.getInteractiveSnapshot()

    if (!result.ok) {return null}

    return result
  } catch {
    return null
  }
}

/**
 * Build a minimal BrowserActionSafetyContext from an interactive snapshot
 * element, suitable for demo / testing.  Uses the element's fingerprint
 * and metadata to populate the safety fields.
 */
export function buildSafetyContextFromElement(
  el: DesktopInteractiveSnapshotElement,
  originUrl: string,
  originTitle: string,
  actionType: 'click' | 'type',
): BrowserActionSafetyContext {
  const descriptionParts: string[] = []
  descriptionParts.push(el.tagName)

  if (el.inputType) {descriptionParts.push(`(type: ${el.inputType})`)}

  if (el.id) {descriptionParts.push(`#${el.id}`)}

  if (el.role) {descriptionParts.push(`role: ${el.role}`)}

  if (el.textContent) {descriptionParts.push(`"${el.textContent.slice(0, 40)}"`)}

  return {
    originUrl,
    originTitle,
    targetDescription: descriptionParts.join(' '),
    targetRef: el.ref,
    typeText: actionType === 'type' ? (el.valuePreview || '') : undefined,
    elementFingerprint: el.fingerprint,
    riskLevel: 'medium',
  }
}
