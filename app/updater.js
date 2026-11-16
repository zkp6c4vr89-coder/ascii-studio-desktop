// Auto-updates without paid code-signing certificates.
//
// Every installer in a release has a detached Ed25519 signature (<file>.sig), made in CI with a
// private key that only lives in a GitHub Actions secret. The matching public key is below. Nothing
// is installed unless its signature verifies.
//
//   Windows  electron-updater downloads the NSIS installer in the background; we verify it, then let
//            it install when the app quits (or straight away if the user clicks "Restart to update").
//   macOS    we check the latest GitHub release, download the .dmg in the background, verify it, and
//            on quit (or "Restart to update") a small script swaps the new app into place. Files the
//            app downloads itself aren't quarantined, so Gatekeeper doesn't block the new version.
//            If the app can't replace itself (read-only location, run from the .dmg…), we just say
//            an update is available and link to the download.
//   Linux    notify only.
//
// Checks 30 s after launch and every 4 hours. Offline / GitHub down / rate-limited = silent.

const { app, net, Notification, shell, dialog } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const OWNER = "zkp6c4vr89-coder";
const REPO = "ascii-studio-desktop";
const PUBLIC_KEY = crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA8NFhqCxoO8m3g1hESR7nWcH/l9BcUKQblq5Fqi73Wx4=
-----END PUBLIC KEY-----`);

// Testing knobs (see RELEASING.md). Safe to leave: whatever the feed, signatures are still checked.
const FEED = process.env.ASCII_UPDATE_FEED || `https://api.github.com/repos/${OWNER}/${REPO}/releases`;
const ALLOW_PRERELEASE = process.env.ASCII_UPDATE_PRERELEASE === "1";
const FIRST_CHECK_MS = Number(process.env.ASCII_UPDATE_FIRST_CHECK_MS) || 30_000;
const EVERY_MS = 4 * 60 * 60 * 1000;

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

// ---------------------------------------------------------------- state
// status: idle | checking | downloading | ready | available | uptodate | error
let state = { status: "idle", version: null, page: `https://github.com/${OWNER}/${REPO}/releases/latest`, error: null };
let onChange = () => {};
let pending = null;            // macOS: { dmg } once a verified update is downloaded
let installing = false;
let notifiedFor = null;
function set(patch) { state = { ...state, ...patch }; onChange(state); }
function log(...parts) {      // a small diagnostic log: <userData>/updates/update.log
  try {
    const dir = path.join(app.getPath("userData"), "updates");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "update.log"), `${new Date().toISOString()} ${parts.join(" ")}\n`);
  } catch {}
}

// ---------------------------------------------------------------- helpers
function newer(a, b) {         // is version a newer than version b? (semver, prereleases sort lower)
  const parse = (v) => {
    const [main, pre] = String(v).replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((n) => parseInt(n, 10) || 0), pre: pre || null };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] || 0) !== (y.nums[i] || 0)) return (x.nums[i] || 0) > (y.nums[i] || 0);
  if (x.pre && !y.pre) return false;
  if (!x.pre && y.pre) return true;
  return (x.pre || "") > (y.pre || "");
}

function verify(file, signatureText) {
  try {
    const sig = Buffer.from(String(signatureText).trim(), "base64");
    return sig.length === 64 && crypto.verify(null, fs.readFileSync(file), PUBLIC_KEY, sig);
  } catch {
    return false;
  }
}

