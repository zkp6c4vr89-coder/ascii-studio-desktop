// ASCII Studio desktop app (Electron main process).
// Windows: the studio (the web app), a first-run setup guide, and live-wallpaper windows
// that sit behind the desktop icons. Plus a menu-bar / tray icon and "open at login".

const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, protocol, session,
  systemPreferences, screen, shell, powerMonitor, Notification,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const updater = require("./updater");

const ROOT = path.join(__dirname, "..");                 // holds web/ (the studio) and app/
const ORIGIN = "app://ascii";
const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";
const LIVE_SUPPORTED = IS_MAC || IS_LINUX;               // Windows has no supported API for this
const MAC_DESKTOP_LEVEL = -2147483623;                   // CGWindowLevelForKey(kCGDesktopWindowLevelKey)
const SCENES = [
  ["water", "Water"], ["butterflies", "Butterflies"], ["fireflies", "Fireflies"],
  ["rain", "Rain"], ["stars", "Starfield"],
  ["snow", "Snowfall"], ["tree", "Christmas tree"], ["fireplace", "Fireplace"], ["aurora", "Northern lights"],
  ["custom", "My picture (from the studio)"],
];
const STONE_IDS = ["water", "butterflies", "fireflies", "rain", "stars", "snow"];   // see web/festive.js
const STONE_NAMES = { water: "blue", butterflies: "yellow", fireflies: "orange", rain: "red", stars: "purple", snow: "green" };
const LIVE_IDS = new Set(["off", ...SCENES.map(([id]) => id)]);
const startedHidden = process.argv.includes("--hidden");

// Pages are served from a private app:// scheme rather than file://, so they get a real,
// secure origin (needed for the camera, IndexedDB and ES modules) and can't read other files.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// For testing: run with a separate, throwaway settings folder.
if (process.env.ASCII_STUDIO_USER_DATA) app.setPath("userData", process.env.ASCII_STUDIO_USER_DATA);

if (!app.requestSingleInstanceLock()) app.quit();

