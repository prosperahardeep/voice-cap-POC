const transcriptBridge = window.transcriptBridge;

const sourceElements = {
  mic: collectSourceElements('mic'),
  system: collectSourceElements('system')
};

const summaryElement = document.querySelector('[data-role="summary"]');
const deepgramStatusElement = document.querySelector('[data-role="deepgram-status"]');
const modelNameElement = document.querySelector('[data-role="model-name"]');
const projectRootElement = document.querySelector('[data-role="project-root"]');

function collectSourceElements(sourceId) {
  const root = document.querySelector(`[data-source="${sourceId}"]`);

  return {
    captureBadge: root.querySelector('[data-role="capture-badge"]'),
    transcriptionBadge: root.querySelector('[data-role="transcription-badge"]'),
    captureDetail: root.querySelector('[data-role="capture-detail"]'),
    transcriptionDetail: root.querySelector('[data-role="transcription-detail"]'),
    finalTranscript: root.querySelector('[data-role="final-transcript"]'),
    interimTranscript: root.querySelector('[data-role="interim-transcript"]'),
    outputFile: root.querySelector('[data-role="output-file"]'),
    updatedAt: root.querySelector('[data-role="updated-at"]')
  };
}

function formatStateLabel(prefix, value) {
  return `${prefix}: ${String(value || 'idle').replace(/-/g, ' ')}`;
}

function formatTone(state) {
  switch (state) {
    case 'active':
    case 'listening':
      return 'active';
    case 'starting':
    case 'checking':
    case 'connecting':
      return 'pending';
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
}

function formatTimestamp(timestampMs) {
  if (!timestampMs) {
    return '-';
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(timestampMs));
}

function getSummary(state) {
  if (!state.meta.deepgramConfigured) {
    return 'Audio capture continues, but Deepgram live transcription is disabled until DEEPGRAM_API_KEY is set.';
  }

  const micState = state.sources.mic;
  const systemState = state.sources.system;
  const activeSources = [micState, systemState].filter((source) => source.captureState === 'active');

  if (activeSources.length === 0) {
    return 'Waiting for the capture pipeline to come online.';
  }

  return 'Microphone and system audio are captured separately and streamed to Deepgram independently.';
}

function renderBadge(element, prefix, value) {
  element.textContent = formatStateLabel(prefix, value);
  element.dataset.tone = formatTone(value);
}

function renderSource(sourceId, sourceState) {
  const elements = sourceElements[sourceId];

  renderBadge(elements.captureBadge, 'Capture', sourceState.captureState);
  renderBadge(elements.transcriptionBadge, 'STT', sourceState.transcriptionState);

  elements.captureDetail.textContent = sourceState.captureDetail;
  elements.transcriptionDetail.textContent = sourceState.transcriptionDetail;
  elements.finalTranscript.textContent =
    sourceState.finalTranscript || `Waiting for ${sourceState.label.toLowerCase()} transcript...`;
  elements.interimTranscript.textContent =
    sourceState.interimTranscript || 'Live partial text will appear here.';
  elements.outputFile.textContent = sourceState.outputFile
    ? `Output file: ${sourceState.outputFile}`
    : 'Output file: not writing a WAV file for this source.';
  elements.updatedAt.textContent = `Updated: ${formatTimestamp(sourceState.updatedAt)}`;
}

function render(state) {
  summaryElement.textContent = getSummary(state);
  deepgramStatusElement.textContent = state.meta.deepgramConfigured
    ? 'Configured'
    : 'Missing DEEPGRAM_API_KEY';
  modelNameElement.textContent = state.meta.language
    ? `${state.meta.model} / ${state.meta.language}`
    : state.meta.model;
  projectRootElement.textContent = state.meta.projectRoot;

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
