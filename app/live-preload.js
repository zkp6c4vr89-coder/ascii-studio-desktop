// Live wallpaper windows can't receive mouse events (they sit behind the desktop icons),
// so the app sends them the cursor position instead. This is the only thing they get.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("liveBridge", {
  onPointer: (cb) => ipcRenderer.on("pointer", (_e, p) => cb(p)),
});