// ---------------------------------------------------------------- settings
const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");
const DEFAULTS = {
  setupDone: false, launchAtLogin: false, liveWallpaper: "off", sceneOpts: {}, clockShow: false, clockOpts: {},
  festive: { snow: true, lights: true }, stones: [], season: {},
};
let settings = { ...DEFAULTS };
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")) }; } catch { settings = { ...DEFAULTS }; }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------- app:// file server
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:", "media-src 'self' blob: mediastream:", "connect-src 'self' blob:",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");
function serveAppProtocol() {
  protocol.handle("app", async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const top = rel.split("/")[0];
    const file = path.normalize(path.join(ROOT, rel));
    // only web/ and app/, and never escape them (no ../ tricks)
    if (url.host !== "ascii" || !["web", "app"].includes(top) || !file.startsWith(path.join(ROOT, top) + path.sep)) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const body = await fs.promises.readFile(file);
      const headers = { "content-type": MIME[path.extname(file)] || "application/octet-stream" };
      if (file.endsWith(".html")) headers["content-security-policy"] = CSP;   // pages run only our own code
      return new Response(body, { headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

// ---------------------------------------------------------------- windows
const PRELOAD = path.join(__dirname, "preload.js");
const secureWeb = { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false };
let studioWin = null, setupWin = null, liveWins = [];

function openStudio() {
  if (studioWin && !studioWin.isDestroyed()) { studioWin.show(); studioWin.focus(); return; }
  studioWin = new BrowserWindow({
    width: 1320, height: 860, minWidth: 760, minHeight: 560, title: "ASCII Studio",
    backgroundColor: "#0b0a12", show: false, webPreferences: secureWeb,
  });
  studioWin.loadURL(`${ORIGIN}/web/index.html`);
  studioWin.once("ready-to-show", () => studioWin.show());
  studioWin.on("closed", () => { studioWin = null; });
}

function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) { setupWin.focus(); return; }
  setupWin = new BrowserWindow({
    width: 760, height: 600, resizable: false, maximizable: false, title: "Welcome to ASCII Studio",
    backgroundColor: "#0b0a12", show: false, webPreferences: secureWeb,
  });
  setupWin.loadURL(`${ORIGIN}/app/setup.html`);
  setupWin.once("ready-to-show", () => setupWin.show());
  setupWin.on("closed", () => { setupWin = null; });
}

// ---------------------------------------------------------------- wallpaper customisation
// Only known keys with the right kind of value are kept, whatever a page sends.
const COLOR = (v) => typeof v === "string" && (/^#[0-9a-f]{6}$/i.test(v) || v === "rainbow");
const NUM = (lo, hi) => (v) => typeof v === "number" && v >= lo && v <= hi;
const BOOL = (v) => typeof v === "boolean";
const ONE_OF = (...xs) => (v) => xs.includes(v);
const SCHEMAS = {
  water: { color: COLOR, size: NUM(0.5, 2), raindrops: BOOL },
  rain: { umbrella: BOOL, fluid: BOOL, strength: NUM(0.4, 2), color: COLOR },
  snow: { color: COLOR, amount: NUM(0.3, 2), pile: BOOL },
  tree: { lights: ONE_OF("multi", "warm", "ice") },
  festive: { snow: BOOL, lights: BOOL },
  clock: {
    font: ONE_OF("modern", "serif", "mono", "rounded", "typewriter", "ascii"), weight: ONE_OF(300, 600, 800),
    size: NUM(0.5, 2), color: COLOR, hours: ONE_OF("auto", "12", "24"), seconds: BOOL,
    date: ONE_OF("long", "short", "numeric", "hidden"), position: ONE_OF("center", "top-left", "bottom-left"), panel: BOOL,
    countdown: BOOL,
  },
};
function clean(obj, schema) {
  const out = {};
  if (obj && typeof obj === "object") for (const [k, ok] of Object.entries(schema)) if (ok(obj[k])) out[k] = obj[k];
  return out;
}
function wallpaperConfig() {
  return {
    scene: settings.liveWallpaper, sceneOpts: settings.sceneOpts, clockShow: settings.clockShow, clockOpts: settings.clockOpts,
    festive: settings.festive, stones: settings.stones,
  };
}
function sendConfig() {
  for (const w of liveWins) if (!w.isDestroyed()) w.webContents.send("config", wallpaperConfig());
  if (customiseWin && !customiseWin.isDestroyed()) customiseWin.webContents.send("config", wallpaperConfig());
}
function setWallpaperConfig(patch = {}) {
  if (patch.sceneId in SCENE_SCHEMAS && patch.sceneOpts) {
    settings.sceneOpts = { ...settings.sceneOpts, [patch.sceneId]: { ...settings.sceneOpts[patch.sceneId], ...clean(patch.sceneOpts, SCHEMAS[patch.sceneId]) } };
  }
  if (typeof patch.clockShow === "boolean") settings.clockShow = patch.clockShow;
  if (patch.clockOpts) settings.clockOpts = patch.clockReset ? clean(patch.clockOpts, SCHEMAS.clock) : { ...settings.clockOpts, ...clean(patch.clockOpts, SCHEMAS.clock) };
  if (patch.festive) settings.festive = { ...settings.festive, ...clean(patch.festive, SCHEMAS.festive) };
  saveSettings();
  for (const w of liveWins) if (!w.isDestroyed()) w.webContents.send("config", wallpaperConfig());
  return { ok: true };
}
const SCENE_SCHEMAS = { water: 1, rain: 1, snow: 1, tree: 1 };

// ---------------------------------------------------------------- the six stones
// The wallpaper reports a stone when the cursor rests on it; the snap is started from the
// Customise window once all six are found.
function collectStone(id) {
  if (!STONE_IDS.includes(id) || settings.stones.includes(id)) return { ok: false };
  settings.stones = [...settings.stones, id];
  saveSettings();
  sendConfig();
  const n = settings.stones.length;
  notify(n === 6 ? "All six stones" : `You found the ${STONE_NAMES[id]} stone`,
    n === 6 ? "Snap from the Customise wallpaper window." : `${n} of 6. Each one hides in a different wallpaper.`);
  return { ok: true };
}
function snapNow() {
  if (STONE_IDS.some((id) => !settings.stones.includes(id)) || !liveWins.length) return { ok: false };
  liveJS("window.snap && window.snap()");
  return { ok: true };
}
function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body, silent: true }).show(); } catch {}
}

