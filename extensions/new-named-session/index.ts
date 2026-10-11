import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Built-in commands run before input handlers. Bare /new stays native;
  // /new <name> reaches input and dispatches a non-conflicting command.
  pi.on("input", (event) => {
    const match = /^\/new\s+([\s\S]+)$/.exec(event.text.trim());
    const name = match?.[1].trim();
    if (!name) return { action: "continue" };
    pi.sendUserMessage(`/new-with-name ${name}`, { expandPromptTemplates: true });
    return { action: "handled" };
  });

  pi.registerCommand("new-with-name", {
    description: "Start a new session with a name (usage: /new-with-name <name>)",
    handler: async (args, ctx) => {
      const name = args.trim();
      await ctx.newSession({
        setup: async (sessionManager) => {
          if (name) sessionManager.appendSessionInfo(name);
        },
        withSession: async (newCtx) => {
          if (name) newCtx.ui.notify(`New session: ${name}`, "info");
        },
      });
    },
  });
}
