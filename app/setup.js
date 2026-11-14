// First-run setup guide: welcome → camera → start at login → live wallpaper → done.
const $ = (id) => document.getElementById(id);
const desk = window.asciiDesktop;
const caps = await desk.capabilities();
const settings = await desk.getSettings();

if (navigator.userAgentData && navigator.userAgentData.brands.some((b) => /Chromium/.test(b.brand))) {
  document.documentElement.classList.add("liquid");
}
const where = caps.platform === "darwin" ? "menu-bar icon (top right of your screen)" : "system-tray icon";
document.querySelectorAll(".where").forEach((el) => (el.textContent = where));

const steps = [...document.querySelectorAll(".step")];
let step = 0, cameraOk = false, live = settings.liveWallpaper || "off";

// dots
for (let i = 0; i < steps.length; i++) $("dots").appendChild(document.createElement("span"));
function show(i) {
  step = Math.max(0, Math.min(steps.length - 1, i));
  steps.forEach((s, k) => (s.hidden = k !== step));
  [...$("dots").children].forEach((d, k) => d.classList.toggle("on", k === step));
  $("back").style.visibility = step === 0 ? "hidden" : "visible";
  $("next").textContent = step === steps.length - 1 ? "Open the studio" : step === 0 ? "Get started" : "Continue";
  if (step === steps.length - 1) summarise();
}
$("back").onclick = () => show(step - 1);
$("next").onclick = async () => {
  if (step === steps.length - 1) { await desk.finishSetup(); return; }
  show(step + 1);
};
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight" || e.key === "Enter") $("next").click();
  if (e.key === "ArrowLeft") $("back").click();
});

// camera
$("cam-allow").onclick = async () => {
  $("cam-status").textContent = "Asking…";
  try {
    const granted = await desk.askCamera();
    if (granted === false) throw new Error("denied");
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
    cameraOk = true;
    $("cam-status").textContent = "✓ Camera ready.";
    $("cam-allow").textContent = "Camera allowed";
    $("cam-allow").disabled = true;
  } catch {
    $("cam-status").textContent = caps.platform === "darwin"
      ? "Camera blocked. Turn on ASCII Studio in System Settings › Privacy & Security › Camera."
      : "Camera blocked or not found. You can allow it later in your system settings.";
  }
};

// start at login
$("login").checked = !!settings.launchAtLogin;
$("login").onchange = (e) => desk.setSettings({ launchAtLogin: e.target.checked });

// live wallpaper
const DESCRIBE = {
  off: "No live wallpaper. You can turn one on later.",
  water: "Calm water with drifting raindrop ripples.",
  butterflies: "Colourful butterflies over swaying grass.",
  fireflies: "Glowing fireflies in a night sky.",
  rain: "Falling green character rain.",
  stars: "Flying through a starfield.",
};
if (!caps.liveWallpaper) {
  $("live-lede").textContent = "Live wallpapers aren't available on Windows yet, but you can set any ASCII image as your desktop picture from the studio.";
  $("live-fine").textContent = "";
} else {
  for (const id of ["off", "water", "butterflies", "fireflies", "rain", "stars"]) {
    const b = Object.assign(document.createElement("button"), { className: "btn tile" });
    b.dataset.id = id;
    const name = id === "off" ? "None" : caps.scenes.find(([k]) => k === id)[1];
    b.append(Object.assign(document.createElement("strong"), { textContent: name }),
      Object.assign(document.createElement("span"), { textContent: DESCRIBE[id] }));
    b.onclick = async () => {
      live = id;
      document.querySelectorAll(".tile").forEach((t) => t.classList.toggle("on", t.dataset.id === id));
      await desk.setLiveWallpaper(id);           // applied straight away so you can see it
    };
    b.classList.toggle("on", id === live);
    $("tiles").appendChild(b);
  }
}

function summarise() {
  const items = [
    cameraOk ? "Camera is ready" : "Camera: allow it any time from the studio",
    $("login").checked ? "Opens quietly when you log in" : "Opens only when you start it",
    caps.liveWallpaper
      ? (live === "off" ? "No live wallpaper (turn one on from the " + where + ")" : `Live wallpaper: ${caps.scenes.find(([k]) => k === live)?.[1] || live}`)
      : "Still wallpapers are available in the studio",
  ];
  $("summary").replaceChildren(...items.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
}

show(0);
