import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "packages/opencode-plugin/package.json");
const cliPath = resolve(root, "packages/opencode-plugin/bin/cli.mjs");
const serverPath = resolve(root, "packages/opencode-plugin/src/index.ts");
const tuiPath = resolve(root, "packages/opencode-plugin/src/tui.tsx");
const runtime = process.execPath;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(args) {
  return new Promise((resolvePromise, reject) => {
    execFile(runtime, args, { cwd: root, timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${runtime} ${args.join(" ")} failed\n${stdout}${stderr}`));
        return;
      }
      resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const cli = await readFile(cliPath, "utf8");
const server = await readFile(serverPath, "utf8");
const tui = await readFile(tuiPath, "utf8");

assert(packageJson.name === "opencode-openremote", "plugin package name changed");
assert(packageJson.bin?.["opencode-openremote"] === "bin/cli.mjs", "opencode-openremote bin alias changed");
assert(packageJson.bin?.oo === "bin/cli.mjs", "oo bin alias changed");
assert(packageJson.exports?.["."] === "./src/index.ts", "server export changed");
assert(packageJson.exports?.["./tui"] === "./src/tui.tsx", "tui export changed");
assert(packageJson["oc-plugin"]?.includes("server"), "oc-plugin missing server");
assert(packageJson["oc-plugin"]?.includes("tui"), "oc-plugin missing tui");

assert(cli.startsWith("#!/usr/bin/env node"), "CLI shebang changed");
assert(cli.includes('if (command === "--help" || command === "-h" || command === "help")'), "gateway help parser missing");
assert(cli.includes('if (config.plugin !== undefined && !Array.isArray(config.plugin))'), "setup config schema guard missing");
assert(cli.includes('console.error(`Unknown gateway command: ${command}'), "unknown gateway command contract missing");

assert(server.includes("export const server"), "server plugin export missing");
assert(server.includes('event.type !== "server.connected"'), "server.connected contract missing");
assert(tui.includes("export const tui"), "tui plugin export missing");
assert(tui.includes('api.event.on("tui.command.execute"'), "tui command event listener missing");
assert(tui.includes("api.command.register"), "tui command registration missing");
assert(tui.includes("api.slots.register"), "tui slot registration missing");
assert(tui.includes("export default { id, tui }"), "tui default export changed");

const help = await run([cliPath, "gateway", "--help"]);
assert(help.stdout.includes("opencode-openremote gateway --help"), "gateway help output changed");

console.log("plugin smoke ok");
