import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync, lstatSync, chmodSync, realpathSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { checkPortability } from "./check-portability.mjs";

export const sourceRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
function readJson(path, optional = false) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (optional && error.code === "ENOENT") return {}; throw new Error(`Cannot read JSON ${path}: ${error.message}`); }
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sourceValue = item => typeof item === "string" ? item : item.source;
function packageId(item) {
  const source = sourceValue(item);
  return /^npm:/.test(source) ? source.replace(/^(npm:(?:@[^/]+\/)?[^@]+)@.*$/, "$1") : source;
}
function resolveSource(item, root) {
  const source = sourceValue(item);
  if (/^(?:npm:|git:|https?:)/.test(source)) return item;
  const path = source.startsWith("~/") ? join(homedir(), source.slice(2)) : resolve(root, source);
  return typeof item === "string" ? path : { ...item, source: path };
}

export function planSettings({ root, agentDir, profile, current = {}, state = {}, base, work = {} }) {
  if (!["home", "work"].includes(profile)) throw new Error("Profile must be home or work");
  if (state.profile && state.profile !== profile) throw new Error("Use a separate --agent-dir to switch profiles safely");
  const result = { ...current };
  const desired = { ...base, ...(profile === "work" ? work : {}) };
  const managedValues = {};
  for (const [key, value] of Object.entries(desired)) {
    if (["packages", "extensions", "skills", "prompts", "themes"].includes(key)) continue;
    managedValues[key] = value;
    if (!(key in current) || equal(current[key], state.managedValues?.[key])) result[key] = value;
  }
  const managedPackages = [...base.packages, ...(profile === "work" ? (work.packages ?? []).map(item => resolveSource(item, root)) : [])];
  if (resolve(root) !== resolve(agentDir)) managedPackages.push(resolve(root));
  const managedIds = new Set([...managedPackages, ...(state.managedPackages ?? [])].map(packageId));
  const packageMap = new Map((current.packages ?? []).map(item => resolveSource(item, agentDir)).filter(item => !managedIds.has(packageId(item))).map(item => [packageId(item), item]));
  for (const item of managedPackages) packageMap.set(packageId(item), item);
  result.packages = [...packageMap.values()];
  const managedPaths = {};
  for (const key of ["extensions", "skills", "prompts", "themes"]) {
    const old = new Set(state.managedPaths?.[key] ?? []);
    const extra = (current[key] ?? []).filter(path => !old.has(path));
    const wanted = [...(base[key] ?? []).map(path => resolve(root, path)), ...(profile === "work" ? (work[key] ?? []).map(path => resolve(root, path)) : [])];
    if (profile === "work" && ["extensions", "skills"].includes(key)) wanted.push(join(root, "work", key));
    managedPaths[key] = wanted;
    if (extra.length || wanted.length || key in current) result[key] = [...new Set([...extra, ...wanted])];
  }
  return { settings: result, managedPackages, managedPaths, managedValues };
}

const BEGIN = "<!-- BEGIN PI CONFIG -->", END = "<!-- END PI CONFIG -->";
export function mergeInstructions(existing, template, root) {
  const block = `${BEGIN}\n${template.replaceAll("{{SOURCE_ROOT}}", root).trim()}\n${END}`;
  const first = existing.indexOf(BEGIN), last = existing.indexOf(END);
  if ((first < 0) !== (last < 0) || (first >= 0 && last < first)) throw new Error("Malformed Pi configuration instruction block");
  if (first >= 0) return existing.slice(0, first) + block + existing.slice(last + END.length);
  return `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`;
}

