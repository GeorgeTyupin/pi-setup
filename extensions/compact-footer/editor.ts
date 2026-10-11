import { CustomEditor } from "@earendil-works/pi-coding-agent";
export function inlineToken(lines: string[], row: number, col: number) {
	const before = (lines[row] ?? "").slice(0, col);
	const match = /(?:^|\s)(\/(?:skill:|pi:|work:|other:)?[\w-]*)$/.exec(before);
	if (!match) return undefined;
	const token = match[1];
	const start = before.length - token.length;
	// Leave the normal command menu at the start of the message untouched.
	if (!lines.slice(0, row).join("\n").trim() && !before.slice(0, start).trim()) return undefined;
	return { token, start };
}
export class InlineSkillEditor extends CustomEditor {
	handleInput(data: string): void {
		const before = this.getText();
		super.handleInput(data);
		if (this.getText() === before || data === "\t" || data === "\r" || data === "\n") return;
		const cursor = this.getCursor();
		if (!inlineToken(this.getLines(), cursor.line, cursor.col)) return;
		// Pi currently excludes '/' from extra trigger characters. Use the editor's
		// existing menu request, without injecting Tab or changing editor text.
		// SAFETY: Pi 1.1.0 supplies this private editor method; check it at runtime.
		// Recheck this compatibility seam when upgrading Pi.
		const trigger = (this as unknown as { tryTriggerAutocomplete?: () => void }).tryTriggerAutocomplete;
		if (typeof trigger === "function") trigger.call(this);
	}
}
