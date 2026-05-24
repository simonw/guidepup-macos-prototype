#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, appendFile, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import process from "node:process";

const VOICEOVER_STARTER =
  "/System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOverStarter";
const VOICEOVER_APPLESCRIPT_ENABLED_DEFAULTS = [
  "read",
  "com.apple.VoiceOver4/default",
  "SCREnableAppleScript",
];
const VOICEOVER_APPLESCRIPT_ENABLED_DB_FILE =
  "/private/var/db/Accessibility/.VoiceOverAppleScriptEnabled";

const knownOutputables = new Set([
  "announcement history",
  "mouse summary",
  "web overview",
  "window overview",
  "workspace overview",
]);

const knownMenus = new Set([
  "applications menu",
  "commands menu",
  "contextual menu",
  "help menu",
  "item chooser",
  "web menu",
  "windows menu",
]);

const knownResources = new Set(["quickstart", "utility", "VoiceOver help"]);

const usage = `Usage:
  npm run voctl -- detect [--pretty] [-f other-file.jsonl]
  npm run voctl -- start [--pretty] [-f other-file.jsonl]
  npm run voctl -- stop [--pretty] [-f other-file.jsonl]
  npm run voctl -- read [--pretty] [-f other-file.jsonl]
  npm run voctl -- perform "move right" [--read-after] [--pretty] [-f other-file.jsonl]
  npm run voctl -- move right [--to "first item"] [--read-after] [--pretty] [-f other-file.jsonl]
  npm run voctl -- output "window overview" [--read-after] [--pretty] [-f other-file.jsonl]
  npm run voctl -- open "commands menu" [--read-after] [--pretty] [-f other-file.jsonl]
  npm run voctl -- open-url "https://example.com/" [--browser Safari] [--read-after] [--pretty] [-f other-file.jsonl]
  npm run voctl -- browser-state [--browser Safari] [--pretty] [-f other-file.jsonl]
  npm run voctl -- activate-app Safari [--read-after] [--pretty] [-f other-file.jsonl]
  npm run voctl -- keystroke "/" [--read-after] [--pretty] [-f other-file.jsonl]
  npm run voctl -- type "search text" [--read-after] [--pretty] [-f other-file.jsonl]
  npm run voctl -- key-code 36 [--read-after] [--pretty] [-f other-file.jsonl]
  npm run voctl -- action [--read-after] [--pretty] [-f other-file.jsonl]
  npm run voctl -- select [--read-after] [--pretty] [-f other-file.jsonl]
  npm run voctl -- sequence actions.json [--read-after] [--pretty] [-f other-file.jsonl]

Options:
  -f, --log-file PATH   append JSONL events to PATH; defaults to ./voice-over.jsonl

Sequence file shape:
  {
    "actions": [
      { "do": "perform", "command": "move right", "readAfter": true },
      { "do": "read" },
      { "do": "wait", "ms": 500 }
    ]
  }
`;

function parseGlobalOptions(args) {
  const options = {
    pretty: false,
    readAfter: false,
    timeoutSeconds: 5,
    logFile: "voice-over.jsonl",
    remaining: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--read-after") {
      options.readAfter = true;
    } else if (arg === "--timeout") {
      options.timeoutSeconds = Number.parseInt(args[index + 1] ?? "", 10);
      index += 1;
    } else if (arg === "-f" || arg === "--log-file") {
      options.logFile = args[index + 1];
      index += 1;
    } else {
      options.remaining.push(arg);
    }
  }

  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error("--timeout must be a positive number of seconds.");
  }

  if (!options.logFile) {
    throw new Error("-f/--log-file requires a file path.");
  }

  return options;
}

function logFileFromRawArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-f" || args[index] === "--log-file") {
      return args[index + 1] || "voice-over.jsonl";
    }
  }

  return "voice-over.jsonl";
}

async function appendJsonl(logFile, record) {
  await appendFile(logFile, `${JSON.stringify(record)}\n`, "utf8");
}

function buildLogRecord({ options, input, output, exitCode, startedAt }) {
  return {
    timestamp: new Date().toISOString(),
    startedAt,
    durationMs: Date.now() - Date.parse(startedAt),
    tool: "voctl",
    cwd: process.cwd(),
    argv: process.argv.slice(2),
    logFile: options.logFile,
    input,
    output,
    exitCode,
  };
}

