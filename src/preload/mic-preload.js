const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('micCaptureBridge', {
  onStart(listener) {
    ipcRenderer.on('mic-capture:start', (_event, payload) => {
      listener(payload);
    });
  },
  onStop(listener) {
    ipcRenderer.on('mic-capture:stop', () => {
      listener();
    });
  },
  sendPageReady() {
    ipcRenderer.send('mic-capture:page-ready');
  },
  sendReady(payload) {
    ipcRenderer.send('mic-capture:ready', payload);
  },
  sendChunk(payload) {
    ipcRenderer.send('mic-capture:chunk', payload);
  },
  sendError(payload) {
    ipcRenderer.send('mic-capture:error', payload);
  },
  sendStopped() {
    ipcRenderer.send('mic-capture:stopped');
  }
});
