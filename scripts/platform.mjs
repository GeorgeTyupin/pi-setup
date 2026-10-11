import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, dirname, delimiter, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

export const sdkName = "@earendil-works/pi-coding-agent";
export function assertNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error("Node.js >=22.19 is required");
}
export function dataRoot() {
  return process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "pi-setup")
    : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pi-setup");
}
// Run npm's JavaScript entry directly: Windows cannot spawn npm.cmd without a shell.
export function npmCommand() {
  const candidates = [
    process.env.npm_execpath && join(dirname(process.env.npm_execpath), "npm-cli.js"),
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    candidates.push(join(dir, "node_modules/npm/bin/npm-cli.js"));
    const npm = join(dir, "npm");
    try { candidates.push(realpathSync(npm)); } catch { /* optional PATH entry */ }
  }
  for (const path of candidates.filter(Boolean)) {
    if (existsSync(path) && /npm-cli\.js$/.test(path)) return [process.execPath, [path]];
  }
  throw new Error("Cannot locate npm-cli.js; install Node.js with npm");
}
export function runNpm(args, options = {}) {
  const [command, prefix] = npmCommand();
  const result = spawnSync(command, [...prefix, ...args], { stdio: "inherit", ...options });
  if (result.error || result.status !== 0) throw new Error(`npm failed: ${result.error?.message || result.status}`);
  return result;
}
export function runtimeEntry(packageRoot, version) {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (manifest.name !== sdkName || manifest.version !== version) return undefined;
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
    if (!bin) return undefined;
    const script = join(packageRoot, bin), rel = relative(packageRoot, script);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) return undefined;
    if (!existsSync(script)) return undefined;
    const result = spawnSync(process.execPath, [script, "--version"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status === 0 && result.stdout.trim() === version) return { node: process.execPath, script };
  } catch { /* missing or incompatible installation */ }
  return undefined;
}
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function launcherText(node, script, platform = process.platform) {
  if (platform === "win32") {
    const quote = value => `"${value.replaceAll("%", "%%")}"`;
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${quote(node)} ${quote(script)} %*\r\nexit /b %errorlevel%\r\n`;
  }
  return `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(script)} "$@"\n`;
}
