import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve, join, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const validName = name => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64;

function assertTree(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
  if (stat.isDirectory()) for (const child of readdirSync(path)) assertTree(join(path, child));
}

function safeDirectory(root, path) {
  const rel = relative(realpathSync(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path escapes source root");
  let cursor = realpathSync(root);
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`Refusing symlink: ${cursor}`);
  }
}

export function createComponent(root, type, slug, work = false) {
  root = realpathSync(root);
  if (!["skill", "extension"].includes(type) || !validName(slug)) throw new Error("Use new <skill|extension> <lowercase-slug> [--work]");
  const name = slug;
  if (type === "skill" && !work && name === "paiw") throw new Error("paiw is an integration-owned directory");
  if (type === "skill") {
    for (const file of ["skills", "work/skills"].flatMap(dir => textFiles(join(root, dir))).filter(file => file.endsWith("/SKILL.md"))) {
      const existingName = /^name:\s*([a-z0-9-]+)\s*$/m.exec(readFileSync(file, "utf8"))?.[1];
      if (existingName === name) throw new Error(`Native skill name already exists: ${name}`);
      if (work && file.startsWith(join(root, "work/skills") + sep) && existingName?.replace(/-oneab$/, "") === name) throw new Error(`Work alias already exists: ${name}`);
    }
  }
  const directory = join(root, work ? "work" : "", type === "skill" ? "skills" : "extensions", name);
  safeDirectory(root, directory);
  if (existsSync(directory) || existsSync(`${directory}.ts`) || existsSync(`${directory}.js`)) throw new Error(`Component already exists: ${directory}`);
  mkdirSync(directory, { recursive: true });
  const body = type === "skill"
    ? `---\nname: ${name}\ndescription: TODO describe purpose and invocation conditions.\ndisable-model-invocation: true\n---\n\n# ${slug}\n\nTODO: inputs, steps, permissions, output and stop conditions.\n`
    : `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\nexport default function (pi: ExtensionAPI) {\n  // TODO: register the component contract; keep side effects out of the factory.\n}\n`;
  writeFileSync(join(directory, type === "skill" ? "SKILL.md" : "index.ts"), body, { flag: "wx" });
  return directory;
}

function textFiles(directory) {
  if (!existsSync(directory)) return [];
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) return [];
  if (!stat.isDirectory()) return /\.(?:md|ts|js|mjs|json)$/.test(directory) ? [directory] : [];
  return readdirSync(directory).filter(name => !["node_modules", "paiw"].includes(name)).flatMap(name => textFiles(join(directory, name)));
}

export function moveToWork(root, type, name, apply = false) {
  root = realpathSync(root);
  if (!["skill", "extension"].includes(type) || !validName(name)) throw new Error("Use to-work <skill|extension> <exact-name> [--apply]");
  if (type === "skill" && name === "paiw") throw new Error("Integration-owned skills may not be moved");
  if (type === "skill" && ["to-work", "skill-creator"].includes(name)) throw new Error("Administrative skills stay in the portable layer");
  const base = join(root, type === "skill" ? "skills" : "extensions", name);
  const candidates = type === "skill" ? [base] : [base, `${base}.ts`, `${base}.js`];
  const found = candidates.filter(existsSync);
  if (found.length !== 1) throw new Error("Component missing or ambiguous; use its exact name");
  const source = found[0];
  safeDirectory(root, source);
  assertTree(source);
  const destination = join(root, "work", type === "skill" ? "skills" : "extensions", source.slice(source.lastIndexOf(sep) + 1));
  safeDirectory(root, destination);
  if (existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);
  const ownFiles = new Set(textFiles(source));
  const references = ["extensions", "skills"].flatMap(dir => textFiles(join(root, dir)))
    .filter(file => !ownFiles.has(file))
    .filter(file => {
      const content = readFileSync(file, "utf8");
      return content.includes(name) || (type === "skill" && content.includes(`/pi:${name}`)) || (type === "extension" && content.includes(`${name}.js`));
    }).map(file => relative(root, file));
  // Relative imports/references outside the component need deliberate rewriting after a move.
  const externalPaths = [...ownFiles].filter(file => /(?:from\s*["']|import\s*\(\s*["']|\]\()\.\.\//.test(readFileSync(file, "utf8"))).map(file => relative(root, file));
  const plan = { source, destination, references, externalPaths };
  if (!apply) return plan;
  if (references.length || externalPaths.length) throw new Error(`Resolve references before moving: ${[...references, ...externalPaths].join(", ")}`);
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(source, destination);
  return plan;
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { work: { type: "boolean" }, apply: { type: "boolean" } } });
    const [action, type, name, ...extra] = positionals;
    if (extra.length) throw new Error("Unexpected arguments");
    if (action === "new") console.log(createComponent(sourceRoot, type, name, values.work));
    else if (action === "to-work") console.log(JSON.stringify(moveToWork(sourceRoot, type, name, values.apply), null, 2));
    else throw new Error("Use new or to-work; see README.md");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
