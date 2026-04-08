# System Audio Transcription Debugging Log

Date: 2026-04-08  
Repo: `voice-cap-POC`

## Goal

Investigate why system audio transcription was not appearing, even though system audio capture looked active.

## Step-by-step log with outcomes

1. Reproduced and reviewed runtime logs from `npm start`.
Outcome:
- Both microphone and system capture started.
- Both Deepgram live connections reported as connected.
- System path reported both "silence so far" and later "Audio detected."
- Symptom remained: no useful transcript text shown.

2. Read core code paths:
- `src/main.js`
- `src/capture/system-audio-capture.js`
- `src/transcription/deepgram-live-transcriber.js`
- `src/capture/mic-capture.js`
- `src/renderer/transcript-view.js`
Outcome:
- Mic and system flows are architecturally similar.
- System chunks are forwarded to WAV writer and Deepgram transcriber.
- No obvious crash/exception path blocking system chunks.

3. Inspected `audiotee` package implementation and README under `node_modules/audiotee`.
Outcome:
- `audiotee` emits raw PCM data buffers.
- With sample rate specified, expected output is ASR-oriented PCM.
- No immediate integration error found in wrapper usage.

4. Validated generated WAV files (`system.wav`, `mic.wav`) with `file` and `afinfo`.
Outcome:
- Both files are valid WAV PCM, mono, 16-bit, 16000 Hz.
- Recording duration and file sizes looked normal.

5. Ran signal-level checks (RMS/peak/active samples) on WAV payloads.
Outcome:
- Both files contain non-silent audio energy.
- This ruled out "all-zero data" as primary cause.

6. Tested Deepgram file transcription API using recorded WAVs.
Initial outcome:
- First attempt appeared empty due to reading wrong response property (`response.result...` instead of `response.results...`).
Corrected outcome:
- Both `system.wav` and `mic.wav` transcribed successfully with strong confidence.
- This proved captured audio itself is transcribable.

7. Replayed `system.wav` through Deepgram Live WebSocket outside the app (Node script).
Outcome:
- Live socket opened and emitted `Results` messages.
- `Results` messages repeatedly contained empty transcript strings.
- This reproduced the issue outside Electron UI/state code.

8. Tested chunk timing and chunk sizing:
- 200 ms chunks paced in real-time
- 100 ms chunks
- burst-like sending
Outcome:
- `Results` still present but transcript text remained empty.
- Chunk size/timing alone did not resolve behavior.

9. Tested live request option combinations:
- Full options (`interim_results`, `endpointing`, `vad_events`, etc.)
- Minimal options (only encoding/sample_rate/channels/model/language)
Outcome:
- Empty transcript behavior persisted in Live mode.

10. Tested different live models (`nova-3`, `nova-2`, `base`).
Outcome:
- Behavior remained the same in these tests (no non-empty live transcript text observed).

11. Tested stream-finalization patterns:
- `Finalize` + `CloseStream`
- `CloseStream` only
- longer wait before close
Outcome:
- No transcript text surfaced before shutdown.

12. Tested payload type variation:
- Node `Buffer`
- `Uint8Array`
Outcome:
- No improvement; live results still empty.

13. Reviewed Deepgram troubleshooting/docs for live streaming behavior.
Outcome:
- Confirmed raw audio requirements (`encoding` + `sample_rate`) are correctly set in our requests.
- Confirmed recommended close-stream handling.
- Documentation did not directly explain this exact "Results with empty transcript" pattern in our scenario.

## What is ruled out

- System audio permission being the only issue (audio is captured and non-silent).
- Invalid WAV formatting (files are valid and transcribable via file API).
- Electron renderer display-only bug as sole cause (issue reproduced in standalone live script).
- A simple chunk-size or one-flag typo in current options.

## Current likely root cause area

Deepgram Live WebSocket path (SDK/runtime/live-model behavior or transport compatibility) rather than local capture pipeline quality.

## Suggested next steps (not yet completed in this log)

1. Implement a low-level `ws` direct client (bypassing SDK helper methods) for A/B validation.
2. Add temporary fallback in app:
- keep live streaming attempt
- periodically run short prerecorded transcription windows for resilient transcript output.
3. Capture and persist full raw live `Results` payload samples in debug mode for support escalation.
