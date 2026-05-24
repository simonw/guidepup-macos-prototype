import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { macOSActivate, voiceOver } from "@guidepup/guidepup";
import { macOSRecord } from "@guidepup/record";
import { webkit } from "playwright";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = join(rootDir, "artifacts");
const recordingsDir = join(rootDir, "recordings");
const playwrightVideoDir = join(recordingsDir, "playwright");
const testResultsDir = join(rootDir, "test-results");

const sessionVideoPath = join(recordingsDir, "guidepup-session.mov");
const audioProbePath = join(artifactsDir, "system-audio-probe");
const audioPath = join(artifactsDir, "system-audio-probe.wav");
const audioReportPath = join(artifactsDir, "system-audio-probe-report.json");
const transcriptPath = join(artifactsDir, "voiceover-transcript.json");
const subtitlesPath = join(artifactsDir, "voiceover-subtitles.srt");
const summaryJsonPath = join(artifactsDir, "summary.json");
const summaryMarkdownPath = join(artifactsDir, "summary.md");
const pagePath = join(rootDir, "fixtures", "voiceover-smoke.html");

const requireSystemAudio = process.env.REQUIRE_SYSTEM_AUDIO !== "false";
const audioProbeDurationSeconds = Number.parseInt(
  process.env.AUDIO_PROBE_SECONDS ?? "45",
  10,
);

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const expectedPagePattern = /Guidepup media smoke|Start audio probe/i;

async function fileSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolveWait) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    child.on("exit", (code, signal) => {
      settled = true;
      clearTimeout(timeout);
      resolveWait({ code, signal });
    });

    child.on("error", (error) => {
      settled = true;
      clearTimeout(timeout);
      resolveWait({ code: null, signal: null, error: String(error) });
    });
  });
}

function escapeSrt(text) {
  return text.replace(/\r?\n/g, " ").trim();
}