// ---------------------------------------------------------------- Christmas season
// In December the live wallpaper turns festive once (only if one is on, and never over
// "My picture"); "Back to …" in the menus undoes it; after 6 Jan it goes back if untouched.
let seasonal = null;
async function seasonCheck() {
  try { seasonal = seasonal || await import(pathToFileURL(path.join(ROOT, "web", "seasonal.js")).href); } catch { return; }
  if (!LIVE_SUPPORTED) return;
  const d = seasonal.autoSwitchDecision(settings.liveWallpaper, settings.season);
  if (!d) return;
  settings.season = d.season;
  saveSettings();
  if (d.restore && LIVE_IDS.has(d.restore)) setLive(d.restore);
  if (d.switch) {
    setLive(d.switch);
    notify(d.christmasDay ? "Merry Christmas!" : "Your wallpaper is festive for December",
      `Switched to ${sceneName(d.switch)}. To undo, choose "Back to ${sceneName(d.season.prev)}" from the ASCII Studio menu.`);
  }
  buildTray(); buildAppMenu();
}
function sceneName(id) { return (SCENES.find(([s]) => s === id) || [id, id])[1]; }
function seasonUndoItem() {
  const s = settings.season || {};
  if (s.done || !s.prev || settings.liveWallpaper !== s.picked) return [];
  return [{ label: `Back to ${sceneName(s.prev)}`, click: () => {
    settings.season = { ...s, done: true };
    setLive(s.prev);
    buildAppMenu();
  } }];
}

let customiseWin = null;
function openCustomise() {
  if (customiseWin && !customiseWin.isDestroyed()) { customiseWin.show(); customiseWin.focus(); return; }
  customiseWin = new BrowserWindow({
    width: 440, height: 760, minWidth: 380, minHeight: 480, title: "Customise wallpaper",
    backgroundColor: "#0b0a12", show: false, webPreferences: secureWeb,
  });
  customiseWin.loadURL(`${ORIGIN}/app/customise.html`);
  customiseWin.once("ready-to-show", () => customiseWin.show());
  customiseWin.on("closed", () => { customiseWin = null; });
}

// ---------------------------------------------------------------- live wallpaper
function stopLive() {
  clearInterval(pointerTimer);
  for (const w of liveWins) if (!w.isDestroyed()) w.destroy();
  liveWins = [];
}

// The wallpaper sits behind the desktop icons, so it never receives mouse events. Instead we
// read the cursor position (no special permission needed) and pass it to the wallpaper, so
// butterflies flee, fireflies gather, rain parts and water leaves a wake as you move.
let pointerTimer = null, lastPt = null;
function trackPointer() {
  clearInterval(pointerTimer);
  if (!liveWins.length) return;
  pointerTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    if (lastPt && p.x === lastPt.x && p.y === lastPt.y) return;
    lastPt = p;
    for (const w of liveWins) {
      if (w.isDestroyed()) continue;
      const b = w.displayBounds;
      if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) {
        w.webContents.send("pointer", { x: p.x - b.x, y: p.y - b.y });
      }
    }
  }, 33);
}
function startLive(id) {
  stopLive();
  if (!LIVE_SUPPORTED || id === "off") return;
  const fps = powerMonitor.isOnBatteryPower() ? 15 : 30;
  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow({
      ...d.bounds,
      // Linux: a real "desktop" window (X11). macOS: placed by hand below, because Electron's
      // "desktop" type shares a layer with the system wallpaper and can end up hidden behind it.
      ...(IS_LINUX ? { type: "desktop" } : {}),
      frame: false, show: false, focusable: false, skipTaskbar: true,
      hasShadow: false, resizable: false, movable: false, enableLargerThanScreen: true,
      backgroundColor: "#000000",
      webPreferences: {
        preload: path.join(__dirname, "live-preload.js"),
        contextIsolation: true, sandbox: true, backgroundThrottling: false,
      },
    });
    w.displayBounds = d.bounds;
    w.setIgnoreMouseEvents(true);
    if (IS_MAC) {
      // kCGDesktopWindowLevel: just above the system wallpaper, below the desktop icons.
      w.setAlwaysOnTop(true, "normal", MAC_DESKTOP_LEVEL);
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    }
    w.loadURL(`${ORIGIN}/app/live.html?scene=${encodeURIComponent(id)}&fps=${fps}`);
    w.once("ready-to-show", () => { w.setBounds(d.bounds); w.showInactive(); });
    liveWins.push(w);
  }
  trackPointer();
}
function setLive(id) {
  if (!LIVE_IDS.has(id)) return { ok: false, error: "Unknown wallpaper." };
  if (!LIVE_SUPPORTED && id !== "off") return { ok: false, error: "Live wallpapers aren't supported on Windows yet." };
  settings.liveWallpaper = id;
  saveSettings();
  startLive(id);
  buildTray();
  buildAppMenu();
  if (customiseWin && !customiseWin.isDestroyed()) customiseWin.webContents.send("scene-changed", id);
  return { ok: true };
}
function liveJS(code) {
  for (const w of liveWins) if (!w.isDestroyed()) w.webContents.executeJavaScript(code).catch(() => {});
}

