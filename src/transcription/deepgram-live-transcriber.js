const WebSocket = require('ws');
const { URL } = require('node:url');

const SOCKET_OPEN_STATE = 1;
const KEEP_ALIVE_INTERVAL_MS = 3_000;
const OPEN_TIMEOUT_MS = 10_000;
const MAX_PENDING_AUDIO_CHUNKS = 50;
const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen';
const AUDIO_LOG_CHUNK_INTERVAL = 25;
const RESULT_PREVIEW_LENGTH = 160;

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

function buildListenUrl({ model, language, sampleRate, channels }) {
  const url = new URL(DEEPGRAM_LISTEN_URL);

  url.searchParams.set('model', model);
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', String(sampleRate));
  url.searchParams.set('channels', String(channels));
  url.searchParams.set('interim_results', 'true');

  if (language) {
    url.searchParams.set('language', language);
  }

  return url.toString();
}

function normalizeMessagePayload(data) {
  if (typeof data === 'string') {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }

  return String(data);
}

function truncateForLog(value, maxLength = RESULT_PREVIEW_LENGTH) {
  if (!value) {
    return '';
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
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

    this.connection = null;
    this.openSignal = null;
    this.closeSignal = null;
    this.keepAliveTimer = null;
    this.pendingAudioChunks = [];
    this.finalSegments = [];
    this.interimTranscript = '';
    this.lastFinalSignature = null;
    this.lastAudioAt = 0;
    this.stopping = false;
    this.startPromise = null;
    this.audioChunksSent = 0;
    this.audioBytesSent = 0;
    this.messagesReceived = 0;
    this.keepAliveSent = 0;
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

    const connectionUrl = buildListenUrl({
      model: this.model,
      language: this.language,
      sampleRate: this.sampleRate,
      channels: this.channels
    });

    this.openSignal = createDeferred();
    this.closeSignal = createDeferred();

    try {
      console.log(`[${this.kind}][deepgram] Opening websocket: ${connectionUrl}`);

      this.connection = new WebSocket(connectionUrl, {
        headers: {
          Authorization: `Token ${this.apiKey}`
        }
      });

      this.connection.on('open', () => {
        this.handleOpen();
      });

      this.connection.on('message', (data) => {
        this.handleRawMessage(data);
      });

      this.connection.on('close', (code, reasonBuffer) => {
        this.handleClose({
          code,
          reason: Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString('utf8') : reasonBuffer
        });
      });

      this.connection.on('error', (error) => {
        this.handleError(error);
      });

      await Promise.race([
        this.openSignal.promise,
        delay(OPEN_TIMEOUT_MS).then(() => {
          throw new Error(`Timed out connecting to Deepgram after ${OPEN_TIMEOUT_MS}ms.`);
        })
      ]);

      this.startKeepAlive();
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
    this.openSignal?.resolve();

    this.setState({
      transcriptionState: 'listening',
      transcriptionDetail: `Streaming live transcription with Deepgram (${this.model}).`
    });

    this.flushPendingAudio();
  }

  handleRawMessage(data) {
    if (this.stopping) {
      return;
    }

    try {
      const message = JSON.parse(normalizeMessagePayload(data));
      this.logIncomingMessage(message);
      this.handleMessage(message);
    } catch (error) {
      console.warn(`[${this.kind}][deepgram] Failed to parse message: ${error.message}`);
    }
  }

  logIncomingMessage(message) {
    this.messagesReceived += 1;

    if (!message || typeof message !== 'object') {
      console.log(`[${this.kind}][deepgram] Received non-object message #${this.messagesReceived}.`);
      return;
    }

    const messageType = message.type || 'Unknown';

    if (messageType === 'Results') {
      const transcript = message.channel?.alternatives?.[0]?.transcript?.trim() || '';
      const preview = transcript ? `"${truncateForLog(transcript)}"` : '<empty>';

      console.log(
        `[${this.kind}][deepgram] Received Results #${this.messagesReceived}: final=${Boolean(
          message.is_final
        )}, speechFinal=${Boolean(message.speech_final)}, start=${message.start ?? 'n/a'}, duration=${
          message.duration ?? 'n/a'
        }, transcript=${preview}`
      );
      return;
    }

    if (messageType === 'Metadata') {
      console.log(
        `[${this.kind}][deepgram] Received Metadata #${this.messagesReceived}: request_id=${
          message.request_id || 'n/a'
        }, model=${message.model_info?.name || this.model}`
      );
      return;
    }

    if (messageType === 'UtteranceEnd') {
      console.log(
        `[${this.kind}][deepgram] Received UtteranceEnd #${this.messagesReceived}: last_word_end=${
          message.last_word_end ?? 'n/a'
        }`
      );
      return;
    }

    console.log(`[${this.kind}][deepgram] Received ${messageType} #${this.messagesReceived}.`);
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    switch (message.type) {
      case 'Metadata':
        this.setState({
          transcriptionState: 'listening',
          transcriptionDetail: `Connected to Deepgram (${this.model}). Waiting for speech...`
        });
        break;
      case 'Results':
        this.handleResults(message);
        break;
      case 'SpeechStarted':
        this.setState({
          transcriptionState: 'listening',
          transcriptionDetail: `Speech detected. Transcribing with Deepgram (${this.model})...`
        });
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
    this.closeSignal?.resolve();

    const code = typeof event?.code === 'number' ? event.code : null;
    const reason = event?.reason ? ` ${event.reason}` : '';

    if (this.stopping) {
      return;
    }

    const detail = code
      ? `Deepgram connection closed (code ${code}).${reason}`.trim()
      : 'Deepgram connection closed.';

    console.warn(
      `[${this.kind}][deepgram] ${detail} Sent ${this.audioChunksSent} chunk(s) / ${this.audioBytesSent} bytes and received ${this.messagesReceived} message(s).`
    );

    this.setState({
      transcriptionState: 'error',
      transcriptionDetail: detail
    });
  }

  handleError(error) {
    const message = error?.message || String(error);

    this.openSignal?.reject?.(error);

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
        this.keepAliveSent += 1;
        console.log(
          `[${this.kind}][deepgram] Sending KeepAlive #${this.keepAliveSent} after idle period.`
        );
        this.connection.send(JSON.stringify({ type: 'KeepAlive' }));
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

    if (this.pendingAudioChunks.length > 0) {
      console.log(
        `[${this.kind}][deepgram] Flushing ${this.pendingAudioChunks.length} queued audio chunk(s).`
      );
    }

    while (this.pendingAudioChunks.length > 0) {
      const chunk = this.pendingAudioChunks.shift();

      try {
        this.connection.send(chunk);
        this.recordAudioSent(chunk, 'flush');
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
        this.connection.send(buffer);
        this.recordAudioSent(buffer, 'live');
        return;
      } catch (error) {
        this.handleError(error);
      }
    }

    if (this.pendingAudioChunks.length >= MAX_PENDING_AUDIO_CHUNKS) {
      this.pendingAudioChunks.shift();
    }

    this.pendingAudioChunks.push(Buffer.from(buffer));

    if (this.pendingAudioChunks.length === 1) {
      console.log(`[${this.kind}][deepgram] Queueing audio until websocket opens.`);
    }
  }

  recordAudioSent(buffer, mode) {
    this.audioChunksSent += 1;
    this.audioBytesSent += buffer.length;

    if (
      this.audioChunksSent === 1 ||
      this.audioChunksSent % AUDIO_LOG_CHUNK_INTERVAL === 0
    ) {
      console.log(
        `[${this.kind}][deepgram] Sent audio chunk #${this.audioChunksSent} via ${mode} (${buffer.length} bytes, total ${this.audioBytesSent} bytes).`
      );
    }
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
        console.log(`[${this.kind}][deepgram] Sending Finalize.`);
        this.connection.send(JSON.stringify({ type: 'Finalize' }));
        await delay(150);
        console.log(`[${this.kind}][deepgram] Sending CloseStream.`);
        this.connection.send(JSON.stringify({ type: 'CloseStream' }));
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
      this.openSignal = null;
      this.closeSignal = null;
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
