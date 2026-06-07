/**
 * Browser Runtime — Phase 1 + 2D Type Contract
 *
 * Defines the minimal shared type surface for all BrowserProvider backends:
 * DesktopVisible, AgentBrowser, CloudBrowser, and future Obscura.
 *
 * Phase 1 is CONTRACT ONLY.  No provider implementation, no runtime dependency,
 * no change to existing browser behaviour.  These types are referenced by
 * future provider adapters and the BrowserProviderRouter (Phase 4).
 *
 * Phase 2D adds Desktop Agent Action Safety types (BrowserActionSafetyContext,
 * ElementFingerprint, PreActionVerification) — contract only, no execution code.
 *
 * @see docs/architecture/browser-runtime-provider-unification.md
 * @see docs/architecture/browser-context-provider-design.md
 * @see docs/architecture/desktop-browser-agent-action-safety.md
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. Identity
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Who is requesting a browser action or snapshot.
 *
 * - `user`   — the human at the keyboard (Desktop right-rail UI).
 * - `agent`  — the Hermes Agent via a `browser_*` tool call.
 * - `system` — internal infrastructure (handoff, background pre-load).
 */
export type BrowserActor = 'user' | 'agent' | 'system'

/**
 * Stable identifier for a provider implementation.
 *
 * The set is open (string) so external/third-party plugins can register
 * without changing this file.  Canonical built-in values below.
 */
export type BrowserProviderId = string

/** Canonical built-in provider ids — usable anywhere a BrowserProviderId is expected. */
export const BUILTIN_PROVIDER_IDS = [
  'desktop-visible',
  'agent-headless',
  'cloud-browserbase',
  'cloud-browser-use',
  'cloud-firecrawl',
  'obscura',
] as const satisfies BrowserProviderId[]

// ═══════════════════════════════════════════════════════════════════════════
// 2. Capability descriptor
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Boolean capabilities a provider advertises at registration time.
 *
 * The BrowserProviderRouter reads these to decide whether a given
 * action is routable to a provider.  Missing keys default to `false`.
 */
export interface BrowserCapability {
  /** The provider's browser surface is visible to the user (e.g. Desktop right-rail). */
  visible: boolean

  /** The provider carries persistent login state (cookies, localStorage). */
  hasLoginState: boolean

  /** The provider can return structured DOM text content. */
  canReadDom: boolean

  /** The provider can capture a page screenshot. */
  canScreenshot: boolean

  /** The provider can navigate to a URL. */
  canNavigate: boolean

  /** The provider can click on page elements. */
  canClick: boolean

  /** The provider can type text into input fields. */
  canType: boolean

  /** The provider can evaluate arbitrary JavaScript in the page context. */
  canEval: boolean

  /**
   * When `true`, agent-initiated actions require user approval before
   * execution.  Desktop browser is the primary example.
   */
  requiresApprovalForAgentAction: boolean

  /**
   * When `true`, the provider can deliver first-page snapshot in < 300 ms
   * (suitable for fast retrieval lanes like web_search / web_extract).
   */
  supportsFastHeadless: boolean
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Permission
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Outcome of a permission check for a (provider, action, actor) triple.
 *
 * - `allow`             — execute immediately.
 * - `deny`              — reject; return error to caller.
 * - `approval_required` — queue for user review; emit ActionProposal event.
 */
export type BrowserPermissionDecision = 'allow' | 'deny' | 'approval_required'

/**
 * A single permission rule.
 *
 * The wildcard `'*'` matches any value for that dimension.
 * Rules are evaluated in order; the first match wins.
 */
export interface BrowserPermissionPolicy {
  /** Provider id this rule applies to. `'*'` = all. */
  provider: BrowserProviderId | '*'

  /** Action kind this rule applies to. `'*'` = all. */
  action: BrowserActionKind['type'] | '*'

  /** Actor this rule applies to. `'*'` = all. */
  actor: BrowserActor | '*'

