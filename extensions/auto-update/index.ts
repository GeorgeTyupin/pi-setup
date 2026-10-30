import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { acquireLock, isDue, readState, saveState, updateCommand } from "./update.js";

export default function (pi: ExtensionAPI) {
  let controller: AbortController | undefined;
  pi.on("session_shutdown", () => { controller?.abort(); });
  pi.on("session_start", async (_event, ctx) => {
    // Do not update from print/RPC workers or subagent invocations.
    if (ctx.mode !== "tui") return;
    const agentDir = getAgentDir();
    let release: (() => Promise<void>) | undefined;
    try {
      const installer = JSON.parse(await readFile(join(agentDir, "pi-config-state.json"), "utf8"));
      if (!["home", "work"].includes(installer.profile)) return;
      if (!isDue(await readState(agentDir))) return;
      release = await acquireLock(agentDir);
      if (!release) {
        ctx.ui.notify("Автообновление сборки пропущено: pi-config-update.lock занят. Если установщик аварийно завершился, удалите файл после проверки процессов.", "warning");
        return;
      }
      // Another session could have completed while we were acquiring the lock.
      const state = await readState(agentDir);
      if (!isDue(state)) return;
      state.lastAttemptAt = new Date().toISOString();
      await saveState(agentDir, state);
      const { command, args } = updateCommand(agentDir);
      controller = new AbortController();
      ctx.ui.setStatus("auto-update", "Обновление сборки Pi…");
      const result = await pi.exec(command, args, {
        cwd: agentDir, timeout: 10 * 60 * 1000, signal: controller.signal,
      });
      if (result.code !== 0 || result.killed) {
        throw new Error("Установщик не завершился успешно. Повтор — не раньше чем через сутки; для диагностики запустите команду сборки вручную.");
      }
      state.lastSuccessAt = new Date().toISOString();
      await saveState(agentDir, state);
      ctx.ui.notify("Сборка Pi обновлена. Перезапустите Pi для применения изменений.", "info");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Do not forward installer output: it may include local settings.
        ctx.ui.notify(`Автообновление сборки: ${error instanceof Error ? error.message : "неизвестная ошибка"}`, "warning");
      }
    } finally {
      controller = undefined;
      ctx.ui.setStatus("auto-update", undefined);
      if (release) await release();
    }
  });
}
