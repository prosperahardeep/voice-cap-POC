const path = require('node:path');
const { BrowserWindow, ipcMain, systemPreferences } = require('electron');

const TARGET_SAMPLE_RATE = 16_000;
const CHUNK_DURATION_MS = 200;
const SESSION_PARTITION = 'persist:voice-cap-poc-mic';

let ipcHandlersRegistered = false;
let activeCapture = null;

function createDeferred() {
  let resolve;
  let reject;

  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}

function sameSender(event) {
  return activeCapture && event.sender.id === activeCapture.window.webContents.id;
}

function normalizeChunkPayload(payload) {
  let pcm;

  if (payload?.data instanceof ArrayBuffer) {
    pcm = Buffer.from(payload.data);
  } else if (ArrayBuffer.isView(payload?.data)) {
    pcm = Buffer.from(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength);
  } else {
    throw new TypeError('Renderer sent an unsupported microphone chunk payload.');
  }

  return {
    timestampMs: Number(payload.timestampMs ?? Date.now()),
    sampleRate: TARGET_SAMPLE_RATE,
    channels: 1,
    sampleCount: Number(payload.sampleCount ?? pcm.byteLength / 2),
    byteLength: pcm.byteLength,
    pcm
  };
}

function registerIpcHandlers() {
  if (ipcHandlersRegistered) {
    return;
  }

  ipcHandlersRegistered = true;

  ipcMain.on('mic-capture:page-ready', (event) => {
    if (!sameSender(event)) {
      return;
    }

    activeCapture.pageReady.resolve();
  });

  ipcMain.on('mic-capture:ready', (event, payload) => {
    if (!sameSender(event)) {
      return;
    }

    activeCapture.ready.resolve(payload);
  });

  ipcMain.on('mic-capture:chunk', (event, payload) => {
    if (!sameSender(event)) {
      return;
    }

    activeCapture.onData(normalizeChunkPayload(payload));
  });

  ipcMain.on('mic-capture:error', (event, payload) => {
    if (!sameSender(event)) {
      return;
    }

    const error = new Error(payload?.message || 'Renderer microphone capture failed.');
    error.cause = payload;

    if (!activeCapture.started) {
      activeCapture.ready.reject(error);
      return;
    }

    console.error('[mic] Renderer reported an error:', error);
  });

  ipcMain.on('mic-capture:stopped', (event) => {
    if (!sameSender(event)) {
      return;
    }

    activeCapture.stopped.resolve();
  });
}

async function ensureMicrophonePermission() {
  if (process.platform !== 'darwin') {
    return;
  }

  const status = systemPreferences.getMediaAccessStatus('microphone');

  if (status === 'granted') {
    return;
  }

  if (status === 'not-determined') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (granted) {
      return;
    }
  }

  throw new Error(
    'Microphone permission is not granted. Enable it in System Settings > Privacy & Security > Microphone and restart the app.'
  );
}

function configureMediaPermissions(session) {
  session.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media';
  });

  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
}

async function createCaptureWindow() {
  const preloadPath = path.join(__dirname, '..', 'preload', 'mic-preload.js');

  const window = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    frame: false,
    transparent: true,
    webPreferences: {
      partition: SESSION_PARTITION,
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  configureMediaPermissions(window.webContents.session);
  return window;
}

async function startMicCapture(onData) {
  if (process.platform !== 'darwin') {
    throw new Error('Microphone capture in this proof of concept only runs on macOS.');
  }

  if (typeof onData !== 'function') {
    throw new TypeError('startMicCapture requires an onData callback.');
  }

  if (activeCapture) {
    throw new Error('A microphone capture session is already running.');
  }

  registerIpcHandlers();
  await ensureMicrophonePermission();

  const pageReady = createDeferred();
  const ready = createDeferred();
  const stopped = createDeferred();
  const window = await createCaptureWindow();
  const htmlPath = path.join(__dirname, '..', 'renderer', 'mic-capture.html');

  activeCapture = {
    window,
    onData,
    pageReady,
    ready,
    stopped,
    started: false
  };

  window.on('closed', () => {
    if (activeCapture?.window === window) {
      activeCapture.stopped.resolve();
      activeCapture = null;
    }
  });

  try {
    await window.loadFile(htmlPath);
    await withTimeout(pageReady.promise, 10_000, 'Mic capture page bootstrap');

    window.webContents.send('mic-capture:start', {
      targetSampleRate: TARGET_SAMPLE_RATE,
      chunkDurationMs: CHUNK_DURATION_MS
    });

    await withTimeout(ready.promise, 15_000, 'Microphone start');
    activeCapture.started = true;
  } catch (error) {
    if (!window.isDestroyed()) {
      window.destroy();
    }
    activeCapture = null;
    throw error;
  }

  return {
    async stop() {
      if (!activeCapture || activeCapture.window !== window) {
        return;
      }

      const captureState = activeCapture;

      if (!window.isDestroyed()) {
        window.webContents.send('mic-capture:stop');
      }

      try {
        await withTimeout(captureState.stopped.promise, 5_000, 'Microphone stop');
      } catch (error) {
        console.warn('[mic] Timed out waiting for the renderer to stop cleanly:', error.message);
      }

      if (!window.isDestroyed()) {
        window.destroy();
      } else if (activeCapture?.window === window) {
        activeCapture = null;
      }
    }
  };
}

module.exports = {
  startMicCapture
};