function appleText(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function withVoiceOver(scriptBody, timeoutSeconds) {
  return `with timeout of ${timeoutSeconds} seconds
tell application "VoiceOver"
  ${scriptBody}
end tell
end timeout`;
}

function withVoiceOverTransaction(scriptBody, timeoutSeconds) {
  return withVoiceOver(
    `with transaction
    ${scriptBody}
  end transaction`,
    timeoutSeconds,
  );
}

function withSystemEvents(scriptBody, timeoutSeconds) {
  return `with timeout of ${timeoutSeconds} seconds
tell application "System Events"
  ${scriptBody}
end tell
end timeout`;
}

function runCommand(command, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code: error?.code ?? 0,
        signal: error?.signal ?? null,
        error: error ? String(error.message ?? error) : null,
      });
    });
  });
}

async function runAppleScript(script, timeoutSeconds = 5) {
  const result = await runCommand(
    "/usr/bin/osascript",
    ["-e", script],
    (timeoutSeconds + 2) * 1000,
  );

  return {
    ...result,
    script,
  };
}

function parseNamedOption(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  return args[index + 1] ?? fallback;
}

function positionalArgs(args, optionNames) {
  const filtered = [];
  for (let index = 0; index < args.length; index += 1) {
    if (optionNames.includes(args[index])) {
      index += 1;
    } else {
      filtered.push(args[index]);
    }
  }

  return filtered;
}

async function probeAppleScript(name, scriptBody, timeoutSeconds) {
  const result = await runAppleScript(withVoiceOver(scriptBody, timeoutSeconds), timeoutSeconds);
  return {
    name,
    ok: result.ok,
    value: result.ok ? result.stdout : null,
    error: result.ok ? null : result.stderr || result.error,
  };
}

async function readVoiceOver(timeoutSeconds) {
  const probes = await Promise.all([
    probeAppleScript("running", "return running", timeoutSeconds),
    probeAppleScript("lastPhrase", "return content of last phrase", timeoutSeconds),
    probeAppleScript("voCursorText", "return text under cursor of vo cursor", timeoutSeconds),
    probeAppleScript(
      "keyboardCursorText",
      "return text under cursor of keyboard cursor",
      timeoutSeconds,
    ),
    probeAppleScript("voCursorBounds", "return bounds of vo cursor", timeoutSeconds),
    probeAppleScript("captionWindowEnabled", "return enabled of caption window", timeoutSeconds),
  ]);

  const fields = Object.fromEntries(
    probes.filter((probe) => probe.ok).map((probe) => [probe.name, probe.value]),
  );
  const errors = Object.fromEntries(
    probes
      .filter((probe) => !probe.ok)
      .map((probe) => [probe.name, probe.error]),
  );

  return {
    ok:
      Boolean(fields.lastPhrase) ||
      Boolean(fields.voCursorText) ||
      Boolean(fields.keyboardCursorText),
    fields,
    errors,
  };
}

async function detect(timeoutSeconds) {
  const defaultsResult = await runCommand(
    "/usr/bin/defaults",
    VOICEOVER_APPLESCRIPT_ENABLED_DEFAULTS,
  );
  const dbFileExists = await access(
    VOICEOVER_APPLESCRIPT_ENABLED_DB_FILE,
    fsConstants.F_OK,
  )
    .then(() => true)
    .catch(() => false);

  const appName = await probeAppleScript("appName", "return name", timeoutSeconds);
  const running = await probeAppleScript("running", "return running", timeoutSeconds);
  const lastPhrase = await probeAppleScript(
    "lastPhrase",
    "return content of last phrase",
    timeoutSeconds,
  );
  const voCursorText = await probeAppleScript(
    "voCursorText",
    "return text under cursor of vo cursor",
    timeoutSeconds,
  );
  const commander = await probeAppleScript("commander", "return class of commander", timeoutSeconds);

  return {
    ok:
      process.platform === "darwin" &&
      appName.ok &&
      running.ok &&
      (lastPhrase.ok || voCursorText.ok || commander.ok),
    platform: process.platform,
    appleScriptControl: {
      defaultsEnabled: defaultsResult.ok && defaultsResult.stdout === "1",
      defaultsRaw: defaultsResult.ok ? defaultsResult.stdout : null,
      defaultsError: defaultsResult.ok ? null : defaultsResult.stderr || defaultsResult.error,
      dbFileExists,
      dbFile: VOICEOVER_APPLESCRIPT_ENABLED_DB_FILE,
    },
    probes: {
      appName,
      running,
      lastPhrase,
      voCursorText,
      commander,
    },
  };
}

async function startVoiceOver(timeoutSeconds) {
  const started = await runCommand(VOICEOVER_STARTER, [], (timeoutSeconds + 5) * 1000);
  return {
    ok: started.ok,
    started,
    read: await readVoiceOver(timeoutSeconds),
  };
}

