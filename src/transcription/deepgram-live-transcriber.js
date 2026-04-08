const { DeepgramClient } = require('@deepgram/sdk');

const SOCKET_OPEN_STATE = 1;
const KEEP_ALIVE_INTERVAL_MS = 3_000;
const MAX_PENDING_AUDIO_CHUNKS = 50;

function createDeferred() {
  let resolve;
  let reject;

  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function delay(timeoutMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

class DeepgramLiveTranscriber {
  constructor({ kind, apiKey, model, language, sampleRate, channels, onStateChange }) {
    if (!apiKey) {
      throw new Error('DeepgramLiveTranscriber requires a Deepgram API key.');
    }

    if (typeof onStateChange !== 'function') {
      throw new TypeError('DeepgramLiveTranscriber requires an onStateChange callback.');
    }

    this.kind = kind;
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.onStateChange = onStateChange;

    this.client = new DeepgramClient({ apiKey: this.apiKey });
    this.connection = null;
    this.keepAliveTimer = null;
    this.pendingAudioChunks = [];
    this.finalSegments = [];
    this.interimTranscript = '';
    this.lastFinalSignature = null;
    this.lastAudioAt = 0;
    this.closeSignal = null;
    this.stopping = false;
    this.startPromise = null;
  }

  setState(update) {
    this.onStateChange({
      ...update,
      updatedAt: Date.now()
    });
  }

  start() {
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  async startInternal() {
    this.setState({
      transcriptionState: 'connecting',
      transcriptionDetail: `Connecting to Deepgram (${this.model})...`
    });

    try {
      const connectionArgs = {
        model: this.model,
        encoding: 'linear16',
        sample_rate: this.sampleRate,
        channels: this.channels,
        interim_results: true,
        punctuate: true,
        smart_format: true,
        endpointing: 300,
        utterance_end_ms: 1_000,
        vad_events: true
      };

      if (this.language) {
        connectionArgs.language = this.language;
      }

      this.connection = await this.client.listen.v1.connect(connectionArgs);
      this.closeSignal = createDeferred();

      this.connection.on('open', () => {
        this.handleOpen();
      });

      this.connection.on('message', (message) => {
        this.handleMessage(message);
      });

      this.connection.on('close', (event) => {
        this.handleClose(event);
      });

      this.connection.on('error', (error) => {
        this.handleError(error);
      });

      this.connection.connect();
      this.startKeepAlive();
      await this.connection.waitForOpen();
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  handleOpen() {
    if (this.stopping) {
      return;
    }

    console.log(`[${this.kind}][deepgram] Live transcription connected.`);

    this.setState({
      transcriptionState: 'listening',
      transcriptionDetail: `Streaming live transcription with Deepgram (${this.model}).`
    });

    this.flushPendingAudio();
  }

  handleMessage(message) {
    if (this.stopping || !message || typeof message !== 'object') {
      return;
    }

    switch (message.type) {
      case 'Results':
        this.handleResults(message);
        break;
      case 'UtteranceEnd':
        this.interimTranscript = '';
        this.setState({
          interimTranscript: ''
        });
        break;
      default:
        break;
    }
  }

  handleResults(message) {
    const transcript = message.channel?.alternatives?.[0]?.transcript?.trim() || '';

    if (!message.is_final) {
      this.interimTranscript = transcript;
      this.setState({
        transcriptionState: 'listening',
        transcriptionDetail: `Streaming live transcription with Deepgram (${this.model}).`,
        interimTranscript: transcript
      });
      return;
    }

    if (transcript) {
      const signature = `${message.start}:${message.duration}:${transcript}`;

      if (signature !== this.lastFinalSignature) {
        this.lastFinalSignature = signature;
        this.finalSegments.push(transcript);
      }
    }

    this.interimTranscript = '';

    this.setState({
      transcriptionState: 'listening',
      transcriptionDetail: `Streaming live transcription with Deepgram (${this.model}).`,
      finalTranscript: this.finalSegments.join('\n'),
      interimTranscript: ''
    });
  }

  handleClose(event) {
    if (this.closeSignal) {
      this.closeSignal.resolve();
    }

    if (this.stopping) {
      return;
    }

    const code = typeof event?.code === 'number' ? event.code : null;
    const detail = code
      ? `Deepgram connection closed (code ${code}). Waiting to reconnect...`
      : 'Deepgram connection closed. Waiting to reconnect...';

    this.setState({
      transcriptionState: 'connecting',
      transcriptionDetail: detail
    });
  }

  handleError(error) {
    const message = error?.message || String(error);

    if (this.stopping) {
      return;
    }

    console.error(`[${this.kind}][deepgram] ${message}`);

    this.setState({
      transcriptionState: 'error',
      transcriptionDetail: message,
      interimTranscript: ''
    });
  }

  startKeepAlive() {
    this.stopKeepAlive();

    this.keepAliveTimer = setInterval(() => {
      if (
        this.stopping ||
        !this.connection ||
        this.connection.readyState !== SOCKET_OPEN_STATE
      ) {
        return;
      }

      if (Date.now() - this.lastAudioAt < KEEP_ALIVE_INTERVAL_MS) {
        return;
      }

      try {
        this.connection.sendKeepAlive({ type: 'KeepAlive' });
      } catch (error) {
        this.handleError(error);
      }
    }, KEEP_ALIVE_INTERVAL_MS);

    this.keepAliveTimer.unref?.();
  }

  stopKeepAlive() {
    if (!this.keepAliveTimer) {
      return;
    }

    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  flushPendingAudio() {
    if (!this.connection || this.connection.readyState !== SOCKET_OPEN_STATE) {
      return;
    }

    while (this.pendingAudioChunks.length > 0) {
      const chunk = this.pendingAudioChunks.shift();

      try {
        this.connection.sendMedia(chunk);
      } catch (error) {
        this.handleError(error);
        this.pendingAudioChunks.unshift(chunk);
        return;
      }
    }
  }

  sendPcmChunk(chunk) {
    if (!chunk || this.stopping) {
      return;
    }

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.lastAudioAt = Date.now();

    if (this.connection && this.connection.readyState === SOCKET_OPEN_STATE) {
      try {
        this.connection.sendMedia(buffer);
        return;
      } catch (error) {
        this.handleError(error);
      }
    }

    if (this.pendingAudioChunks.length >= MAX_PENDING_AUDIO_CHUNKS) {
      this.pendingAudioChunks.shift();
    }

    this.pendingAudioChunks.push(Buffer.from(buffer));
  }

  async stop() {
    this.stopping = true;
    this.stopKeepAlive();

    try {
      await this.startPromise;
    } catch (_error) {
    }

    if (!this.connection) {
      this.setState({
        transcriptionState: 'stopped',
        transcriptionDetail: 'Deepgram transcription stopped.',
        interimTranscript: ''
      });
      return;
    }

    try {
      if (this.connection.readyState === SOCKET_OPEN_STATE) {
        this.connection.sendFinalize({ type: 'Finalize' });
        this.connection.sendCloseStream({ type: 'CloseStream' });
      }

      if (this.closeSignal) {
        await Promise.race([this.closeSignal.promise, delay(1_500)]);
      }
    } catch (error) {
      console.warn(`[${this.kind}][deepgram] Failed to close cleanly:`, error);
    } finally {
      try {
        this.connection.close();
      } catch (_error) {
      }

      this.connection = null;
      this.pendingAudioChunks.length = 0;

      this.setState({
        transcriptionState: 'stopped',
        transcriptionDetail: 'Deepgram transcription stopped.',
        interimTranscript: ''
      });
    }
  }
}

module.exports = {
  DeepgramLiveTranscriber
};