// ---------------------------------------------------------------- still wallpaper
function run(cmd, args, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 20000 }, (err) => resolve(!err));
  });
}
async function setStillWallpaper(buf) {
  const bytes = Buffer.from(buf);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 8 || bytes.length > 200 * 1024 * 1024 || !bytes.subarray(0, 8).equals(PNG)) {
    return { ok: false, error: "That isn't a PNG image." };
  }
  const dir = path.join(app.getPath("userData"), "wallpapers");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.startsWith("ascii-")) fs.rmSync(path.join(dir, f), { force: true });
  const file = path.join(dir, `ascii-${Date.now()}.png`);   // new name each time: macOS caches by name
  fs.writeFileSync(file, bytes);

  // The path is always passed as an argument or environment variable, never pasted into a
  // script, so it can't be used to inject commands.
  let ok = false;
  if (IS_MAC) {
    ok = await run("osascript", ["-e", "on run argv",
      "-e", 'tell application "System Events" to tell every desktop to set picture to (item 1 of argv)',
      "-e", "end run", file]);
  } else if (IS_WIN) {
    const ps = 'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public class W { [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int SystemParametersInfo(int a, int b, string c, int d); }\'; ' +
      "[void][W]::SystemParametersInfo(20, 0, $env:ASCII_WALLPAPER, 3)";
    ok = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { ASCII_WALLPAPER: file });
  } else {
    const uri = pathToFileURL(file).href.replace(/'/g, "%27");
    ok = (await run("gsettings", ["set", "org.gnome.desktop.background", "picture-uri", `'${uri}'`]))
      && (await run("gsettings", ["set", "org.gnome.desktop.background", "picture-uri-dark", `'${uri}'`]) || true);
    if (!ok) ok = await run("plasma-apply-wallpaperimage", [file]);      // KDE Plasma
    if (!ok) ok = await run("feh", ["--bg-fill", file]);                 // lightweight window managers
  }
  if (ok) {
    if (settings.liveWallpaper !== "off") setLive("off");              // a live wallpaper would cover it
    return { ok: true };
  }
  return { ok: false, error: "your desktop didn't accept the image" };
}

// ---------------------------------------------------------------- open at login
function linuxAutostartFile() { return path.join(os.homedir(), ".config", "autostart", "ascii-studio.desktop"); }
function setLaunchAtLogin(on) {
  settings.launchAtLogin = !!on;
  saveSettings();
  if (IS_LINUX) {
    const file = linuxAutostartFile();
    if (!on) { fs.rmSync(file, { force: true }); return; }
    const exe = process.env.APPIMAGE || process.execPath;
    const quoted = `"${exe.replace(/(["`$\\])/g, "\\$1")}"`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ["[Desktop Entry]", "Type=Application", "Name=ASCII Studio",
      `Exec=${quoted} --hidden`, "X-GNOME-Autostart-enabled=true", ""].join("\n"));
  } else {
    app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true, args: ["--hidden"] });
  }
  buildTray();
}
function openedAtLogin() {
  if (startedHidden) return true;
  try { return IS_MAC && app.getLoginItemSettings().wasOpenedAtLogin; } catch { return false; }
}

