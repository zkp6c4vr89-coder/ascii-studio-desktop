# ASCII Studio: Desktop app

Turn photos, videos and your camera into colourful ASCII art, and bring your desktop to life
with **live ASCII wallpapers**. For macOS, Windows and Linux.

- **The full studio**: open photos and videos or use your camera; colour, Matrix and mono looks;
  character size, contrast, edge strokes, glow, shimmer and character speed; save images,
  record seamless 5 / 10 / 15 s or custom loops, copy as text
- **Live wallpapers** behind your desktop icons: Water, Butterflies, Fireflies, Rain, Starfield,
  or any photo or video from the studio. They react as you move the mouse, slow down on battery
  and pause while the screen is locked
- **Customise wallpaper** window (menu-bar icon or the studio): ripple & rain colours (or rainbow),
  laminar rain that flows round your cursor, umbrella on/off, and an optional desktop clock with six
  fonts (incl. ASCII digits), 15 colours, size, 12/24-hour, seconds, date style, position and a glass panel
- **Still wallpapers**: set any ASCII image as your desktop picture
- **Menu-bar / tray icon**: open the studio, switch wallpapers, turn "open at login" on or off
- **First-run setup guide**: camera, start at login and wallpaper, in about 30 seconds
- 100% on-device. Nothing is uploaded

| | macOS | Windows | Linux |
|---|---|---|---|
| Studio, camera, recording | ✅ | ✅ | ✅ |
| Still wallpaper | ✅ | ✅ | ✅ GNOME, KDE, feh |
| Live wallpaper | ✅ | ❌ (no supported way yet) | ⚠️ X11 desktops |
| Open at login | ✅ | ✅ | ✅ |
| Tested on real machines | ✅ | not yet | not yet |

## Download
Get the latest installer from the **[Releases page](../../releases/latest)**.

## Installing
The app isn't signed with a paid Apple or Microsoft certificate, so the **first** launch needs one extra
step. After that it **updates itself** (see below).

- **macOS:** open the `.dmg` and drag **ASCII Studio** into **Applications**, then open it. macOS will say
  it can't check the app for malicious software. Click **Done**, then go to
  **System Settings → Privacy & Security**, scroll down to the message about ASCII Studio and click
  **Open Anyway**, then **Open Anyway** again and enter your password. You only do this once.
- **Windows:** run the `.exe`. If SmartScreen appears, click **More info → Run anyway**.
- **Linux:** `chmod +x ASCII-Studio-*.AppImage` and run it, or install the `.deb`
  (`sudo apt install ./ASCII-Studio-*.deb`).

## Updates
ASCII Studio checks for new versions on launch and every few hours, downloads them in the background,
**checks their digital signature**, and installs them when you quit (or straight away with
**Restart to update** in the menu-bar / tray icon). The icon's menu also shows your version and has
**Check for updates…**. On macOS this needs the app to be in a folder it can write to, like
Applications; on Linux it tells you a new version is out. Versions before 1.2.0 have no updater, so
download 1.2.0 by hand once.

## Develop
```
npm install
npm start          # run the app
npm run dist:mac   # build installers into dist/ (also dist:win, dist:linux)
```
`npm start` works from VS Code's terminal too. VS Code sets `ELECTRON_RUN_AS_NODE`, which would
otherwise stop Electron from starting; `scripts/start.js` clears it.

**Releasing:** see [RELEASING.md](RELEASING.md). In short: bump `version` in `package.json`, commit,
`git tag vX.Y.Z`, `git push --follow-tags`.

## Layout
| Path | What it is |
|---|---|
| `app/main.js` | The app: windows, tray, wallpapers, open-at-login, security rules |
| `app/preload.js` | The small, fixed set of functions pages may call |
| `app/setup.*` | First-run setup guide |
| `app/live.*` | Live wallpaper page (scene + optional clock) |
| `app/customise.*` | Customise wallpaper window |
| `app/updater.js` | Auto-updates with Ed25519 signature checks |
| `scripts/sign-release.js` | Signs installers in CI (`UPDATE_SIGNING_KEY` secret) |
| `web/` | The studio and scenes, copied from **ascii-studio-web** (`python3 sync_web.py ../ascii-studio-web`) |
| `python-tools/` | The original Python tools, including the ASCII webcam for Zoom (macOS) |
| `.github/workflows/release.yml` | Builds and publishes the installers |

## Security
Pages are served from a private `app://` origin with a Content-Security-Policy, run sandboxed
with no Node.js access, can't navigate away or open windows, and only get camera permission for
the app's own pages. The app checks every message from a page, and file paths handed to the
operating system are always passed as arguments, never pasted into scripts.
