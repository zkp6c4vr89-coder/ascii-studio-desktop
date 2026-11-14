// `npm start`: launch the app in development. Clears ELECTRON_RUN_AS_NODE, which VS Code's
// terminal sets and which would otherwise start Electron as plain Node.js.
const { spawn } = require("node:child_process");
const electron = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [".", ...process.argv.slice(2)], { stdio: "inherit", env, cwd: require("node:path").join(__dirname, "..") });
child.on("exit", (code) => process.exit(code ?? 0));
