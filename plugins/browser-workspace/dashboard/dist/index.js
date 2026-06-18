/**
 * Hermes Browser Workspace — Dashboard Plugin (Phase 5B)
 *
 * Host controls + Snapshot + Screenshot + Context extraction.
 * Single BrowserContextSnapshot schema for both /snapshot and /context.
 *
 * Phase 4B: lightweight browserContextRef generation + metadata tracking.
 * Phase 5A: plugin context display + GitHub PR info in prompt block.
 * Phase 5B: ChatGPT conversation detection + prompt block integration.
 *
 * Plain IIFE. Uses window.__HERMES_PLUGIN_SDK__.
 */
(function () {
  "use strict";

  var SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;

  var React = SDK.React;
  var h = React.createElement;
  var useState = SDK.hooks.useState;
  var useEffect = SDK.hooks.useEffect;
  var useCallback = SDK.hooks.useCallback;
  var fetchJSON = SDK.fetchJSON;
  var Card = SDK.components.Card;
  var CardContent = SDK.components.CardContent;
  var Badge = SDK.components.Badge;
  var Button = SDK.components.Button;
  var Separator = SDK.components.Separator;

  // ── Helpers ───────────────────────────────────────────────────────

  function toneForStatus(status) {
    if (status === "running") return "success";
    if (status === "error") return "destructive";
    return "outline";
  }

  function labelForStatus(status) {
    if (status === "running") return "Running";
    if (status === "stopped") return "Stopped";
    if (status === "error") return "Error";
    return status;
  }

  function InfoRow(props) {
    return h("div", { className: "flex items-center justify-between gap-3 py-1" },
      h("span", { className: "text-xs text-muted-foreground" }, props.label),
      h("span", { className: "text-xs font-mono truncate max-w-[300px]" }, props.value || "(none)")
    );
  }

  // ── Prompt block formatting (Phase 4B) ──────────────────────────

  function makeShortId() {
    return Math.random().toString(36).slice(2, 8);
  }

  function generateContextRef(ctx) {
    var at = ctx.activeTab || {};
    return {
      id: "browserctx_" + (ctx.capturedAt || Date.now().toString()) + "_" + makeShortId(),
      capturedAt: ctx.capturedAt || new Date().toISOString(),
      url: at.url || "",
      title: at.title || "",
      pageType: at.pageType || "generic-web",
      source: "browser-workspace"
    };
  }

  function truncateText(value, limit) {
    if (!value || typeof value !== "string") return "(none)";
    if (value.length <= limit) return value;
    return value.substring(0, limit) + "... [truncated]";
  }

  function formatContextBlock(ctx, ref) {
    var at = ctx.activeTab || {};
    var refLine = ref && ref.id ? "Browser Context Ref: " + ref.id + "\n" : "";
    var block = "[Browser Workspace Context]\n" +
      refLine +
      "URL: " + (at.url || "(unknown)") + "\n" +
      "Title: " + (at.title || "(unknown)") + "\n" +
      "Page Type: " + (at.pageType || "generic-web") + "\n";

    // Phase 5A: include GitHub PR info from pluginContext
    var pc = ctx.pluginContext;
    if (pc && pc.pluginId === "github-pr" && pc.matched && pc.githubPullRequest) {
      var gpr = pc.githubPullRequest;
      block += "\nGitHub PR:\n" +
        "- " + gpr.owner + "/" + gpr.repo + "#" + gpr.number + "\n" +
        "- Title: " + (gpr.title || at.title) + "\n" +
        "- URL: " + (gpr.url || at.url) + "\n";
    }

    // Phase 5B: include ChatGPT conversation info from pluginContext
    if (pc && pc.pluginId === "chatgpt-conversation" && pc.matched && pc.chatgptConversation) {
      var cc = pc.chatgptConversation;
      block += "\nChatGPT Conversation:\n" +
        "- Title: " + (cc.title || at.title) + "\n" +
        (cc.conversationId ? "- Conversation ID: " + cc.conversationId + "\n" : "") +
        "- URL: " + (cc.url || at.url) + "\n";
    }

    block += "Selected Text:\n" + truncateText(at.selectedText, 1500) + "\n\n" +
      "Clipboard Preview:\n" + truncateText(at.clipboardTextPreview, 1000) + "\n\n" +
      "Page Summary:\n" + truncateText(at.domSummary, 3000) + "\n\n" +
      "Source: Hermes Browser Workspace\n" +
      "Captured At: " + (ctx.capturedAt || "(unknown)") + "\n" +
      "[/Browser Workspace Context]";
    return block;
  }

  //
  // Returns "chat" | "clipboard" | null.
  //   "chat"      — inserted into ChatPage composer via term.paste()
  //   "clipboard" — ChatPage not available, block copied to clipboard
  //   null        — clipboard API unavailable (explicit error)
  //
  function insertToChat(ctx, ref) {
    var block = "\n" + formatContextBlock(ctx, ref) + "\n";
    // Phase 4B: notify ChatPage of the lightweight browser context ref
    if (ref && typeof window.__HERMES_SET_BROWSER_CONTEXT_REF__ === "function") {
      window.__HERMES_SET_BROWSER_CONTEXT_REF__(ref);
    }
    if (typeof window.__HERMES_INSERT_CHAT_TEXT__ === "function") {
      window.__HERMES_INSERT_CHAT_TEXT__(block);
      return "chat";
    }
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(block).catch(function () {
        // Silently ignore clipboard write rejection — the caller already
        // returned "clipboard" so the UI message is correct regardless.
      });
      return "clipboard";
    }
    return null;
  }

  // ── Main component ───────────────────────────────────────────────

  function BrowserWorkspacePage() {
    var hostState = useState(null);
    var host = hostState[0];
    var setHost = hostState[1];

    var snapState = useState(null);
    var snapshot = snapState[0];
    var setSnapshot = snapState[1];

    var screenshotState = useState(null);
    var screenshot = screenshotState[0];
    var setScreenshot = screenshotState[1];

    var ctxState = useState(null);
    var context = ctxState[0];
    var setContext = ctxState[1];

    var loading = useState(false);
    var busy = loading[0];
    var setBusy = loading[1];

    var msg = useState("");
    var message = msg[0];
    var setMessage = msg[1];

    var lastRefState = useState(null);
    var lastInsertedRef = lastRefState[0];
    var setLastInsertedRef = lastRefState[1];

    var fetchStatus = useCallback(function () {
      setBusy(true);
      fetchJSON("/api/browser-host/status")
        .then(function (d) { setHost(d); })
        .catch(function (e) { setHost({ status: "error", lastError: String(e), pid: null, port: null, healthUrl: null, health: null }); })
        .finally(function () { setBusy(false); });
    }, []);

    var doStart = useCallback(function () {
      setBusy(true);
      setMessage("");
      fetchJSON("/api/browser-host/start", { method: "POST" })
        .then(function (d) { setHost(d); setMessage(d.status === "running" ? "Host started" : "Start: " + (d.lastError || d.status)); })
        .catch(function (e) { setMessage("Start failed: " + String(e)); })
        .finally(function () { setBusy(false); });
    }, []);

    var doStop = useCallback(function () {
      setBusy(true);
      setMessage("");
      fetchJSON("/api/browser-host/stop", { method: "POST" })
        .then(function (d) { setHost(d); setMessage(d.status === "stopped" ? "Host stopped" : "Stop: " + (d.lastError || d.status)); })
        .catch(function (e) { setMessage("Stop failed: " + String(e)); })
        .finally(function () { setBusy(false); });
    }, []);

    var fetchSnapshot = useCallback(function () {
      setBusy(true);
      setMessage("");
      fetchJSON("/api/browser-host/snapshot")
        .then(function (d) {
          setSnapshot(d);
          setMessage("Snapshot refreshed");
        })
        .catch(function (e) {
          setSnapshot({ error: String(e) });
          setMessage("Snapshot failed: " + String(e));
        })
        .finally(function () { setBusy(false); });
    }, []);

    var captureScreenshot = useCallback(function () {
      setBusy(true);
      setMessage("");
      fetchJSON("/api/browser-host/screenshot")
        .then(function (d) {
          if (d.error) { setMessage("Screenshot: " + d.error); setScreenshot(null); }
          else { setScreenshot(d); setMessage("Screenshot captured (" + (d.sizeBytes || 0) + " bytes)"); }
        })
        .catch(function (e) {
          setMessage("Screenshot failed: " + String(e));
        })
        .finally(function () { setBusy(false); });
    }, []);

    var fetchContext = useCallback(function () {
      setBusy(true);
      setMessage("");
      fetchJSON("/api/browser-host/context")
        .then(function (d) {
          setContext(d);
          setMessage("Context refreshed");
        })
        .catch(function (e) {
          setContext({ error: String(e) });
          setMessage("Context failed: " + String(e));
        })
        .finally(function () { setBusy(false); });
    }, []);

    useEffect(function () {
      fetchStatus();
      var interval = setInterval(fetchStatus, 15000);
      return function () { clearInterval(interval); };
    }, [fetchStatus]);

    var status = host ? host.status : "unknown";
    var isRunning = status === "running";
    var tab = snapshot && snapshot.activeTab ? snapshot.activeTab : null;

    return h("div", { className: "p-6 max-w-2xl space-y-4" },

      // Header
      h("div", { className: "flex items-center gap-3" },
        h("h1", { className: "text-2xl font-semibold tracking-tight" }, "Browser Workspace"),
        h(Badge, { tone: "secondary", className: "text-xs" }, "Phase 5B")
      ),

      // Message
      message ? h("div", { className: "rounded-md bg-muted px-3 py-2" },
        h("p", { className: "text-xs" }, message)
      ) : null,

      // ── Host controls ────────────────────────────────────────────
      h(Card, null,
        h(CardContent, { className: "pt-6 space-y-4" },

          h("div", { className: "flex items-center justify-between" },
            h("span", { className: "text-sm font-medium" }, "Browser Host"),
            h("div", { className: "flex items-center gap-2" },
              h("span", { className: "inline-block w-2 h-2 rounded-full", style: { background: isRunning ? "#4caf50" : status === "error" ? "#e94560" : "#888" } }),
              h(Badge, { tone: toneForStatus(status), className: "text-xs" }, labelForStatus(status))
            )
          ),

          h(Separator),

          h("div", { className: "space-y-1" },
            h(InfoRow, { label: "PID", value: host && host.pid != null ? String(host.pid) : "—" }),
            h(InfoRow, { label: "Port", value: host && host.port != null ? String(host.port) : "—" })
          ),

          host && host.lastError ? h("div", { className: "rounded-md bg-destructive/10 px-3 py-2" },
            h("p", { className: "text-xs text-destructive font-mono" }, host.lastError)
          ) : null,

          h("div", { className: "flex items-center gap-2" },
            h(Button, { variant: "outline", size: "sm", disabled: busy, onClick: fetchStatus }, "Refresh Status"),
            isRunning
              ? h(Button, { variant: "destructive", size: "sm", disabled: busy, onClick: doStop }, "Stop")
              : h(Button, { variant: "default", size: "sm", disabled: busy, onClick: doStart }, "Start")
          )
        )
      ),

      // ── Snapshot ──────────────────────────────────────────────────
      isRunning ? h(Card, null,
        h(CardContent, { className: "pt-6 space-y-3" },
          h("div", { className: "flex items-center justify-between" },
            h("span", { className: "text-sm font-medium" }, "Snapshot"),
            h(Button, { variant: "outline", size: "sm", disabled: busy, onClick: fetchSnapshot }, "Refresh Snapshot")
          ),
          h(Separator),
          snapshot && snapshot.error ? h("div", { className: "rounded-md bg-destructive/10 px-3 py-2" },
            h("p", { className: "text-xs text-destructive" }, snapshot.error)
          ) : null,
          h("div", { className: "space-y-1" },
            h(InfoRow, { label: "URL", value: tab ? tab.url : "—" }),
            h(InfoRow, { label: "Title", value: tab ? tab.title : "—" }),
            h(InfoRow, { label: "Loading", value: tab ? String(!!tab.isLoading) : "—" }),
            h(InfoRow, { label: "Can go back", value: tab ? String(!!tab.canGoBack) : "—" }),
            h(InfoRow, { label: "Tabs", value: snapshot && snapshot.tabs ? String(snapshot.tabs.length) : "—" }),
            h(InfoRow, { label: "Captured at", value: snapshot && snapshot.capturedAt ? snapshot.capturedAt : "—" })
          )
        )
      ) : null,

      // ── Screenshot ────────────────────────────────────────────────
      isRunning ? h(Card, null,
        h(CardContent, { className: "pt-6 space-y-3" },
          h("div", { className: "flex items-center justify-between" },
            h("span", { className: "text-sm font-medium" }, "Screenshot"),
            h(Button, { variant: "outline", size: "sm", disabled: busy, onClick: captureScreenshot }, "Capture Screenshot")
          ),
          h(Separator),
          screenshot && screenshot.dataUri ? h("div", { className: "flex justify-center" },
            h("img", { src: screenshot.dataUri, style: { maxWidth: "100%", maxHeight: "300px", border: "1px solid #333", borderRadius: "6px" } })
          ) : h("p", { className: "text-xs text-muted-foreground" }, "No screenshot captured yet.")
        )
      ) : null,

      // ── Context ──────────────────────────────────────────────────
      isRunning ? h(Card, null,
        h(CardContent, { className: "pt-6 space-y-3" },
          h("div", { className: "flex items-center justify-between" },
            h("span", { className: "text-sm font-medium" }, "Context"),
            h(Button, { variant: "outline", size: "sm", disabled: busy, onClick: fetchContext }, "Refresh Context")
          ),
          h(Separator),
          context && context.error ? h("div", { className: "rounded-md bg-destructive/10 px-3 py-2" },
            h("p", { className: "text-xs text-destructive" }, context.error)
          ) : null,
          h("div", { className: "space-y-2" },
            h("div", null,
              h("div", { className: "text-xs font-medium mb-1" }, "DOM Summary"),
              h("div", { className: "text-xs text-muted-foreground bg-muted rounded p-2 max-h-24 overflow-y-auto font-mono whitespace-pre-wrap break-all" },
                context && context.activeTab && context.activeTab.domSummary
                  ? context.activeTab.domSummary.substring(0, 500) + (context.activeTab.domSummary.length > 500 ? "..." : "")
                  : "(empty)")),
            h("div", null,
              h("div", { className: "text-xs font-medium mb-1" }, "Selected Text"),
              h("div", { className: "text-xs text-muted-foreground bg-muted rounded p-2 max-h-16 overflow-y-auto font-mono whitespace-pre-wrap break-all" },
                context && context.activeTab && context.activeTab.selectedText
                  ? context.activeTab.selectedText.substring(0, 300) + (context.activeTab.selectedText.length > 300 ? "..." : "")
                  : "(none selected)")),
            h("div", null,
              h("div", { className: "text-xs font-medium mb-1" }, "Clipboard Preview"),
              h("div", { className: "text-xs text-muted-foreground bg-muted rounded p-2 max-h-16 overflow-y-auto font-mono whitespace-pre-wrap break-all" },
                context && context.activeTab && context.activeTab.clipboardTextPreview
                  ? context.activeTab.clipboardTextPreview.substring(0, 200) + (context.activeTab.clipboardTextPreview.length > 200 ? "..." : "")
                  : "(empty / disabled)")),
            h("div", null,
              h(InfoRow, { label: "Recent Events", value: context && context.recentEvents ? String(context.recentEvents.length) : "—" })),
            h("div", null,
              h(InfoRow, { label: "Captured at", value: context && context.capturedAt ? context.capturedAt : "—" })),
            h("div", null,
              h(InfoRow, { label: "Page Type", value: context && context.activeTab ? context.activeTab.pageType || "generic-web" : "—" })),
            // Phase 5A: plugin context
            context && context.pluginContext && context.pluginContext.matched ? h("div", null,
              h("div", { className: "text-xs font-medium mb-1" }, "Plugin: " + context.pluginContext.pluginId),
              context.pluginContext.pluginId === "github-pr" && context.pluginContext.githubPullRequest
                ? h("div", { className: "text-xs text-muted-foreground bg-muted rounded p-2 space-y-1 font-mono" },
                    h("div", null, context.pluginContext.githubPullRequest.owner + "/" + context.pluginContext.githubPullRequest.repo + "#" + context.pluginContext.githubPullRequest.number),
                    h("div", null, context.pluginContext.githubPullRequest.title || "(no title)")
                  )
                : context.pluginContext.pluginId === "chatgpt-conversation" && context.pluginContext.chatgptConversation
                ? h("div", { className: "text-xs text-muted-foreground bg-muted rounded p-2 space-y-1 font-mono" },
                    h("div", null, context.pluginContext.chatgptConversation.title || "(no title)"),
                    context.pluginContext.chatgptConversation.conversationId
                      ? h("div", null, "ID: " + context.pluginContext.chatgptConversation.conversationId)
                      : null,
                    h("div", null, context.pluginContext.chatgptConversation.url || "")
                  )
                : null
            ) : h("div", null,
              context && context.pluginContext
                ? h("div", { className: "text-xs font-medium mb-1" }, "Plugin: " + context.pluginContext.pluginId + " (not matched)")
                : null
            )
          ),

          h(Separator),

          // Insert button — inserts bounded context block into chat composer
          h("div", { className: "flex flex-col gap-2" },
            h(Button, {
              variant: "default",
              size: "sm",
              disabled: busy,
              onClick: function () {
                function doInsert(ctxData) {
                  var ref = generateContextRef(ctxData);
                  setLastInsertedRef(ref);
                  var result = insertToChat(ctxData, ref);
                  if (result === "chat") {
                    setMessage("Inserted context ref: " + ref.id);
                  } else if (result === "clipboard") {
                    setMessage("Chat not available \u2014 context copied to clipboard (ref: " + ref.id + ")");
                  } else {
                    setMessage("Chat not available and clipboard access denied");
                  }
                }
                if (context) {
                  doInsert(context);
                } else {
                  setBusy(true);
                  setMessage("");
                  fetchJSON("/api/browser-host/context")
                    .then(function (d) {
                      setContext(d);
                      doInsert(d);
                    })
                    .catch(function (e) {
                      setContext({ error: String(e) });
                      setMessage("Context fetch failed: " + String(e));
                    })
                    .finally(function () { setBusy(false); });
                }
              }
            }, "Insert Current Page Context"),
            h("p", { className: "text-[0.65rem] text-muted-foreground" },
              "Inserts a bounded context block into the chat composer. Falls back to clipboard if chat is unavailable. Does not auto-send or create a run.")
          )
        )
      ) : null,

      // ── Last inserted context ref (Phase 4B) ─────────────────────
      lastInsertedRef ? h(Card, null,
        h(CardContent, { className: "pt-6 space-y-2" },
          h("div", { className: "flex items-center justify-between" },
            h("span", { className: "text-sm font-medium" }, "Last Browser Context Ref"),
            h(Badge, { tone: "success", className: "text-xs" }, lastInsertedRef.id)
          ),
          h(Separator),
          h(InfoRow, { label: "URL", value: lastInsertedRef.url }),
          h(InfoRow, { label: "Title", value: lastInsertedRef.title }),
          h(InfoRow, { label: "Captured at", value: lastInsertedRef.capturedAt }),
          h("p", { className: "text-[0.65rem] text-muted-foreground pt-1" },
            "Only lightweight metadata retained. Full DOM, selection, and clipboard text are not stored."
          )
        )
      ) : null,

      // ── Feature status ───────────────────────────────────────────
      h(Card, null,
        h(CardContent, { className: "pt-6 space-y-1" },
          h("div", { className: "flex items-center justify-between py-1" },
            h("span", { className: "text-sm text-muted-foreground" }, "Provider"),
            h(Badge, { tone: "outline", className: "text-xs" }, "read-only host API")
          ),
          h("div", { className: "flex items-center justify-between py-1" },
            h("span", { className: "text-sm text-muted-foreground" }, "Agent browser actions"),
            h(Badge, { tone: "outline", className: "text-xs" }, "off")
          ),
          h("div", { className: "flex items-center justify-between py-1" },
            h("span", { className: "text-sm text-muted-foreground" }, "DOM / selected text / clipboard"),
            h(Badge, { tone: "success", className: "text-xs" }, "available")
          ),
          h("div", { className: "flex items-center justify-between py-1" },
            h("span", { className: "text-sm text-muted-foreground" }, "Plugin detection (GH PR + ChatGPT)"),
            h(Badge, { tone: "success", className: "text-xs" }, "Phase 5B")
          )
        )
      ),

      // Notice
      h("div", { className: "rounded-md bg-muted px-4 py-3" },
        h("p", { className: "text-xs text-muted-foreground" },
          "Phase 5B \u2014 Hermes-native plugins: GitHub PR + ChatGPT conversation detection. ",
          "Detects github.com pull requests and chatgpt.com/chat.openai.com conversations via URL parsing. ",
          "No API calls. No click/type/submit. ",
          "Prompt block includes plugin-specific info when available."
        )
      )
    );
  }

  window.__HERMES_PLUGINS__.register("browser-workspace", BrowserWorkspacePage);
})();
