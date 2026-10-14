import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { CustomEditor, getAgentDir, getSettingsListTheme, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Level = typeof LEVELS[number];

export function parseLevels(value: unknown): Level[] {
  if (!Array.isArray(value) || !value.length || value.some(level => !LEVELS.includes(level))) {
    throw new Error(`Choose at least one level: ${LEVELS.join(", ")}`);
  }
  return [...new Set(value)] as Level[];
}

export function nextLevel(current: Level, scope: readonly Level[], supported: readonly Level[]): Level | undefined {
  const available = scope.filter(level => supported.includes(level));
  if (!available.length) return undefined;
  return available[(available.indexOf(current) + 1) % available.length];
}

export default function (pi: ExtensionAPI) {
  const directory = getAgentDir();
  const path = join(directory, "scoped-thinking.json");
  let scope: Level[] = [...LEVELS];
  let stopWatchingEditor: (() => void) | undefined;
  pi.on("session_shutdown", () => { stopWatchingEditor?.(); stopWatchingEditor = undefined; });

  function save(levels: Level[]) {
    const validated = parseLevels(levels);
    mkdirSync(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ levels: validated }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
    scope = validated;
  }

  function cycle(ctx: ExtensionContext) {
    if (!ctx.model?.reasoning) {
      ctx.ui.notify("Current model does not support thinking", "info");
      return;
    }
    const level = nextLevel(pi.getThinkingLevel(), scope, getSupportedThinkingLevels(ctx.model));
    if (level === undefined) {
      ctx.ui.notify("No scoped thinking levels supported by this model. Use /scoped-thinking to change the scope.", "warning");
      return;
    }
    pi.setThinkingLevel(level);
    ctx.ui.notify(`Thinking: ${pi.getThinkingLevel()}`, "info");
  }

  pi.on("session_start", (_event, ctx) => {
    scope = [...LEVELS];
    try {
      scope = parseLevels(JSON.parse(readFileSync(path, "utf8")).levels);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        ctx.ui.notify(`Could not load scoped thinking; using all levels: ${error instanceof Error ? error.message : error}`, "warning");
      }
    }
    stopWatchingEditor?.();
    if (ctx.mode !== "tui") return;
    let attached = false;
    const editors = new WeakSet<CustomEditor>();
    const attach = ({ editor, keybindings }: { editor: CustomEditor; keybindings: KeybindingsManager }) => {
      attached = true;
      if (editors.has(editor)) return;
      editors.add(editor);
      const original = editor.handleInput.bind(editor);
      // The native action is reserved: registerShortcut cannot override it.
      // Intercept at the editor boundary, respecting remapped keys and dialog focus.
      editor.handleInput = (data: string) => {
        if (keybindings.matches(data, "app.thinking.cycle")) cycle(ctx);
        else original(data);
      };
    };
    stopWatchingEditor = pi.events.on("pi-config:editor-created", data => {
      const candidate = data as { editor?: CustomEditor; keybindings?: KeybindingsManager } | undefined;
      if (candidate?.editor && typeof candidate.editor.handleInput === "function"
        && candidate.keybindings && typeof candidate.keybindings.matches === "function") {
        attach({ editor: candidate.editor, keybindings: candidate.keybindings });
      }
    });
    pi.events.emit("pi-config:editor-query", {});
    if (!attached) {
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        const editor = new CustomEditor(tui, theme, keybindings);
        attach({ editor, keybindings });
        return editor;
      });
    }
  });

  pi.registerCommand("scoped-thinking", {
    description: "Choose thinking levels for Shift+Tab (or: /scoped-thinking medium high; all to reset)",
    handler: async (args, ctx) => {
      try {
        if (args.trim()) {
          save(args.trim() === "all" ? [...LEVELS] : parseLevels(args.trim().split(/[\s,]+/)));
        } else {
          if (ctx.mode !== "tui") {
            ctx.ui.notify(`Scope: ${scope.join(", ")}. Set with /scoped-thinking medium high`, "info");
            return;
          }
          const selected = await ctx.ui.custom<Level[] | undefined>((tui, theme, kb, done) => {
            const draft = new Set(scope);
            const supported = ctx.model ? getSupportedThinkingLevels(ctx.model) : LEVELS;
            const container = new Container();
            container.addChild(new Text(theme.fg("accent", "Scoped thinking"), 1, 1));
            container.addChild(new Text("Enter/Space: toggle · Ctrl+S: save · Esc: cancel", 1, 0));
            const list = new SettingsList(
              LEVELS.map(level => ({
                id: level,
                label: level,
                description: supported.includes(level) ? undefined : "Not supported by the current model; kept for other models",
                currentValue: draft.has(level) ? "on" : "off",
                values: ["on", "off"],
              })),
              LEVELS.length,
              getSettingsListTheme(),
              (id, value) => { if (value === "on") draft.add(id as Level); else draft.delete(id as Level); },
              () => done(undefined),
            );
            container.addChild(list);
            return {
              render: (width: number) => container.render(width),
              invalidate: () => container.invalidate(),
              handleInput(data: string) {
                if (kb.matches(data, "app.models.save")) {
                  if (!draft.size) ctx.ui.notify("Choose at least one thinking level", "warning");
                  else done([...draft]);
                } else list.handleInput(data);
                tui.requestRender();
              },
            };
          });
          if (!selected) return;
          save(selected);
        }
        ctx.ui.notify(`Scoped thinking: ${scope.join(" → ")}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
