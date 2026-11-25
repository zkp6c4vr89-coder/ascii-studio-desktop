// The only bridge between the pages and the app. Pages get these few functions and
// nothing else (no Node.js, no file access).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("asciiDesktop", {
  capabilities: () => ipcRenderer.invoke("capabilities"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  setStillWallpaper: (pngArrayBuffer) => ipcRenderer.invoke("wallpaper:still", pngArrayBuffer),
  setLiveWallpaper: (id) => ipcRenderer.invoke("wallpaper:live", id),
  askCamera: () => ipcRenderer.invoke("camera:ask"),
  finishSetup: () => ipcRenderer.invoke("setup:finish"),
  getWallpaperConfig: () => ipcRenderer.invoke("wallpaper:config:get"),
  setWallpaperConfig: (patch) => ipcRenderer.invoke("wallpaper:config:set", patch),
  openCustomise: () => ipcRenderer.invoke("window:customise"),
  onSceneChanged: (cb) => ipcRenderer.on("scene-changed", (_e, id) => cb(id)),
  onConfig: (cb) => ipcRenderer.on("config", (_e, c) => cb(c)),
  snap: () => ipcRenderer.invoke("wallpaper:snap"),
  updates: {
    state: () => ipcRenderer.invoke("update:state"),
    check: () => ipcRenderer.invoke("update:check"),
    install: () => ipcRenderer.invoke("update:install"),
    download: () => ipcRenderer.invoke("update:download"),
    onChange: (cb) => ipcRenderer.on("update-state", (_e, state) => cb(state)),
  },
});
