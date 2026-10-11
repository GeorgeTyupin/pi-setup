import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Hide automatic skill descriptions without removing /skill commands or changing linked sources. */
export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.skills = event.systemPromptOptions.skills
			.filter((skill) => !["swe-helper", "self-improvement"].includes(skill.name))
			.map((skill) => ({ ...skill, disableModelInvocation: true }));
	});
}
