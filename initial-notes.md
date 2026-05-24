I would like to automated testing of VoiceOver against Safari on my Mac with a script that record the audio and maybe even video of the screen while the script is running, controlling the keyboard and making sure to capture the voice audio

How feasible is this? Is it possible to get the text version of the audio as well, like  subtitles or similar?

----

Yes—it’s feasible, but there are two different levels of “feasible”:

Practical and useful: automate Safari/WebKit, drive VoiceOver with scripted keyboard commands, record video/audio, and save a text log of what VoiceOver announced.

Fully deterministic, CI-grade, exact replica of human VoiceOver testing: possible for targeted flows, but fragile. VoiceOver is a global, stateful desktop assistive technology, so tests are slower, need a real logged-in macOS GUI session, and usually cannot run safely in parallel. Even Playwright’s own accessibility guidance says automated checks catch only some accessibility problems and should be combined with manual assessment and user testing.  ￼

The best architecture

For your use case, I would not start by transcribing the audio. I would capture three artifacts:

1. A test transcript: the text VoiceOver announced.
2. A screen recording: visual proof of what happened.
3. System audio recording: proof of what was actually spoken.

The most promising toolchain is:

Guidepup + Playwright/WebKit or Safari WebDriver + macOS screen/audio capture

Guidepup is specifically built to automate real screen readers; it supports VoiceOver on macOS and exposes APIs for moving through content and reading VoiceOver output.  ￼ Its Playwright integration shows tests that navigate web content, inspect voiceOver.itemText(), and assert on voiceOver.spokenPhraseLog()—which is effectively the text transcript you want.  ￼

A minimal shape would look like this conceptually:

import { voiceOverTest as test } from "@guidepup/playwright";
import { expect } from "@playwright/test";
test("VoiceOver announces the main heading", async ({ page, voiceOver }) => {
  await page.goto("https://example.com");
  await voiceOver.navigateToWebContent();
  while ((await voiceOver.itemText()) !== "Example Domain heading level 1") {
    await voiceOver.perform(voiceOver.keyboardCommands.findNextHeading);
  }
  expect(await voiceOver.spokenPhraseLog()).toContain(
    "Example Domain heading level 1"
  );
});

That gives you machine-checkable assertions without needing speech-to-text.

Safari vs WebKit matters

There is a subtle but important distinction:

Playwright WebKit is often good enough for web accessibility regression testing because it uses WebKit and can emulate “Desktop Safari” style behavior, but it is not literally the Safari app UI.

For actual Safari, use Safari’s built-in WebDriver support through safaridriver. Apple/WebKit documents that Safari exposes WebDriver through /usr/bin/safaridriver, and first-time setup requires safaridriver --enable plus Remote Automation.  ￼

So I’d choose based on the goal:

Goal	Better choice
Web component regression tests	Playwright WebKit + Guidepup
“Does this work in the real Safari app?”	Safari WebDriver + Guidepup / OS keyboard control
Full human-like VoiceOver traversal	Guidepup or lower-level keyboard scripting
CI reliability	Dedicated Mac runner, one test worker, controlled VoiceOver settings

Guidepup’s own example config uses a single worker because VoiceOver can only act on one browser instance at a time, and it notes that VoiceOver automation is slower than ordinary browser automation.  ￼

Recording the screen and VoiceOver audio

Screen recording is straightforward. macOS has built-in screen recording via Screenshot, and Apple documents recording the entire screen, selected windows, or portions of the screen.  ￼

The audio part is the trickier bit.

VoiceOver speech is usually system output audio, not microphone input. Apple’s built-in Screenshot UI lets you choose a microphone for screen recordings, but that does not necessarily capture internal/system audio such as VoiceOver.  ￼

For system audio, you have three realistic options:

Option A: ScreenCaptureKit-based recorder. Apple’s ScreenCaptureKit is intended for high-performance screen and audio capture on macOS.  ￼ This is the cleanest route if you are comfortable using or writing a small Swift/Objective-C helper.

Option B: virtual audio device. Use a loopback driver such as BlackHole or Loopback, route VoiceOver/system output into it, and record that device with ffmpeg, OBS, QuickTime, or your own script. BlackHole describes itself as a macOS virtual audio loopback driver that passes audio between apps; Loopback similarly creates virtual devices from app/audio sources.  ￼

Option C: record the VoiceOver caption panel visually. VoiceOver has a caption panel that shows what VoiceOver is currently speaking. Apple documents that the caption panel “shows what VoiceOver is speaking” and can be shown with VoiceOver Utility or a keyboard shortcut.  ￼ This is useful in recordings, but I would treat it as a visual artifact, not the primary test oracle.

