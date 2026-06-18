/**
 * ChatSidebar — structured-events panel that sits next to the xterm.js
 * terminal in the dashboard Chat tab.
 *
 * Two WebSockets, one per concern:
 *
 *   1. **JSON-RPC sidecar** (`GatewayClient` → /api/ws) — drives the
 *      sidebar's own slot of the dashboard's in-process gateway.  Owns
 *      the model badge / picker / connection state / error banner.
 *      Independent of the PTY pane's session by design — those are the
 *      pieces the sidebar needs to be able to drive directly (model
 *      switch via slash.exec, etc.).
 *
 *   2. **Event subscriber** (/api/events?channel=…) — passive, receives
 *      every dispatcher emit from the PTY-side `tui_gateway.entry` that
 *      the dashboard fanned out.  This is how `tool.start/progress/
 *      complete` from the agent loop reach the sidebar even though the
 *      PTY child runs three processes deep from us.  The `channel` id
 *      ties this listener to the same chat tab's PTY child — see
 *      `ChatPage.tsx` for where the id is generated.
 *
 * Best-effort throughout: WS failures show in the badge / banner, the
 * terminal pane keeps working unimpaired.
 */

import { Button } from "@nous-research/ui/ui/components/button";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Card } from "@/components/ui/card";

import { ModelPickerDialog } from "@/components/ModelPickerDialog";
import { ToolCall, type ToolEntry } from "@/components/ToolCall";
import { GatewayClient, type ConnectionState } from "@/lib/gatewayClient";

