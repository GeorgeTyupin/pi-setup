import { existsSync, realpathSync } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

const DAY = 24 * 60 * 60 * 1000;
export const stateName = "pi-config-update-state.json";
export const bootstrap = "https://codeload.github.com/GeorgeTyupin/pi-setup/tar.gz/refs/heads/main?v=0.2.1";
export interface UpdateState {
  lastSuccessAt?: string;
  lastAttemptAt?: string;
}
export async function readState(agentDir: string): Promise<UpdateState> {
  try {
    const value = JSON.parse(await readFile(join(agentDir, stateName), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid update state");
    for (const key of ["lastSuccessAt", "lastAttemptAt"]) {
      if (value[key] !== undefined && (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key])))) {
        throw new Error(`Invalid update timestamp: ${key}`);
      }
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
export function isDue(state: UpdateState, now = Date.now()): boolean {
  return (!state.lastSuccessAt || now - Date.parse(state.lastSuccessAt) >= 7 * DAY)
    && (!state.lastAttemptAt || now - Date.parse(state.lastAttemptAt) >= DAY);
}
export async function saveState(agentDir: string, state: UpdateState): Promise<void> {
  const path = join(agentDir, stateName);
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(state, null, 2) + "\n"); }
    finally { await file.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

// An exclusive file serializes auto-updates across Pi processes. Never steal a
// lock by age: a slow but live installer must not race another installer.
export async function acquireLock(agentDir: string): Promise<(() => Promise<void>) | undefined> {
  const path = join(agentDir, "pi-config-update.lock");
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  try { await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); }
  catch (error) { await file.close(); await unlink(path); throw error; }
  return async () => { await file.close(); await unlink(path); };
}

// Run npm's JS entry without a shell, including on Windows (npm.cmd cannot be
// executed directly). Kept inside the component so it remains portable alone.
export function updateCommand(agentDir: string): { command: string; args: string[] } {
  const candidates = [
    process.env.npm_execpath && join(dirname(process.env.npm_execpath), "npm-cli.js"),
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    candidates.push(join(dir, "node_modules/npm/bin/npm-cli.js"));
    try { candidates.push(realpathSync(join(dir, "npm"))); } catch { /* optional PATH entry */ }
  }
  const cli = candidates.find(path => path && /npm-cli\.js$/.test(path) && existsSync(path));
  if (!cli) throw new Error("Cannot locate npm-cli.js; install Node.js with npm");
  return { command: process.execPath, args: [cli, "exec", "--yes", `--package=${bootstrap}`, "--", "pi-setup", "--agent-dir", agentDir, "--no-launch"] };
}