On current macOS, you should expect to grant permissions manually at least once. Apple documents separate privacy permissions for apps that control your Mac through accessibility features and for apps/websites that record screen and system audio.  ￼

Getting a text version / subtitles

Yes, there are several ways.

The best text version is not speech-to-text. It is the VoiceOver announcement log from Guidepup, for example spokenPhraseLog(). That gives you the actual phrases the test framework observed from VoiceOver, which is better for assertions than an AI transcription.

For video subtitles, you can generate an .srt file in two ways:

Best for tests: timestamp your actions and VoiceOver announcements yourself.

Example conceptual output:

[
  { "time": 1.25, "text": "Example Domain heading level 1" },
  { "time": 2.80, "text": "More information link" }
]

Then convert that to SRT:

1
00:00:01,250 --> 00:00:02,750
Example Domain heading level 1
2
00:00:02,800 --> 00:00:04,000
More information link

Fallback for human review: run speech-to-text on the recorded audio, for example Whisper, Apple Speech, or another transcription engine. This is good for searchable evidence, but I would not rely on it for pass/fail because it can mishear synthesized speech, miss repeated announcements, or lose timing around interrupted VoiceOver speech.

A very practical hybrid is: use spokenPhraseLog() for pass/fail, use the audio/video recording for debugging, and optionally add SRT subtitles from the Guidepup log.

Required setup checklist

You’ll likely need to do these once on the Mac running the tests:

1. Enable VoiceOver automation: VoiceOver Utility has an option “Allow VoiceOver to be controlled with AppleScript,” which Apple describes as allowing AppleScript scripts to automate VoiceOver tasks.  ￼
2. Grant Accessibility permission to the runner app: Terminal, iTerm, Node, Python, VS Code, your test runner, or your packaged recorder. Apple requires explicit permission when an app controls the Mac through accessibility features.  ￼
3. Grant Screen & System Audio Recording permission to the recorder. Apple’s Privacy & Security settings include Screen & System Audio Recording, and Apple notes apps can be allowed to record both screen and audio or just audio.  ￼
4. If using real Safari WebDriver, enable Safari automation with safaridriver --enable and Remote Automation.  ￼
5. Freeze your VoiceOver settings: voice, speech rate, verbosity, punctuation, rotor settings, keyboard modifier, Safari zoom, system language, and window size.

Where it will be fragile

The fragile parts are not impossible; they just need discipline.

VoiceOver output can change with macOS/Safari updates, verbosity settings, punctuation settings, language, voice, page timing, focus state, and whether Safari is in a clean automation window. Safari WebDriver also isolates automated sessions with separate windows/tabs/preferences/storage, which is good for repeatability but can differ from a user’s normal Safari session.  ￼

I would avoid writing tests like “the entire transcript must equal this 40-line snapshot” unless the flow is very stable. Prefer targeted assertions:

expect(await voiceOver.spokenPhraseLog()).toEqual(
  expect.arrayContaining([
    expect.stringContaining("Search"),
    expect.stringContaining("button"),
  ])
);

Overall feasibility

Feasibility: high for local or dedicated-Mac automation.
You can automate keyboard/VoiceOver, test Safari/WebKit flows, record video, capture VoiceOver speech audio, and get text announcements.

Reliability: medium.
Good for regression tests around critical flows, headings, labels, focus order, form controls, modals, menus, and live regions. Less good for broad “prove the whole page is accessible” testing.

CI feasibility: medium to difficult.
You’ll want a dedicated Mac mini/Mac Studio or a managed macOS runner where permissions and VoiceOver settings are preconfigured. Avoid parallelization.

Text/subtitles: very feasible.
Use Guidepup’s VoiceOver phrase log as the canonical transcript. Use speech-to-text only as a secondary artifact.

My recommended starting point: build one small Guidepup test that opens Safari/WebKit, turns on VoiceOver, navigates to your page’s first heading, records spokenPhraseLog(), and saves Playwright video. Add system-audio recording after the basic transcript is reliable.

----

Does GitHub actions have Mac runners that could work for this and are free for open source projects?

----

Yes. GitHub Actions has GitHub-hosted macOS runners, and standard GitHub-hosted runners are free for public repositories. GitHub’s docs say standard GitHub-hosted runner usage is “free and unlimited” for public repositories, and the current standard public macOS options include Intel and Apple Silicon runners such as macos-15-intel, macos-26-intel, macos-latest, macos-14, macos-15, and macos-26.  ￼

For your VoiceOver/Safari idea, the answer is: yes, it can work, but I would treat GitHub-hosted macOS as a good experiment / smoke-test target, not the most stable long-term accessibility lab.

