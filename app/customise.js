// The desktop app's "Customise wallpaper" window: pick the live scene, its colours and flow,
// and the clock shown on the desktop. Uses the same controls as the browser extension.
import { SCENES } from "../web/scenes.js";
import { Clock, CLOCK_DEFAULTS, el, seg, sceneControls, clockControls, festiveControls, stoneDots, scenesInOrder } from "../web/customise.js";
import { christmasSeason } from "../web/seasonal.js";

const $ = (id) => document.getElementById(id);
const desk = window.asciiDesktop;
let config = await desk.getWallpaperConfig();

// the controls drive this hidden clock; the real one is on the desktop
const clock = new Clock(el("div"), el("div"), el("div"), config.clockOpts);
const saveClock = (opts) => desk.setWallpaperConfig({ clockOpts: opts });
const setShown = (v) => { config.clockShow = v; desk.setWallpaperConfig({ clockShow: v }); };

function buildScenePicker() {
  const options = [["off", "Off"], ...scenesInOrder().map((s) => [s.id, s.name]), ["custom", "My picture"]];
  const picker = seg(options, config.scene, async (id) => {
    const res = await desk.setLiveWallpaper(id);
    if (res && res.ok) { config.scene = id; buildSceneOptions(); }
  });
  picker.classList.add("scenes");
  $("scene-pick").replaceChildren(picker);
}

function buildSceneOptions() {
  const id = config.scene;
  $("scene-title").textContent = id === "off" ? "Scene" : id === "custom" ? "My picture" : (SCENES[id] || SCENES.water).name;
  const set = (patch) => {
    config.sceneOpts = { ...config.sceneOpts, [id]: { ...config.sceneOpts[id], ...patch } };
    desk.setWallpaperConfig({ sceneId: id, sceneOpts: patch });
  };
  $("scene-opts").replaceChildren(...(id === "off"
    ? [el("p", { className: "note", textContent: "Pick a live wallpaper above to see its options." })]
    : id === "custom"
      ? [el("p", { className: "note", textContent: "Your picture uses the look you chose in the studio." })]
      : sceneControls(id, config.sceneOpts[id], set, { hover: true })));
}

// Festive extras (in season) and the stones (only once one has been found)
function buildExtras() {
  $("festive-group").hidden = !christmasSeason();
  if (christmasSeason()) $("festive-opts").replaceChildren(...festiveControls(config.festive, (patch) => {
    config.festive = { ...config.festive, ...patch };
    desk.setWallpaperConfig({ festive: patch });
  }));
  const found = config.stones || [];
  $("stones-group").hidden = !found.length;
  if (!found.length) return;
  const kids = [stoneDots(found)];
  if (found.length === 6) {
    const b = el("button", { className: "reset glass", textContent: "Snap" });
    b.onclick = async () => {
      const res = await desk.snap();
      if (!res || !res.ok) b.textContent = "Turn on a live wallpaper first";
    };
    kids.push(b);
  } else {
    kids.push(el("p", { className: "note", textContent: `${found.length} of 6 found. Each one hides in a different wallpaper: rest your mouse on it to pick it up.` }));
  }
  $("stones-opts").replaceChildren(...kids);
}

function buildClockOptions() {
  const reset = el("button", { className: "reset glass", textContent: "Reset clock to default" });
  reset.onclick = () => {
    clock.reset();
    desk.setWallpaperConfig({ clockOpts: { ...CLOCK_DEFAULTS }, clockReset: true });
    buildClockOptions();
  };
  $("clock-opts").replaceChildren(...clockControls(clock, saveClock, [config.clockShow, setShown]), reset);
}

if (!config.liveSupported) {
  document.body.replaceChildren(el("h1", { textContent: "Customise wallpaper" }),
    el("p", { className: "lede", textContent: "Live wallpapers aren't available on this system yet." }));
} else {
  buildScenePicker();
  buildSceneOptions();
  buildClockOptions();
  buildExtras();
  desk.onConfig((c) => { config = { ...config, ...c }; buildExtras(); });
  // the tray menu can change the scene too
  desk.onSceneChanged((id) => { config.scene = id; buildScenePicker(); buildSceneOptions(); });
}
