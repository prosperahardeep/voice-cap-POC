const { contextBridge, ipcRenderer } = require('electron');

const transcriptBridge = {
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

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('transcriptBridge', transcriptBridge);
} else {
  window.transcriptBridge = transcriptBridge;
}
