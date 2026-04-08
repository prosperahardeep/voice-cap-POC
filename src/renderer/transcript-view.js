const transcriptBridge = window.transcriptBridge;

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

  return emptyMessages[sourceId];
}

function renderSource(sourceId, sourceState) {
  const elements = sourceElements[sourceId];
  const text = getTranscriptText(sourceId, sourceState);

  elements.transcript.textContent = text;
  elements.transcript.dataset.empty = String(text === emptyMessages[sourceId]);
}

function render(state) {
  renderSource('mic', state.sources.mic);
  renderSource('system', state.sources.system);
}

let removeStateListener = null;

async function bootstrap() {
  const initialState = await transcriptBridge.getState();
  render(initialState);

  removeStateListener = transcriptBridge.onStateUpdate((nextState) => {
    render(nextState);
  });
}

window.addEventListener('beforeunload', () => {
  removeStateListener?.();
});

bootstrap().catch((error) => {
  console.error('[transcript-view] Failed to initialize renderer:', error);
});
