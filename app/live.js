// A live desktop wallpaper: one of the built-in scenes, or the picture saved from the studio.
// No UI. The app tells it to slow down on battery and to pause while the screen is locked.
import { AsciiRenderer } from "../web/renderer.js";
import { loadWallpaper } from "../web/wallpaper-store.js";
import { Grid, SCENES } from "../web/scenes.js";
import { Clock } from "../web/customise.js";
import { christmasSeason, doomsdayText } from "../web/seasonal.js";
import { Festive, Stones, Snap } from "../web/festive.js";

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
let config = { sceneOpts: {}, clockShow: false, clockOpts: {}, festive: {}, stones: [] };
try { config = { ...config, ...(await window.liveBridge?.getConfig()) }; } catch {}

// festive extras, the hidden stones (rest the cursor on one to collect it) and the snap
let inSeason = christmasSeason();
setInterval(() => { inSeason = christmasSeason(); }, 60000);
const festive = new Festive(config.festive);
const stones = new Stones(config.stones || [], (id) => window.liveBridge?.collectStone(id), { dwell: true });
let lineTimer;
const line = document.getElementById("snap-line");
const snap = new Snap((phase) => {
  if (phase === "start") document.body.classList.add("snapping");
  if (phase === "doom") {
    const text = doomsdayText();
    line.textContent = ""; line.classList.add("show");
    let n = 0;
    clearInterval(lineTimer);
    lineTimer = setInterval(() => { line.textContent = text.slice(0, ++n); if (n >= text.length) clearInterval(lineTimer); }, 45);
  }
  if (phase === "back") { clearInterval(lineTimer); line.classList.remove("show"); document.body.classList.remove("snapping"); }
});
window.snap = () => { if (scene && sized && !snap.active) snap.start(grid); };
const clock = new Clock(document.getElementById("clock"), document.getElementById("time"), document.getElementById("date"), config.clockOpts);
document.body.classList.toggle("hide-clock", !config.clockShow);
window.liveBridge?.onConfig((c) => {
  config = c;
  if (scene && scene.setOptions) scene.setOptions(c.sceneOpts[choice] || {});
  clock.set(c.clockOpts || {});
  festive.set(c.festive || {});
  stones.setHave(c.stones || []);
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
  Object.assign(S, { cell: (def.cell || 7) * dpr, glow: def.glow, fps: 30, period: 10, shimmer: 0 });
  scene = def.make(config.sceneOpts[choice]);
  festive.sceneId = stones.sceneId = SCENES[choice] ? choice : "water";
}

// cursor position from the app (CSS pixels within this screen) -> character cells
if (window.liveBridge) {
  window.liveBridge.onPointer(({ x, y }) => {
    window.lastPointer = { x, y };          // handy for checking it works
    if (!scene || !sized) return;          // not measured yet
    const [cols, rows] = r.gridSize();
    const ox = Math.floor((canvas.width - cols * r.cellW) / 2), oy = Math.floor((canvas.height - rows * r.cellH) / 2);
    const cx = (x * dpr - ox) / r.cellW, cy = (y * dpr - oy) / r.cellH;
    stones.pointer(cx, cy, "move");
    scene.pointer(cx, cy, "move");
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
    if (!sized || sized[0] !== cols || sized[1] !== rows) {
      snap.active = false; document.body.classList.remove("snapping");
      scene.resize(cols, rows); grid.resize(cols, rows); festive.resize(cols, rows); stones.resize(cols, rows);
      sized = [cols, rows];
    }
    const C = r.charMap();
    if (snap.active) { snap.step(dt); snap.draw(grid, C); }
    else {
      scene.step(dt, t); festive.step(dt, t); stones.step(dt);
      grid.clear();
      scene.draw(grid, C, t);
      festive.draw(grid, C, t, inSeason);
      stones.draw(grid, C, t);
    }
    r.renderDirect(grid.pack(), t);
  } else {
    r.render(((t % S.period) + S.period) % S.period);
  }
}
requestAnimationFrame(frame);