  /** The decision. */
  decision: BrowserPermissionDecision
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Provider descriptor (registration-time metadata)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Static metadata a provider publishes at registration time.
 *
 * The router uses this to select a provider for a given task context.
 * Capabilities are static (set at registration); availability is dynamic
 * (checked via `isAvailable()` at call time).
 */
export interface BrowserProviderDescriptor {
  /** Unique provider id. */
  id: BrowserProviderId

  /** Human-readable label. */
  displayName: string

  /** One-line description shown in config / tools picker. */
  description: string

  /** Static capabilities this provider advertises. */
  capabilities: BrowserCapability

  /**
   * Default permission policies for this provider.
   * Evaluated before any user-supplied override policies.
   */
  defaultPolicies: BrowserPermissionPolicy[]

  /** Whether this provider is a built-in (shipped with Hermes). */
  builtin: boolean
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. BrowserSnapshot
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Unified read-only page context snapshot.
 *
 * This is the single payload the Agent receives from any BrowserProvider.
 * The provider populates whichever fields its runtime supports; the Agent
 * treats `null` fields as "not available from this provider."
 */
export interface BrowserSnapshot {
  /** ISO 8601 timestamp of capture. */
  capturedAt: string

  /** Which provider produced this snapshot and how. */
  source: BrowserSnapshotSource

  /** Active page state. */
  activeTab: BrowserActiveTabContext

  /** DOM content extracted from the page. */
  dom: BrowserDomContent

  /** User-specific context (selection, clipboard). */
  userContext: BrowserUserContext

  /** Visual capture. */
  screenshot: BrowserScreenshotRef

  /** Browser console output — best effort, may be null. */
  console: BrowserConsoleSnapshot | null

  /** Size limits applied to this snapshot. */
  limits: BrowserSnapshotLimits

  /** Per-field capture errors (non-fatal). */
  errors: BrowserSnapshotError[]
}

export interface BrowserSnapshotSource {
  provider: BrowserProviderId
  /** Session identifier within the provider. */
  sessionKey: string
  /** Whether this provider is read-only or permits agent actions. */
  mode: 'read_only' | 'agent_action' | 'approval_required'
}

export interface BrowserActiveTabContext {
  /** Full URL. */
  url: string
  /** Document title. */
  title: string
  /** Whether the page is still loading. */
  isLoading: boolean
  /** Whether back-history exists. */
  canGoBack: boolean
  /** Whether forward-history exists. */
  canGoForward: boolean
  /** Who initiated navigation to the current page. */
  navigationSource: BrowserActor | null
}

export interface BrowserDomContent {
  /**
   * Structured accessibility tree text (ariaSnapshot).
   * Source: agent-browser "snapshot" command or CDP Accessibility.getFullAXTree.
   * Contains interactive @eN refs when the provider supports them.
   * Max 20 KB, clipped.
   */
  ariaSnapshot: string | null

  /**
   * Raw body text extract.
   * Source: document.body.innerText (Electron) or CDP Runtime.evaluate.
   * Max 10 KB, clipped.
   */
  bodyText: string | null

  /**
   * Meta description from <meta name="description">.
   */
  metaDescription: string | null

  /**
   * Top-level headings (h1-h3), up to 20.
   * Each heading text clipped to 200 chars.
   */
  headings: Array<{ tag: string; text: string }>
}

export interface BrowserUserContext {
  /**
   * User-selected text on the page.
   * Source: window.getSelection().toString().
   * Max 10 KB, clipped. Empty string if nothing selected
   * or provider doesn't support it (headless).
   */
  selectedText: string

