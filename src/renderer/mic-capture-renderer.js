const bridge = window.micCaptureBridge;

const MIC_CONSTRAINTS = {
  audio: {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  },
  video: false
};

class LinearPcmResampler {
  constructor({ sourceSampleRate, targetSampleRate, outputChunkSamples }) {
    this.sourceSampleRate = sourceSampleRate;
    this.targetSampleRate = targetSampleRate;
    this.outputChunkSamples = outputChunkSamples;
    this.step = sourceSampleRate / targetSampleRate;
    this.position = 0;
    this.tail = new Float32Array(0);
    this.pending = [];
  }

  push(inputChunk) {
    const source = concatFloat32(this.tail, inputChunk);
    const emitted = [];

    if (source.length < 2) {
      this.tail = source;
      return emitted;
    }

    while (this.position + 1 < source.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const sample =
        source[index] + (source[index + 1] - source[index]) * fraction;

      this.pending.push(floatToInt16(sample));

      if (this.pending.length === this.outputChunkSamples) {
        emitted.push(Int16Array.from(this.pending));
        this.pending.length = 0;
      }

      this.position += this.step;
    }

    const reusableIndex = Math.min(Math.floor(this.position), source.length - 1);
    this.tail = source.slice(reusableIndex);
    this.position -= reusableIndex;

    return emitted;
  }

  flush() {
    if (this.pending.length === 0) {
      return null;
    }

    const finalChunk = Int16Array.from(this.pending);
    this.pending.length = 0;
    this.tail = new Float32Array(0);
    this.position = 0;
    return finalChunk;
  }
}

function concatFloat32(left, right) {
  if (!left.length) {
    return right;
  }

  if (!right.length) {
    return left;
  }

  const combined = new Float32Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

function floatToInt16(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let workletNode = null;
let sinkNode = null;
let resampler = null;
let started = false;

function cloneAudioConstraints() {
  return {
    audio: { ...MIC_CONSTRAINTS.audio },
    video: false
  };
}

function buildConstraints(overrides = {}) {
  const constraints = cloneAudioConstraints();
  Object.assign(constraints.audio, overrides);
  return constraints;
}

async function listAudioInputDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();

  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      label: device.label || `Audio input ${index + 1}`
    }));
}

function serializeMicError(error, context = {}) {
  return {
    message: error?.message || String(error),
    name: error?.name,
    constraint: error?.constraint,
    context
  };
}

async function getMicrophoneStream() {
  const attemptErrors = [];

  try {
    return await navigator.mediaDevices.getUserMedia(cloneAudioConstraints());
  } catch (error) {
    attemptErrors.push({
      attempt: 'default-constrained',
      name: error?.name,
      message: error?.message || String(error)
    });
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });
  } catch (error) {
    attemptErrors.push({
      attempt: 'default-relaxed',
      name: error?.name,
      message: error?.message || String(error)
    });
  }

  const audioInputs = await listAudioInputDevices();

  for (const device of audioInputs) {
    try {
      return await navigator.mediaDevices.getUserMedia(
        buildConstraints({
          deviceId: { exact: device.deviceId }
        })
      );
    } catch (error) {
      attemptErrors.push({
        attempt: 'explicit-device',
        deviceId: device.deviceId,
        label: device.label,
        name: error?.name,
        message: error?.message || String(error)
      });
    }
  }

  const error = new Error('Unable to open any microphone input device.');
  error.name = 'MicrophoneUnavailableError';
  error.context = {
    audioInputs,
    attempts: attemptErrors
  };
  throw error;
}

async function stopCapture() {
  const finalChunk = resampler?.flush();

  if (finalChunk && finalChunk.length > 0) {
    bridge.sendChunk({
      timestampMs: Date.now(),
      sampleCount: finalChunk.length,
      data: finalChunk.buffer
    });
  }

  if (workletNode) {
    try {
      workletNode.disconnect();
    } catch (_error) {
    }
  }

  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (_error) {
    }
  }

  if (sinkNode) {
    try {
      sinkNode.disconnect();
    } catch (_error) {
    }
  }

  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
  }

  if (audioContext && audioContext.state !== 'closed') {
    await audioContext.close();
  }

  audioContext = null;
  mediaStream = null;
  sourceNode = null;
  workletNode = null;
  sinkNode = null;
  resampler = null;
  started = false;
}

async function startCapture({ targetSampleRate, chunkDurationMs }) {
  if (started) {
    return;
  }

  mediaStream = await getMicrophoneStream();
  audioContext = new AudioContext({ latencyHint: 'interactive' });

  const workletUrl = new URL('./mic-capture.worklet.js', window.location.href);
  await audioContext.audioWorklet.addModule(workletUrl.toString());

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, 'mic-capture-processor');
  sinkNode = new GainNode(audioContext, { gain: 0 });

  resampler = new LinearPcmResampler({
    sourceSampleRate: audioContext.sampleRate,
    targetSampleRate,
    outputChunkSamples: Math.round((targetSampleRate * chunkDurationMs) / 1000)
  });

  workletNode.port.onmessage = (event) => {
    const floatChunk = new Float32Array(event.data.buffer);
    const emittedChunks = resampler.push(floatChunk);

    for (const pcmChunk of emittedChunks) {
      bridge.sendChunk({
        timestampMs: Date.now(),
        sampleCount: pcmChunk.length,
        data: pcmChunk.buffer
      });
    }
  };

  sourceNode.connect(workletNode);
  workletNode.connect(sinkNode);
  sinkNode.connect(audioContext.destination);

  await audioContext.resume();
  started = true;

  bridge.sendReady({
    sourceSampleRate: audioContext.sampleRate,
    targetSampleRate
  });
}

bridge.onStart(async (payload) => {
  try {
    await startCapture(payload);
  } catch (error) {
    bridge.sendError(serializeMicError(error, error?.context));
  }
});

bridge.onStop(async () => {
  try {
    await stopCapture();
  } catch (error) {
    bridge.sendError(serializeMicError(error));
  } finally {
    bridge.sendStopped();
  }
});

window.addEventListener('beforeunload', () => {
  if (!started) {
    return;
  }

  stopCapture().catch((error) => {
    bridge.sendError(serializeMicError(error));
  });
});

bridge.sendPageReady();