// The update line shared by the tray and the app menu.
function updateMenuItem() {
  const u = updater.getState();
  return u.status === "ready" ? { label: `Restart to Update to ${u.version}`, click: () => updater.install() }
    : u.status === "downloading" ? { label: `Downloading Update ${u.version || ""}…`, enabled: false }
      : u.status === "available" ? { label: `Download Version ${u.version}…`, click: () => updater.openDownloadPage() }
        : u.status === "checking" ? { label: "Checking for Updates…", enabled: false }
          : { label: "Check for Updates…", click: () => updater.checkNow() };
}

// The menu at the top of the screen (macOS) or in the window (Windows / Linux).
// "Check for Updates…" lives here as well as in the tray, because the menu-bar icon
// can end up hidden behind the notch on MacBooks.
function buildAppMenu() {
  const update = updateMenuItem();
  const version = { label: `Version ${app.getVersion()}`, enabled: false };
  const wallpaper = [
    ...seasonUndoItem(),
    { label: "Customise Wallpaper…", enabled: LIVE_SUPPORTED, click: openCustomise },
    { label: "Run Setup Again", click: openSetup },
  ];
  const template = [
    ...(IS_MAC ? [{
      label: app.name,
      submenu: [
        { role: "about" }, update, version,
        { type: "separator" }, ...wallpaper,
        { type: "separator" }, { role: "services" },
        { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" }, { role: "quit" },
      ],
    }] : []),
    { role: "fileMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        ...(IS_MAC ? [] : [update, version, { type: "separator" }, ...wallpaper, { type: "separator" }]),
        { label: "ASCII Studio on GitHub", click: () => shell.openExternal("https://github.com/zkp6c4vr89-coder/ascii-studio-desktop") },
        { label: "Support on Ko-fi", click: () => shell.openExternal("https://ko-fi.com/nandhu_sauce") },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Tell the studio when the update state changes, so its About card stays current.
function updatesChanged() {
  buildTray();
  buildAppMenu();
  if (studioWin && !studioWin.isDestroyed()) studioWin.webContents.send("update-state", updater.getState());
}

// ---------------------------------------------------------------- tray / menu-bar icon
let tray = null;
function buildTray() {
  if (!tray) {
    const img = IS_MAC
      ? nativeImage.createFromPath(path.join(__dirname, "icons", "trayTemplate.png"))
      : nativeImage.createFromPath(path.join(__dirname, "icons", "tray.png"));
    if (IS_MAC) img.setTemplateImage(true);
    tray = new Tray(img);
    tray.setToolTip("ASCII Studio");
    if (!IS_MAC) tray.on("click", openStudio);
  }
  const liveItems = LIVE_SUPPORTED
    ? [["off", "Off"], ...SCENES].map(([id, label]) => ({
      label, type: "radio", checked: settings.liveWallpaper === id, click: () => {
        setLive(id);
        if (customiseWin && !customiseWin.isDestroyed()) customiseWin.webContents.send("scene-changed", id);
      },
    }))
    : [{ label: "Not available on Windows yet", enabled: false }];
  const updateItem = updateMenuItem();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `ASCII Studio ${app.getVersion()}`, enabled: false },
    updateItem,
    { type: "separator" },
    { label: "Open ASCII Studio", click: openStudio },
    { type: "separator" },
    { label: "Live wallpaper", submenu: liveItems },
    ...seasonUndoItem(),
    { label: "Customise wallpaper…", enabled: LIVE_SUPPORTED, click: openCustomise },
    { label: "Open at login", type: "checkbox", checked: settings.launchAtLogin, click: (i) => setLaunchAtLogin(i.checked) },
    { label: "Run setup again", click: openSetup },
    { type: "separator" },
    { label: "Quit ASCII Studio", role: "quit" },
  ]));
}

