import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Window = { usedPercent: number; resetAfterSeconds: number };
type Usage = { primary: Window | null; secondary: Window | null; fetchedAt: number; accountId?: string };
const SLOT = "codex-footer-limits";
const PERIOD = 5 * 60_000;
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const cachePath = join(agentDir, "codex-footer-cache.json");

function readJson(path: string): any {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function credential(): { access: string; accountId?: string } | undefined {
	const auth = readJson(process.env.PI_AUTH_PATH?.trim() || join(agentDir, "auth.json"));
	const config = readJson(join(agentDir, "codex-footer.json"));
	const provider = typeof config?.authProvider === "string" ? config.authProvider : "openai-codex";
	const native = auth?.[provider];
	const codex = readJson(process.env.PI_CODEX_AUTH_PATH?.trim() || join(homedir(), ".codex", "auth.json"));
	// Prefer the live host credential, which may have been refreshed since codex login.
	const access = native?.access || codex?.tokens?.access_token;
	if (typeof access !== "string" || !access.trim()) return undefined;
	let accountId = native?.access ? native.accountId : codex?.tokens?.account_id;
	try {
		const claims = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString("utf8"));
		accountId = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? accountId;
	} catch { /* opaque tokens can still be used for the read-only usage endpoint */ }
	return { access, accountId: typeof accountId === "string" ? accountId : undefined };
}

function validWindow(value: any): Window | null {
	return value && Number.isFinite(value.usedPercent) && Number.isFinite(value.resetAfterSeconds)
		? { usedPercent: value.usedPercent, resetAfterSeconds: value.resetAfterSeconds } : null;
}

function readUsage(path: string): Usage | null {
	const raw = readJson(path);
	if (!raw || !Number.isFinite(raw.fetchedAt)) return null;
	const primary = validWindow(raw.primary), secondary = validWindow(raw.secondary);
	return primary || secondary ? { primary, secondary, fetchedAt: raw.fetchedAt, accountId: typeof raw.accountId === "string" ? raw.accountId : undefined } : null;
}

export function formatLimits(usage: Usage, now = Date.now()): string {
	const windowText = (window: Window | null, weekly: boolean) => {
		if (!window) return "—";
		const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
		const reset = new Date(usage.fetchedAt + window.resetAfterSeconds * 1000).toLocaleString("ru-RU", {
			...(weekly ? { day: "2-digit", month: "2-digit" } as const : {}), hour: "2-digit", minute: "2-digit",
		}).replace(",", "");
		return `${remaining}% ↻${reset}`;
	};
	return `${windowText(usage.primary, false)} | ${windowText(usage.secondary, true)}${now - usage.fetchedAt > 6 * 60_000 ? " · данные устарели" : ""}`;
}

export default function (pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let pending: Promise<void> | undefined;
	let controller: AbortController | undefined;
	let lastAttempt = 0;
	let usage: Usage | null = null;

	const render = () => ctx?.ui.setStatus(SLOT, usage ? formatLimits(usage) : "лимиты —");
	const refresh = (force = false): Promise<void> => {
		if (!ctx) return Promise.resolve();
		if (pending) return pending;
		render();
		if (!force && Date.now() - lastAttempt < 60_000) return Promise.resolve();
		lastAttempt = Date.now();
		const current = ctx;
		const token = credential();
		if (!token) { usage = null; render(); return Promise.resolve(); }
		if (usage?.accountId !== token.accountId) { usage = null; render(); }
		const abort = new AbortController();
		controller = abort;
		const timeout = setTimeout(() => abort.abort(), 15_000);
		pending = (async () => {
			try {
				const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
					headers: { Authorization: `Bearer ${token.access}`, ...(token.accountId ? { "ChatGPT-Account-Id": token.accountId } : {}) },
					redirect: "error", signal: abort.signal,
				});
				if (!response.ok) return;
				const raw = await response.json() as any;
				const window = (value: any) => validWindow({ usedPercent: value?.used_percent, resetAfterSeconds: Number(value?.reset_after_seconds ?? 0) });
				const next = { primary: window(raw.rate_limit?.primary_window), secondary: window(raw.rate_limit?.secondary_window), fetchedAt: Date.now(), accountId: token.accountId };
				if ((!next.primary && !next.secondary) || ctx !== current || abort.signal.aborted) return;
				usage = next;
				try {
					mkdirSync(dirname(cachePath), { recursive: true });
					const tmp = `${cachePath}.tmp-${process.pid}`;
					writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
					renameSync(tmp, cachePath);
				} catch { /* keep in-memory limits if the cache cannot be written */ }
			} catch { /* never interrupt an agent request because usage is unavailable */ }
			finally {
				clearTimeout(timeout);
				if (controller === abort) controller = undefined;
				if (ctx === current) render();
			}
		})().finally(() => { pending = undefined; });
		return pending;
	};

	pi.on("session_start", async (_event, context) => {
		if (context.mode !== "tui") return;
		controller?.abort();
		await pending;
		lastAttempt = 0;
		ctx = context;
		const accountId = credential()?.accountId;
		usage = [readUsage(cachePath), readUsage(join(agentDir, "codex-usage-cache.json"))]
			.filter((item): item is Usage => !!item && item.accountId === accountId)
			.sort((a, b) => b.fetchedAt - a.fetchedAt)[0] ?? null;
		render();
		void refresh(true);
		if (timer) clearInterval(timer);
		timer = setInterval(() => { void refresh(); }, PERIOD);
		timer.unref?.();
	});
	// Do not delay model requests while fetching usage. Completion gets fresh limits.
	pi.on("agent_start", () => { void refresh(); });
	pi.on("agent_end", () => { void refresh(true); });
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		controller?.abort();
		ctx?.ui.setStatus(SLOT, undefined);
		ctx = undefined;
	});
}
