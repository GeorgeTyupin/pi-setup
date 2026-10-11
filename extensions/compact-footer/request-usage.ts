type Usage = { input?: number; output?: number; cacheWrite?: number; cacheRead?: number };
type Entry = { type?: string; usage?: Usage; message?: { usage?: Usage } };

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}kk`;
}

/** Per-agent-run reported usage. Cached reads are deliberately excluded from in. */
export class RequestUsage {
	private startIndex = 0;
	private active = false;
	private text = "in   · out  ";
	start(entries: readonly unknown[]) {
		this.startIndex = entries.length;
		this.active = true;
		this.text = "in   · out  ";
	}
	read(entries: readonly unknown[]): string {
		if (!this.active) return this.text;
		let input = 0, output = 0, reported = false;
		for (const raw of entries.slice(this.startIndex)) {
			const item = raw as Entry;
			const usage = item.usage ?? (item.type === "message" ? item.message?.usage : undefined);
			if (!usage) continue;
			// Zero-only records can represent a cancelled stream without reported usage.
			if ((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0) + (usage.cacheRead ?? 0) > 0) reported = true;
			input += (usage.input ?? 0) + (usage.cacheWrite ?? 0);
			output += usage.output ?? 0;
		}
		this.text = reported ? `in ${formatTokens(input)} · out ${formatTokens(output)}` : "in   · out  ";
		return this.text;
	}
	finish(entries: readonly unknown[]) {
		this.read(entries);
		this.active = false;
	}
	reset() {
		this.active = false;
		this.text = "in   · out  ";
	}
}
