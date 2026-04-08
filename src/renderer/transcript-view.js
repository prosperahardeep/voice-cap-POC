const REFRESH_INTERVAL_MS = 500;

function createTranscriptBridge() {
  if (window.transcriptBridge) {
    return window.transcriptBridge;
  }

  try {
    const { ipcRenderer } = require('electron');

    return {
      getState() {
        return ipcRenderer.invoke('transcript:get-state');
      },
      onStateUpdate(listener) {
        const wrappedListener = (_event, payload) => {
          listener(payload);
        };

        ipcRenderer.on('transcript:state', wrappedListener);

        return () => {
          ipcRenderer.off('transcript:state', wrappedListener);
        };
      },
      onSourceUpdate(listener) {
        const wrappedListener = (_event, payload) => {
          listener(payload);
        };

        ipcRenderer.on('transcript:source-state', wrappedListener);

        return () => {
          ipcRenderer.off('transcript:source-state', wrappedListener);
        };
      }
    };
  } catch (error) {
    console.error('[transcript-view] Failed to create transcript bridge:', error);
    return null;
  }
}

const transcriptBridge = createTranscriptBridge();

const sourceElements = {
  mic: collectSourceElements('mic'),
  system: collectSourceElements('system')
};

const emptyMessages = {
  mic: 'Waiting for microphone transcript...',
  system: 'Waiting for third party audio transcript...'
};

const localState = {
  sources: {
    mic: {},
    system: {}
  }
};

function collectSourceElements(sourceId) {
  const root = document.querySelector(`[data-source="${sourceId}"]`);

  return {
    transcript: root.querySelector('[data-role="transcript"]')
  };
}

function getTranscriptText(sourceId, sourceState) {
  const finalText = sourceState.finalTranscript?.trim() || '';
  const interimText = sourceState.interimTranscript?.trim() || '';

  if (finalText && interimText) {
    return `${finalText}\n\n${interimText}`;
  }

  if (finalText) {
    return finalText;
  }

  if (interimText) {
    return interimText;
  }

  if (sourceState.transcriptionState === 'error') {
    return sourceState.transcriptionDetail || emptyMessages[sourceId];
  }

  if (sourceState.captureState === 'error' || sourceState.captureState === 'unavailable') {
    return sourceState.captureDetail || emptyMessages[sourceId];
  }

  if (sourceState.transcriptionState === 'disabled') {
    return sourceState.transcriptionDetail || emptyMessages[sourceId];
  }

  if (sourceState.captureDetail?.toLowerCase().includes('silence')) {
    return sourceState.captureDetail;
  }

  if (sourceState.transcriptionState === 'connecting') {
    return sourceState.transcriptionDetail || 'Connecting to Deepgram...';
  }

  if (sourceState.transcriptionState === 'listening') {
    return 'Listening... waiting for speech.';
  }

  if (sourceState.captureState === 'active') {
    return sourceState.captureDetail || 'Capture is active. Waiting for speech...';
  }

  return emptyMessages[sourceId];
}

function scrollTranscriptToLatest(element) {
  element.scrollTop = element.scrollHeight;
}

function renderSource(sourceId, sourceState) {
  const elements = sourceElements[sourceId];
  const text = getTranscriptText(sourceId, sourceState);

  elements.transcript.textContent = text;
  elements.transcript.dataset.empty = String(text === emptyMessages[sourceId]);
  scrollTranscriptToLatest(elements.transcript);
}

function mergeFullState(nextState) {
  localState.meta = nextState?.meta || localState.meta;
  localState.sources.mic = {
    ...localState.sources.mic,
    ...(nextState?.sources?.mic || {})
  };
  localState.sources.system = {
    ...localState.sources.system,
    ...(nextState?.sources?.system || {})
  };

  renderSource('mic', localState.sources.mic);
  renderSource('system', localState.sources.system);
}

function mergeSourceState(payload) {
  if (!payload?.kind || !payload.source) {
    return;
  }

  localState.sources[payload.kind] = {
    ...localState.sources[payload.kind],
    ...payload.source
  };

  renderSource(payload.kind, localState.sources[payload.kind]);

  const preview = getTranscriptText(payload.kind, localState.sources[payload.kind]);
  console.log(
    `[transcript-view] Updated ${payload.kind} panel with ${preview.length} visible character(s).`
  );
}

let removeStateListener = null;
let removeSourceListener = null;
let refreshTimer = null;

async function refreshState() {
  const nextState = await transcriptBridge.getState();
  mergeFullState(nextState);
}

function renderInitializationError(message) {
  for (const sourceId of ['mic', 'system']) {
    sourceElements[sourceId].transcript.textContent = message;
    sourceElements[sourceId].transcript.dataset.empty = 'false';
  }
}

async function bootstrap() {
  if (!transcriptBridge) {
    renderInitializationError('Transcript bridge is unavailable in the renderer.');
    return;
  }

  await refreshState();

  removeStateListener = transcriptBridge.onStateUpdate((nextState) => {
    mergeFullState(nextState);
  });

  removeSourceListener = transcriptBridge.onSourceUpdate((payload) => {
    mergeSourceState(payload);
  });

  refreshTimer = window.setInterval(() => {
    refreshState().catch((error) => {
      console.error('[transcript-view] Failed to refresh transcript state:', error);
    });
  }, REFRESH_INTERVAL_MS);
}

window.addEventListener('beforeunload', () => {
  removeStateListener?.();
  removeSourceListener?.();

  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

bootstrap().catch((error) => {
  console.error('[transcript-view] Failed to initialize renderer:', error);
  renderInitializationError(`Renderer initialization failed: ${error.message || error}`);
});
