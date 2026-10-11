import { relative, isAbsolute, sep } from "node:path";

export interface SkillCommand {
  name: string;
  source: string;
  description?: string;
  sourceInfo?: { path: string };
}
export interface SkillAlias extends SkillCommand { alias: string }

function inside(path: string | undefined, directory: string): path is string {
  if (!path) return false;
  const rel = relative(directory, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function skillAliases(commands: SkillCommand[], root: string | readonly string[]): Map<string, SkillAlias | null> {
  const roots = typeof root === "string" ? [root] : root;
  const aliases = new Map<string, SkillAlias | null>();
  const candidates: Array<{ command: SkillCommand; group: string; fullAlias: string; alias: string }> = [];
  const seen = new Set<string>();
  const reserved = new Set(commands.filter(c => c.source !== "skill").map(c => c.name));
  for (const command of commands) {
    if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;
    const name = command.name.slice(6);
    const path = command.sourceInfo?.path;
    if (path) {
      const identity = JSON.stringify([command.name, path]);
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    let group = "other", slug = name.replace(/^generic-/, "");
    if (roots.some(root => inside(path, `${root}/work/skills`))) {
      group = "work";
      slug = name.replace(/-oneab$/, "");
    } else if (roots.some(root => inside(path, `${root}/skills`) && relative(`${root}/skills`, path).split(sep)[0] !== "paiw")) {
      group = "pi";
      slug = name;
    }
    candidates.push({ command, group, fullAlias: `${group}:${name}`, alias: `${group}:${slug}` });
  }
  // Shortening generic-* is a convenience, never a reason to choose or hide a source.
  // Iterate because expanding one name may collide with another shortened name.
  let changed: boolean;
  do {
    changed = false;
    const counts = new Map<string, number>();
    for (const { alias } of candidates) counts.set(alias, (counts.get(alias) ?? 0) + 1);
    for (const candidate of candidates) {
      if (candidate.group === "other" && candidate.alias !== candidate.fullAlias
        && ((counts.get(candidate.alias) ?? 0) > 1 || reserved.has(candidate.alias))) {
        candidate.alias = candidate.fullAlias;
        changed = true;
      }
    }
  } while (changed);
  for (const { command, alias } of candidates) {
    // Genuine conflicts (including reserved commands) still remain blocked.
    if (aliases.has(alias) || reserved.has(alias)) aliases.set(alias, null);
    else aliases.set(alias, { ...command, alias });
  }
  return aliases;
}

export function namespaceInvocations(text: string): Array<{ alias: string; start: number; length: number }> {
  const plain = text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, value => " ".repeat(value.length));
  return [...plain.matchAll(/(?:^|\s)(\/(?:pi|work|other):[\w-]+)(?=\s|$)/g)].map(match => ({
    alias: match[1].slice(1),
    start: match.index + match[0].length - match[1].length,
    length: match[1].length,
  }));
}
