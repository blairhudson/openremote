#!/usr/bin/env node
import { intro, outro, select, confirm, note, spinner, isCancel, cancel } from "@clack/prompts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const repoUrl = "https://github.com/blairhudson/openremote";
const docsUrl = "https://openremote.blairhudson.com";
const serverPlugin = "opencode-openremote";
const tuiPlugin = "opencode-openremote/tui";
const serverSchema = "https://opencode.ai/config.json";
const tuiSchema = "https://opencode.ai/tui.json";

function relativePath(file) {
  const home = homedir();
  if (file === home) return "~";
  if (file.startsWith(`${home}${path.sep}`)) return `~${path.sep}${path.relative(home, file)}`;
  const rel = path.relative(process.cwd(), file);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel || ".";
  return file;
}

function stop(message) {
  cancel(message);
  process.exit(1);
}

function exitIfCancel(value) {
  if (isCancel(value)) stop("Setup cancelled.");
  return value;
}

async function readConfig(file, schema, plugin) {
  let config = {};
  const exists = existsSync(file);
  if (exists) {
    const raw = await readFile(file, "utf8");
    try {
      config = JSON.parse(raw);
    } catch {
      throw new Error(`Could not parse:\n  ${relativePath(file)}\n\nFix JSON syntax, then run:\n  npx opencode-openremote`);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error(`Invalid config object:\n  ${relativePath(file)}`);
    }
  }

  if (config.plugin !== undefined && !Array.isArray(config.plugin)) {
    throw new Error(`Invalid plugin field:\n  ${relativePath(file)}\n\nExpected:\n  "plugin": ["${plugin}"]`);
  }

  const changes = [];
  const next = { ...config };
  if (next.$schema === undefined) {
    next.$schema = schema;
    changes.push(`add schema: ${schema}`);
  }
  const plugins = [...(next.plugin ?? [])];
  if (!plugins.includes(plugin)) {
    plugins.push(plugin);
    next.plugin = plugins;
    changes.push(`add plugin: ${plugin}`);
  } else {
    next.plugin = plugins;
    changes.push(`plugin already present: ${plugin}`);
  }

  return { file, next, changes, exists };
}

function configPreview(configs) {
  return configs
    .map((config) => `${relativePath(config.file)}\n${config.changes.map((change) => `  ${change}`).join("\n")}`)
    .join("\n\n");
}

async function writeConfig(config) {
  await mkdir(path.dirname(config.file), { recursive: true });
  await writeFile(config.file, `${JSON.stringify(config.next, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    console.error(`Unknown option: ${args[0]}\n\nRun setup with:\n  npx opencode-openremote`);
    process.exit(1);
  }

  intro("OpenRemote setup");
  note(
    "Install OpenRemote's OpenCode plugin and wire your config.\n\nOpenCode will install npm plugins automatically at startup.\n\nThis adds:\n  opencode.json  -> opencode-openremote\n  tui.json       -> opencode-openremote/tui",
    "Setup",
  );

  const scope = exitIfCancel(
    await select({
      message: "Where should OpenRemote be installed?",
      initialValue: "global",
      options: [
        { value: "global", label: "Global OpenCode config (~/.config/opencode)", hint: "recommended" },
        { value: "project", label: "Current project" },
      ],
    }),
  );

  const configDir = scope === "global" ? path.join(homedir(), ".config", "opencode") : process.cwd();
  const configs = [
    await readConfig(path.join(configDir, "opencode.json"), serverSchema, serverPlugin),
    await readConfig(path.join(configDir, "tui.json"), tuiSchema, tuiPlugin),
  ];

  const shouldWrite = exitIfCancel(
    await confirm({
      message: `Update OpenCode config files?\n\n${configPreview(configs)}`,
      initialValue: true,
    }),
  );
  if (!shouldWrite) stop("Setup cancelled.");

  const s = spinner();
  s.start("Updating config");
  for (const config of configs) await writeConfig(config);
  s.stop("Updated config");

  note(configPreview(configs), "Config");

  const shouldStar = exitIfCancel(
    await confirm({
      message: "Star blairhudson/openremote on GitHub?",
      initialValue: false,
    }),
  );
  if (shouldStar) {
    note(`Unable to star automatically. Please star the repo at:\n${repoUrl}`, "GitHub");
  }

  outro(`Setup complete\n\nRestart opencode for changes to take effect.\nOpenCode will install opencode-openremote automatically.\n\nNext:\n  opencode --mdns\n\nor:\n  opencode --hostname 0.0.0.0\n\nDocs:\n  ${docsUrl}`);
}

main().catch((error) => stop(error instanceof Error ? error.message : String(error)));
