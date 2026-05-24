import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

@available(macOS 12.3, *)
final class SystemAudioProbe: NSObject, SCStreamOutput, SCStreamDelegate {
  let sampleQueue = DispatchQueue(label: "guidepup.system-audio-probe.samples")

  private let outputURL: URL
  private let reportURL: URL
  private var audioFile: AVAudioFile?
  private var sampleBufferCount = 0
  private var screenSampleBufferCount = 0
  private var audioFrameCount: AVAudioFramePosition = 0
  private var totalAudioBytes = 0
  private var peakAmplitude: Float = 0
  private var firstAudioSampleAt: Date?
  private var lastAudioSampleAt: Date?
  private var errors: [String] = []

  init(outputURL: URL, reportURL: URL) {
    self.outputURL = outputURL
    self.reportURL = reportURL
  }

  func stream(
    _ stream: SCStream,
    didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of outputType: SCStreamOutputType
  ) {
    guard CMSampleBufferIsValid(sampleBuffer) else { return }

    switch outputType {
    case .audio:
      handleAudioSample(sampleBuffer)
    case .screen:
      screenSampleBufferCount += 1
    default:
      break
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    errors.append("ScreenCaptureKit stream stopped with error: \(error)")
  }

  private func handleAudioSample(_ sampleBuffer: CMSampleBuffer) {
    guard
      let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
      let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)
    else {
      errors.append("Audio sample did not include a usable format description.")
      return
    }

    let audioDescription = streamDescription.pointee
    guard
      let format = AVAudioFormat(
        standardFormatWithSampleRate: audioDescription.mSampleRate,
        channels: audioDescription.mChannelsPerFrame
      )
    else {
      errors.append("Could not create AVAudioFormat for captured audio.")
      return
    }

    do {
      try sampleBuffer.withAudioBufferList { audioBufferList, _ in
        guard
          let pcmBuffer = AVAudioPCMBuffer(
            pcmFormat: format,
            bufferListNoCopy: audioBufferList.unsafePointer
          )
        else {
          errors.append("Could not create PCM buffer for captured audio.")
          return
        }

        pcmBuffer.frameLength = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))

        if audioFile == nil {
          audioFile = try AVAudioFile(forWriting: outputURL, settings: format.settings)
        }

        try audioFile?.write(from: pcmBuffer)
        updatePeakAmplitude(from: pcmBuffer)

        sampleBufferCount += 1
        audioFrameCount += AVAudioFramePosition(pcmBuffer.frameLength)
        totalAudioBytes += CMSampleBufferGetTotalSampleSize(sampleBuffer)

        let now = Date()
        if firstAudioSampleAt == nil {
          firstAudioSampleAt = now
        }
        lastAudioSampleAt = now
      }
    } catch {
      errors.append("Could not write captured audio sample: \(error)")
    }
  }

  private func updatePeakAmplitude(from pcmBuffer: AVAudioPCMBuffer) {
    guard let channelData = pcmBuffer.floatChannelData else { return }

    let channelCount = Int(pcmBuffer.format.channelCount)
    let frameLength = Int(pcmBuffer.frameLength)
    guard channelCount > 0, frameLength > 0 else { return }

    for channel in 0..<channelCount {
      let samples = channelData[channel]
      for frame in 0..<frameLength {
        peakAmplitude = max(peakAmplitude, abs(samples[frame]))
      }
    }
  }

  func writeReport(status: String, requestedDurationSeconds: Int, startupError: String? = nil) {
    audioFile = nil

    var report: [String: Any] = [
      "status": status,
      "requestedDurationSeconds": requestedDurationSeconds,
      "audioSampleBufferCount": sampleBufferCount,
      "screenSampleBufferCount": screenSampleBufferCount,
      "audioFrameCount": audioFrameCount,
      "totalAudioBytes": totalAudioBytes,
      "peakAmplitude": peakAmplitude,
      "outputPath": outputURL.path,
      "outputFileBytes": (try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size])
        as? NSNumber ?? 0,
      "errors": errors,
    ]

    if let firstAudioSampleAt {
      report["firstAudioSampleAt"] = ISO8601DateFormatter().string(from: firstAudioSampleAt)
    }

    if let lastAudioSampleAt {
      report["lastAudioSampleAt"] = ISO8601DateFormatter().string(from: lastAudioSampleAt)
    }

    if let startupError {
      report["startupError"] = startupError
    }

    do {
      let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
      try data.write(to: reportURL)
    } catch {
      FileHandle.standardError.write(
        "Could not write audio probe report: \(error)\n".data(using: .utf8)!
      )
    }
  }
}

@available(macOS 12.3, *)
enum ProbeRunner {
  static func run(outputPath: String, reportPath: String, durationSeconds: Int) async -> Int32 {
    let outputURL = URL(fileURLWithPath: outputPath)
    let reportURL = URL(fileURLWithPath: reportPath)
    let probe = SystemAudioProbe(outputURL: outputURL, reportURL: reportURL)

    do {
      try FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )

      let content = try await SCShareableContent.excludingDesktopWindows(
        false,
        onScreenWindowsOnly: true
      )

      guard let display = content.displays.first else {
        throw NSError(
          domain: "SystemAudioProbe",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "No shareable display was available."]
        )
      }

      let filter = SCContentFilter(display: display, excludingWindows: [])
      let configuration = SCStreamConfiguration()
      configuration.capturesAudio = true
      configuration.excludesCurrentProcessAudio = false
      configuration.width = min(display.width, 1280)
      configuration.height = min(display.height, 720)
      configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
      configuration.queueDepth = 3

      let stream = SCStream(filter: filter, configuration: configuration, delegate: probe)
      try stream.addStreamOutput(probe, type: .screen, sampleHandlerQueue: probe.sampleQueue)
      try stream.addStreamOutput(probe, type: .audio, sampleHandlerQueue: probe.sampleQueue)

      try await stream.startCapture()
      try await Task.sleep(nanoseconds: UInt64(durationSeconds) * 1_000_000_000)
      try await stream.stopCapture()

      probe.sampleQueue.sync {
        probe.writeReport(status: "completed", requestedDurationSeconds: durationSeconds)
      }

      return 0
    } catch {
      probe.sampleQueue.sync {
        probe.writeReport(
          status: "failed",
          requestedDurationSeconds: durationSeconds,
          startupError: String(describing: error)
        )
      }
      FileHandle.standardError.write("System audio probe failed: \(error)\n".data(using: .utf8)!)
      return 2
    }
  }
}

@main
struct Main {
  static func main() async {
    guard CommandLine.arguments.count >= 4 else {
      FileHandle.standardError.write(
        "Usage: system-audio-probe <output.wav> <report.json> <duration-seconds>\n"
          .data(using: .utf8)!
      )
      Foundation.exit(64)
    }

    let outputPath = CommandLine.arguments[1]
    let reportPath = CommandLine.arguments[2]
    let durationSeconds = max(Int(CommandLine.arguments[3]) ?? 10, 1)

    if #available(macOS 12.3, *) {
      Foundation.exit(await ProbeRunner.run(
        outputPath: outputPath,
        reportPath: reportPath,
        durationSeconds: durationSeconds
      ))
    } else {
      let report: [String: Any] = [
        "status": "unsupported",
        "reason": "ScreenCaptureKit requires macOS 12.3 or newer.",
      ]
      if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted]) {
        try? data.write(to: URL(fileURLWithPath: reportPath))
      }
      Foundation.exit(69)
    }
  }
}
