# voice-cap-poc

Small Electron proof of concept for macOS that captures:

- system output audio with `audiotee`
- microphone audio with `getUserMedia` + `AudioWorklet` when an input device is available

Streams are converted to 16 kHz mono PCM int16 and written to:

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

## Notes

- For system audio, `audiotee` relies on macOS System Audio Recording permission. If macOS does not prompt or you only capture silence, grant access manually in:
  `Settings > Privacy & Security > Screen & System Audio Recording > System Audio Recording Only`
- On machines without an audio input device, the app automatically skips microphone capture and records system audio only.
- Output files are written into the project root.
- Stop capture with `Ctrl+C`.