import { cn } from "@/lib/utils";
import { AlertCircle, Check, ChevronDown, ChevronLeft, FileText, RefreshCw, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface SessionInfo {
  cwd?: string;
  model?: string;
  provider?: string;
  credential_warning?: string;
}

interface RpcEnvelope {
  method?: string;
  params?: { type?: string; payload?: unknown };
}

const TOOL_LIMIT = 20;

const STATE_LABEL: Record<ConnectionState, string> = {
  idle: "idle",
  connecting: "connecting",
  open: "live",
  closed: "closed",
  error: "error",
};

const STATE_TONE: Record<
  ConnectionState,
  "secondary" | "warning" | "success" | "destructive"
> = {
  idle: "secondary",
  connecting: "warning",
  open: "success",
  closed: "secondary",
  error: "destructive",
};

/* ── Structured preview parser ──────────────────────────────────── */

interface StructuredPreview {
  unified_diff?: string;
  files?: string[];
  review_findings?: { file?: string; line?: number; severity?: string; message: string }[];
  review_summary?: string;
  qa_passed?: number;
  qa_failed?: number;
  qa_checks?: { name: string; passed: boolean; detail?: string }[];
  qa_summary?: string;
  artifact_title?: string;
  artifact_path?: string;
  artifact_url?: string;
  artifact_content?: string;
  artifact_preview?: string;
  raw?: unknown;
}

/** Best-effort: resolve an artifact sub-object from one of several common
 *  nesting patterns in JSON tool summaries. */
function resolveArtifactObject(
  obj: Record<string, unknown>,
): Record<string, unknown> | null {
  // Direct flat shape: { title, path, url, content, preview }
  if (
    typeof obj.title === "string" ||
    typeof obj.path === "string" ||
    typeof obj.url === "string" ||
    typeof obj.content === "string"
  ) {
    return obj;
  }
  // { artifact: { title, ... } }
  if (obj.artifact && typeof obj.artifact === "object") {
    return obj.artifact as Record<string, unknown>;
  }
  // { result: { artifact: { title, ... } } }
  if (obj.result && typeof obj.result === "object") {
    const r = obj.result as Record<string, unknown>;
    if (r.artifact && typeof r.artifact === "object") {
      return r.artifact as Record<string, unknown>;
    }
  }
  // { artifacts: [{ title, ... }] }
  if (Array.isArray(obj.artifacts) && obj.artifacts.length > 0) {
    const first = obj.artifacts[0];
    if (first && typeof first === "object") return first as Record<string, unknown>;
  }
  // { result: { artifacts: [{ title, ... }] } }
  if (obj.result && typeof obj.result === "object") {
    const r = obj.result as Record<string, unknown>;
    if (Array.isArray(r.artifacts) && r.artifacts.length > 0) {
      const first = r.artifacts[0];
      if (first && typeof first === "object") return first as Record<string, unknown>;
    }
  }
  return null;
}

/** Best-effort parse of a tool's summary/fields into structured sections.
 *  Returns null when nothing structured was recognized — the caller falls
 *  back to the existing generic render. */
function parseStructuredPreview(tool: ToolEntry): StructuredPreview | null {
  if (tool.error) return null; // errors take priority, skip structured parse

  const parsed: StructuredPreview = {};

  // 1. inline_diff → unified_diff + files
  if (tool.inline_diff) {
    parsed.unified_diff = tool.inline_diff;
    // Extract file names from diff headers (--- a/... / +++ b/...)
    const fileSet = new Set<string>();
    for (const m of tool.inline_diff.matchAll(/^[-+]{3} [ab]\/(.+)$/gm)) {
      fileSet.add(m[1]);
    }
    const files = [...fileSet];
    if (files.length > 0) parsed.files = files;
  }

  // 2. Try JSON parse on summary
  if (tool.summary) {
    try {
      const obj = JSON.parse(tool.summary);
      if (obj && typeof obj === "object") {
        parsed.raw = obj;

        // Review result shape: { findings, summary, ... }
        if (Array.isArray(obj.findings)) {
          parsed.review_findings = obj.findings.map(
            (f: Record<string, unknown>) => ({
              file: typeof f.file === "string" ? f.file : undefined,
              line: typeof f.line === "number" ? f.line : undefined,
              severity: typeof f.severity === "string" ? f.severity : undefined,
              message:
                typeof f.message === "string"
                  ? f.message
                  : JSON.stringify(f),
            }),
          );
        }
        if (typeof obj.summary === "string") parsed.review_summary = obj.summary;
        if (typeof obj.note === "string" && !parsed.review_summary)
          parsed.review_summary = obj.note;

        // QA result shape: { test_passed, test_failed, checks, ... }
        if (typeof obj.test_passed === "number")
          parsed.qa_passed = obj.test_passed;
        if (typeof obj.test_failed === "number")
          parsed.qa_failed = obj.test_failed;
        if (typeof obj.test_skipped === "number")
          parsed.qa_passed = (parsed.qa_passed ?? 0) + obj.test_skipped;
        if (Array.isArray(obj.checks)) {
          parsed.qa_checks = obj.checks.map(
            (c: Record<string, unknown>) => ({
              name: typeof c.name === "string" ? c.name : String(c.name ?? "?"),
              passed: c.passed !== false,
              detail: typeof c.detail === "string" ? c.detail : undefined,
            }),
          );
        }
        if (typeof obj.note === "string" && !parsed.qa_summary)
          parsed.qa_summary = obj.note;

        // Artifact shape — try multiple common nesting patterns:
        //   { title, path, url, content, preview }
        //   { artifact: { title, path, ... } }
        //   { artifacts: [{ title, path, ... }] }
        const artifactObj = resolveArtifactObject(obj);
        if (artifactObj) {
          if (typeof artifactObj.title === "string")
            parsed.artifact_title = artifactObj.title;
          if (typeof artifactObj.path === "string")
            parsed.artifact_path = artifactObj.path;
          if (typeof artifactObj.url === "string")
            parsed.artifact_url = artifactObj.url;
          if (typeof artifactObj.content === "string")
            parsed.artifact_content = artifactObj.content;
          if (typeof artifactObj.preview === "string")
            parsed.artifact_preview = artifactObj.preview;
        }

        // Nested diff fields in JSON
        if (!parsed.unified_diff && typeof obj.unified_diff === "string") {
          parsed.unified_diff = obj.unified_diff;
        }
        if (!parsed.files && Array.isArray(obj.files)) {
          parsed.files = obj.files.map((f: unknown) => String(f));
        }
      }
    } catch {
      // Not JSON — summary is plain text, no structured parse
    }
  }

  // Determine if we found anything structured
  const hasStructured =
    parsed.unified_diff ||
    parsed.files ||
    parsed.review_findings ||
    parsed.review_summary ||
    parsed.qa_passed !== undefined ||
    parsed.qa_checks ||
    parsed.qa_summary ||
    parsed.artifact_title ||
    parsed.artifact_path ||
    parsed.artifact_url ||
    parsed.artifact_content ||
    parsed.artifact_preview;

  return hasStructured ? parsed : null;
}

/* ── Component ───────────────────────────────────────────────────── */

interface ChatSidebarProps {
  channel: string;
  taskId?: string;
  className?: string;
}

export function ChatSidebar({ channel, taskId, className }: ChatSidebarProps) {
  // `version` bumps on reconnect; gw is derived so we never call setState
  // for it inside an effect (React 19's set-state-in-effect rule). The
  // counter is the dependency on purpose — it's not read in the memo body,
  // it's the signal that says "rebuild the client".
  const [version, setVersion] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const gw = useMemo(() => new GatewayClient(), [version]);

  const [state, setState] = useState<ConnectionState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [info, setInfo] = useState<SessionInfo>({});
  const [tools, setTools] = useState<ToolEntry[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const offState = gw.onState(setState);

    const offSessionInfo = gw.on<SessionInfo>("session.info", (ev) => {
      if (ev.session_id) {
        setSessionId(ev.session_id);
      }

      if (ev.payload) {
        setInfo((prev) => ({ ...prev, ...ev.payload }));
      }
    });

    const offError = gw.on<{ message?: string }>("error", (ev) => {
      const message = ev.payload?.message;

      if (message) {
        setError(message);
      }
    });

    // Adopt whichever session the gateway hands us. session.create on the
    // sidecar is independent of the PTY pane's session by design — we
    // only need a sid to drive the model picker's slash.exec calls.
    gw.connect()
      .then(() => {
        if (cancelled) {
          return;
        }
        return gw.request<{ session_id: string }>("session.create", {});
      })
      .then((created) => {
        if (cancelled || !created?.session_id) {
          return;
        }
        setSessionId(created.session_id);
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message);
        }
      });

    return () => {
      cancelled = true;
      offState();
      offSessionInfo();
      offError();
      gw.close();
    };
  }, [gw]);

  // Event subscriber WebSocket — receives the rebroadcast of every
  // dispatcher emit from the PTY child's gateway.  See /api/pub +
  // /api/events in hermes_cli/web_server.py for the broadcast hop.
  //
  // Failures (auth/loopback rejection, server too old to expose the
  // endpoint, transient drops) surface in the same banner as the
  // JSON-RPC sidecar so the sidebar matches its documented best-effort
  // UX and the user always has a reconnect affordance.
  useEffect(() => {
    const token = window.__HERMES_SESSION_TOKEN__;

    if (!token || !channel) {
      return;
    }

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const qs = new URLSearchParams({ token, channel });
    if (taskId) qs.set("task_id", taskId);
    const ws = new WebSocket(
      `${proto}//${window.location.host}/api/events?${qs.toString()}`,
    );

    // `unmounting` suppresses the banner during cleanup — `ws.close()`
    // from the effect's return fires a close event with code 1005 that
    // would otherwise look like an unexpected drop.
    const DISCONNECTED = "events feed disconnected — tool calls may not appear";
    let unmounting = false;
    const surface = (msg: string) => !unmounting && setError(msg);

    ws.addEventListener("error", () => surface(DISCONNECTED));

    ws.addEventListener("close", (ev) => {
      if (ev.code === 4401 || ev.code === 4403) {
        surface(`events feed rejected (${ev.code}) — reload the page`);
      } else if (ev.code !== 1000) {
        surface(DISCONNECTED);
      }
    });

    ws.addEventListener("message", (ev) => {
      let frame: RpcEnvelope;

      try {
        frame = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (frame.method !== "event" || !frame.params) {
        return;
      }

      const { type, payload } = frame.params;

      if (type === "tool.start") {
        const p = payload as
          | { tool_id?: string; name?: string; context?: string }
          | undefined;
        const toolId = p?.tool_id;

        if (!toolId) {
          return;
        }

        setTools((prev) =>
          [
            ...prev,
            {
              kind: "tool" as const,
              id: `tool-${toolId}-${prev.length}`,
              tool_id: toolId,
              name: p?.name ?? "tool",
              context: p?.context,
              status: "running" as const,
              startedAt: Date.now(),
            },
          ].slice(-TOOL_LIMIT),
        );
      } else if (type === "tool.progress") {
        const p = payload as
          | { name?: string; preview?: string }
          | undefined;

        if (!p?.name || !p.preview) {
          return;
        }

        setTools((prev) =>
          prev.map((t) =>
            t.status === "running" && t.name === p.name
              ? { ...t, preview: p.preview }
              : t,
          ),
        );
      } else if (type === "tool.complete") {
        const p = payload as
          | {
              tool_id?: string;
              summary?: string;
              error?: string;
              inline_diff?: string;
            }
          | undefined;

        if (!p?.tool_id) {
          return;
        }

        setTools((prev) =>
          prev.map((t) =>
            t.tool_id === p.tool_id
              ? {
                  ...t,
                  status: p.error ? "error" : "done",
                  summary: p.summary,
                  error: p.error,
                  inline_diff: p.inline_diff,
                  completedAt: Date.now(),
                }
              : t,
          ),
        );

        if (p.error) {
          queueMicrotask(() => {
            setTools((prev) => {
              const entry = prev.find((t) => t.tool_id === p.tool_id);
              if (entry) setSelectedToolId(entry.id);
              return prev;
            });
          });
        }
      }
    });

    return () => {
      unmounting = true;
      ws.close();
    };
  }, [channel, taskId, version]);

  const reconnect = useCallback(() => {
    setError(null);
    setTools([]);
    setVersion((v) => v + 1);
  }, []);

  // Picker hands us a fully-formed slash command (e.g. "/model anthropic/...").
  // Fire-and-forget through `slash.exec`; the TUI pane will render the result
  // via PTY, so the sidebar doesn't need to surface output of its own.
  const onModelSubmit = useCallback(
    (slashCommand: string) => {
      if (!sessionId) {
        return;
      }

      void gw.request("slash.exec", {
        session_id: sessionId,
        command: slashCommand,
      });
      setModelOpen(false);
    },
    [gw, sessionId],
  );

  const canPickModel = state === "open" && !!sessionId;
  const modelLabel = (info.model ?? "—").split("/").slice(-1)[0] ?? "—";
  const banner = error ?? info.credential_warning ?? null;
  const runningCount = tools.filter((t) => t.status === "running").length;
  const selectedTool = tools.find((t) => t.id === selectedToolId) ?? null;
  const structuredPreview = useMemo(
    () => (selectedTool ? parseStructuredPreview(selectedTool) : null),
    [selectedTool],
  );

  const handleToolClick = useCallback((tool: ToolEntry) => {
    setSelectedToolId(tool.id);
  }, []);

  const handleDeselect = useCallback(() => {
    setSelectedToolId(null);
  }, []);

  return (
    <aside
      className={cn(
        "flex h-full w-full min-w-0 shrink-0 flex-col gap-2.5 overflow-y-auto overflow-x-hidden pr-1 normal-case",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[0.6rem] uppercase tracking-[0.1em] text-muted-foreground/70">
            model
          </div>

          <Button
            ghost
            size="sm"
            disabled={!canPickModel}
            onClick={() => setModelOpen(true)}
            suffix={
              canPickModel ? (
                <ChevronDown className="opacity-60 h-3 w-3" />
              ) : undefined
            }
            className="self-start min-w-0 px-0 py-0 normal-case tracking-normal text-[0.72rem] font-medium hover:underline disabled:no-underline"
            title={info.model ?? "switch model"}
          >
            <span className="truncate">{modelLabel}</span>
          </Button>
        </div>

        <Badge tone={STATE_TONE[state]} className="text-[0.58rem] px-1.5 py-0">
          {STATE_LABEL[state]}
        </Badge>
      </div>

      {banner && (
        <Card className="flex items-start gap-2 border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />

          <div className="min-w-0 flex-1">
            <div className="wrap-break-word text-destructive">{banner}</div>

            {error && (
              <Button
                size="sm"
                outlined
                className="mt-1"
                onClick={reconnect}
                prefix={<RefreshCw />}
              >
                reconnect
              </Button>
            )}
          </div>
        </Card>
      )}

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 py-2">
        <div className="flex items-center justify-between px-1 pb-2">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">
            Activity
          </span>
          {runningCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[0.6rem] tabular-nums text-primary/80">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              {runningCount} running
            </span>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {tools.length === 0 ? (
            <div className="px-2 py-6 text-center text-[0.65rem] text-muted-foreground/60">
              No activity yet
            </div>
          ) : (
            tools.map((t) => (
              <ToolCall
                key={t.id}
                tool={t}
                onClick={() => handleToolClick(t)}
                selected={t.id === selectedToolId}
              />
            ))
          )}
        </div>
      </Card>

      {/* Detail preview panel — shown when a tool is selected */}
      {selectedTool && (
        <Card className="flex shrink-0 flex-col overflow-hidden border-primary/30 max-h-[55%]">
          <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-1.5">
            <Button
              ghost
              size="icon"
              onClick={handleDeselect}
              className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Back to activity list"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="text-[0.58rem] uppercase tracking-[0.08em] text-muted-foreground/60">
              Detail
            </span>
            <span className="flex-1 truncate text-[0.7rem] font-mono font-medium">
              {selectedTool.name}
            </span>
            {selectedTool.status === "error" && (
              <Badge tone="destructive" className="text-[0.58rem] px-1.5 py-0">
                error
              </Badge>
            )}
            {selectedTool.status === "running" && (
              <Badge tone="warning" className="text-[0.58rem] px-1.5 py-0">
                running
              </Badge>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 text-xs font-mono">
            {/* Error first — most important */}
            {selectedTool.error && (
              <div>
                <div className="mb-1 text-[0.6rem] uppercase tracking-[0.08em] text-destructive/80">
                  error
                </div>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-destructive/[0.06] px-2 py-1.5 text-[0.7rem] leading-relaxed text-destructive">
                  {selectedTool.error}
                </pre>
              </div>
            )}

            {/* ── Structured preview (when available) ── */}

            {/* Diff — with file list header */}
            {structuredPreview?.unified_diff && (
              <div>
                <div className="mb-1 text-[0.6rem] uppercase tracking-[0.08em] text-muted-foreground/60">
                  diff
                </div>
                {structuredPreview.files && structuredPreview.files.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1.5">
                    {structuredPreview.files.map((f) => (
                      <span
                        key={f}
                        className="inline-flex items-center rounded border border-border/60 px-1.5 py-0.5 text-[0.58rem] text-muted-foreground/80"
                      >
                        <FileText className="mr-1 h-2.5 w-2.5 shrink-0 opacity-60" />
                        {f}
                      </span>
                    ))}
                  </div>
                )}
                <pre className="max-h-48 overflow-auto whitespace-pre rounded bg-muted/30 px-2 py-1.5 text-[0.7rem] leading-snug">
                  {structuredPreview.unified_diff.split("\n").map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith("+") && !line.startsWith("+++")
                          ? "text-emerald-500"
                          : line.startsWith("-") && !line.startsWith("---")
                            ? "text-destructive"
                            : line.startsWith("@@")
                              ? "text-primary"
                              : "text-muted-foreground/80"
                      }
                    >
                      {line || "\u00A0"}
                    </div>
                  ))}
                </pre>
              </div>
            )}

            {/* Review — findings list + summary */}
            {(structuredPreview?.review_findings || structuredPreview?.review_summary) && (
              <div>
                <div className="mb-1 text-[0.6rem] uppercase tracking-[0.08em] text-muted-foreground/60">
                  review
                </div>
                {structuredPreview.review_findings && (
                  <div className="max-h-48 space-y-1 overflow-auto">
                    {structuredPreview.review_findings.map((f, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-1.5 rounded bg-muted/20 px-2 py-1 text-[0.68rem]"
                      >
                        <span
                          className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                            f.severity === "error" || f.severity === "critical"
                              ? "bg-destructive"
                              : f.severity === "warning"
                                ? "bg-amber-500"
                                : "bg-muted-foreground/40"
                          }`}
                        />
                        <div className="min-w-0 flex-1">
                          <span className="leading-snug text-foreground/85">
                            {f.message}
                          </span>
                          {(f.file || f.line) && (
                            <span className="ml-1.5 text-[0.58rem] text-muted-foreground/60">
                              {f.file}
                              {f.line ? `:${f.line}` : ""}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {structuredPreview.review_summary && (
                  <div className="mt-1.5 rounded bg-muted/30 px-2 py-1 text-[0.68rem] leading-relaxed text-muted-foreground/80">
                    {structuredPreview.review_summary}
                  </div>
                )}
              </div>
            )}

            {/* QA — passed/failed summary + checks list */}
            {((structuredPreview?.qa_passed !== undefined && structuredPreview?.qa_passed !== null) ||
              (structuredPreview?.qa_failed !== undefined && structuredPreview?.qa_failed !== null) ||
              structuredPreview?.qa_checks ||
              structuredPreview?.qa_summary) && (
              <div>
                <div className="mb-1 text-[0.6rem] uppercase tracking-[0.08em] text-muted-foreground/60">
                  qa
                </div>
                {(structuredPreview.qa_passed !== undefined ||
                  structuredPreview.qa_failed !== undefined) && (
                  <div className="mb-1.5 flex gap-2">
                    {structuredPreview.qa_passed !== undefined && (
                      <span className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/[0.06] px-1.5 py-0.5 text-[0.62rem] font-medium text-emerald-500">
                        <Check className="h-2.5 w-2.5" />
                        {structuredPreview.qa_passed} passed
                      </span>
                    )}
                    {structuredPreview.qa_failed !== undefined && structuredPreview.qa_failed > 0 && (
                      <span className="inline-flex items-center gap-1 rounded border border-destructive/30 bg-destructive/[0.06] px-1.5 py-0.5 text-[0.62rem] font-medium text-destructive">
                        {structuredPreview.qa_failed} failed
                      </span>
                    )}
                  </div>
                )}
                {structuredPreview.qa_checks && structuredPreview.qa_checks.length > 0 && (
                  <div className="max-h-40 space-y-0.5 overflow-auto">
                    {structuredPreview.qa_checks.map((c, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-1.5 rounded bg-muted/20 px-2 py-0.5 text-[0.68rem]"
                      >
                        <span
                          className={`mt-0.5 h-3 w-3 shrink-0 ${
                            c.passed ? "text-emerald-500" : "text-destructive"
                          }`}
                        >
                          {c.passed ? <Check /> : <Zap />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <span className="leading-snug text-foreground/85">
                            {c.name}
                          </span>
                          {c.detail && (
                            <span className="ml-1.5 text-[0.58rem] text-muted-foreground/60">
                              {c.detail}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {structuredPreview.qa_summary && (
                  <div className="mt-1.5 rounded bg-muted/30 px-2 py-1 text-[0.68rem] leading-relaxed text-muted-foreground/80">
                    {structuredPreview.qa_summary}
                  </div>
                )}
              </div>
            )}

            {/* Artifact */}
            {(structuredPreview?.artifact_title ||
              structuredPreview?.artifact_path ||
              structuredPreview?.artifact_url ||
              structuredPreview?.artifact_content ||
              structuredPreview?.artifact_preview) && (
              <div>
                <div className="mb-1 text-[0.6rem] uppercase tracking-[0.08em] text-muted-foreground/60">
                  artifact
                </div>
                <div className="rounded border border-border/50 bg-muted/30 px-2 py-1.5">
                  {structuredPreview.artifact_title && (
                    <div className="text-[0.7rem] font-medium text-foreground/90">
                      {structuredPreview.artifact_title}
                    </div>
                  )}
                  {structuredPreview.artifact_path && (
                    <div className="mt-0.5 flex items-center gap-1 text-[0.6rem] text-muted-foreground/70">
                      <FileText className="h-2.5 w-2.5 shrink-0" />
                      <span className="truncate">
                        {structuredPreview.artifact_path}
                      </span>
                    </div>
                  )}
                  {structuredPreview.artifact_url && (
                    <div className="mt-0.5 flex items-center gap-1 text-[0.6rem]">
                      <span className="shrink-0 text-muted-foreground/50">url</span>
                      <a
                        href={structuredPreview.artifact_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate text-primary/80 underline-offset-2 hover:underline"
                      >
                        {structuredPreview.artifact_url}
                      </a>
                    </div>
                  )}
                  {(structuredPreview.artifact_content ||
                    structuredPreview.artifact_preview) && (
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/40 px-2 py-1 text-[0.68rem] leading-relaxed text-muted-foreground/80">
                      {structuredPreview.artifact_preview ||
                        structuredPreview.artifact_content}
                    </pre>
                  )}
                </div>
              </div>
            )}

            {/* ── Generic fallback (when no structured data) ── */}

            {/* Generic diff — only if structured didn't already show it */}
            {!structuredPreview?.unified_diff && selectedTool.inline_diff && (
              <div>
                <div className="mb-1 text-[0.6rem] uppercase tracking-[0.08em] text-muted-foreground/60">
                  diff
                </div>
                <pre className="max-h-48 overflow-auto whitespace-pre rounded bg-muted/30 px-2 py-1.5 text-[0.7rem] leading-snug">
                  {selectedTool.inline_diff.split("\n").map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith("+") && !line.startsWith("+++")
                          ? "text-emerald-500"
                          : line.startsWith("-") && !line.startsWith("---")
                            ? "text-destructive"
                            : line.startsWith("@@")
                              ? "text-primary"
                              : "text-muted-foreground/80"
                      }
                    >
                      {line || "\u00A0"}
                    </div>
                  ))}
                </pre>
              </div>
            )}

            {/* Generic result */}
            {!structuredPreview && selectedTool.summary && (
              <div>
                <div className="mb-1 text-[0.6rem] uppercase tracking-[0.08em] text-muted-foreground/60">
                  result
                </div>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/30 px-2 py-1.5 text-[0.7rem] leading-relaxed text-foreground/90">
                  {selectedTool.summary}
                </pre>
              </div>
            )}

            {/* Streaming preview (running tools) */}
            {selectedTool.preview && selectedTool.status === "running" && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[0.6rem] uppercase tracking-[0.08em] text-muted-foreground/60">
                  streaming
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                </div>
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/30 px-2 py-1.5 text-[0.7rem] leading-relaxed text-muted-foreground">
                  {selectedTool.preview}
                </pre>
              </div>
            )}

            {/* Context last */}
            {selectedTool.context && (
              <div>
                <div className="mb-1 text-[0.6rem] uppercase tracking-[0.08em] text-muted-foreground/60">
                  context
                </div>
                <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/30 px-2 py-1.5 text-[0.7rem] leading-relaxed text-muted-foreground/80">
                  {selectedTool.context}
                </pre>
              </div>
            )}
          </div>
        </Card>
      )}

      {modelOpen && canPickModel && sessionId && (
        <ModelPickerDialog
          gw={gw}
          sessionId={sessionId}
          onClose={() => setModelOpen(false)}
          onSubmit={onModelSubmit}
        />
      )}
    </aside>
  );
}