  /**
   * System clipboard text preview.
   * Max 2 KB, clipped. Empty string if clipboard empty
   * or clipboard-read permission is off.
   */
  clipboardPreview: string
}

export interface BrowserScreenshotRef {
  /**
   * Reference to the captured screenshot.
   * May be a file path, data URI, or null.
   */
  ref: string | null
  width: number
  height: number
  sizeBytes: number
}

export interface BrowserConsoleSnapshot {
  /** Recent console messages (log/warn/error), up to 50. */
  messages: Array<{ level: string; text: string }>
  /** Recent uncaught JS exceptions, up to 20. */
  errors: Array<{ message: string }>
}

export interface BrowserSnapshotLimits {
  maxAriaSnapshotChars: number
  maxBodyTextChars: number
  maxSelectionChars: number
  maxClipboardChars: number
  maxTotalBytes: number
  actualTotalBytes: number
}

export interface BrowserSnapshotError {
  /** Which field had the error. */
  field: string
  /** Human-readable error message. */
  message: string
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. BrowserAction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Discriminated union of all browser actions.
 *
 * Mapped 1:1 from the existing `browser_tool.py` BROWSER_TOOL_SCHEMAS plus
 * explicit `eval` (currently hidden inside `browser_console`'s `expression`
 * parameter — see `hermes-agent/tools/browser_tool.py:2767`).
 */
export type BrowserActionKind =
  | NavigateAction
  | SnapshotAction
  | ClickAction
  | TypeAction
  | ScrollAction
  | BackAction
  | PressKeyAction
  | GetImagesAction
  | VisionAction
  | ConsoleAction
  | EvalAction

export interface NavigateAction {
  type: 'navigate'
  url: string
}

export interface SnapshotAction {
  type: 'snapshot'
  /** Full page content (true) or compact interactive elements only (false). */
  full?: boolean
}

export interface ClickAction {
  type: 'click'
  /** Element ref from aria snapshot (e.g. "@e5"). */
  ref: string
}

export interface TypeAction {
  type: 'type'
  ref: string
  text: string
}

export interface ScrollAction {
  type: 'scroll'
  direction: 'up' | 'down'
}

export interface BackAction {
  type: 'back'
}

export interface PressKeyAction {
  type: 'press_key'
  key: string
}

export interface GetImagesAction {
  type: 'get_images'
}

export interface VisionAction {
  type: 'vision'
  /** Natural-language question about the screenshot. */
  question: string
  /** Whether to overlay @eN annotations on the screenshot. */
  annotate?: boolean
}

export interface ConsoleAction {
  type: 'console'
  /** If true, clear message buffers after reading. */
  clear?: boolean
  /**
   * Optional JavaScript expression to evaluate in the page.
   * When absent, returns console log/warn/error messages.
   * When present, evaluates the expression and returns the result.
   */
  expression?: string
}

export interface EvalAction {
  type: 'eval'
  /** JavaScript expression to evaluate in the page context. */
  expression: string
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. BrowserActionRequest
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Unified action request from an actor to a BrowserProvider.
 */
export interface BrowserActionRequest {
  /** Unique request ID (generated by the caller). */
  requestId: string

  /** ISO 8601 timestamp. */
  requestedAt: string

  /** Which actor initiated this action. */
  actor: BrowserActor

  /** The task context this action belongs to. */
  taskId: string

  /** The action to perform. */
  action: BrowserActionKind

  /**
   * Why the actor is requesting this action.
   * Required for agent-initiated actions — shown in approval UI.
   */
  reason?: string

  /**
   * Target provider hint.
   * When set, the router prefers this provider.
   * When absent, the router selects based on capability and availability.
   */
  targetProvider?: BrowserProviderId

  /**
   * Safety context for user-visible providers (Desktop).
   * Populated at proposal time by the provider adapter.
   * Absent for headless/cloud providers.
   *
   * Phase 2D — contract only.  Not populated by any current code path.
   * @see docs/architecture/desktop-browser-agent-action-safety.md
   */
  safetyContext?: BrowserActionSafetyContext
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. BrowserActionResult
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Unified result from a BrowserActionRequest.
 */
export interface BrowserActionResult {
  /** Echoes the request ID. */
  requestId: string

  /** ISO 8601 timestamp of execution. */
  executedAt: string

  /** Which provider executed this action. */
  executedBy: {
    provider: BrowserProviderId
    sessionKey: string
  }

