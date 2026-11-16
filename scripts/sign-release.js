// Signs every installer in a folder with the Ed25519 update key, writing <file>.sig (base64).
//   UPDATE_SIGNING_KEY="$(cat key.pem)" node scripts/sign-release.js dist
// The app refuses to install an update unless this signature verifies against its built-in key.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const dir = process.argv[2] || "dist";
const pem = process.env.UPDATE_SIGNING_KEY;
if (!pem) {
  console.error("UPDATE_SIGNING_KEY is not set. Add it as a GitHub Actions secret (see RELEASING.md).");
  process.exit(1);
}
const key = crypto.createPrivateKey(pem);
const files = fs.readdirSync(dir).filter((f) => /\.(dmg|exe|AppImage|deb)$/.test(f));
if (!files.length) { console.error(`no installers found in ${dir}`); process.exit(1); }
for (const f of files) {
  const file = path.join(dir, f);
  const sig = crypto.sign(null, fs.readFileSync(file), key).toString("base64");
  fs.writeFileSync(`${file}.sig`, sig + "\n");
  console.log(`signed ${f}`);
}