async function stopVoiceOver(timeoutSeconds) {
  const result = await runAppleScript(
    withVoiceOver("quit", timeoutSeconds),
    timeoutSeconds,
  );
  return {
    ok: result.ok,
    result: summarizeAppleScript(result),
  };
}

async function activateApp(appName, timeoutSeconds) {
  const result = await runAppleScript(
    `with timeout of ${timeoutSeconds} seconds
tell application ${appleText(appName)} to activate
end timeout`,
    timeoutSeconds,
  );

  return {
    ok: result.ok,
    action: { do: "activate-app", appName },
    result: summarizeAppleScript(result),
  };
}

async function openUrl(url, appName, timeoutSeconds) {
  const result = await runAppleScript(
    `with timeout of ${timeoutSeconds} seconds
tell application ${appleText(appName)}
  activate
  open location ${appleText(url)}
end tell
end timeout`,
    timeoutSeconds,
  );

  return {
    ok: result.ok,
    action: { do: "open-url", url, appName },
    result: summarizeAppleScript(result),
  };
}

async function browserState(appName, timeoutSeconds) {
  const separator = String.fromCharCode(30);
  const result = await runAppleScript(
    `with timeout of ${timeoutSeconds} seconds
tell application ${appleText(appName)}
  if (count of documents) is 0 then
    return ""
  end if
  set pageName to name of front document
  set pageUrl to URL of front document
  return pageName & (ASCII character 30) & pageUrl
end tell
end timeout`,
    timeoutSeconds,
  );

  const [title = "", url = ""] = result.stdout.split(separator);
  return {
    ok: result.ok,
    action: { do: "browser-state", appName },
    title,
    url,
    result: summarizeAppleScript(result),
  };
}

async function keystroke(text, timeoutSeconds) {
  const result = await runAppleScript(
    withSystemEvents(`keystroke ${appleText(text)}`, timeoutSeconds),
    timeoutSeconds,
  );

  return {
    ok: result.ok,
    action: { do: "keystroke", text },
    result: summarizeAppleScript(result),
  };
}

async function keyCode(code, timeoutSeconds) {
  const numericCode = Number.parseInt(code, 10);
  if (!Number.isFinite(numericCode)) {
    throw new Error("key-code requires a numeric key code.");
  }

  const result = await runAppleScript(
    withSystemEvents(`key code ${numericCode}`, timeoutSeconds),
    timeoutSeconds,
  );

  return {
    ok: result.ok,
    action: { do: "key-code", code: numericCode },
    result: summarizeAppleScript(result),
  };
}

function summarizeAppleScript(result) {
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    signal: result.signal,
    error: result.error,
  };
}

async function performCommand(command, timeoutSeconds) {
  const result = await runAppleScript(
    withVoiceOverTransaction(
      `tell commander to perform command ${appleText(command)}`,
      timeoutSeconds,
    ),
    timeoutSeconds,
  );

  return {
    ok: result.ok,
    action: { do: "perform", command },
    result: summarizeAppleScript(result),
  };
}

async function moveCursor(direction, place, timeoutSeconds) {
  const allowedDirections = new Set(["up", "down", "left", "right"]);
  if (!allowedDirections.has(direction)) {
    throw new Error("move direction must be up, down, left, or right.");
  }

  const script = `tell vo cursor to move ${direction}${
    place ? ` to ${place}` : ""
  }`;
  const result = await runAppleScript(
    withVoiceOverTransaction(script, timeoutSeconds),
    timeoutSeconds,
  );

  return {
    ok: result.ok,
    action: { do: "move", direction, to: place ?? null },
    result: summarizeAppleScript(result),
  };
}

async function output(target, timeoutSeconds) {
  const targetScript = knownOutputables.has(target) ? target : appleText(target);
  const result = await runAppleScript(
    withVoiceOverTransaction(`output ${targetScript}`, timeoutSeconds),
    timeoutSeconds,
  );

  return {
    ok: result.ok,
    action: { do: "output", target },
    result: summarizeAppleScript(result),
  };
}

async function openTarget(target, timeoutSeconds) {
  if (!knownMenus.has(target) && !knownResources.has(target)) {
    throw new Error(
      `Unknown VoiceOver open target: ${target}. Use a menu/resource name from VoiceOver's AppleScript dictionary.`,
    );
  }

  const result = await runAppleScript(
    withVoiceOverTransaction(`open ${target}`, timeoutSeconds),
    timeoutSeconds,
  );

  return {
    ok: result.ok,
    action: { do: "open", target },
    result: summarizeAppleScript(result),
  };
}

