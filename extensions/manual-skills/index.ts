import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function ownSkill(filePath: string, roots: string[]): boolean {
	let path: string;
	try { path = realpathSync(filePath); } catch { return false; }
	return roots.some(root => {
		const [directory, child] = relative(root, path).split(sep);
		return (directory === "skills" && child !== "paiw") || (directory === "work" && child === "skills");
	});
}

/** Honor our frontmatter without changing the existing policy for external skills. */
export default function (pi: ExtensionAPI) {
	const roots = [fileURLToPath(new URL("../../", import.meta.url)), getAgentDir()].map(root => {
		try { return realpathSync(root); } catch { return resolve(root); }
	});
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.skills = event.systemPromptOptions.skills
			.filter((skill) => !["swe-helper", "self-improvement"].includes(skill.name))
			.map((skill) => ownSkill(skill.filePath, roots) ? skill : { ...skill, disableModelInvocation: true });
	});
}