The good news

Guidepup specifically supports CI setup for screen reader automation. Its setup action says it enables VoiceOver on macOS and NVDA on Windows, and its docs show a GitHub Action step for setting up screen reader automation in CI.  ￼

There is even a real Guidepup Playwright workflow that runs on macos-14, uses guidepup/setup-action, enables record: true, runs VoiceOver tests, and uploads test-results plus recordings as artifacts.  ￼

A minimal workflow shape would be something like:

name: voiceover-safari
on:
  pull_request:
  push:
    branches: [main]
jobs:
  voiceover:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: Setup VoiceOver automation
        uses: guidepup/setup-action@0.19.0
        with:
          record: true
      - run: npm ci
      - run: npm run test:voiceover
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: voiceover-artifacts
          path: |
            test-results/**/*
            recordings/**/*

The cost answer

For a public open-source repo, standard macOS runners are free. For private repos, GitHub uses included minutes and then bills beyond the quota. GitHub’s billing docs also say larger runners are always charged, even for public repositories.  ￼

So:

Runner type	Public OSS cost	Suitable?
macos-14, macos-15, macos-latest, standard macOS	Free	Yes, best starting point
macos-15-intel, macos-26-intel, standard Intel macOS	Free	Useful if Safari/VoiceOver behavior differs by arch
macOS larger runners	Paid	Only if you need more resources
Self-hosted Mac mini	GitHub Actions usage free, hardware is yours	Best for long-term reliability

There are still limits. GitHub’s Free plan has a 20 total concurrent job limit and 5 concurrent macOS jobs limit for standard hosted runners.  ￼ Also, recordings can consume artifact storage quickly; GitHub lists 500 MB artifact storage for GitHub Free / Free for organizations in its limits table.  ￼

The main caveat: macOS version drift

I would not use macos-latest for this. Pin the runner.

The most proven path right now appears to be macos-14, because Guidepup’s own Playwright workflow uses macos-14.  ￼ But there’s a catch: GitHub has announced that macOS 14 runner images begin deprecation on July 6, 2026 and become fully unsupported on November 2, 2026.  ￼

Newer macOS versions may be less stable for VoiceOver automation. There is an open GitHub Actions runner-images issue saying macOS 15 changed where VoiceOver AppleScript automation configuration is stored, causing VoiceOver automation to fail on macos-15 agents unless the setup is updated.  ￼ Guidepup’s repo currently advertises support badges for macOS Monterey, Ventura, and Sonoma, but not Sequoia/Tahoe.  ￼

So my practical recommendation is:

runs-on: macos-14

for the first prototype, while tracking a migration path to macos-15 or self-hosted macOS before November 2026.

Safari specifically

The GitHub macOS runner images include Safari and SafariDriver. For example, the current macos-14 image lists Safari and SafariDriver in its installed browser list.  ￼ The macos-15 image also lists Safari and SafariDriver.  ￼

That said, actual Safari + VoiceOver + CI permissions can be brittle. There was a 2025 GitHub runner-images issue where Safari automation started failing because of a macOS permission prompt allowing the hosted runner process to control Safari.  ￼ That is exactly the kind of thing that makes this feasible but not “set it and forget it.”

Text transcript vs audio/video

For CI, I would make the VoiceOver text log the official test artifact and treat audio/video as debug evidence.

Guidepup can expose spoken phrases, so your test can assert on the text VoiceOver produced. That is much more reliable than trying to transcribe synthesized speech from an audio recording.

For recording:

* Guidepup setup has a CI recording option for macOS setup/debugging.  ￼
* Playwright can record browser videos, but that may not capture the entire desktop/VoiceOver context.
* Full system audio capture on GitHub-hosted macOS is the part I would consider least reliable. On a self-hosted Mac, you can configure ScreenCaptureKit, BlackHole, Loopback, OBS, or another known audio route once and keep it stable. On ephemeral GitHub-hosted VMs, permissions and audio device behavior can change.

Bottom line

Yes: GitHub Actions standard macOS runners can work and are free for public open-source repos. They are a very reasonable place to prototype VoiceOver + Safari/WebKit testing with Guidepup.

For serious long-term testing, I’d use a two-tier setup:

1. GitHub-hosted macos-14 smoke tests: run a small number of VoiceOver transcript assertions on PRs.
2. Self-hosted Mac runner: run the full Safari + VoiceOver + screen/audio recording suite, with stable permissions and audio routing.

That gives you free public CI coverage while avoiding the worst fragility of full desktop accessibility automation on ephemeral hosted machines.