async function voCursorCommand(command, timeoutSeconds) {
  const allowed = new Set(["perform action", "select"]);
  if (!allowed.has(command)) {
    throw new Error(`Unsupported VO cursor command: ${command}`);
  }

  const result = await runAppleScript(
    withVoiceOverTransaction(`tell vo cursor to ${command}`, timeoutSeconds),
    timeoutSeconds,
  );

  return {
    ok: result.ok,
    action: { do: command === "select" ? "select" : "action" },
    result: summarizeAppleScript(result),
  };
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return {
    ok: true,
    action: { do: "wait", ms },
  };
}

async function runAction(action, options) {
  const timeoutSeconds = action.timeoutSeconds ?? options.timeoutSeconds;
  let result;

  switch (action.do) {
    case "read":
      result = await readVoiceOver(timeoutSeconds);
      return {
        ok: result.ok,
        action,
        read: result,
      };
    case "perform":
      result = await performCommand(action.command, timeoutSeconds);
      break;
    case "move":
      result = await moveCursor(action.direction, action.to, timeoutSeconds);
      break;
    case "output":
      result = await output(action.target ?? action.text, timeoutSeconds);
      break;
    case "open":
      result = await openTarget(action.target, timeoutSeconds);
      break;
    case "action":
      result = await voCursorCommand("perform action", timeoutSeconds);
      break;
    case "select":
      result = await voCursorCommand("select", timeoutSeconds);
      break;
    case "wait":
      result = await wait(action.ms ?? 250);
      break;
    case "activate-app":
      result = await activateApp(action.appName, timeoutSeconds);
      break;
    case "open-url":
      result = await openUrl(action.url, action.appName ?? "Safari", timeoutSeconds);
      break;
    case "browser-state":
      result = await browserState(action.appName ?? "Safari", timeoutSeconds);
      break;
    case "keystroke":
    case "type":
      result = await keystroke(action.text, timeoutSeconds);
      break;
    case "key-code":
      result = await keyCode(action.code, timeoutSeconds);
      break;
    default:
      throw new Error(`Unsupported sequence action: ${action.do}`);
  }

  if (action.readAfter ?? options.readAfter) {
    result.read = await readVoiceOver(timeoutSeconds);
  }

  return result;
}

async function loadSequence(path) {
  const content =
    path === "-"
      ? await new Promise((resolve, reject) => {
          let buffer = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => {
            buffer += chunk;
          });
          process.stdin.on("end", () => resolve(buffer));
          process.stdin.on("error", reject);
        })
      : await readFile(path, "utf8");

  const parsed = JSON.parse(content);
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed.actions)) {
    return parsed.actions;
  }

  throw new Error("Sequence JSON must be an array or an object with an actions array.");
}

function parseMoveArgs(args) {
  const direction = args[0];
  let place = null;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === "--to") {
      place = args[index + 1];
      index += 1;
    }
  }
  return { direction, place };
}

