import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels, StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHECKS, EFFORTS, resolveOptions } from "./options.mjs";
import { fileReference, localUrl, RequestError, resolveAuth, runLocalCurl } from "./http.mjs";

type Level = ReturnType<ExtensionAPI["getThinkingLevel"]>;

const root = fileURLToPath(new URL("../../", import.meta.url));
const authFields = {
  configFile: Type.Optional(Type.String({ description: "Путь к JSON-указателю; только пути, не secrets." })),
  jwtFile: Type.Optional(Type.String({ description: "Путь к файлу JWT; никогда не сам JWT." })),
  authMode: Type.Optional(StringEnum(["jwt", "headers", "none"])),
  headerFiles: Type.Optional(Type.Array(Type.Object({ name: Type.String(), file: Type.String() }, { additionalProperties: false }), { maxItems: 8 })),
};
const result = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value, isError,
});
const supported = (ctx: ExtensionContext) => ctx.model ? getSupportedThinkingLevels(ctx.model) : [];
const modelKey = (ctx: ExtensionContext) => ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

export default function (pi: ExtensionAPI) {
  let effort: { id: string; previous: Level; applied: Level; model: string | undefined } | undefined;
  const protectedFiles = new Set<string>();
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const protect = (auth: Awaited<ReturnType<typeof resolveAuth>>) => {
    if (auth.status !== "ready") return;
    if (auth.jwtFile) protectedFiles.add(canonical(auth.jwtFile));
    for (const header of auth.headerFiles ?? []) protectedFiles.add(canonical(header.file));
  };
  const restore = (ctx: ExtensionContext) => {
    const lease = effort;
    effort = undefined;
    if (!lease) return { restored: false, reason: "Нет активного inline-ревью." };
    if (modelKey(ctx) !== lease.model || pi.getThinkingLevel() !== lease.applied) {
      return { restored: false, reason: "Модель или effort уже изменены; пользовательский выбор сохранён." };
    }
    if (!supported(ctx).includes(lease.previous)) return { restored: false, reason: "Прежний effort больше не поддерживается." };
    pi.setThinkingLevel(lease.previous);
    return { restored: true, effort: pi.getThinkingLevel() };
  };
  pi.on("agent_settled", (_event, ctx) => { if (effort) restore(ctx); });
  pi.on("session_shutdown", (_event, ctx) => { if (effort) restore(ctx); protectedFiles.clear(); });

  pi.on("tool_call", (event, ctx) => {
    const input = event.input as Record<string, unknown>;
    const path = input.file ?? input.path ?? (event.toolName === "grep" ? ctx.cwd : undefined);
    if (typeof path !== "string" || !["read", "grep", "read_symbol", "read_enclosing", "module_report"].includes(event.toolName)) return;
    const target = canonical(fileReference(path, ctx.cwd));
    const contains = (file: string) => {
      const path = relative(target, file);
      return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    };
    const blocked = protectedFiles.has(target) || (event.toolName === "grep" && [...protectedFiles].some(contains));
    if (blocked) return { block: true, reason: "Credential-файл нельзя читать или искать инструментами модели. Передай его путь в verification_curl." };
  });

  pi.registerTool({
    name: "verification_options", label: "Verification options",
    description: "Разбирает флаги и валидирует параметры verify/code-review/tester/curler. Передай исходные arguments; mode/effort/checks — только явно названные в текущем запросе значения или ответы ask. Ничего не запускает. Спрашивай только поля missing; при ready=true повторных вопросов нет.",
    parameters: Type.Object({
      skill: StringEnum(["verify", "code-review", "tester", "curler"]),
      arguments: Type.Optional(Type.String()),
      mode: Type.Optional(StringEnum(["agent", "inline"])),
      effort: Type.Optional(StringEnum(EFFORTS)),
      checks: Type.Optional(Type.Array(StringEnum(CHECKS), { minItems: 1, maxItems: 3, uniqueItems: true })),
    }, { additionalProperties: false }),
    async execute(_id, input, _signal, _update, ctx) {
      try {
        const options = resolveOptions(input, supported(ctx));
        return result({ ...options,
          reviewModel: options.effort && modelKey(ctx) ? `${modelKey(ctx)}:${options.effort}` : undefined,
          executors: {
            review: { agent: "code-reviewer", skillFile: resolve(root, "skills/code-review/SKILL.md"), context: "fork" },
            tests: { agent: "tester", skillFile: resolve(root, "skills/tester/SKILL.md"), context: "fresh" },
            curl: { agent: "curler", skillFile: resolve(root, "skills/curler/SKILL.md"), context: "fresh" },
          },
        });
      } catch (error) { return result({ status: "blocked", reason: error instanceof Error ? error.message : "Некорректные параметры проверки." }, true); }
    },
  });

  pi.registerTool({
    name: "verification_effort", label: "Review effort",
    description: "Временно меняет реальный thinking level только для inline code-review. begin возвращает lease; end восстанавливает прежний уровень. У субагента вместо этого задавай model с суффиксом effort.",
    parameters: Type.Object({ action: StringEnum(["begin", "end", "status"]), level: Type.Optional(StringEnum(EFFORTS)), lease: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, input, _signal, _update, ctx) {
      if (input.action === "status") return result({ effort: pi.getThinkingLevel(), supported: supported(ctx), lease: effort?.id });
      if (input.action === "end") {
        if (!effort || input.lease !== effort.id) return result({ status: "blocked", reason: "Нужен lease текущего inline-ревью." }, true);
        return result(restore(ctx));
      }
      if (effort) return result({ status: "blocked", reason: "Сначала заверши текущее inline-ревью; вложенный effort запрещён." }, true);
      const level = input.level as Level | undefined;
      if (!level || !supported(ctx).includes(level)) return result({ status: "blocked", reason: "Выбери поддерживаемый effort явно.", supported: supported(ctx) }, true);
      const previous = pi.getThinkingLevel();
      pi.setThinkingLevel(level);
      if (pi.getThinkingLevel() !== level) {
        pi.setThinkingLevel(previous);
        return result({ status: "blocked", reason: "Host не применил effort; ревью не запущено." }, true);
      }
      effort = { id: randomUUID(), previous, applied: level, model: modelKey(ctx) };
      return result({ effort: level, previous, lease: effort.id });
    },
  });

  pi.registerTool({
    name: "verification_auth", label: "HTTP auth references",
    description: "Разрешает схему авторизации и безопасные ссылки на credential-файлы. Явный authMode none не требует credentials и не ищет PAIW-указатель. Значения JWT/credentials не читает и не возвращает. При blocked запроси недостающее у пользователя.",
    parameters: Type.Object(authFields, { additionalProperties: false }),
    async execute(_id, input, _signal, _update, ctx) {
      try {
        const auth = await resolveAuth(input, ctx.cwd);
        protect(auth);
        return result(auth);
      } catch (error) {
        return result({ status: "blocked", reason: error instanceof RequestError ? error.message : "Не удалось разрешить ссылки авторизации; содержимое не показано." }, true);
      }
    },
  });

  pi.registerTool({
    name: "verification_curl", label: "Local HTTP verification",
    description: "Выполняет один согласованный локальный curl. Явный authMode none — без credentials; JWT/headers принимает только файлами и загружает внутри исполнителя. Не следует редиректам и не использует curlrc/proxy. mutationApproved/authApproved означают уже полученное разрешение; none требует authApproved, автоматического fallback нет.",
    parameters: Type.Object({
      ...authFields,
      url: Type.String(), method: Type.Optional(StringEnum(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"])),
      bodyFile: Type.Optional(Type.String()), contentType: Type.Optional(Type.String()),
      expectedStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
      mutationApproved: Type.Optional(Type.Boolean()), authApproved: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_id, input, signal, _update, ctx) {
      try {
        signal?.throwIfAborted();
        localUrl(input.url);
        const auth = await resolveAuth(input, ctx.cwd);
        protect(auth);
        if (auth.status !== "ready") return result(auth, true);
        const report = await runLocalCurl({ ...input, ...auth, configFile: undefined }, ctx.cwd, signal);
        return result(report, report.outcome !== "passed");
      } catch (error) {
        let reason = "Не удалось выполнить HTTP-проверку; сырые данные не показаны.";
        if (error instanceof RequestError) reason = error.message;
        else if (signal?.aborted) reason = "HTTP-проверка отменена.";
        return result({ outcome: "blocked", reason }, true);
      }
    },
  });
}
