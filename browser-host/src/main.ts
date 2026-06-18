/**
 * Hermes Browser Host — Phase 5A
 *
 * Electron app that:
 *  - Opens a window with embedded browser surface (WebContentsView)
 *  - User-controlled URL bar + navigation
 *  - Starts a localhost HTTP health server
 *  - Provides read-only /snapshot, /screenshot, /context API
 *  - Hermes-native plugin layer: detects GitHub PR + ChatGPT pages
 *  - Writes state to ~/.hermes/browser-host/state.json
 *
 * No Agent actions. No click/type/submit/navigateAsAgent.
 * No user-provided JavaScript execution.
 * executeJavaScript only used for built-in static read-only scripts.
 */

import { app, BrowserWindow, WebContentsView, ipcMain, clipboard } from "electron";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  buildSnapshot,
  type BrowserContextSnapshot,
  type BrowserEvent,
  type PluginContext,
} from "./schema";

/* ── Constants ────────────────────────────────────────────────────── */

const STATE_DIR = join(homedir(), ".hermes", "browser-host");
const STATE_FILE = join(STATE_DIR, "state.json");
const HEALTH_PORT_FILE = join(STATE_DIR, "port");
const BROWSER_PROFILE = join(homedir(), ".hermes", "browser");

/* ── Globals ──────────────────────────────────────────────────────── */

let healthPort = 0;
let startedAt = "";
let mainWindow: BrowserWindow | null = null;
let browserView: WebContentsView | null = null;
let httpServer: ReturnType<typeof createServer> | null = null;
let pageReady = false;
const recentEvents: BrowserEvent[] = [];

function pushEvent(type: string, extra: Partial<BrowserEvent> = {}) {
  recentEvents.push({ ts: new Date().toISOString(), type, ...extra });
  if (recentEvents.length > 50) recentEvents.shift();
}

/* ── State management ─────────────────────────────────────────────── */

