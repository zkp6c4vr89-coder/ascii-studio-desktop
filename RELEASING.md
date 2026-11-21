# Releasing ASCII Studio

## The short version
```bash
npm version 1.2.0 --no-git-tag-version   # or edit "version" in package.json by hand
git commit -am "v1.2.0"
git tag -a v1.2.0 -m v1.2.0     # -a matters: --follow-tags only pushes annotated tags
git push --follow-tags
```
That's it. GitHub Actions builds the macOS, Windows and Linux installers, signs them for the
auto-updater, and publishes a GitHub Release. Installed apps pick it up within a few hours (or
straight away with **Check for updates…** in the menu-bar / tray icon).

- The version lives in **one place: `package.json`**. The app reads it at runtime and the build names
  files from it. The workflow refuses to build if the tag doesn't match (`scripts/check-version.js`).
- A tag with a dash, like `v1.3.0-beta.1`, is published as a **prerelease**. Normal installs ignore
  prereleases; that's what makes them safe for testing (see below).

## How updates work
Every installer in a release gets a detached **Ed25519 signature** (`<installer>.sig`), made in CI with
a private key that only exists in a GitHub secret. The app has the public key built in and **will not
install anything whose signature doesn't verify**.

| | What happens |
|---|---|
| **Windows** | electron-updater downloads the new installer in the background (`latest.yml`). We verify the signature, then it installs when you quit, or now via **Restart to update**. |
| **macOS** | The app reads the latest GitHub release, downloads the `.dmg` for your Mac in the background and verifies it. On quit (or **Restart to update**) it swaps the new app into place and relaunches. No Apple certificate needed: files the app downloads itself aren't quarantined. If the app can't replace itself (running from the `.dmg`, read-only folder…), it shows "Download version X…" instead. |
| **Linux** | Notify only: "Download version X…" opens the release page. |

Checks happen 30 s after launch and every 4 hours. Being offline, or GitHub being down or
rate-limiting, is silent. Problems are logged to `<app data>/updates/update.log`
(macOS: `~/Library/Application Support/ASCII Studio/updates/update.log`).

## Secrets
| Secret | What it is |
|---|---|
| `UPDATE_SIGNING_KEY` | The Ed25519 **private** key in PEM form (the whole file, `-----BEGIN PRIVATE KEY-----` … `-----END PRIVATE KEY-----`). |

`GITHUB_TOKEN` is provided automatically. Add the secret under
**GitHub → ascii-studio-desktop → Settings → Secrets and variables → Actions → New repository secret**,
or from the terminal:
```bash
gh secret set UPDATE_SIGNING_KEY -R zkp6c4vr89-coder/ascii-studio-desktop < ~/.ascii-studio-keys/update-signing-key.pem
```

## The signing key
The current key pair lives in `~/.ascii-studio-keys/` on the machine that made it:
- `update-signing-key.pem`: **private**. Never commit it, never share it.
- `update-signing-key.pub.pem`: public. Its contents are pasted into `app/updater.js` (`PUBLIC_KEY`).

> ⚠️ **Back up the private key** (password manager, encrypted USB…). If you lose it, you can't sign
> new releases with it, and **every app already installed will refuse all future updates**. Users
> would have to download the next version by hand. If it leaks, anyone with it could sign a fake update.

To make a new key pair (only for a fresh start, or if the old one leaked):
```bash
node -e "
const c=require('crypto'),fs=require('fs');
const {publicKey,privateKey}=c.generateKeyPairSync('ed25519');
fs.writeFileSync('update-signing-key.pem', privateKey.export({type:'pkcs8',format:'pem'}), {mode:0o600});
fs.writeFileSync('update-signing-key.pub.pem', publicKey.export({type:'spki',format:'pem'}));"
```
Then put the new public key into `app/updater.js`, update the `UPDATE_SIGNING_KEY` secret, and
release. Apps on older versions (which trust the old key) need one manual download to switch over.

## Testing an update end to end
### macOS
1. Install the current release from the `.dmg` into **Applications** and open it once
   (**System Settings → Privacy & Security → Open Anyway** the first time).
2. Make a test prerelease: set `package.json` to e.g. `1.2.1-test.1`, commit, `git tag -a v1.2.1-test.1 -m v1.2.1-test.1`,
   `git push --follow-tags`, and wait for the Actions run to finish.
3. Quit ASCII Studio, then start it so it looks at prereleases:
   ```bash
   ASCII_UPDATE_PRERELEASE=1 "/Applications/ASCII Studio.app/Contents/MacOS/ASCII Studio"
   ```
4. Use **Check for updates…** in the menu-bar icon. It should say **"ASCII Studio 1.2.1-test.1 is ready"**,
   which means it was downloaded and the signature verified.
5. Click **Restart now**. The app quits, swaps itself and reopens. The menu-bar icon's first line
   should show the new version, and you shouldn't get an "Open Anyway" prompt.
6. Check `~/Library/Application Support/ASCII Studio/updates/update.log` ends with `updated`.

### Windows
1. Install the current release with the `.exe`.
2. Publish a test prerelease as above.
3. In a terminal: `set ASCII_UPDATE_PRERELEASE=1` then start
   `"%LOCALAPPDATA%\Programs\ASCII Studio\ASCII Studio.exe"`.
4. **Check for updates…** in the tray icon, wait for "Update ready", then **Restart to update**.
   The installer runs silently and the app reopens on the new version.

### Bad signature (both systems)
Edit a test release on GitHub and replace one `.sig` with the `.sig` from a different file. The app
should report "The update's signature didn't match, so it wasn't installed." and stay on its version.

Afterwards, delete the test prerelease and its tag (`git push --delete origin v1.2.1-test.1`).

## Local test without GitHub (macOS)
`ASCII_UPDATE_FEED=http://127.0.0.1:8792/releases` points the updater at any server that answers like
the GitHub releases API. Signatures are still checked, so this can't be used to push an unsigned update.