async function fetchOk(url, opts = {}) {
  const res = await net.fetch(url, { ...opts, headers: { "User-Agent": "ASCII-Studio-updater", ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

async function latestRelease() {
  const url = ALLOW_PRERELEASE ? `${FEED}?per_page=10` : `${FEED}/latest`;
  const data = await (await fetchOk(url, { headers: { Accept: "application/vnd.github+json" } })).json();
  const rel = Array.isArray(data) ? data.find((r) => !r.draft) : data;
  if (!rel || !rel.tag_name) throw new Error("no release");
  return {
    version: rel.tag_name.replace(/^v/, ""),
    page: rel.html_url || state.page,
    assets: Object.fromEntries((rel.assets || []).map((a) => [a.name, a.browser_download_url])),
  };
}

async function download(url, dest) {
  const res = await fetchOk(url);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title, body, silent: true }).show(); } catch {}
}

// ---------------------------------------------------------------- macOS: can we replace ourselves?
function macBundle() { return path.resolve(path.dirname(process.execPath), "..", ".."); }
function canSelfUpdate() {
  if (!IS_MAC || !app.isPackaged) return false;
  const bundle = macBundle();
  if (!bundle.endsWith(".app") || bundle.includes("/AppTranslocation/") || bundle.startsWith("/Volumes/")) return false;
  try {
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    fs.accessSync(bundle, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Swaps the new app into place after we've quit. Paths are passed as arguments, never pasted into
// the script. If anything fails, the old app is put back.
const APPLY_SCRIPT = `#!/bin/bash
set -u
PID="$1"; DMG="$2"; TARGET="$3"; RELAUNCH="$4"; LOG="$5"
exec >>"$LOG" 2>&1
echo "--- $(date) applying update"
for i in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
MNT="$(mktemp -d /tmp/ascii-update.XXXXXX)"
if ! hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG"; then echo "mount failed"; exit 1; fi
SRC="$(find "$MNT" -maxdepth 1 -name '*.app' -print -quit)"
STAGE="\${TARGET%.app}.updating.app"; OLD="\${TARGET%.app}.old.app"
rm -rf "$STAGE" "$OLD"
OK=0
if [ -n "$SRC" ] && ditto "$SRC" "$STAGE"; then OK=1; fi
hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet
rmdir "$MNT" 2>/dev/null
if [ "$OK" = 1 ]; then
  xattr -dr com.apple.quarantine "$STAGE" 2>/dev/null
  if mv "$TARGET" "$OLD" && mv "$STAGE" "$TARGET"; then
    rm -rf "$OLD" "$DMG" "$DMG.sig"; echo "updated"
  else
    [ -d "$OLD" ] && [ ! -d "$TARGET" ] && mv "$OLD" "$TARGET"
    rm -rf "$STAGE"; echo "swap failed, kept old version"
  fi
else
  rm -rf "$STAGE"; echo "copy failed, kept old version"
fi
[ "$RELAUNCH" = 1 ] && open "$TARGET"
exit 0
`;

function applyMacUpdate(relaunch) {
  if (!pending || installing) return;
  installing = true;
  const dir = path.join(app.getPath("userData"), "updates");
  const script = path.join(dir, "apply-update.sh");
  fs.writeFileSync(script, APPLY_SCRIPT, { mode: 0o700 });
  spawn("/bin/bash", [script, String(process.pid), pending.dmg, macBundle(), relaunch ? "1" : "0", path.join(dir, "update.log")],
    { detached: true, stdio: "ignore" }).unref();
}

// ---------------------------------------------------------------- the check
async function checkMac(manual) {
  const rel = await latestRelease();
  if (!newer(rel.version, app.getVersion())) return set({ status: "uptodate", version: rel.version, page: rel.page });
  if (pending && state.version === rel.version) return;                 // already downloaded

  const name = `ASCII-Studio-${rel.version}-mac-${process.arch}.dmg`;
  const dmgUrl = rel.assets[name], sigUrl = rel.assets[`${name}.sig`];
  if (!canSelfUpdate() || !dmgUrl || !sigUrl) {
    set({ status: "available", version: rel.version, page: rel.page });
    if (notifiedFor !== rel.version) { notifiedFor = rel.version; notify("ASCII Studio update available", `Version ${rel.version} is out. Get it from the menu-bar icon.`); }
    return;
  }
  set({ status: "downloading", version: rel.version, page: rel.page });
  const dir = path.join(app.getPath("userData"), "updates");
  fs.mkdirSync(dir, { recursive: true });
  const dmg = path.join(dir, name);
  await download(dmgUrl, dmg);
  const sig = await (await fetchOk(sigUrl)).text();
  if (!verify(dmg, sig)) {
    fs.rmSync(dmg, { force: true });
    return set({ status: "error", error: "The update's signature didn't match, so it wasn't installed." });
  }
  pending = { dmg };
  set({ status: "ready" });
  if (!manual) notify("ASCII Studio update ready", `Version ${rel.version} will install next time you quit, or restart now from the menu-bar icon.`);
}

async function checkLinux() {
  const rel = await latestRelease();
  if (!newer(rel.version, app.getVersion())) return set({ status: "uptodate", version: rel.version, page: rel.page });
  set({ status: "available", version: rel.version, page: rel.page });
  if (notifiedFor !== rel.version) { notifiedFor = rel.version; notify("ASCII Studio update available", `Version ${rel.version} is out. Get it from the tray icon.`); }
}

// Windows: electron-updater does the download and install; we gate the install on our signature.
let winUpdater = null;
function setupWindows() {
  const { autoUpdater } = require("electron-updater");
  winUpdater = autoUpdater;
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;      // switched on only once the signature checks out
  autoUpdater.allowPrerelease = ALLOW_PRERELEASE;
  autoUpdater.on("update-available", (info) => set({ status: "downloading", version: info.version }));
  autoUpdater.on("update-not-available", (info) => set({ status: "uptodate", version: info.version }));
  autoUpdater.on("error", () => { if (state.status === "checking" || state.status === "downloading") set({ status: "idle" }); });
  autoUpdater.on("update-downloaded", async (info) => {
    try {
      const fileName = (info.files && info.files[0] && info.files[0].url) || info.path || path.basename(info.downloadedFile);
      const sigUrl = `https://github.com/${OWNER}/${REPO}/releases/download/v${info.version}/${encodeURIComponent(path.basename(fileName))}.sig`;
      const sig = await (await fetchOk(sigUrl)).text();
      if (!verify(info.downloadedFile, sig)) throw new Error("bad signature");
      autoUpdater.autoInstallOnAppQuit = true;
      set({ status: "ready", version: info.version });
      notify("ASCII Studio update ready", `Version ${info.version} will install next time you quit, or restart now from the tray icon.`);
    } catch {
      try { fs.rmSync(info.downloadedFile, { force: true }); } catch {}
      set({ status: "error", error: "The update's signature didn't match, so it wasn't installed." });
    }
  });
}

let checking = false;
async function check({ manual = false } = {}) {
  if (checking || installing || state.status === "ready") return state;
  checking = true;
  set({ status: "checking", error: null });
  try {
    if (IS_WIN && winUpdater) {
      await winUpdater.checkForUpdates();                    // events above move the state on
      if (state.status === "checking") set({ status: "idle" });
    } else if (IS_MAC) await checkMac(manual);
    else await checkLinux();
  } catch (e) {
    log("check failed:", e && e.message);
    set({ status: manual ? "error" : "idle", error: manual ? "Couldn't reach GitHub. Check your connection and try again." : null });
  } finally {
    checking = false;
  }
  return state;
}

// ---------------------------------------------------------------- public API
function init(changed) {
  onChange = changed || onChange;
  if (!app.isPackaged && !process.env.ASCII_UPDATE_FEED) return;   // `npm start`: no update checks
  if (IS_WIN) { try { setupWindows(); } catch { return; } }
  setTimeout(() => check(), FIRST_CHECK_MS);
  setInterval(() => check(), EVERY_MS);
  // updating on quit: macOS swaps the app in; Windows is handled by electron-updater
  app.on("before-quit", () => { if (IS_MAC && pending) applyMacUpdate(false); });
}

async function checkNow() {
  const s = await check({ manual: true });
  const v = app.getVersion();
  if (s.status === "uptodate" || s.status === "idle") {
    dialog.showMessageBox({ type: "info", message: "You're up to date", detail: `ASCII Studio ${v} is the latest version.` });
  } else if (s.status === "error") {
    dialog.showMessageBox({ type: "warning", message: "Couldn't check for updates", detail: s.error || "" });
  } else if (s.status === "available") {
    const r = await dialog.showMessageBox({ type: "info", message: `ASCII Studio ${s.version} is available`, detail: `You have ${v}. Download the new version from GitHub.`, buttons: ["Download", "Later"] });
    if (r.response === 0) shell.openExternal(s.page);
  } else if (s.status === "ready") {
    const r = await dialog.showMessageBox({ type: "info", message: `ASCII Studio ${s.version} is ready`, detail: "Restart now to update, or it'll install next time you quit.", buttons: ["Restart now", "Later"] });
    if (r.response === 0) install();
  }
  return s;
}

function install() {
  if (state.status !== "ready") return;
  if (IS_WIN && winUpdater) { installing = true; winUpdater.quitAndInstall(true, true); return; }
  if (IS_MAC) { applyMacUpdate(true); app.quit(); }
}

function openDownloadPage() { shell.openExternal(state.page); }
function getState() { return { ...state, current: app.getVersion() }; }

module.exports = { init, checkNow, check, install, openDownloadPage, getState, _test: { newer, verify } };
