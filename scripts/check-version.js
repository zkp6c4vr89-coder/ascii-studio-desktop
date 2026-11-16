// Fails if the pushed tag (vX.Y.Z) doesn't match package.json, the single source of the version.
const tag = (process.env.GITHUB_REF_NAME || process.argv[2] || "").replace(/^v/, "");
const { version } = require("../package.json");
if (!tag) { console.log(`no tag; package.json version is ${version}`); process.exit(0); }
if (tag !== version) {
  console.error(`Tag v${tag} doesn't match package.json version ${version}. Bump package.json, commit, then tag.`);
  process.exit(1);
}
console.log(`version ${version} matches tag`);
