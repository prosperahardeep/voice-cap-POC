const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('transcriptBridge', {
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
  }
});
