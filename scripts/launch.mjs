import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// This file is copied next to the descriptor in the agent's bin directory.
export function launch(agentDir, runtime, args = []) {
  const child = spawnSync(runtime.node, [runtime.script, ...args], {
    stdio: "inherit",
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PATH: `${dirname(runtime.node)}${delimiter}${process.env.PATH || ""}` },
  });
  if (child.error) throw child.error;
  return child.status ?? 1;
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const descriptor = JSON.parse(readFileSync(new URL("./pi-runtime.json", import.meta.url), "utf8"));
    process.exitCode = launch(descriptor.agentDir, descriptor, process.argv.slice(2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
