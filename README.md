# voice-cap-poc

Small Electron proof of concept for macOS that captures:

- system output audio with `audiotee`
- microphone audio with `getUserMedia` + `AudioWorklet` when an input device is available
- live Deepgram speech-to-text for both sources independently when `DEEPGRAM_API_KEY` is set

Streams are converted to 16 kHz mono PCM int16, written to disk, and shown in a
live transcript window with separate microphone and system text panes.

Audio is written to:

- `system.wav`
- `mic.wav` when a microphone/input device is detected

## Requirements

- macOS 14.2+
- Node.js 20+

## Run

```bash
npm install
npm start
```

Environment setup:

- Create a local `.env` file from `.env.example`
- `dotenv` is loaded automatically by the Electron main process on startup

Available variables:

- `DEEPGRAM_MODEL` to override the default model (`nova-3`)
- `DEEPGRAM_LANGUAGE` to pin the transcription language instead of using the model default
- `DEEPGRAM_API_KEY` to enable live Deepgram transcription

If `DEEPGRAM_API_KEY` is not set, the app still captures audio and writes WAV files,
but the transcript screen will show Deepgram transcription as disabled.

## Notes

- For system audio, `audiotee` relies on macOS System Audio Recording permission. If macOS does not prompt or you only capture silence, grant access manually in:
  `Settings > Privacy & Security > Screen & System Audio Recording > System Audio Recording Only`
- On machines without an audio input device, the app automatically skips microphone capture and records system audio only.
- Output files are written into the project root.
- Stop capture by closing the transcript window or pressing `Ctrl+C`.