// ---------------------------------------------------------------- messages from pages
// Only our own pages may call these, and every argument is checked.
function fromUs(e) { return (e.senderFrame?.url || "").startsWith(`${ORIGIN}/`); }
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromUs(e)) throw new Error("blocked");
    return fn(...args);
  });
}
function registerIpc() {
  handle("capabilities", () => ({ liveWallpaper: LIVE_SUPPORTED, platform: process.platform, scenes: SCENES }));
  handle("settings:get", () => ({ ...settings }));
  handle("settings:set", (patch) => {
    if (patch && typeof patch.launchAtLogin === "boolean") setLaunchAtLogin(patch.launchAtLogin);
    if (patch && typeof patch.liveWallpaper === "string") return setLive(patch.liveWallpaper);
    return { ok: true };
  });
  handle("wallpaper:still", (buf) => (buf instanceof ArrayBuffer || ArrayBuffer.isView(buf)
    ? setStillWallpaper(buf) : { ok: false, error: "bad image" }));
  handle("wallpaper:live", (id) => {
    const res = setLive(String(id));
    if (customiseWin && !customiseWin.isDestroyed()) customiseWin.webContents.send("scene-changed", settings.liveWallpaper);
    return res;
  });
  handle("wallpaper:config:get", () => ({ ...wallpaperConfig(), liveSupported: LIVE_SUPPORTED }));
  handle("wallpaper:config:set", (patch) => setWallpaperConfig(patch));
  handle("window:customise", () => { openCustomise(); return { ok: true }; });
  handle("stones:collect", (id) => collectStone(id));
  handle("wallpaper:snap", () => snapNow());
  handle("update:state", () => updater.getState());
  handle("update:check", async () => { await updater.check({ manual: true }); return updater.getState(); });
  handle("update:install", () => { updater.install(); return { ok: true }; });
  handle("update:download", () => { updater.openDownloadPage(); return { ok: true }; });
  handle("camera:ask", async () => {
    if (!IS_MAC) return true;                      // Windows/Linux ask when the camera starts
    return systemPreferences.askForMediaAccess("camera");
  });
  handle("setup:finish", () => {
    settings.setupDone = true;
    saveSettings();
    if (setupWin) setupWin.close();
    openStudio();
    return { ok: true };
  });
}

// ---------------------------------------------------------------- hardening
function harden() {
  const ours = (url) => (url || "").startsWith(`${ORIGIN}/`);
  // camera only for our own pages; everything else (location, notifications…) is denied
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === "media" && ours(wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === "media" && ours(wc?.getURL()));
  app.on("web-contents-created", (_e, wc) => {
    wc.on("will-navigate", (e, url) => { if (!ours(url)) e.preventDefault(); });
    wc.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) shell.openExternal(url);    // links open in the real browser
      return { action: "deny" };
    });
  });
}

// ---------------------------------------------------------------- start
app.on("second-instance", () => (settings.setupDone ? openStudio() : openSetup()));
app.on("activate", () => (settings.setupDone ? openStudio() : openSetup()));   // macOS Dock click
app.on("window-all-closed", () => { /* keep running in the menu bar / tray */ });

app.whenReady().then(() => {
  app.setName("ASCII Studio");
  loadSettings();
  serveAppProtocol();
  harden();
  registerIpc();
  buildTray();
  buildAppMenu();
  updater.init(updatesChanged);
  seasonCheck();
  setInterval(seasonCheck, 60 * 60 * 1000);           // notices 1 Dec / 7 Jan without a restart

  if (!settings.setupDone) openSetup();
  else if (!openedAtLogin()) openStudio();
  if (settings.liveWallpaper !== "off") startLive(settings.liveWallpaper);

  // rebuild wallpapers when screens change; go easy on the battery
  const restart = () => settings.liveWallpaper !== "off" && startLive(settings.liveWallpaper);
  screen.on("display-added", restart);
  screen.on("display-removed", restart);
  screen.on("display-metrics-changed", restart);
  powerMonitor.on("on-battery", () => liveJS("window.setFps && window.setFps(15)"));
  powerMonitor.on("on-ac", () => liveJS("window.setFps && window.setFps(30)"));
  powerMonitor.on("lock-screen", () => liveJS("window.setPaused && window.setPaused(true)"));
  powerMonitor.on("unlock-screen", () => liveJS("window.setPaused && window.setPaused(false)"));
});
