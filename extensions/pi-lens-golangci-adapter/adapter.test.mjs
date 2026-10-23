import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { applyAdapter, patchRunner } from "./adapter.mjs";

const source = 'return safeSpawnAsync(cmd, ["run", "--out-format=json", ctx.filePath], { cwd });';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function argumentsFor(version) {
  const run = new AsyncFunction("safeSpawnAsync", "cmd", "ctx", "cwd", patchRunner(source));
  return run(async (_cmd, args) => args[0] === "version"
    ? { stdout: `golangci-lint has version ${version}` }
    : args, "golangci-lint", { filePath: "example.go" }, ".");
}

function fixture(t, version = "4.3.0", secondSource = source) {
  const root = mkdtempSync(join(tmpdir(), "pi-lens-adapter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-lens", version }));
  const files = [join(root, "dist/index.js"), join(root, "dist/clients/dispatch/runners/golangci-lint.js")];
  files.forEach((file, index) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, index === 0 ? source : secondSource);
  });
  return { root, files };
}

test("v2 получает JSON без текстового вывода и статистики", async () => {
  // arrange
  const version = "2.15.0";
  // act
  const args = await argumentsFor(version);
  // assert
  assert.deepEqual(args, ["run", "--output.json.path=stdout",
    `--output.text.path=${process.platform === "win32" ? "NUL" : devNull}`,
    "--show-stats=false", "example.go"]);
});

test("v1 сохраняет прежние аргументы", async () => {
  // arrange
  const version = "1.64.8";
  // act
  const args = await argumentsFor(version);
  // assert
  assert.deepEqual(args, ["run", "--out-format=json", "example.go"]);
});

test("повторное применение не меняет уже исправленные артефакты", (t) => {
  // arrange
  const { root, files } = fixture(t);
  assert.equal(applyAdapter(root), 2);
  const patched = files.map((file) => readFileSync(file, "utf8"));
  // act
  const changed = applyAdapter(root);
  // assert
  assert.equal(changed, 0);
  assert.deepEqual(files.map((file) => readFileSync(file, "utf8")), patched);
});

test("неизвестная сигнатура отменяет запись обоих артефактов", (t) => {
  // arrange
  const { root, files } = fixture(t, "4.3.0", "unknown runner");
  // act + assert
  assert.throws(() => applyAdapter(root), /неизвестный формат/);
  assert.equal(readFileSync(files[0], "utf8"), source);
  assert.equal(readFileSync(files[1], "utf8"), "unknown runner");
});

test("другая версия Pi Lens остаётся без изменений", (t) => {
  // arrange
  const { root, files } = fixture(t, "4.4.0");
  // act
  const changed = applyAdapter(root);
  // assert
  assert.equal(changed, 0);
  assert.equal(readFileSync(files[0], "utf8"), source);
});
