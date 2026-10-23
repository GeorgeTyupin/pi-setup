import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const legacyArgs = '["run", "--out-format=json", ctx.filePath]';
const marker = "/* pi-setup:golangci-v2 */";
const compatibleArgs = `(${marker} /\\bversion\\s+v?2\\./.test(
  (await safeSpawnAsync(cmd, ["version"], { cwd, timeout: 5000 })).stdout ?? ""
) ? ["run", "--output.json.path=stdout",
  "--output.text.path=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
  "--show-stats=false", ctx.filePath] : ${legacyArgs})`;

export function patchRunner(source) {
  if (source.includes(marker)) return source;
  if (source.split(legacyArgs).length !== 2) {
    throw new Error("Pi Lens: неизвестный формат runner, автопатч отменён");
  }
  return source.replace(legacyArgs, compatibleArgs);
}

export function applyAdapter(packageDir) {
  const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (metadata.name !== "pi-lens" || metadata.version !== "4.3.0") return 0;

  const updates = ["dist/index.js", "dist/clients/dispatch/runners/golangci-lint.js"]
    .map((relative) => {
      const file = join(packageDir, relative);
      const source = readFileSync(file, "utf8");
      return { file, source, patched: patchRunner(source) };
    })
    .filter(({ source, patched }) => source !== patched);

  for (const { file, patched } of updates) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, patched, { flag: "wx", mode: statSync(file).mode & 0o777 });
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return updates.length;
}
