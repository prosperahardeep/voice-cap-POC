const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { app, BrowserWindow, ipcMain } = require('electron');
require('dotenv').config();

const { startMicCapture } = require('./capture/mic-capture');
const { startSystemAudioCapture } = require('./capture/system-audio-capture');
const { DeepgramLiveTranscriber } = require('./transcription/deepgram-live-transcriber');
const { WavFileWriter } = require('./utils/wav-writer');

const TARGET_SAMPLE_RATE = 16_000;
const TARGET_CHANNELS = 1;
const TRANSCRIPT_WINDOW_WIDTH = 1_240;
const TRANSCRIPT_WINDOW_HEIGHT = 820;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || '';
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || 'nova-3';
const DEEPGRAM_LANGUAGE = process.env.DEEPGRAM_LANGUAGE || '';
const execFileAsync = promisify(execFile);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let micCapture = null;
let systemCapture = null;
let micWriter = null;
let systemWriter = null;
let micTranscriber = null;
let systemTranscriber = null;
let transcriptWindow = null;
let shuttingDown = false;
let transcriptIpcRegistered = false;

const transcriptState = {
  meta: {
    deepgramConfigured: Boolean(DEEPGRAM_API_KEY),
    model: DEEPGRAM_MODEL,
    language: DEEPGRAM_LANGUAGE,
    projectRoot: process.cwd(),
    updatedAt: Date.now()
  },
  sources: {
    mic: createSourceState('Microphone'),
    system: createSourceState('System Audio')
  }
};

function createSourceState(label) {
  return {
    label,
    captureState: 'idle',
    captureDetail: `Waiting to start ${label.toLowerCase()} capture.`,
    transcriptionState: DEEPGRAM_API_KEY ? 'idle' : 'disabled',
    transcriptionDetail: DEEPGRAM_API_KEY
      ? `Waiting to start ${label.toLowerCase()} transcription.`
      : 'Set DEEPGRAM_API_KEY to enable live Deepgram transcription.',
    finalTranscript: '',
    interimTranscript: '',
    outputFile: null,
    updatedAt: Date.now()
  };
}

function snapshotTranscriptState() {
  return {
    meta: { ...transcriptState.meta },
    sources: {
      mic: { ...transcriptState.sources.mic },
      system: { ...transcriptState.sources.system }
    }
  };
}

function publishTranscriptState() {
  transcriptState.meta.updatedAt = Date.now();

  if (!transcriptWindow || transcriptWindow.isDestroyed()) {
    return;
  }

  transcriptWindow.webContents.send('transcript:state', snapshotTranscriptState());
}

function updateSourceState(kind, update) {
  Object.assign(transcriptState.sources[kind], update, {
    updatedAt: Date.now()
  });
  publishTranscriptState();
}

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

function resetCaptureResources() {
  micCapture = null;
  systemCapture = null;
  micWriter = null;
  systemWriter = null;
  micTranscriber = null;
  systemTranscriber = null;
}

function installTranscriptIpc() {
  if (transcriptIpcRegistered) {
    return;
  }

  transcriptIpcRegistered = true;

  ipcMain.handle('transcript:get-state', () => {
    return snapshotTranscriptState();
  });
}

