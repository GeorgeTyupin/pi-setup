import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { builtinModules } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
export function checkPortability(root) {
  const errors = [];
  const files = [];
  const visit = (path, target = files) => {
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) { errors.push(`Portable symlink: ${relative(root, path)}`); return; }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) {
        if (["node_modules", ".DS_Store", ".cache"].includes(name)) continue;
        if (path === join(root, "extensions") && (name === "idea-selection" || name.startsWith("idea-selection."))) continue;
        visit(join(path, name), target);
      }
    } else target.push(path);
  };
  for (const dir of ["extensions", "config"]) visit(join(root, dir));
  if (existsSync(join(root, "skills"))) {
    for (const name of readdirSync(join(root, "skills"))) {
      if (!["paiw", ".DS_Store", ".cache", "node_modules"].includes(name)) visit(join(root, "skills", name));
    }
  }
  // Each extension must be copyable as one directory. Host SDK imports are supplied by Pi.
  const hostPackages = new Set(["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]);
  for (const layer of ["extensions", "work/extensions"]) {
    const directory = join(root, layer);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      if ([".DS_Store", ".cache", "node_modules", ".npmignore"].includes(name)) continue;
      if (layer === "extensions" && (name === "idea-selection" || name.startsWith("idea-selection."))) continue;
      const component = join(directory, name);
      if (!lstatSync(component).isDirectory() || lstatSync(component).isSymbolicLink()) {
        errors.push(`Extension must be a real directory: ${relative(root, component)}`);
        continue;
      }
      if (!["index.ts", "index.js"].some(entry => existsSync(join(component, entry)))) errors.push(`Missing extension entry point: ${relative(root, component)}`);
      const componentFiles = [];
      visit(component, componentFiles);
      let dependencies = {};
      const manifest = join(component, "package.json");
      if (existsSync(manifest)) {
        try { dependencies = JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {}; }
        catch (error) { errors.push(`Invalid extension manifest: ${relative(root, manifest)}: ${error.message}`); }
      }
      for (const dependency of Object.keys(dependencies)) if (hostPackages.has(dependency)) errors.push(`Host package must not be bundled: ${relative(root, component)}: ${dependency}`);
      for (const file of componentFiles.filter(file => /\.(?:ts|mts|js|mjs)$/.test(file))) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g)) {
          const specifier = match[1];
          if (specifier.startsWith(".")) {
            const rel = relative(component, resolve(dirname(file), specifier));
            if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) errors.push(`Import escapes extension: ${relative(root, file)}: ${specifier}`);
          } else if (isAbsolute(specifier) || specifier.startsWith("file:")) {
            errors.push(`Nonportable extension import: ${relative(root, file)}: ${specifier}`);
          } else if (!specifier.startsWith("node:") && !builtinModules.includes(specifier)) {
            const dependency = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
            if (!hostPackages.has(dependency) && !(dependency in dependencies)) errors.push(`Undeclared extension dependency: ${relative(root, file)}: ${specifier}`);
          }
        }
      }
    }
  }
  const workNames = new Set();
  const workSkills = join(root, "work/skills");
  if (existsSync(workSkills)) for (const folder of readdirSync(workSkills)) {
    const file = join(workSkills, folder, "SKILL.md");
    if (existsSync(file) && !lstatSync(file).isSymbolicLink() && !lstatSync(join(workSkills, folder)).isSymbolicLink()) {
      const name = /^name:\s*([a-z0-9-]+)\s*$/m.exec(readFileSync(file, "utf8"))?.[1];
      if (name) workNames.add(name);
    }
  }
  const names = new Set();
  for (const file of files) {
    const rel = relative(root, file);
    if (/(?:^|\/)(?:auth\.json|\.env(?:\..*)?|.*\.(?:pem|key|secret\.yaml))$/.test(rel)) errors.push(`Secret-like file: ${rel}`);
    if (!/\.(?:md|ts|mts|js|mjs|json)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    if (/vk\.team|vk-proxy|pi-harness|ABUP-\d|\/Users\/[\w.-]+\/|\/home\/[\w.-]+\//i.test(text)) errors.push(`Work or machine-specific reference: ${rel}`);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:glpat-|ghp_|sk-proj-)[A-Za-z0-9_-]{16,}/.test(text)) errors.push(`Possible credential: ${rel}`);
    if (basename(file) === "SKILL.md") {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
      const name = /^name:\s*([a-z0-9-]+)\s*$/m.exec(frontmatter ?? "")?.[1];
      if (!name || name !== basename(join(file, "..")) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) errors.push(`Invalid portable skill name: ${rel}`);
      if (names.has(name)) errors.push(`Duplicate skill name: ${name}`);
      if (workNames.has(name)) errors.push(`Native skill name collision between common and work layers: ${name}`);
      names.add(name);
      if (!/^description:\s*\S/m.test(frontmatter ?? "")) errors.push(`Missing description: ${rel}`);
      if (/TODO/.test(text)) errors.push(`Unfinished skill: ${rel}`);
      if (!/^disable-model-invocation:\s*(?:true|false)\s*$/m.test(frontmatter ?? "")) errors.push(`Missing explicit invocation policy: ${rel}`);
    }
  }
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (JSON.stringify(manifest.pi) !== JSON.stringify({ extensions: ["./extensions", "!extensions/idea-selection/**", "!extensions/idea-selection.*"], skills: ["./skills/*/SKILL.md", "!skills/paiw/**"] })) errors.push("Unexpected Pi manifest: review resource boundaries");
    if ((manifest.files ?? []).some(path => path === "work" || path.startsWith("work/"))) errors.push("Work layer included in package files");
    const base = JSON.parse(readFileSync(join(root, "config/settings.base.json"), "utf8"));
    if (["defaultProvider", "defaultModel", "enabledModels"].some(key => key in base)) errors.push("Provider/model bindings must remain local");
    for (const source of base.packages ?? []) if (!/^npm:(?:@[^/]+\/)?[^@]+@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(source)) errors.push(`Unpinned/nonportable base package: ${source}`);
  } catch (error) {
    errors.push(`Invalid manifest/configuration: ${error.message}`);
  }
  try {
    const listed = existsSync(join(root, ".git")) ? execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\0").filter(Boolean) : [];
    for (const path of listed) {
      const absolute = join(root, path);
      if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) errors.push(`Symlink visible to Git: ${path}`);
      if (existsSync(absolute) && /\.(?:md|ts|mts|js|mjs|json)$/.test(path)) {
        const content = readFileSync(absolute, "utf8");
        if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:glpat-|ghp_|sk-proj-)[A-Za-z0-9_-]{16,}/.test(content)) errors.push(`Possible credential visible to Git: ${path}`);
      }
      if (/^(?:work\/|skills\/paiw\/|extensions\/idea-selection(?:\/|\.)|(?:auth|settings|models|mcp)\.json$|AGENTS\.md$|sessions\/|backups\/|install\/|npm\/)/.test(path)) errors.push(`Local file visible to Git: ${path}`);
    }
  } catch { /* A downloaded archive need not contain Git metadata. */ }
  return { errors, checkedFiles: files.length };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkPortability(sourceRoot);
    for (const error of result.errors) console.error(error);
    console.log(`Portability: ${result.checkedFiles} files; ${result.errors.length} problem(s). This is not a complete secret or licensing audit.`);
    if (result.errors.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
