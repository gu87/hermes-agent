/**
 * Hermes Browser Host — Shared schema (Phase 5A)
 *
 * Single BrowserContextSnapshot contract used by both /snapshot and /context.
 * /snapshot returns the same shape with domSummary/selectedText/clipboardTextPreview
 * as empty strings. /context fills them via read-only extraction.
 *
 * No Agent actions. No user-provided JavaScript execution.
 */

/** Event logged during the browser host session. */
export interface BrowserEvent {
  ts: string;
  type: string;
  tabId?: string;
  url?: string;
  title?: string;
  [key: string]: unknown;
}

/** A single browser tab. */
export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

/** The currently-focused tab with extended fields. */
export interface ActiveTab {
  id: string;
  url: string;
  title: string;
  pageType: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  screenshotRef: string | null;
  domSummary: string;
  selectedText: string;
  clipboardTextPreview: string;
}

/** Host-set permission flags for each context dimension. */
export interface Permissions {
  screenshot: "available" | "unavailable";
  clipboard: "available" | "unavailable";
  dom: "available" | "unavailable";
  selection: "available" | "unavailable";
}

/** Character limits enforced by the host. */
export interface Limits {
  domSummaryChars: 3000;
  selectedTextChars: 3000;
  clipboardPreviewChars: 1000;
}

/** Hermes-native plugin detection result. */
export interface PluginContext {
  pluginId: string;
  matched: boolean;
  [key: string]: unknown;
}

/** Stable BrowserContextSnapshot contract. */
export interface BrowserContextSnapshot {
  capturedAt: string;
  source: {
    provider: "browser-host";
    mode: "read-only";
    version: "phase-5a";
  };
  profileId: string;
  activeTab: ActiveTab;
  tabs: BrowserTab[];
  recentEvents: BrowserEvent[];
  permissions: Permissions;
  limits: Limits;
  pluginContext: PluginContext | null;
}

/** Build a BrowserContextSnapshot from raw data. */
export function buildSnapshot(params: {
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  domSummary: string;
  selectedText: string;
  clipboardTextPreview: string;
  recentEvents: BrowserEvent[];
  pageType?: string;
  pluginContext?: PluginContext | null;
}): BrowserContextSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    source: {
      provider: "browser-host",
      mode: "read-only",
      version: "phase-5a",
    },
    profileId: "default",
    activeTab: {
      id: "main",
      url: params.url,
      title: params.title,
      pageType: params.pageType || "generic-web",
      isLoading: params.isLoading,
      canGoBack: params.canGoBack,
      canGoForward: params.canGoForward,
      screenshotRef: null,
      domSummary: params.domSummary,
      selectedText: params.selectedText,
      clipboardTextPreview: params.clipboardTextPreview,
    },
    tabs: [
      {
        id: "main",
        url: params.url,
        title: params.title,
        active: true,
      },
    ],
    recentEvents: params.recentEvents.slice(-20),
    permissions: {
      screenshot: "available",
      clipboard: "available",
      dom: "available",
      selection: "available",
    },
    limits: {
      domSummaryChars: 3000,
      selectedTextChars: 3000,
      clipboardPreviewChars: 1000,
    },
    pluginContext: params.pluginContext ?? null,
  };
}