async function createTranscriptWindow() {
  if (transcriptWindow && !transcriptWindow.isDestroyed()) {
    return transcriptWindow;
  }

  const preloadPath = path.join(__dirname, 'preload', 'transcript-preload.js');
  const htmlPath = path.join(__dirname, 'renderer', 'transcript-view.html');

  transcriptWindow = new BrowserWindow({
    show: false,
    width: TRANSCRIPT_WINDOW_WIDTH,
    height: TRANSCRIPT_WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 640,
    title: 'Voice Cap Live Transcripts',
    autoHideMenuBar: true,
    backgroundColor: '#07171d',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  transcriptWindow.once('ready-to-show', () => {
    transcriptWindow?.show();
  });

  transcriptWindow.on('closed', () => {
    transcriptWindow = null;

    if (!shuttingDown) {
      app.quit();
    }
  });

  transcriptWindow.webContents.on('did-finish-load', () => {
    publishTranscriptState();
  });

  await transcriptWindow.loadFile(htmlPath);
  return transcriptWindow;
}

async function shutdown(reason) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[main] Shutting down (${reason})`);

  await Promise.allSettled([micCapture?.stop?.(), systemCapture?.stop?.()]);

  updateSourceState('system', {
    captureState: transcriptState.sources.system.captureState === 'unavailable' ? 'unavailable' : 'stopped',
    captureDetail:
      transcriptState.sources.system.captureState === 'unavailable'
        ? transcriptState.sources.system.captureDetail
        : 'System audio capture stopped.'
  });

  updateSourceState('mic', {
    captureState: transcriptState.sources.mic.captureState === 'unavailable' ? 'unavailable' : 'stopped',
    captureDetail:
      transcriptState.sources.mic.captureState === 'unavailable'
        ? transcriptState.sources.mic.captureDetail
        : 'Microphone capture stopped.'
  });

  await Promise.allSettled([micTranscriber?.stop?.(), systemTranscriber?.stop?.()]);

  closeWriter(micWriter, 'mic');
  closeWriter(systemWriter, 'system');
  resetCaptureResources();
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

function createDeepgramTranscriber(kind) {
  return new DeepgramLiveTranscriber({
    kind,
    apiKey: DEEPGRAM_API_KEY,
    model: DEEPGRAM_MODEL,
    language: DEEPGRAM_LANGUAGE || undefined,
    sampleRate: TARGET_SAMPLE_RATE,
    channels: TARGET_CHANNELS,
    onStateChange: (update) => {
      updateSourceState(kind, update);
    }
  });
}

function configureSourceOutput(kind, writer) {
  updateSourceState(kind, {
    outputFile: writer?.filePath || null
  });
}

function markTranscriptionDisabled(kind, detail) {
  updateSourceState(kind, {
    transcriptionState: 'disabled',
    transcriptionDetail: detail
  });
}

async function startCaptures() {
  updateSourceState('system', {
    captureState: 'starting',
    captureDetail: 'Preparing system audio capture...'
  });

  updateSourceState('mic', {
    captureState: 'checking',
    captureDetail: 'Checking for an audio input device...'
  });

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
    configureSourceOutput('mic', micWriter);
    console.log(`[main] Writing microphone output to ${micWriter.filePath}`);
  } else {
    updateSourceState('mic', {
      captureState: 'unavailable',
      captureDetail: 'No audio input device detected. Microphone capture was skipped.',
      outputFile: null
    });
    markTranscriptionDisabled(
      'mic',
      'Microphone transcription is unavailable because no audio input device was detected.'
    );
    console.log('[main] No audio input device detected. Capturing system audio only.');
  }

  systemWriter = new WavFileWriter(path.join(process.cwd(), 'system.wav'), {
    sampleRate: TARGET_SAMPLE_RATE,
    channels: TARGET_CHANNELS,
    bitsPerSample: 16
  });
  configureSourceOutput('system', systemWriter);
  console.log(`[main] Writing system output to ${systemWriter.filePath}`);

  if (DEEPGRAM_API_KEY) {
    systemTranscriber = createDeepgramTranscriber('system');
    void systemTranscriber.start().catch(() => {
    });

    if (shouldCaptureMic) {
      micTranscriber = createDeepgramTranscriber('mic');
      void micTranscriber.start().catch(() => {
      });
    }
  } else {
    markTranscriptionDisabled(
      'system',
      'Set DEEPGRAM_API_KEY to enable live Deepgram transcription for system audio.'
    );

    if (shouldCaptureMic) {
      markTranscriptionDisabled(
        'mic',
        'Set DEEPGRAM_API_KEY to enable live Deepgram transcription for microphone audio.'
      );
    }
  }

  try {
    systemCapture = await startSystemAudioCapture((chunk) => {
      logChunk('system', chunk);
      systemWriter.writePcmChunk(chunk.pcm);
      systemTranscriber?.sendPcmChunk(chunk.pcm);
    });

    updateSourceState('system', {
      captureState: 'active',
      captureDetail: 'Capturing system audio at 16 kHz mono.'
    });

    if (shouldCaptureMic) {
      micCapture = await startMicCapture((chunk) => {
        logChunk('mic', chunk);
        micWriter.writePcmChunk(chunk.pcm);
        micTranscriber?.sendPcmChunk(chunk.pcm);
      });

      updateSourceState('mic', {
        captureState: 'active',
        captureDetail: 'Capturing microphone audio at 16 kHz mono.'
      });
    }
  } catch (error) {
    await Promise.allSettled([systemCapture?.stop?.(), micCapture?.stop?.()]);
    await Promise.allSettled([systemTranscriber?.stop?.(), micTranscriber?.stop?.()]);
    closeWriter(micWriter, 'mic');
    closeWriter(systemWriter, 'system');
    resetCaptureResources();
    throw error;
  }

  if (shouldCaptureMic) {
    console.log('[main] Microphone and system audio capture are running. Close the window or press Ctrl+C to stop.');
    return;
  }

  console.log('[main] System audio capture is running. Close the window or press Ctrl+C to stop.');
}

function publishStartupError(error) {
  const detail = error?.message || String(error);

  for (const kind of ['mic', 'system']) {
    const currentSource = transcriptState.sources[kind];
    updateSourceState(kind, {
      captureState: 'error',
      captureDetail: detail,
      transcriptionState:
        currentSource.transcriptionState === 'disabled' ? currentSource.transcriptionState : 'error',
      transcriptionDetail:
        currentSource.transcriptionState === 'disabled'
          ? currentSource.transcriptionDetail
          : detail
    });
  }
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
  installTranscriptIpc();
  await createTranscriptWindow();

  try {
    await startCaptures();
  } catch (error) {
    console.error('[main] Failed to start capture:', error);
    publishStartupError(error);
  }
}

main().catch((error) => {
  console.error('[main] Fatal error:', error);
  app.exit(1);
});
