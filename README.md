# guidepup-macos-prototype
A prototype of running Guidepup on macOS in GitHub Actions

> [!CAUTION]
> Everything in this repo, both text and code, was built by Codex (with GPT-5.5 xhigh) and is unreviewed.

## VoiceOver media smoke experiment

This repo contains a GitHub Actions experiment that tries to run
Guidepup on a pinned GitHub-hosted macOS runner, drive VoiceOver against a
small WebKit page, record the desktop session, probe ScreenCaptureKit system
audio capture, and upload all outputs as an Actions artifact.

It runs automatically on push. You can also run it manually from
**Actions -> voiceover-media-smoke -> Run workflow**.

The workflow uploads:

- `artifacts/voiceover-transcript.json`
- `artifacts/voiceover-subtitles.srt`
- `artifacts/system-audio-probe.wav`
- `artifacts/system-audio-probe-report.json`
- `artifacts/summary.md`
- `recordings/guidepup-session.mov`
- any setup recordings emitted by `guidepup/setup-action`

The default runner is `macos-14`, with `macos-15` available as a manual
comparison. The `require_audio` input is enabled by default, so the job fails if
the ScreenCaptureKit probe cannot produce a non-silent audio artifact; the
artifact upload still runs so failures are inspectable.