function toSrtTimestamp(offsetMs) {
  const totalMs = Math.max(0, offsetMs);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const milliseconds = totalMs % 1000;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}:${String(seconds).padStart(2, "0")},${String(milliseconds).padStart(
    3,
    "0",
  )}`;
}

function buildSrt(events) {
  return events
    .filter((event) => event.text)
    .map((event, index) => {
      const start = toSrtTimestamp(event.offsetMs);
      const end = toSrtTimestamp(event.offsetMs + 1800);
      return `${index + 1}\n${start} --> ${end}\n${escapeSrt(event.text)}\n`;
    })
    .join("\n");
}

async function readAudioReport() {
  if (!existsSync(audioReportPath)) {
    return null;
  }

  try {
    return JSON.parse(await readFile(audioReportPath, "utf8"));
  } catch (error) {
    return { status: "unreadable", error: String(error) };
  }
}

async function main() {
  await Promise.all([
    mkdir(artifactsDir, { recursive: true }),
    mkdir(recordingsDir, { recursive: true }),
    mkdir(playwrightVideoDir, { recursive: true }),
    mkdir(testResultsDir, { recursive: true }),
  ]);

  const startedAt = Date.now();
  const phraseEvents = [];
  const errors = [];
  const notes = [];
  let browser;
  let context;
  let screenRecordingStop;
  let audioProbe;
  let audioProbeResult;
  let voiceOverStarted = false;

  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    platform: process.platform,
    requireSystemAudio,
    checks: {},
    artifacts: {
      sessionVideoPath,
      playwrightVideoDir,
      audioPath,
      audioReportPath,
      transcriptPath,
      subtitlesPath,
    },
    notes,
    errors,
  };

  const rememberPhrase = async (label) => {
    try {
      const text = await voiceOver.lastSpokenPhrase();
      const trimmed = text?.trim();
      const previous = phraseEvents.at(-1)?.text;
      if (trimmed && trimmed !== previous) {
        phraseEvents.push({
          label,
          offsetMs: Date.now() - startedAt,
          text: trimmed,
        });
      }
    } catch (error) {
      notes.push(`Could not read last spoken phrase after ${label}: ${error}`);
    }
  };

  const activateWebContent = async (page) => {
    await macOSActivate("Playwright");
    await page.bringToFront();
    await page.locator("body").waitFor();
    await page.locator("body").focus();
    await page.locator("#page-title").focus();
    await sleep(500);
    await voiceOver.interact();
    await voiceOver.perform(voiceOver.keyboardCommands.jumpToLeftEdge);
    await voiceOver.clearItemTextLog();
    await voiceOver.clearSpokenPhraseLog();
  };

  try {
    if (process.platform !== "darwin") {
      throw new Error("This smoke test must run on macOS.");
    }

    try {
      screenRecordingStop = macOSRecord(sessionVideoPath);
      notes.push("Started Guidepup desktop session recording.");
    } catch (error) {
      errors.push(`Could not start Guidepup desktop recording: ${error}`);
    }

    if (existsSync(audioProbePath)) {
      audioProbe = spawn(
        audioProbePath,
        [audioPath, audioReportPath, String(audioProbeDurationSeconds)],
        { stdio: "inherit" },
      );
      notes.push("Started ScreenCaptureKit system-audio probe.");
      await sleep(1500);
    } else {
      const skippedReport = {
        status: "skipped",
        reason: `Missing compiled probe at ${audioProbePath}`,
      };
      await writeFile(audioReportPath, JSON.stringify(skippedReport, null, 2));
      notes.push("Skipped system-audio probe because the Swift binary was missing.");
    }

    spawnSync("say", ["Guidepup audio probe started. VoiceOver test beginning."], {
      stdio: "ignore",
    });

    browser = await webkit.launch({ headless: false });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: {
        dir: playwrightVideoDir,
        size: { width: 1280, height: 720 },
      },
    });

    const page = await context.newPage();
    await page.goto(pathToFileURL(pagePath).href);
    await page.locator("#page-title").waitFor();
    await page.bringToFront();
    await page.locator("#page-title").focus();
    await macOSActivate("Playwright");

    await voiceOver.start();
    voiceOverStarted = true;
    await sleep(1500);
    await activateWebContent(page);
    await sleep(1000);

    await rememberPhrase("navigate to web content");

    for (let index = 0; index < 8; index += 1) {
      const itemText = await voiceOver.itemText();
      if (expectedPagePattern.test(itemText)) {
        phraseEvents.push({
          label: `observed expected page content ${index + 1}`,
          offsetMs: Date.now() - startedAt,
          text: itemText,
        });
        break;
      }

      await voiceOver.perform(voiceOver.keyboardCommands.findNextHeading);
      await sleep(650);
      await rememberPhrase(`find next heading ${index + 1}`);
    }

    await page.keyboard.press("Tab");
    await sleep(1000);
    await rememberPhrase("tab to next control");

    const spokenPhraseLog = await voiceOver.spokenPhraseLog();
    const itemTextLog = await voiceOver.itemTextLog();

    const transcript = {
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      phraseEvents,
      spokenPhraseLog,
      itemTextLog,
    };

    await writeFile(transcriptPath, JSON.stringify(transcript, null, 2));
    await writeFile(subtitlesPath, buildSrt(phraseEvents));

    summary.checks.voiceOverStarted = voiceOverStarted;
    summary.checks.spokenPhraseCount = spokenPhraseLog.length;
    summary.checks.itemTextCount = itemTextLog.length;
    summary.checks.phraseEventCount = phraseEvents.length;
    summary.checks.transcriptNonEmpty =
      spokenPhraseLog.length > 0 || itemTextLog.length > 0 || phraseEvents.length > 0;
    summary.checks.expectedPageContentObserved = [
      ...spokenPhraseLog,
      ...itemTextLog,
      ...phraseEvents.map((event) => event.text),
    ].some((text) => expectedPagePattern.test(text));
  } catch (error) {
    errors.push(String(error));
  } finally {
    if (voiceOverStarted) {
      await voiceOver.stop().catch((error) => {
        errors.push(`Could not stop VoiceOver cleanly: ${error}`);
      });
    }

    if (context) {
      await context.close().catch((error) => {
        errors.push(`Could not close Playwright context cleanly: ${error}`);
      });
    }

    if (browser) {
      await browser.close().catch((error) => {
        errors.push(`Could not close browser cleanly: ${error}`);
      });
    }

    if (screenRecordingStop) {
      try {
        await Promise.resolve(screenRecordingStop());
        await sleep(1500);
      } catch (error) {
        errors.push(`Could not stop Guidepup desktop recording: ${error}`);
      }
    }

    if (audioProbe) {
      audioProbeResult = await waitForChild(
        audioProbe,
        (audioProbeDurationSeconds + 10) * 1000,
      );
      summary.audioProbeResult = audioProbeResult;
    }
  }

  const audioReport = await readAudioReport();
  const sessionVideoBytes = await fileSize(sessionVideoPath);
  const audioBytes = await fileSize(audioPath);
  const transcriptBytes = await fileSize(transcriptPath);
  const subtitlesBytes = await fileSize(subtitlesPath);

  summary.finishedAt = new Date().toISOString();
  summary.durationMs = Date.now() - startedAt;
  summary.audioReport = audioReport;
  summary.checks.sessionVideoBytes = sessionVideoBytes;
  summary.checks.audioBytes = audioBytes;
  summary.checks.transcriptBytes = transcriptBytes;
  summary.checks.subtitlesBytes = subtitlesBytes;
  summary.checks.sessionVideoNonEmpty = sessionVideoBytes > 1024;
  summary.checks.audioFileNonEmpty = audioBytes > 1024;
  summary.checks.audioPeakAmplitude = Number(audioReport?.peakAmplitude ?? 0);
  summary.checks.audioNonSilent = summary.checks.audioPeakAmplitude > 0.001;

  if (!summary.checks.voiceOverStarted) {
    errors.push("VoiceOver did not start.");
  }

  if (!summary.checks.transcriptNonEmpty) {
    errors.push("VoiceOver transcript is empty.");
  }

  if (!summary.checks.expectedPageContentObserved) {
    errors.push("VoiceOver did not observe the expected page content.");
  }

  if (!summary.checks.sessionVideoNonEmpty) {
    errors.push("Guidepup desktop session video is missing or empty.");
  }

  if (requireSystemAudio && !summary.checks.audioFileNonEmpty) {
    errors.push("System-audio probe file is missing or empty.");
  }

  if (requireSystemAudio && !summary.checks.audioNonSilent) {
    errors.push("System-audio probe did not report non-silent audio.");
  }

  const markdown = [
    "# VoiceOver Media Smoke",
    "",
    `- VoiceOver started: ${Boolean(summary.checks.voiceOverStarted)}`,
    `- Transcript entries: ${
      (summary.checks.spokenPhraseCount ?? 0) +
      (summary.checks.itemTextCount ?? 0) +
      (summary.checks.phraseEventCount ?? 0)
    }`,
    `- Expected page content observed: ${Boolean(
      summary.checks.expectedPageContentObserved,
    )}`,
    `- Session video bytes: ${summary.checks.sessionVideoBytes}`,
    `- Audio bytes: ${summary.checks.audioBytes}`,
    `- Audio peak amplitude: ${summary.checks.audioPeakAmplitude}`,
    `- Require system audio: ${requireSystemAudio}`,
    "",
    "## Notes",
    ...notes.map((note) => `- ${note}`),
    "",
    "## Errors",
    ...(errors.length > 0 ? errors.map((error) => `- ${error}`) : ["- None"]),
    "",
  ].join("\n");

  await writeFile(summaryJsonPath, JSON.stringify(summary, null, 2));
  await writeFile(summaryMarkdownPath, markdown);
  console.log(markdown);

  if (errors.length > 0) {
    throw new Error(
      `VoiceOver media smoke failed. See ${summaryMarkdownPath} in the uploaded artifact.`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
