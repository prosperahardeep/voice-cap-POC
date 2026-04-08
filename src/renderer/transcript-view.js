const transcriptBridge = window.transcriptBridge;
const REFRESH_INTERVAL_MS = 500;

const sourceElements = {
  mic: collectSourceElements('mic'),
  system: collectSourceElements('system')
};

const emptyMessages = {
  mic: 'Waiting for microphone transcript...',
  system: 'Waiting for third party audio transcript...'
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

function renderSource(sourceId, sourceState) {
  const elements = sourceElements[sourceId];
  const text = getTranscriptText(sourceId, sourceState);

  elements.transcript.textContent = text;
  elements.transcript.dataset.empty = String(text === emptyMessages[sourceId]);
  scrollTranscriptToLatest(elements.transcript);
}

function render(state) {
  renderSource('mic', state.sources.mic);
  renderSource('system', state.sources.system);
}

let removeStateListener = null;
let refreshTimer = null;

async function refreshState() {
  const nextState = await transcriptBridge.getState();
  render(nextState);
}

function scrollTranscriptToLatest(element) {
  element.scrollTop = element.scrollHeight;
}

async function bootstrap() {
  await refreshState();
  removeStateListener = transcriptBridge.onStateUpdate((nextState) => {
    render(nextState);
  });

  refreshTimer = window.setInterval(() => {
    refreshState().catch((error) => {
      console.error('[transcript-view] Failed to refresh transcript state:', error);
    });
  }, REFRESH_INTERVAL_MS);
}

window.addEventListener('beforeunload', () => {
  removeStateListener?.();
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

bootstrap().catch((error) => {
  console.error('[transcript-view] Failed to initialize renderer:', error);
});
