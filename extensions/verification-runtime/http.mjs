import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const execute = promisify(execFile);
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_IN_TEXT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const SENSITIVE_KEY = /authorization|cookie|password|passwd|secret|token|api[_-]?key|jwt/i;
const METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];

export class RequestError extends Error {}

export function localUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new RequestError("Нужен абсолютный URL локального приложения."); }
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new RequestError("Разрешены только HTTP(S) localhost, 127.0.0.1 и ::1.");
  }
  if (url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => SENSITIVE_KEY.test(key))) {
    throw new RequestError("Credentials в URL, секретные query-параметры и fragment запрещены.");
  }
  return url;
}

export function fileReference(value, cwd) {
  if (typeof value !== "string" || !value.trim() || /[\0\r\n]/.test(value) || (value.trim().startsWith("eyJ") && JWT.test(value.trim()))) {
    throw new RequestError("Нужен путь к файлу, не значение секрета.");
  }
  let path = value;
  if (value === "~") path = homedir();
  else if (value.startsWith("~/")) path = join(homedir(), value.slice(2));
  return resolve(cwd, path);
}

async function regularFile(path, maximum) {
  try {
    const canonical = await realpath(path), info = await stat(canonical);
    if (!info.isFile() || info.size > maximum) throw new Error();
    return canonical;
  } catch { throw new RequestError("Файл недоступен, не является обычным файлом или превышает допустимый размер. Содержимое не показано."); }
}

function headerReferences(value, cwd) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new RequestError("Нужен список не более восьми файлов заголовков.");
  const names = new Set();
  return value.map(item => {
    if (!item || Object.keys(item).some(key => !["name", "file"].includes(key)) || typeof item.name !== "string"
      || !/^[A-Za-z0-9-]+$/.test(item.name) || /^(host|content-length|transfer-encoding|connection|proxy-authorization)$/i.test(item.name)) {
      throw new RequestError("Недопустимое имя credential-заголовка или формат ссылки.");
    }
    const name = item.name.toLowerCase();
    if (names.has(name)) throw new RequestError("Credential-заголовки не должны повторяться.");
    names.add(name);
    return { name: item.name, file: fileReference(item.file, cwd) };
  });
}

export async function resolveAuth(input, cwd) {
  let source, data = input, base = cwd;
  if (input.configFile && (input.jwtFile || input.headerFiles || input.authMode)) {
    throw new RequestError("Передай либо файл-указатель, либо явные ссылки на credential-файлы.");
  }
  if (input.configFile || (input.authMode !== "none" && !input.jwtFile && !input.headerFiles)) {
    const candidates = input.configFile ? [fileReference(input.configFile, cwd)] : [];
    if (!input.configFile) {
      let directory = resolve(cwd);
      while (true) {
        candidates.push(join(directory, ".paiw", "verification.json"));
        const parent = dirname(directory);
        if (existsSync(join(directory, ".git")) || directory === homedir() || parent === directory) break;
        directory = parent;
      }
      candidates.push(join(homedir(), ".paiw", "resources", "personal", "verification.json"));
    }
    source = candidates.find(candidate => existsSync(candidate));
    if (!source) return { status: "blocked", reason: "Нет безопасного указателя авторизации. Запроси путь к JWT-файлу или metadata-файлу, не сам JWT.", candidates };
    try {
      await regularFile(source, 16384);
      data = JSON.parse(await readFile(source, "utf8"));
    } catch { throw new RequestError("Не удалось прочитать безопасный JSON-указатель авторизации. Содержимое не показано."); }
    if (!data || Array.isArray(data) || typeof data !== "object" || Object.keys(data).some(key => !["jwtFile", "headerFiles", "authMode", "baseUrl"].includes(key))) {
      throw new RequestError("Указатель допускает только jwtFile, headerFiles, authMode и baseUrl; не храни в нём секреты.");
    }
    base = dirname(source);
  }
  const authMode = data.authMode ?? "jwt";
  if (!["jwt", "headers", "none"].includes(authMode)) throw new RequestError("Схема авторизации не поддерживается. Уточни jwt, headers или явно выбранный none.");
  const headers = headerReferences(data.headerFiles, base);
  if (authMode === "none" && (data.jwtFile !== undefined || headers.length)) {
    throw new RequestError("В режиме none нельзя передавать JWT или credential-заголовки.");
  }
  if (authMode === "jwt" && headers.some(header => /^authorization$/i.test(header.name))) {
    throw new RequestError("В JWT-режиме Authorization формируется только из jwtFile.");
  }
  if (authMode === "jwt" && !data.jwtFile) return { status: "blocked", reason: "Для JWT-режима нужен путь jwtFile. Не отправляй запрос без него." };
  if (authMode === "headers" && (data.jwtFile || !headers.length)) throw new RequestError("Для явно выбранной другой схемы нужны только именованные headerFiles.");
  const jwtFile = data.jwtFile ? await regularFile(fileReference(data.jwtFile, base), 65536) : undefined;
  for (const header of headers) header.file = await regularFile(header.file, 65536);
  return {
    status: "ready", source, authMode, jwtFile, headerFiles: headers,
    baseUrl: data.baseUrl ? localUrl(data.baseUrl).href : undefined,
  };
}

export function redact(value, secrets = []) {
  let text = String(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(JWT_IN_TEXT, "[REDACTED_JWT]");
}

function responsePreview(text, secrets) {
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : clean(item)]));
    return typeof value === "string" ? redact(value, secrets) : value;
  };
  try { return JSON.stringify(clean(JSON.parse(text)), null, 2).slice(0, 8000); }
  catch { return redact(text, secrets).replace(/((?:authorization|cookie|password|secret|token|api[_-]?key|jwt)\s*[:=]\s*)[^\s,;<]+/gi, "$1[REDACTED]").slice(0, 8000); }
}

