import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InlineSkillEditor, inlineToken } from "./editor.js";


export function wrapSkillAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,
		async getSuggestions(lines, row, col, options) {
			const match = inlineToken(lines, row, col);
			if (!match) return current.getSuggestions(lines, row, col, options);
			// Ask the real command provider for fuzzy matches, not a separate skill index.
			const suggestions = await current.getSuggestions([match.token], 0, match.token.length, {
				...options, force: false,
			});
			const items = suggestions?.items.filter(item => /^(?:skill|pi|work|other):/.test(item.value)) ?? [];
			return items.length ? { items, prefix: match.token } : null;
		},
		applyCompletion(lines, row, col, item, prefix) {
			const match = inlineToken(lines, row, col);
			if (!match || prefix !== match.token || !/^(?:skill|pi|work|other):/.test(item.value)) {
				return current.applyCompletion(lines, row, col, item, prefix);
			}
			const line = lines[row];
			const after = line.slice(col);
			const replacement = `/${item.value}${/^\s/.test(after) ? "" : " "}`;
			const newLines = [...lines];
			newLines[row] = line.slice(0, match.start) + replacement + after;
			return { lines: newLines, cursorLine: row, cursorCol: match.start + replacement.length };
		},
		shouldTriggerFileCompletion(lines, row, col) {
			return Boolean(inlineToken(lines, row, col)) || (current.shouldTriggerFileCompletion?.(lines, row, col) ?? false);
		},
	};
}


export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider(wrapSkillAutocomplete);
		// Optional editor coordination; works alone and in either extension load order.
		let claimed = false;
		const unsubscribe = pi.events.on("pi-config:editor-claimed", () => { claimed = true; });
		try { pi.events.emit("pi-config:editor-query", {}); } finally { unsubscribe(); }
		if (!claimed) ctx.ui.setEditorComponent((tui, theme, keybindings) => new InlineSkillEditor(tui, theme, keybindings));
	});

	pi.on("input", event => {
		// Let Pi load the selected skill natively, including its relative references.
		const match = /(?:^|\s)(\/skill:[\w-]+)(?=\s|$)/.exec(event.text);
		if (!match) return { action: "continue" };
		const invocation = match[1];
		const start = match.index + match[0].length - invocation.length;
		if (start === 0) return { action: "continue" };
		const surrounding = [event.text.slice(0, start).trim(), event.text.slice(start + invocation.length).trim()]
			.filter(Boolean).join(" ");
		return { action: "transform", text: `${invocation}${surrounding ? ` ${surrounding}` : ""}`, images: event.images };
	});
}
