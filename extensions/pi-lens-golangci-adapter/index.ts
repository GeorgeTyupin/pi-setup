import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyAdapter } from "./adapter.mjs";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const packageDir = join(getAgentDir(), "npm", "node_modules", "pi-lens");
    if (!existsSync(join(packageDir, "package.json"))) return;
    try {
      if (applyAdapter(packageDir) > 0) {
        ctx.ui.notify("Pi Lens: добавлена совместимость golangci-lint v2; выполни /reload.", "info");
      }
    } catch (error) {
      ctx.ui.notify(`Pi Lens: автопатч не применён: ${String(error)}`, "warning");
    }
  });
}
