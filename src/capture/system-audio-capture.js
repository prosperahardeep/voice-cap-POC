const TARGET_SAMPLE_RATE = 16_000;
const CHUNK_DURATION_MS = 200;

function normalizeBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (Buffer.isBuffer(chunk?.data)) {
    return chunk.data;
  }

  if (ArrayBuffer.isView(chunk?.data)) {
    return Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
  }

  if (chunk?.data instanceof ArrayBuffer) {
    return Buffer.from(chunk.data);
  }

  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }

  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }

  throw new TypeError('Received an unsupported system audio chunk payload.');
}

function extractAudioTeeConstructor(moduleNamespace) {
  if (typeof moduleNamespace?.AudioTee === 'function') {
    return moduleNamespace.AudioTee;
  }

  if (typeof moduleNamespace?.default?.AudioTee === 'function') {
    return moduleNamespace.default.AudioTee;
  }

  if (typeof moduleNamespace?.default === 'function') {
    return moduleNamespace.default;
  }

  throw new Error('Could not resolve AudioTee constructor from the audiotee package.');
}

async function loadAudioTeeConstructor() {
  const moduleNamespace = await import('audiotee');
  return extractAudioTeeConstructor(moduleNamespace);
}

async function startSystemAudioCapture(onData) {
  if (process.platform !== 'darwin') {
    throw new Error('System audio capture only works on macOS 14.2+.');
  }

  if (typeof onData !== 'function') {
    throw new TypeError('startSystemAudioCapture requires an onData callback.');
  }

  console.log(
    '[system] If macOS does not prompt for System Audio Recording or you only get silence, grant access in Settings > Privacy & Security > Screen & System Audio Recording > System Audio Recording Only.'
  );

  const AudioTee = await loadAudioTeeConstructor();
  const audiotee = new AudioTee({
    sampleRate: TARGET_SAMPLE_RATE,
    chunkDurationMs: CHUNK_DURATION_MS
  });

  const handleData = (chunk) => {
    const pcm = normalizeBuffer(chunk);
    const timestampMs = Date.now();

    onData({
      timestampMs,
      sampleRate: TARGET_SAMPLE_RATE,
      channels: 1,
      sampleCount: pcm.byteLength / 2,
      byteLength: pcm.byteLength,
      pcm
    });
  };

  const handleError = (error) => {
    console.error('[system] AudioTee error:', error);
  };

  const removeListener =
    typeof audiotee.off === 'function'
      ? audiotee.off.bind(audiotee)
      : audiotee.removeListener?.bind(audiotee);

  audiotee.on?.('data', handleData);
  audiotee.on?.('error', handleError);

  await audiotee.start();

  let stopped = false;

  return {
    async stop() {
      if (stopped) {
        return;
      }

      stopped = true;

      if (typeof removeListener === 'function') {
        removeListener('data', handleData);
        removeListener('error', handleError);
      }

      await audiotee.stop();
    }
  };
}

module.exports = {
  startSystemAudioCapture
};
