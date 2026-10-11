#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, lstatSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { assertNode, dataRoot, runNpm } from "./platform.mjs";
import { launch } from "./launch.mjs";

const ownRoot = fileURLToPath(new URL("../", import.meta.url));
const repository = "GeorgeTyupin/pi-setup";
function readState(agentDir) {
  const path = join(agentDir, "pi-config-state.json");
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}; }
  catch (error) { throw new Error(`Cannot read installer state: ${error.message}`); }
}
async function confirmAdoption(agentDir, state, { adopt, dryRun }) {
  if (adopt || dryRun || state.profile) return Boolean(adopt);
  const path = join(agentDir, "settings.json");
  if (!existsSync(path)) return false;
  let settings;
  try { settings = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`Cannot read existing settings: ${error.message}`); }
  if (Object.keys(settings).every(key => ["deviceId", "lastChangelogVersion", "enableInstallTelemetry"].includes(key))) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Existing unmanaged Pi settings: run pi-setup --adopt to preserve them and connect the configuration, or choose --agent-dir PATH");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Keep your existing Pi settings and connect this configuration? [y/N] ");
    if (!["y", "yes", "да"].includes(answer.trim().toLowerCase())) throw new Error("Installation cancelled; existing settings unchanged");
    return true;
  } finally { prompt.close(); }
}
export async function latestSource() {
  // Resolve main independently of npx's package cache, then install an immutable SHA.
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/main`, {
    headers: { "User-Agent": "pi-setup", Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Cannot resolve latest source: GitHub HTTP ${response.status}`);
  const { sha } = await response.json();
  if (!/^[a-f0-9]{40}$/.test(sha || "")) throw new Error("Invalid GitHub commit SHA");
  const releases = join(dataRoot(), "releases"), release = join(releases, sha);
  for (const path of [dataRoot(), releases, release]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing source cache symlink: ${path}`);
  }
  const root = join(release, "node_modules/pi-setup");
  if (!existsSync(release)) {
    mkdirSync(releases, { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(join(releases, ".download-"));
    try {
      runNpm(["install", "--prefix", staging, "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", `https://codeload.github.com/${repository}/tar.gz/${sha}`]);
      const manifest = JSON.parse(readFileSync(join(staging, "node_modules/pi-setup/package.json"), "utf8"));
      if (manifest.name !== "pi-setup" || manifest.bin?.["pi-setup"] !== "scripts/cli.mjs") throw new Error("Source is missing the universal installer");
      // Another process may have installed this same SHA while we were downloading.
      if (!existsSync(release)) renameSync(staging, release);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  if (!existsSync(join(root, "scripts/cli.mjs"))) throw new Error(`Incomplete source cache: ${release}`);
  return root;
}
export async function main(argv = process.argv.slice(2), { preparedRoot } = {}) {
  const separator = argv.indexOf("--"), piArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const { values, positionals } = parseArgs({ args: separator < 0 ? argv : argv.slice(0, separator), allowPositionals: true, options: {
    "agent-dir": { type: "string" }, profile: { type: "string" }, "source-root": { type: "string" },
    adopt: { type: "boolean" }, "dry-run": { type: "boolean" }, dryrun: { type: "boolean" }, "skip-install": { type: "boolean" },
    "no-launch": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("pi-setup [--agent-dir PATH] [--adopt] [--dry-run|--dryrun] [--no-launch]\nInstalls or updates the configuration, then launches Pi; pass Pi arguments after --.");
    return 0;
  }
  values["dry-run"] = Boolean(values["dry-run"] || values.dryrun);
  assertNode();
  // Legacy subcommands remain aliases; the installed state selects the operation.
  const requested = positionals[0];
  if ((requested && !["install", "update"].includes(requested)) || positionals.length > 1) throw new Error("Use pi-setup without a subcommand");
  const agentDir = resolve(values["agent-dir"] || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"));
  const state = readState(agentDir), profile = values.profile || state.profile || "home";
  const command = state.profile ? "update" : "install";
  if (!["home", "work"].includes(profile)) throw new Error("Unknown profile");
  if (state.profile && state.profile !== profile) throw new Error("Use a separate --agent-dir to switch profiles safely");
  let root = preparedRoot || (values["source-root"] && resolve(values["source-root"]));
  if (!root && profile === "work") {
    root = state.sourceRoot;
    if (!root || !existsSync(join(root, "work/settings.json"))) throw new Error("Work requires an existing local source with work/settings.json");
    if (command === "update" && !values["dry-run"]) {
      const git = args => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
      if (git(["status", "--porcelain"]).trim()) throw new Error("Work source has local changes; leaving them unchanged");
      if (git(["branch", "--show-current"]).trim() !== "main") throw new Error("Work source must be on main");
      console.log(git(["pull", "--ff-only"]).trim());
    }
  }
  if (!root) {
    root = await latestSource();
    // Also refresh installer code when npx reused an older cached bootstrap.
    if (resolve(root) !== resolve(ownRoot)) {
      const fresh = await import(pathToFileURL(join(root, "scripts/cli.mjs")).href);
      return fresh.main(argv, { preparedRoot: root });
    }
  }
  const adopt = await confirmAdoption(agentDir, state, { adopt: values.adopt, dryRun: values["dry-run"] });
  const { configure } = await import(pathToFileURL(join(root, "scripts/setup.mjs")).href);
  const result = configure({ root, agentDir, profile, adopt, dryRun: values["dry-run"], skipInstall: values["skip-install"] });
  if (values["dry-run"]) { console.log(JSON.stringify(result, null, 2)); return 0; }
  console.log(`Pi ${command === "update" ? "updated" : "installed"}.`);
  if (!values["no-launch"]) {
    if (!result.runtime) throw new Error("Pi runtime is missing; run pi-setup without --skip-install");
    return launch(agentDir, result.runtime, piArgs);
  }
  return 0;
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`pi-setup: ${error.message}`); process.exitCode = 1; });
}