function saveFile(path, content, agentDir, mode = 0o600) {
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to overwrite symlink: ${path}`);
    if (readFileSync(path, "utf8") === content) return;
    const backup = join(agentDir, "backups", `config-${Date.now()}-${process.pid}`, path.slice(agentDir.length).replace(/^\//, ""));
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    copyFileSync(path, backup);
    chmodSync(backup, 0o600);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, content, { mode, flag: "wx" });
  renameSync(temp, path);
}
const shellQuote = text => `'${text.replaceAll("'", "'\\''")}'`;
function findPi(root, agentDir, version) {
  let external;
  try { external = execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim(); } catch { /* optional */ }
  for (const path of [join(agentDir, "bin/pi"), join(root, "bin/pi"), external].filter(Boolean)) {
    try {
      const output = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 15000 }).trim();
      if (output === version) return path;
    } catch { /* use a private pinned runtime instead */ }
  }
  const privatePi = join(agentDir, "runtime/node_modules/.bin/pi");
  try { if (execFileSync(privatePi, ["--version"], { encoding: "utf8", timeout: 15000 }).trim() === version) return privatePi; } catch { /* not installed */ }
  return undefined;
}

export function configure({ root = sourceRoot, agentDir, profile, adopt = false, dryRun = false, skipInstall = false }) {
  root = resolve(root); agentDir = resolve(agentDir);
  const result = checkPortability(root);
  if (result.errors.length) throw new Error(`Portability check failed:\n${result.errors.join("\n")}`);
  const manifest = readJson(join(root, "package.json"));
  const base = readJson(join(root, "config/settings.base.json"));
  const settingsPath = join(agentDir, "settings.json");
  const statePath = join(agentDir, "pi-config-state.json");
  const current = readJson(settingsPath, true), state = readJson(statePath, true);
  if (state.profile && state.profile !== profile) throw new Error("Use a separate --agent-dir to switch profiles safely");
  const metadataOnly = Object.keys(current).every(key => ["deviceId", "lastChangelogVersion", "enableInstallTelemetry"].includes(key));
  if (existsSync(settingsPath) && !metadataOnly && !state.profile && !adopt && !dryRun) throw new Error("Existing unmanaged settings: inspect --dry-run, then explicitly use --adopt, or choose an empty --agent-dir");
  const work = profile === "work" ? readJson(join(root, "work/settings.json")) : {};
  const plan = planSettings({ root, agentDir, profile, current, state, base, work });
  const agentsPath = join(agentDir, "AGENTS.md");
  const existingAgents = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  const agents = mergeInstructions(existingAgents, readFileSync(join(root, "AGENTS.example.md"), "utf8"), root);
  const footer = profile === "work" && existsSync(join(root, "work/codex-footer.json")) ? readJson(join(root, "work/codex-footer.json")) : undefined;
  for (const path of [settingsPath, statePath, agentsPath, join(agentDir, "codex-footer.json"), join(agentDir, "bin"), join(agentDir, "bin/pi-config"), join(agentDir, "backups")]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing managed destination symlink: ${path}`);
  }
  if (dryRun) return { profile, agentDir, ...plan };
  if (!skipInstall) {
    for (const item of plan.managedPackages) {
      const source = sourceValue(item);
      if (!/^(?:npm:|git:|https?:)/.test(source) && !existsSync(source)) throw new Error(`Local package not available: ${source}`);
    }
  }
  let pi = findPi(root, agentDir, manifest.piRuntimeVersion);
  if (!pi && !skipInstall) {
    const installed = spawnSync("npm", ["install", "--prefix", join(agentDir, "runtime"), "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--save-exact", `@earendil-works/pi-coding-agent@${manifest.piRuntimeVersion}`], { stdio: "inherit" });
    if (installed.error || installed.status !== 0) throw new Error("Pinned Pi runtime installation failed; settings unchanged");
    pi = join(agentDir, "runtime/node_modules/.bin/pi");
  }
  saveFile(settingsPath, JSON.stringify(plan.settings, null, 2) + "\n", agentDir);
  saveFile(agentsPath, agents, agentDir, 0o644);
  if (footer) {
    saveFile(join(agentDir, "codex-footer.json"), JSON.stringify(footer, null, 2) + "\n", agentDir);
  }
  if (pi) {
    const executable = shellQuote(pi);
    const launcher = `#!/bin/sh\nexport PI_CODING_AGENT_DIR=${shellQuote(agentDir)}\nexport PATH=${shellQuote(dirname(process.execPath))}:"$PATH"\nexec ${executable} "$@"\n`;
    saveFile(join(agentDir, "bin/pi-config"), launcher, agentDir, 0o755);
  }
  // Record ownership before package downloads, so an interrupted install can be resumed safely.
  saveFile(statePath, JSON.stringify({ profile, sourceRoot: root, ...plan }, null, 2) + "\n", agentDir);
  if (!skipInstall) {
    const updated = spawnSync(pi, ["update", "--extensions"], { stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
    if (updated.error || updated.status !== 0) throw new Error("Package installation failed; local backups are in backups/. Re-run setup after resolving the error.");
  }
  return { profile, agentDir, skippedInstall: skipInstall, launcher: pi ? join(agentDir, "bin/pi-config") : undefined };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      profile: { type: "string", default: "home" }, "agent-dir": { type: "string" },
      "dry-run": { type: "boolean" }, "skip-install": { type: "boolean" }, adopt: { type: "boolean" },
      update: { type: "boolean" }, help: { type: "boolean" },
    } });
    if (values.help) {
      console.log("./setup [--profile home|work] [--agent-dir PATH] [--dry-run] [--adopt] [--skip-install] [--update]");
    } else {
      const [major, minor] = process.versions.node.split(".").map(Number);
      if (major < 22 || (major === 22 && minor < 19)) throw new Error("Node.js >=22.19 is required");
      if (values.update) {
        if (values["dry-run"]) throw new Error("--update changes the checkout; do not combine it with --dry-run");
        if (execFileSync("git", ["status", "--porcelain"], { cwd: sourceRoot, encoding: "utf8" }).trim()) throw new Error("Commit or resolve source changes before updating");
        execFileSync("git", ["pull", "--ff-only"], { cwd: sourceRoot, stdio: "inherit" });
        // Run the freshly pulled installer, not modules imported before git pull.
        const restarted = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2).filter(arg => arg !== "--update")], { stdio: "inherit" });
        if (restarted.error) throw restarted.error;
        process.exit(restarted.status ?? 1);
      }
      const result = configure({ agentDir: values["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent"), profile: values.profile, adopt: values.adopt, dryRun: values["dry-run"], skipInstall: values["skip-install"] });
      console.log(JSON.stringify(result, null, 2));
      if (!values["dry-run"]) console.log(`${values["skip-install"] ? "Configuration prepared; runtime/package downloads skipped." : "Setup complete."} Use /login and /model for your own provider. Existing credentials and sessions were not copied or edited.`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