function writeStateFile(): void {
  const state = {
    pid: process.pid,
    port: healthPort,
    healthUrl: `http://127.0.0.1:${healthPort}/health`,
    startedAt,
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cleanupStateFile(): void {
  try {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
    if (existsSync(HEALTH_PORT_FILE)) unlinkSync(HEALTH_PORT_FILE);
  } catch {
    // best-effort cleanup
  }
}

/* ── Renderer + Browser surface ───────────────────────────────────── */

function createWindow(): void {
  // Set persistent profile for login state
  app.setPath("userData", BROWSER_PROFILE);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Hermes Browser Host (Phase 2C)",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // ── Embedded browser surface ──────────────────────────────────
  browserView = new WebContentsView({
    webPreferences: {
      // Inherits default session from the persistent profile
    },
  });
  browserView.setBackgroundColor("#ffffff");
  mainWindow.contentView.addChildView(browserView);

  const wc = browserView.webContents;
  wc.on("did-finish-load", () => {
    pageReady = true;
    pushEvent("page-load-complete", { url: wc.getURL() });
    mainWindow?.webContents.send("browser:url-changed", wc.getURL());
    mainWindow?.webContents.send("browser:loading", false);
  });
  wc.on("did-start-loading", () => {
    pageReady = false;
    mainWindow?.webContents.send("browser:loading", true);
  });
  wc.on("page-title-updated", (_ev, title) => {
    pushEvent("page-title-updated", { title });
  });
  wc.on("did-navigate", (_ev, url) => {
    pushEvent("page-navigation-committed", { url });
  });
  wc.on("did-fail-load", (_ev, _code, desc, url) => {
    pushEvent("page-failed", { url, error: desc });
    mainWindow?.webContents.send("browser:loading", false);
  });

  // ── Layout ────────────────────────────────────────────────────
  const layoutBrowserView = () => {
    if (!mainWindow || !browserView) return;
    const cb = mainWindow.contentView.getBounds();
    const toolbarH = 48;
    browserView.setBounds({
      x: 0,
      y: toolbarH,
      width: cb.width,
      height: Math.max(100, cb.height - toolbarH),
    });
  };
  layoutBrowserView();
  mainWindow.on("resize", layoutBrowserView);

  // ── IPC from renderer toolbar ─────────────────────────────────
  ipcMain.handle("browser:go", (_ev, url: string) => {
    if (!browserView || !url) return { error: "No browser surface" };
    try {
      browserView.webContents.loadURL(url);
      pushEvent("navigate-human", { url });
      return { success: true };
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle("browser:back", () => {
    if (browserView?.webContents.canGoBack()) {
      browserView.webContents.goBack();
      pushEvent("go-back", {});
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle("browser:forward", () => {
    if (browserView?.webContents.canGoForward()) {
      browserView.webContents.goForward();
      pushEvent("go-forward", {});
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle("browser:getInfo", () => {
    if (!browserView) return { url: "", title: "", loading: false };
    return {
      url: browserView.webContents.getURL(),
      title: browserView.webContents.getTitle(),
      loading: browserView.webContents.isLoading(),
    };
  });

  mainWindow.loadFile(join(__dirname, "renderer.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

/* ── Hermes-native plugin detector (Phase 5A) ────────────────────────── */

/**
 * Detects known page types from URL + title.
 * Extensible: add new detectors here.
 * No network calls. No user JS. URL parsing only.
 */
function detectPluginContext(url: string, title: string): {
  pageType: string;
  pluginContext: PluginContext | null;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { pageType: "generic-web", pluginContext: null };
  }

  // ── GitHub Pull Request detector ──────────────────────────────
  if (parsed.hostname === "github.com") {
    const prMatch = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (prMatch) {
      const owner = prMatch[1];
      const repo = prMatch[2];
      const prNumber = parseInt(prMatch[3], 10);

      let prTitle = title;
      const pullIdx = title.lastIndexOf(" · Pull Request #");
      if (pullIdx > 0) {
        const byIdx = title.lastIndexOf(" by ", pullIdx);
        prTitle = byIdx > 0 ? title.substring(0, byIdx) : title.substring(0, pullIdx);
      }

      return {
        pageType: "github_pull_request",
        pluginContext: {
          pluginId: "github-pr",
          matched: true,
          githubPullRequest: {
            owner,
            repo,
            number: prNumber,
            url: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
            title: prTitle,
          },
        },
      };
    }
  }

  // ── ChatGPT conversation detector ─────────────────────────────
  if (parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com") {
    // Match /c/{conversationId} (specific conversation)
    const convMatch = parsed.pathname.match(/^\/c\/([a-zA-Z0-9_-]+)/);
    const conversationId = convMatch ? convMatch[1] : null;
    const pageType = conversationId ? "chatgpt_conversation" : "chatgpt_home";

    return {
      pageType,
      pluginContext: {
        pluginId: "chatgpt-conversation",
        matched: true,
        chatgptConversation: {
          url,
          title,
          conversationId,
        },
      },
    };
  }

  return { pageType: "generic-web", pluginContext: null };
}

/* ── Snapshot / context (shared schema) ────────────────────────────── */

function getBaseParams(): {
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
} {
  if (!browserView) {
    return { url: "", title: "", isLoading: false, canGoBack: false, canGoForward: false };
  }
  const wc = browserView.webContents;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    isLoading: wc.isLoading(),
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
  };
}

function getSnapshot(): BrowserContextSnapshot {
  const base = getBaseParams();
  const detection = detectPluginContext(base.url, base.title);
  return buildSnapshot({
    ...base,
    domSummary: "",
    selectedText: "",
    clipboardTextPreview: "",
    recentEvents,
    pageType: detection.pageType,
    pluginContext: detection.pluginContext,
  });
}

/* ── Context extraction ────────────────────────────────────────────── */

/** Built-in static read-only scripts. Never accept user/Agent input. */
const EXTRACT_DOM_SCRIPT = `(function(){
  try { return (document.body ? document.body.innerText : '').slice(0, 3000); }
  catch(e) { return ''; }
})()`;

const EXTRACT_SELECTION_SCRIPT = `(function(){
  try { var s = window.getSelection(); return s ? s.toString().slice(0, 3000) : ''; }
  catch(e) { return ''; }
})()`;

async function getContext(): Promise<BrowserContextSnapshot> {
  const base = getBaseParams();
  const detection = detectPluginContext(base.url, base.title);

  let domSummary = "";
  let selectedText = "";
  let clipboardTextPreview = "";

  try {
    domSummary =
      (await browserView!.webContents.executeJavaScript(EXTRACT_DOM_SCRIPT)) || "";
  } catch {
    domSummary = "";
  }

  try {
    selectedText =
      (await browserView!.webContents.executeJavaScript(EXTRACT_SELECTION_SCRIPT)) || "";
  } catch {
    selectedText = "";
  }

  try {
    clipboardTextPreview = clipboard.readText().slice(0, 1000);
  } catch {
    clipboardTextPreview = "";
  }

  return buildSnapshot({
    ...base,
    domSummary,
    selectedText,
    clipboardTextPreview,
    recentEvents,
    pageType: detection.pageType,
    pluginContext: detection.pluginContext,
  });
}

/* ── HTTP server ──────────────────────────────────────────────────── */

function routeRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url || "/";
  const method = req.method || "GET";

  // CORS for localhost
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:9119");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url === "/health" || url === "/health/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "hermes-browser-host",
        phase: "5A",
        pid: process.pid,
        port: healthPort,
        startedAt,
        features: {
          embeddedBrowser: true,
          snapshot: true,
          screenshot: true,
          agentActions: false,
          plugins: true,
        },
      })
    );
    return;
  }

  if (url === "/snapshot" || url === "/snapshot/") {
    if (!browserView) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No browser surface" }));
      return;
    }
    const snap = getSnapshot();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snap));
    return;
  }

  if (url === "/screenshot" || url === "/screenshot/") {
    if (!browserView) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No browser surface" }));
      return;
    }
    if (!pageReady) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Page not loaded yet" }));
      return;
    }
    browserView.webContents
      .capturePage()
      .then((image) => {
        const buf = image.toPNG();
        if (buf.length === 0) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Zero-byte capture" }));
          return;
        }
        // Limit to max 1920px wide
        const base64 = buf.toString("base64");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            format: "png",
            sizeBytes: buf.length,
            dataUri: `data:image/png;base64,${base64}`,
          })
        );
        pushEvent("screenshot-captured", { sizeBytes: buf.length });
      })
      .catch((err: Error) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  if (url === "/context" || url === "/context/") {
    if (!browserView) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No browser surface" }));
      return;
    }
    getContext().then((ctx) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(ctx));
    }).catch((err: Error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

function startHttpServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(routeRequest);

    function tryListen(port: number): void {
      server.listen(port, "127.0.0.1", () => {
        healthPort = port;
        httpServer = server;
        resolve(port);
      });
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          server.close();
          const retry = createServer(routeRequest);
          retry.listen(port === 8765 ? 0 : port + 1, "127.0.0.1", () => {
            healthPort = port === 8765 ? 0 : port + 1;
            httpServer = retry;
            resolve(healthPort);
          });
          retry.once("error", () => reject(err));
        } else {
          reject(err);
        }
      });
    }

    tryListen(8765);
  });
}

/* ── Cleanup ──────────────────────────────────────────────────────── */

function cleanup(): void {
  cleanupStateFile();
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}

/* ── App lifecycle ────────────────────────────────────────────────── */

app.whenReady().then(async () => {
  startedAt = new Date().toISOString();

  try {
    await startHttpServer();
  } catch (err) {
    console.error("Failed to start HTTP server:", err);
    app.quit();
    return;
  }

  writeStateFile();
  createWindow();

  console.log(
    `Hermes Browser Host Phase 5A running`,
    `\n  Health:  http://127.0.0.1:${healthPort}/health`,
    `\n  Context: http://127.0.0.1:${healthPort}/context`,
    `\n  State:   ${STATE_FILE}`
  );
});

app.on("window-all-closed", () => {
  // Don't quit — keep the HTTP server alive
});

app.on("before-quit", () => {
  cleanup();
});

process.on("SIGTERM", () => {
  cleanup();
  app.quit();
});

process.on("SIGINT", () => {
  cleanup();
  app.quit();
});

process.on("exit", () => {
  cleanupStateFile();
});
