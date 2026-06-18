/**
 * Hermes Browser Host — Preload (Phase 2C)
 *
 * Exposes toolbar navigation to the renderer window.
 * No Agent APIs. No context bridge for snapshot/screenshot.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("toolbarAPI", {
  go: (url: string) => ipcRenderer.invoke("browser:go", url),
  back: () => ipcRenderer.invoke("browser:back"),
  forward: () => ipcRenderer.invoke("browser:forward"),
  getInfo: () => ipcRenderer.invoke("browser:getInfo"),
  onUrlChanged: (cb: (url: string) => void) => {
    ipcRenderer.on("browser:url-changed", (_ev, url) => cb(url));
  },
  onLoading: (cb: (loading: boolean) => void) => {
    ipcRenderer.on("browser:loading", (_ev, loading) => cb(loading));
  },
});
