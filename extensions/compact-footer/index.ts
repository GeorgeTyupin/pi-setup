import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "node:os";

import { RequestUsage } from "./request-usage.js";
import { InlineSkillEditor } from "./editor.js";

const auxiliaryServers = new Set(["opengrep", "ast-grep", "zizmor", "typos"]);
const lspLanguages: Record<string, string> = {
	typescript: "ts/js", deno: "ts/js", python: "py", "python-jedi": "py",
	rust: "rs", ruby: "rb", powershell: "ps", csharp: "c#", omnisharp: "c#",
	fsharp: "f#", kotlin: "kt", cpp: "c/c++", haskell: "hs",
	expert: "elixir", tinymist: "typst", marksman: "md", clojure: "clj",
	terraform: "hcl", bash: "sh", docker: "dockerfile",
};

export function formatLensStatus(status: string | undefined): string {
	if (!status) return "";
	const plain = status.replace(/\x1b\[[0-9;]*m/g, "");
	if (plain.includes("LSP Failed:")) return "pi-lens[off]";
	const active = plain.match(/LSP Active: ([^·]+)/)?.[1];
	if (active) {
		const languages = [...new Set(active.split(",").map(id => id.trim())
			.filter(id => id && !auxiliaryServers.has(id))
			.map(id => lspLanguages[id] ?? id))];
		return languages.length ? `pi-lens[on]: ${languages.join(", ")}` : "pi-lens[idle]";
	}
	if (plain.includes("LSP ✓")) return "pi-lens[on]";
	if (plain.includes("LSP ✗")) return "pi-lens[off]";
	return "pi-lens[idle]";
}

export default function (pi: ExtensionAPI) {
	const usage = new RequestUsage();
	let releaseEditorClaim: (() => void) | undefined;
	pi.on("session_shutdown", () => { releaseEditorClaim?.(); releaseEditorClaim = undefined; });
	pi.on("agent_start", (_event, ctx) => usage.start(ctx.sessionManager.getEntries()));
	pi.on("agent_end", (_event, ctx) => usage.finish(ctx.sessionManager.getEntries()));
	pi.on("session_start", (_event, ctx) => {
		usage.reset();
		if (ctx.mode !== "tui") return;
		class FooterEditor extends InlineSkillEditor {
			protected renderTopBorder(width: number, hiddenLineCount: number): string {
				const name = ctx.sessionManager.getSessionName()?.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
				if (!name || width < 32) return super.renderTopBorder(width, hiddenLineCount);
				const taskPrefix = name.match(/^[A-Z]+-\d+/)?.[0];
				const displayName = taskPrefix ?? name;
				const availableWidth = Math.max(0, width - 30);
				const textLimit = taskPrefix ? visibleWidth(taskPrefix) : 20;
				const needsEllipsis = visibleWidth(displayName) > Math.min(textLimit, availableWidth);
				const ellipsis = needsEllipsis ? ".".repeat(Math.min(3, availableWidth)) : "";
				const textWidth = Math.min(textLimit, Math.max(0, availableWidth - ellipsis.length));
				const title = this.borderColor(truncateToWidth(displayName, textWidth, ""))
					+ this.borderColor(ellipsis);
				const label = `${this.borderColor(" ")}${title}${this.borderColor(" ")}`;
				const leftWidth = width - visibleWidth(label) - 1;
				return super.renderTopBorder(leftWidth, hiddenLineCount)
					+ this.borderColor(label) + this.borderColor("─");
			}
		}
		releaseEditorClaim?.();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new FooterEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			const announce = () => {
				pi.events.emit("pi-config:editor-claimed", {});
				pi.events.emit("pi-config:editor-created", { editor, keybindings });
			};
			releaseEditorClaim = pi.events.on("pi-config:editor-query", announce);
			announce();
			return editor;
		});
		ctx.ui.setFooter((tui, theme, data) => {
			const unsubscribe = data.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const manager = ctx.sessionManager;
					const cwd = manager.getCwd();
					const home = homedir();
					const folder = cwd === home ? "~" : cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd;
					const branch = data.getGitBranch();
					const context = ctx.getContextUsage();
					const percentage = context?.percent == null ? "?" : context.percent.toFixed(0);
					const statuses = data.getExtensionStatuses();
					const lens = formatLensStatus(statuses.get("pi-lens-lsp"));
					const location = folder + (branch ? ` (${branch})` : "") + (lens ? ` · ${lens}` : "");
					const limits = statuses.get("codex-footer-limits") ?? statuses.get("chatgpt");
					const duration = statuses.get("execution-time");
					const stats = [duration, `ctx ${percentage}%`, limits, usage.read(manager.getEntries())].filter(Boolean).join(" · ");
					const modelName = ctx.model?.id ?? "";
					const thinkingLevel = ctx.model?.reasoning && ctx.thinkingLevel && ctx.thinkingLevel !== "off"
						? ` · ${ctx.thinkingLevel}`
						: "";
					const model = `${modelName}${thinkingLevel}`;
					const room = width - visibleWidth(stats) - 2;
					const right = room > 8 ? truncateToWidth(model, room, "") : "";
					const left = truncateToWidth(stats, Math.max(0, width - visibleWidth(right) - 2), "");
					const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
					const file = statuses.get("idea-selection") ?? "";
					const fileRight = truncateToWidth(file, Math.max(0, width - 2), "");
					const locationLeft = truncateToWidth(location, fileRight ? Math.max(0, width - visibleWidth(fileRight) - 2) : width, "");
					const filePadding = fileRight ? " ".repeat(Math.max(2, width - visibleWidth(locationLeft) - visibleWidth(fileRight))) : "";
					// Exactly two lines; file position sits above the model on the right.
					return [theme.fg("dim", truncateToWidth(locationLeft + filePadding + fileRight, width)), theme.fg("dim", truncateToWidth(left + padding + right, width))];
				}
			};
		});
	});
}