async function credential(path) {
  const reference = await regularFile(path, 65536);
  let value;
  try { value = (await readFile(reference, "utf8")).trim(); }
  catch { throw new RequestError("Не удалось загрузить credential внутри исполнителя; значение не показано."); }
  if (!value || /[\0\r\n]/.test(value)) throw new RequestError("Credential-файл пуст или имеет неподдерживаемый формат. Нужен один credential без переносов строк.");
  return value;
}

export async function runLocalCurl(input, cwd, signal) {
  signal?.throwIfAborted();
  const url = localUrl(input.url), method = input.method ?? "GET";
  if (!METHODS.includes(method)) throw new RequestError("Неподдерживаемый HTTP-метод.");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && input.mutationApproved !== true) {
    throw new RequestError("Сначала получи разрешение на последствия изменяющего HTTP-запроса.");
  }
  const timeout = input.timeoutSeconds ?? 20;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) throw new RequestError("Timeout должен быть от 1 до 120 секунд.");
  if (input.expectedStatus !== undefined && (!Number.isInteger(input.expectedStatus) || input.expectedStatus < 100 || input.expectedStatus > 599)) {
    throw new RequestError("Некорректный ожидаемый HTTP-статус.");
  }
  if (input.contentType && !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:; charset=[A-Za-z0-9-]+)?$/.test(input.contentType)) {
    throw new RequestError("Недопустимый Content-Type.");
  }
  const auth = await resolveAuth(input, cwd);
  if (auth.status !== "ready") throw new RequestError(auth.reason);
  if ((auth.authMode !== "jwt" || auth.headerFiles.length) && input.authApproved !== true) {
    throw new RequestError("Схемы none/headers и дополнительные credentials должны быть явно согласованы пользователем.");
  }
  const secrets = [], headers = [];
  if (auth.jwtFile) {
    const jwt = await credential(auth.jwtFile);
    if (!JWT.test(jwt)) throw new RequestError("jwtFile должен содержать только JWT. Уточни формат, не читай файл инструментами модели.");
    secrets.push(jwt); headers.push(`Authorization: Bearer ${jwt}`);
  }
  for (const header of auth.headerFiles) {
    const value = await credential(header.file);
    secrets.push(value); headers.push(`${header.name}: ${value}`);
  }
  if (secrets.some(secret => url.href.includes(secret))) throw new RequestError("Credential не может находиться в URL.");
  const bodyFile = input.bodyFile ? await regularFile(fileReference(input.bodyFile, cwd), 1048576) : undefined;
  if (bodyFile && [auth.jwtFile, ...auth.headerFiles.map(header => header.file)].includes(bodyFile)) throw new RequestError("Credential-файл не может использоваться как тело запроса.");
  if (method === "HEAD" && bodyFile) throw new RequestError("HEAD не принимает тело запроса.");
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "pi-verification-http-"));
  const headerFile = join(directory, "headers.private"), responseFile = join(directory, "response.private");
  let saved = false;
  try {
    await writeFile(headerFile, `${headers.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(responseFile, "", { mode: 0o600, flag: "wx" });
    const args = ["--disable", "--silent", "--show-error", "--globoff", "--noproxy", "*", "--proto", "=http,https", "--max-time", String(timeout), "--max-filesize", "4194304", "--header", `@${headerFile}`, "--output", responseFile, "--write-out", "%{http_code}"];
    if (url.hostname === "localhost") args.push("--resolve", `localhost:${url.port || (url.protocol === "https:" ? "443" : "80")}:127.0.0.1`);
    args.push(method === "HEAD" ? "--head" : "--request", ...(method === "HEAD" ? [] : [method]));
    if (input.contentType) args.push("--header", `Content-Type: ${input.contentType}`);
    if (bodyFile) args.push("--data-binary", `@${bodyFile}`);
    args.push("--url", url.href);
    let code = 0, stdout = "", stderr = "";
    try {
      ({ stdout, stderr } = await execute("curl", args, { encoding: "utf8", maxBuffer: 65536, timeout: (timeout + 5) * 1000, signal, windowsHide: true }));
    } catch (error) {
      code = typeof error.code === "number" ? error.code : 1;
      stdout = typeof error.stdout === "string" ? error.stdout : "";
      if (signal?.aborted) stderr = "Запрос отменён.";
      else if (typeof error.stderr === "string" && error.stderr) stderr = error.stderr;
      else stderr = "Не удалось выполнить curl; проверь наличие curl и доступность приложения.";
    }
    const httpStatus = /^\d{3}$/.test(stdout.trim()) ? Number(stdout.trim()) : 0;
    const matches = input.expectedStatus !== undefined ? httpStatus === input.expectedStatus : httpStatus >= 200 && httpStatus < 300;
    await regularFile(responseFile, 4194304);
    let outcome = "failed";
    if (code === 0 && matches) outcome = "passed";
    else if (code === 0 && [401, 403].includes(httpStatus)) outcome = "blocked";
    const report = {
      outcome,
      method, url: url.href, exitCode: code, httpStatus, expectedStatus: input.expectedStatus,
      response: method === "HEAD" ? "" : responsePreview(await readFile(responseFile, "utf8"), secrets),
      error: redact(stderr, secrets).slice(0, 2000),
      note: "Редиректы не выполнялись. Credentials и сырые ответы не сохраняются в отчёте.",
    };
    const reportFile = join(directory, "report.json");
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    saved = true;
    return { ...report, reportFile };
  } finally {
    await Promise.all([rm(headerFile, { force: true }), rm(responseFile, { force: true })]);
    if (!saved) await rm(directory, { recursive: true, force: true });
  }
}
