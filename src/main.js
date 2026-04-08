const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { app } = require('electron');

const { startMicCapture } = require('./capture/mic-capture');
const { startSystemAudioCapture } = require('./capture/system-audio-capture');
const { WavFileWriter } = require('./utils/wav-writer');

const TARGET_SAMPLE_RATE = 16_000;
const TARGET_CHANNELS = 1;
const execFileAsync = promisify(execFile);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let micCapture = null;
let systemCapture = null;
let micWriter = null;
let systemWriter = null;
let shuttingDown = false;

function formatTimestamp(timestampMs) {
  return new Date(timestampMs).toISOString();
}

function logChunk(kind, chunk) {
  console.log(
    `${formatTimestamp(chunk.timestampMs)} ${kind} chunk received (${chunk.byteLength} bytes, ${chunk.sampleCount} samples)`
  );
}

function closeWriter(writer, label) {
  if (!writer) {
    return;
  }

  try {
    writer.close();
  } catch (error) {
    console.error(`[${label}] Failed to close WAV writer:`, error);
  }
}

async function shutdown(reason) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[main] Shutting down (${reason})`);

  await Promise.allSettled([
    micCapture?.stop?.(),
    systemCapture?.stop?.()
  ]);

  closeWriter(micWriter, 'mic');
  closeWriter(systemWriter, 'system');

  micCapture = null;
  systemCapture = null;
  micWriter = null;
  systemWriter = null;
}

function objectContainsInputMarker(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();

    if (
      normalizedKey.includes('input') ||
      normalizedKey.includes('microphone') ||
      normalizedKey.includes('mic')
    ) {
      return true;
    }

    if (typeof nestedValue === 'string') {
      const normalizedValue = nestedValue.toLowerCase();

      if (
        normalizedValue.includes('input') ||
        normalizedValue.includes('microphone') ||
        normalizedValue.includes('mic')
      ) {
        return true;
      }
    }

    if (Array.isArray(nestedValue)) {
      if (nestedValue.some((item) => objectContainsInputMarker(item))) {
        return true;
      }
      continue;
    }

    if (objectContainsInputMarker(nestedValue)) {
      return true;
    }
  }

  return false;
}

async function hasAudioInputDevice() {
  const { stdout } = await execFileAsync('system_profiler', ['SPAudioDataType', '-json']);
  const profile = JSON.parse(stdout);
  const rootItems = profile?.SPAudioDataType;

  if (!Array.isArray(rootItems) || rootItems.length === 0) {
    return false;
  }

  return rootItems.some((item) => {
    if (objectContainsInputMarker(item)) {
      return true;
    }

    if (!Array.isArray(item?._items)) {
      return false;
    }

    return item._items.some((child) => objectContainsInputMarker(child));
  });
}

async function startCaptures() {
  if (process.platform !== 'darwin') {
    throw new Error('This proof of concept only runs on macOS 14.2+.');
  }

  const shouldCaptureMic = await hasAudioInputDevice();

  if (shouldCaptureMic) {
    micWriter = new WavFileWriter(path.join(process.cwd(), 'mic.wav'), {
      sampleRate: TARGET_SAMPLE_RATE,
      channels: TARGET_CHANNELS,
      bitsPerSample: 16
    });
    console.log(`[main] Writing microphone output to ${micWriter.filePath}`);
  } else {
    console.log('[main] No audio input device detected. Capturing system audio only.');
  }

  systemWriter = new WavFileWriter(path.join(process.cwd(), 'system.wav'), {
    sampleRate: TARGET_SAMPLE_RATE,
    channels: TARGET_CHANNELS,
    bitsPerSample: 16
  });

  console.log(`[main] Writing system output to ${systemWriter.filePath}`);

  const capturePromises = [
    startSystemAudioCapture((chunk) => {
      logChunk('system', chunk);
      systemWriter.writePcmChunk(chunk.pcm);
    })
  ];

  if (shouldCaptureMic) {
    capturePromises.unshift(
      startMicCapture((chunk) => {
        logChunk('mic', chunk);
        micWriter.writePcmChunk(chunk.pcm);
      })
    );
  }

  const captures = await Promise.all(capturePromises);

  if (shouldCaptureMic) {
    [micCapture, systemCapture] = captures;
    console.log('[main] Microphone and system audio capture are running. Press Ctrl+C to stop.');
    return;
  }

  [systemCapture] = captures;
  console.log('[main] System audio capture is running. Press Ctrl+C to stop.');
}

function installShutdownHandlers() {
  process.once('SIGINT', () => {
    shutdown('SIGINT')
      .catch((error) => {
        console.error('[main] Shutdown failed after SIGINT:', error);
      })
      .finally(() => {
        app.exit(0);
      });
  });

  process.once('SIGTERM', () => {
    shutdown('SIGTERM')
      .catch((error) => {
        console.error('[main] Shutdown failed after SIGTERM:', error);
      })
      .finally(() => {
        app.exit(0);
      });
  });

  app.on('before-quit', (event) => {
    if (shuttingDown) {
      return;
    }

    event.preventDefault();
    shutdown('before-quit')
      .catch((error) => {
        console.error('[main] Shutdown failed before quit:', error);
      })
      .finally(() => {
        app.exit(0);
      });
  });
}

async function main() {
  installShutdownHandlers();
  await app.whenReady();
  app.dock?.hide?.();

  try {
    await startCaptures();
  } catch (error) {
    console.error('[main] Failed to start capture:', error);
    await shutdown('startup-error');
    app.exit(1);
  }
}

main().catch((error) => {
  console.error('[main] Fatal error:', error);
  app.exit(1);
});