  /** Execution status. */
  status: BrowserActionResultStatus

  /**
   * If status is `pending_approval`, the action was queued for user
   * review.  The Agent should wait for a follow-up result with the
   * final status.
   */
  approvalId?: string

  /** Error details when status is `failed` or `denied`. */
  error?: string

  /**
   * Snapshot captured after the action completed.
   * Always present for navigate/click/type/scroll — a fresh page state
   * so the Agent doesn't need a separate snapshot call.
   */
  postActionSnapshot?: BrowserSnapshot

  /**
   * For eval/console(expression) actions: the return value.
   */
  evalResult?: unknown

  /**
   * For vision/screenshot actions: reference to the captured screenshot.
   */
  screenshotRef?: string

  /**
   * Pre-action verification snapshot + ref validation.
   * Populated for click/type actions on Desktop after user approval
   * and before execution.  Absent for headless/cloud providers.
   *
   * Phase 2D — contract only.
   * @see docs/architecture/desktop-browser-agent-action-safety.md §5.1
   */
  preActionVerification?: PreActionVerification

  /**
   * Whether a fallback provider was used
   * (e.g. Lightpanda → Chrome, or cloud → local).
   */
  fallback?: BrowserActionFallback
}

export type BrowserActionResultStatus =
  | 'executed'
  | 'denied'
  | 'failed'
  | 'pending_approval'

export interface BrowserActionFallback {
  /** Provider that was tried first. */
  from: BrowserProviderId
  /** Provider that actually executed the action. */
  to: BrowserProviderId
  /** Why the fallback was triggered. */
  reason: string
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Phase 2D — Desktop Agent Action Safety
// ═══════════════════════════════════════════════════════════════════════════
//
// @see docs/architecture/desktop-browser-agent-action-safety.md

/**
 * Conservative risk level for a proposed browser action.
 *
 * - `low`: click on a link, type into a search box.
 * - `medium`: click on a button, type into a form field.
 * - `high`: click on a submit/delete button, type into a payment/credential field.
 */
export type BrowserActionRiskLevel = 'low' | 'medium' | 'high'

/**
 * Element identity fingerprint captured from the live DOM at proposal time.
 *
 * Used at execution time to verify that the target element is still the
 * one the agent intended — if text or attributes have changed materially,
 * the executor returns `failed` with a diff.
 */
export interface ElementFingerprint {
  /** element.tagName at proposal time (e.g. "BUTTON", "INPUT"). */
  tagName: string
  /** element.textContent trimmed to 200 chars. */
  textContent: string
  /** element.id if present. */
  id: string | null
  /** element.getAttribute('name') if present. */
  name: string | null
  /** element.getAttribute('type') if present (meaningful for <input>). */
  inputType: string | null
  /** element.getAttribute('aria-label') if present. */
  ariaLabel: string | null
  /** element.getBoundingClientRect() at proposal time. */
  rect: { x: number; y: number; w: number; h: number }
}

/**
 * Safety context attached to a BrowserActionRequest by a user-visible
 * provider (Desktop) at proposal time.
 *
 * Carries enough information for the user to understand what the agent
 * wants to do, and for the executor to validate the target at execution
 * time.  Absent for headless/cloud providers.
 */
export interface BrowserActionSafetyContext {
  /** The page URL when the action was proposed. */
  originUrl: string

  /** The page title when the action was proposed. */
  originTitle: string

  /**
   * Human-readable description of the target element, resolved from
   * the ref at proposal time.
   *
   * Example (click):
   *   "button 'Submit PR' (tag: button, type: submit)
   *    near heading 'Create Pull Request'"
   *
   * Example (type):
   *   "input field 'Search' (tag: input, type: text,
   *    placeholder: 'Search...') inside form 'nav-search'"
   */
  targetDescription: string

  /**
   * The ref ID from the accessibility snapshot (e.g. "@e5").
   * Carried through for execution — the executor re-resolves it
   * against the live page.
   */
  targetRef: string