async function main() {
  const options = parseGlobalOptions(process.argv.slice(2));
  const [command, ...args] = options.remaining;
  const startedAt = new Date().toISOString();
  const inputPayload = {
    command: command ?? null,
    args,
    options: {
      pretty: options.pretty,
      readAfter: options.readAfter,
      timeoutSeconds: options.timeoutSeconds,
      logFile: options.logFile,
    },
  };

  if (!command || command === "-h" || command === "--help") {
    console.log(usage);
    await appendJsonl(
      options.logFile,
      buildLogRecord({
        options,
        input: inputPayload,
        output: { ok: true, help: true },
        exitCode: 0,
        startedAt,
      }),
    );
    return;
  }

  let outputPayload;
  let exitCode = 0;

  try {
    switch (command) {
      case "detect":
        outputPayload = await detect(options.timeoutSeconds);
        break;
      case "start":
        outputPayload = await startVoiceOver(options.timeoutSeconds);
        break;
      case "stop":
        outputPayload = await stopVoiceOver(options.timeoutSeconds);
        break;
      case "read":
        outputPayload = await readVoiceOver(options.timeoutSeconds);
        break;
      case "perform":
        inputPayload.action = { do: "perform", command: args.join(" ") };
        outputPayload = await performCommand(args.join(" "), options.timeoutSeconds);
        if (options.readAfter) {
          outputPayload.read = await readVoiceOver(options.timeoutSeconds);
        }
        break;
      case "move": {
        const { direction, place } = parseMoveArgs(args);
        inputPayload.action = { do: "move", direction, to: place };
        outputPayload = await moveCursor(direction, place, options.timeoutSeconds);
        if (options.readAfter) {
          outputPayload.read = await readVoiceOver(options.timeoutSeconds);
        }
        break;
      }
      case "output":
        inputPayload.action = { do: "output", target: args.join(" ") };
        outputPayload = await output(args.join(" "), options.timeoutSeconds);
        if (options.readAfter) {
          outputPayload.read = await readVoiceOver(options.timeoutSeconds);
        }
        break;
      case "open":
        inputPayload.action = { do: "open", target: args.join(" ") };
        outputPayload = await openTarget(args.join(" "), options.timeoutSeconds);
        if (options.readAfter) {
          outputPayload.read = await readVoiceOver(options.timeoutSeconds);
        }
        break;
      case "open-url": {
        const browser = parseNamedOption(args, "--browser", "Safari");
        const [url] = positionalArgs(args, ["--browser"]);
        inputPayload.action = { do: "open-url", url, appName: browser };
        outputPayload = await openUrl(url, browser, options.timeoutSeconds);
        if (options.readAfter) {
          outputPayload.read = await readVoiceOver(options.timeoutSeconds);
        }
        break;
      }
      case "browser-state": {
        const browser = parseNamedOption(args, "--browser", "Safari");
        inputPayload.action = { do: "browser-state", appName: browser };
        outputPayload = await browserState(browser, options.timeoutSeconds);
        break;
      }
      case "activate-app":
        inputPayload.action = { do: "activate-app", appName: args.join(" ") };
        outputPayload = await activateApp(args.join(" "), options.timeoutSeconds);
        if (options.readAfter) {
          outputPayload.read = await readVoiceOver(options.timeoutSeconds);
        }
        break;
      case "keystroke":
      case "type":
        inputPayload.action = { do: command, text: args.join(" ") };
        outputPayload = await keystroke(args.join(" "), options.timeoutSeconds);
        if (options.readAfter) {
          outputPayload.read = await readVoiceOver(options.timeoutSeconds);
        }
        break;
      case "key-code":
        inputPayload.action = { do: "key-code", code: args[0] };
        outputPayload = await keyCode(args[0], options.timeoutSeconds);
        if (options.readAfter) {
          outputPayload.read = await readVoiceOver(options.timeoutSeconds);
        }
        break;
      case "action":
        inputPayload.action = { do: "action" };
        outputPayload = await voCursorCommand("perform action", options.timeoutSeconds);
        if (options.readAfter) {
          outputPayload.read = await readVoiceOver(options.timeoutSeconds);
        }
        break;
      case "select":
        inputPayload.action = { do: "select" };
        outputPayload = await voCursorCommand("select", options.timeoutSeconds);
        if (options.readAfter) {
          outputPayload.read = await readVoiceOver(options.timeoutSeconds);
        }
        break;
      case "sequence": {
        const sequencePath = args[0];
        if (!sequencePath) {
          throw new Error("sequence requires a JSON file path or '-' for stdin.");
        }
        const actions = await loadSequence(sequencePath);
        inputPayload.sequence = {
          path: sequencePath,
          actions,
        };
        const results = [];
        for (const action of actions) {
          results.push(await runAction(action, options));
        }
        outputPayload = {
          ok: results.every((result) => result.ok),
          results,
        };
        break;
      }
      default:
        throw new Error(`Unknown command: ${command}`);
    }

    if (outputPayload.ok === false) {
      exitCode = 1;
    }
  } catch (error) {
    outputPayload = { ok: false, error: String(error) };
    exitCode = 1;
  }

  console.log(JSON.stringify(outputPayload, null, options.pretty ? 2 : 0));

  try {
    await appendJsonl(
      options.logFile,
      buildLogRecord({
        options,
        input: inputPayload,
        output: outputPayload,
        exitCode,
        startedAt,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        error: `Could not write VoiceOver log: ${error}`,
        logFile: options.logFile,
      }),
    );
    exitCode = 1;
  }

  process.exitCode = exitCode;
}

main().catch(async (error) => {
  const outputPayload = { ok: false, error: String(error) };
  const logFile = logFileFromRawArgs(process.argv.slice(2));
  console.error(JSON.stringify(outputPayload, null, 2));
  try {
    await appendJsonl(
      logFile,
      buildLogRecord({
        options: { logFile },
        input: { argv: process.argv.slice(2) },
        output: outputPayload,
        exitCode: 1,
        startedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // If parsing or logging setup is broken, preserve the original error.
  }
  process.exitCode = 1;
});
