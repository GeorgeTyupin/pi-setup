import { fileURLToPath } from "node:url";
import { basename, dirname } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteProvider } from "@earendil-works/pi-tui";
// Keep the helper in TypeScript: native .mjs imports can stay stale across /reload.
import { skillAliases, namespaceInvocations } from "./aliases.js";

const container = dirname(dirname(fileURLToPath(import.meta.url)));
const collection = dirname(container);
const roots = [getAgentDir()];
if (basename(container) === "extensions") roots.push(basename(collection) === "work" ? dirname(collection) : collection);

export function wrapNamespaceAutocomplete(current: AutocompleteProvider, getAliases: () => ReturnType<typeof skillAliases>): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), ":"])],
    async getSuggestions(lines, row, col, options) {
      const before = (lines[row] ?? "").slice(0, col);
      const match = /(?:^|\s)(\/[\w:-]*)$/.exec(before);
      if (!match) return current.getSuggestions(lines, row, col, options);
      const token = match[1];
      if (token.startsWith("/skill:")) return current.getSuggestions(lines, row, col, options);
      const aliases = [...getAliases().values()].filter((item): item is NonNullable<typeof item> => item !== null);
      const query = token.slice(1);
      const scoped = query.includes(":") || /^(?:work|pi|other)$/i.test(query);
      // Rank bare skill names, not namespace lengths or description text.
      const priority: Record<string, number> = { work: 0, pi: 1, other: 2 };
      const items = fuzzyFilter(aliases, query, item => scoped ? item.alias : item.alias.slice(item.alias.indexOf(":") + 1))
        .sort((a, b) => priority[a.alias.split(":")[0]] - priority[b.alias.split(":")[0]])
        .map(item => ({ value: item.alias, label: item.alias, description: item.description }));
      const native = await current.getSuggestions(lines, row, col, options);
      if (options?.signal?.aborted) return null;
      const aliasNames = new Set(aliases.map(item => item.alias));
      const others = native?.prefix === token ? native.items.filter(item => !item.value.startsWith("skill:") && !aliasNames.has(item.value)) : [];
      // Match commands and skills together, using the same bare-name scoring.
      const ranked = fuzzyFilter([...others, ...items], query, item =>
        aliasNames.has(item.value) && !scoped ? item.value.slice(item.value.indexOf(":") + 1) : item.value);
      // Reorder only skill slots: namespace priority must never move command slots.
      let skillIndex = 0;
      const merged = ranked.map(item => aliasNames.has(item.value) ? items[skillIndex++] : item);
      return merged.length ? { items: merged, prefix: token } : null;
    },
    applyCompletion(lines, row, col, item, prefix) {
      if (!/^(?:pi|work|other):/.test(item.value)) return current.applyCompletion(lines, row, col, item, prefix);
      const before = (lines[row] ?? "").slice(0, col);
      if (!before.endsWith(prefix)) return current.applyCompletion(lines, row, col, item, prefix);
      const after = lines[row].slice(col);
      const replacement = `/${item.value}${/^\s/.test(after) ? "" : " "}`;
      const start = col - prefix.length;
      const result = [...lines];
      result[row] = lines[row].slice(0, start) + replacement + after;
      return { lines: result, cursorLine: row, cursorCol: start + replacement.length };
    },
    shouldTriggerFileCompletion(lines, row, col) {
      return /(?:^|\s)\/(?:pi|work|other):[\w-]*$/.test((lines[row] ?? "").slice(0, col))
        || (current.shouldTriggerFileCompletion?.(lines, row, col) ?? false);
    },
  };
}

export default function (pi: ExtensionAPI) {
  const aliases = () => skillAliases(pi.getCommands(), roots);
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider(current => wrapNamespaceAutocomplete(current, aliases));
    const collisions = [...aliases()].flatMap(([name, value]) => value === null ? [name] : []);
    if (collisions.length) ctx.ui.notify(`Неоднозначные алиасы скиллов: ${collisions.join(", ")}. Используй /skill:<name>.`, "warning");
  });
  pi.on("input", (event, ctx) => {
    const matches = namespaceInvocations(event.text);
    if (!matches.length) return { action: "continue" };
    if (matches.length > 1) {
      ctx.ui.notify("Вызывай один скилл за сообщение.", "warning");
      return { action: "handled" };
    }
    const match = matches[0];
    const target = aliases().get(match.alias);
    if (!target) {
      ctx.ui.notify(`Скилл /${match.alias} недоступен или его алиас неоднозначен. Проверь автодополнение и /reload.`, "warning");
      return { action: "handled" };
    }
    const surrounding = [event.text.slice(0, match.start).trim(), event.text.slice(match.start + match.length).trim()].filter(Boolean).join(" ");
    return { action: "transform", text: `/${target.name}${surrounding ? ` ${surrounding}` : ""}`, images: event.images };
  });
}