  /**
   * For `type` actions: the full text the agent wants to type.
   * Displayed verbatim in the approval UI.  Max 500 chars.
   */
  typeText?: string

  /**
   * Element identity fingerprint captured at proposal time.
   * Compared against the live DOM at execution time.
   */
  elementFingerprint?: ElementFingerprint

  /** Conservative risk level assigned at proposal time. */
  riskLevel: BrowserActionRiskLevel
}

/**
 * Captured IMMEDIATELY before executing a click/type action,
 * after user approval and before the IPC call.
 */
export interface PreActionVerification {
  /** ISO 8601 timestamp just before execution. */
  verifiedAt: string

  /** The page URL at execution time. */
  currentUrl: string

  /** Whether the target ref is still valid. */
  refValid: boolean

  /**
   * If refValid is false, why the ref was invalidated.
   *
   * - `"element_removed"` — element no longer in DOM
   * - `"text_changed"` — element text differs from fingerprint
   * - `"navigation"` — page URL changed since proposal
   * - `"page_unloaded"` — page is no longer the active tab
   */
  invalidationReason?: string

  /**
   * Current element fingerprint at execution time.
   * Compared against BrowserActionSafetyContext.elementFingerprint.
   */
  currentFingerprint?: ElementFingerprint

  /** Snapshot of the page before the action. */
  snapshot: BrowserSnapshot
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. Built-in provider capability presets
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Static capability presets for the canonical built-in providers.
 *
 * These are reference values — actual providers may differ at runtime if
 * the underlying engine or configuration changes.
 */
export const BUILTIN_CAPABILITIES = {
  'desktop-visible': {
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
  },

  'agent-headless': {
    visible: false,
    hasLoginState: false,
    canReadDom: true,
    canScreenshot: true,
    canNavigate: true,
    canClick: true,
    canType: true,
    canEval: true,
    requiresApprovalForAgentAction: false,
    supportsFastHeadless: false,
  },

  'cloud-browserbase': {
    visible: false,
    hasLoginState: false,
    canReadDom: true,
    canScreenshot: true,
    canNavigate: true,
    canClick: true,
    canType: true,
    canEval: true,
    requiresApprovalForAgentAction: false,
    supportsFastHeadless: false,
  },

  'cloud-browser-use': {
    visible: false,
    hasLoginState: false,
    canReadDom: true,
    canScreenshot: true,
    canNavigate: true,
    canClick: true,
    canType: true,
    canEval: true,
    requiresApprovalForAgentAction: false,
    supportsFastHeadless: false,
  },

  'cloud-firecrawl': {
    visible: false,
    hasLoginState: false,
    canReadDom: true,
    canScreenshot: true,
    canNavigate: true,
    canClick: true,
    canType: true,
    canEval: true,
    requiresApprovalForAgentAction: false,
    supportsFastHeadless: false,
  },

  obscura: {
    visible: false,
    hasLoginState: false,
    canReadDom: true,
    canScreenshot: false,
    canNavigate: true,
    canClick: false,
    canType: false,
    canEval: false,
    requiresApprovalForAgentAction: false,
    supportsFastHeadless: true,
  },
} as const satisfies Record<string, BrowserCapability>

/**
 * Returns true when the provider is known to be an interactive surface —
 * i.e. it supports click/type and does NOT require user approval per action.
 * Useful as a heuristic in the router for action-routing decisions.
 */
export function isInteractiveProvider(capabilities: BrowserCapability): boolean {
  return capabilities.canClick && capabilities.canType && !capabilities.requiresApprovalForAgentAction
}

/**
 * Returns true when the provider is a fast retrieval lane — suitable for
 * web_search / web_extract style queries where first-snapshot latency
 * matters more than interactivity.
 */
export function isFastRetrievalProvider(capabilities: BrowserCapability): boolean {
  return capabilities.supportsFastHeadless && capabilities.canReadDom
}
