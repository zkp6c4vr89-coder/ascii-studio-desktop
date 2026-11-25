// Live wallpaper windows can't receive mouse events (they sit behind the desktop icons),
// so the app sends them the cursor position instead, plus their colour/clock settings.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("liveBridge", {
  onPointer: (cb) => ipcRenderer.on("pointer", (_e, p) => cb(p)),
  getConfig: () => ipcRenderer.invoke("wallpaper:config:get"),
  onConfig: (cb) => ipcRenderer.on("config", (_e, c) => cb(c)),
  collectStone: (id) => ipcRenderer.invoke("stones:collect", id),
});
