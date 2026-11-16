// A live desktop wallpaper: one of the built-in scenes, or the picture saved from the studio.
// No UI. The app tells it to slow down on battery and to pause while the screen is locked.
import { AsciiRenderer } from "../web/renderer.js";
import { loadWallpaper } from "../web/wallpaper-store.js";
import { Grid, SCENES } from "../web/scenes.js";
import { Clock } from "../web/customise.js";

const q = new URLSearchParams(location.search);
const canvas = document.getElementById("out");
const dpr = window.devicePixelRatio || 1;
const r = new AsciiRenderer(canvas);
const S = r.settings;
let fps = Math.min(60, Math.max(1, Number(q.get("fps")) || 30));
let paused = false;
window.setFps = (n) => { fps = n; };
window.setPaused = (p) => { paused = p; };

let scene = null;
const grid = new Grid();
let choice = q.get("scene") || "water";

// colours, flow and clock settings come from the app, and update live
let config = { sceneOpts: {}, clockShow: false, clockOpts: {} };
try { config = { ...config, ...(await window.liveBridge?.getConfig()) }; } catch {}
const clock = new Clock(document.getElementById("clock"), document.getElementById("time"), document.getElementById("date"), config.clockOpts);
document.body.classList.toggle("hide-clock", !config.clockShow);
window.liveBridge?.onConfig((c) => {
  config = c;
  if (scene && scene.setOptions) scene.setOptions(c.sceneOpts[choice] || {});
  clock.set(c.clockOpts || {});
  document.body.classList.toggle("hide-clock", !c.clockShow);
});

if (choice === "custom") {
  let pic = null;
  try { pic = await loadWallpaper(); } catch {}
  if (pic && pic.mode === "rain") choice = "rain";
  else if (pic && pic.blob) {
    Object.assign(S, pic.settings, { mode: "source" });
    S.cell = (pic.settings.cell || 7) * dpr;
    const url = URL.createObjectURL(pic.blob);
    if (pic.isVideo) {
      const v = Object.assign(document.createElement("video"), { src: url, loop: true, muted: true, playsInline: true, autoplay: true });
      v.addEventListener("loadeddata", () => r.setSource(v));
      v.play().catch(() => {});
    } else {
      const img = new Image();
      img.onload = () => r.setSource(img);
      img.src = url;
    }
  } else {
    choice = "water";                 // nothing saved yet
  }
}
if (choice !== "custom") {
  const def = SCENES[choice] || SCENES.water;
  Object.assign(S, { cell: 7 * dpr, glow: def.glow, fps: 30, period: 10, shimmer: 0 });
  scene = def.make(config.sceneOpts[choice]);
}

// cursor position from the app (CSS pixels within this screen) -> character cells
if (window.liveBridge) {
  window.liveBridge.onPointer(({ x, y }) => {
    window.lastPointer = { x, y };          // handy for checking it works
    if (!scene || !sized) return;          // not measured yet
    const [cols, rows] = r.gridSize();
    const ox = Math.floor((canvas.width - cols * r.cellW) / 2), oy = Math.floor((canvas.height - rows * r.cellH) / 2);
    scene.pointer((x * dpr - ox) / r.cellW, (y * dpr - oy) / r.cellH, "move");
  });
}

let sized = null, last = performance.now(), lastTick = -1;
function frame(ms) {
  requestAnimationFrame(frame);
  if (paused) return;
  const tick = Math.floor((ms / 1000) * fps);
  if (tick === lastTick) return;
  lastTick = tick;
  const dt = Math.min(0.1, (ms - last) / 1000);
  last = ms;
  r.resize(Math.round(innerWidth * dpr), Math.round(innerHeight * dpr));
  const t = ms / 1000;
  if (scene) {
    const [cols, rows] = r.gridSize();
    if (!sized || sized[0] !== cols || sized[1] !== rows) { scene.resize(cols, rows); grid.resize(cols, rows); sized = [cols, rows]; }
    scene.step(dt, t);
    grid.clear();
    scene.draw(grid, r.charMap(), t);
    r.renderDirect(grid.pack(), t);
  } else {
    r.render(((t % S.period) + S.period) % S.period);
  }
}
requestAnimationFrame(frame);
