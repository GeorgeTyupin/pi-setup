const SKILLS = ["verify", "code-review", "tester", "curler"];
export const CHECKS = ["review", "tests", "curl"];
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function words(input) {
  const result = [];
  let word = "", quote = "", escaped = false, started = false;
  for (const character of input) {
    if (escaped) { word += character; escaped = false; started = true; }
    else if (character === "\\" && quote !== "'") { escaped = true; started = true; }
    else if (quote) { if (character === quote) quote = ""; else word += character; }
    else if (character === "'" || character === '"') { quote = character; started = true; }
    else if (/\s/.test(character)) { if (started) result.push(word); word = ""; started = false; }
    else { word += character; started = true; }
  }
  if (quote || escaped) throw new Error("Незакрытая кавычка или escape в аргументах.");
  if (started) result.push(word);
  return result;
}

export function parseInvocation(skill, input = "") {
  if (!SKILLS.includes(skill)) throw new Error("Неизвестный скилл проверки.");
  const tokens = words(input), options = {}, target = [];
  const assign = (key, value) => {
    if (options[key] !== undefined && JSON.stringify(options[key]) !== JSON.stringify(value)) {
      throw new Error(`Противоречащие значения ${key}.`);
    }
    options[key] = value;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--") { target.push(...tokens.slice(index + 1)); break; }
    if (token === "--agent" || token === "--inline") { assign("mode", token.slice(2)); continue; }
    if (token === "--effort" || token.startsWith("--effort=") || token === "--checks" || token.startsWith("--checks=")) {
      const equals = token.indexOf("="), key = token.slice(2, equals < 0 ? undefined : equals);
      const value = equals < 0 ? tokens[++index] : token.slice(equals + 1);
      if (!value || value.startsWith("--")) throw new Error(`У --${key} отсутствует значение.`);
      assign(key, key === "checks" ? [...new Set(value.split(","))] : value);
      continue;
    }
    if (token.startsWith("-")) throw new Error(`Неизвестный флаг: ${token.split("=")[0]}.`);
    target.push(token);
  }
  if (options.checks && skill !== "verify") throw new Error("--checks доступен только у verify.");
  return { ...options, target: target.join(" ") };
}

export function resolveOptions(input, supportedEfforts) {
  const parsed = parseInvocation(input.skill, input.arguments ?? "");
  const choose = key => {
    const explicit = input[key];
    if (explicit !== undefined && parsed[key] !== undefined && JSON.stringify(explicit) !== JSON.stringify(parsed[key])) {
      throw new Error(`Параметр из запроса или ответа противоречит явному флагу ${key}.`);
    }
    return explicit ?? parsed[key];
  };
  const mode = choose("mode"), effort = choose("effort");
  const checks = input.skill === "verify" ? choose("checks") : [({ "code-review": "review", tester: "tests", curler: "curl" })[input.skill]];
  if (mode !== undefined && !["agent", "inline"].includes(mode)) throw new Error("Режим: agent или inline.");
  if (checks !== undefined && (!Array.isArray(checks) || !checks.length || checks.some(check => !CHECKS.includes(check)) || new Set(checks).size !== checks.length)) {
    throw new Error("Выбери непустой набор review, tests, curl без повторов.");
  }
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new Error("Неизвестный effort.");
  if (checks && !checks.includes("review") && effort !== undefined) throw new Error("Effort применим только к code-review.");
  if (effort !== undefined && !supportedEfforts.includes(effort)) throw new Error("Выбранный effort не поддерживается текущей моделью. Выбери другой явно.");
  const missing = [];
  if (!checks) missing.push("checks");
  if (!mode) missing.push("mode");
  if (checks?.includes("review") && effort === undefined) missing.push("effort");
  return {
    ready: missing.length === 0, skill: input.skill, mode, checks, effort, target: parsed.target, missing,
    supportedEfforts,
    recommendedMode: input.skill === "verify" ? "agent" : "inline",
    recommendedEffort: supportedEfforts.includes("medium") ? "medium" : supportedEfforts[0],
    contexts: { review: "fork", tests: "fresh", curl: "fresh" },
  };
}
