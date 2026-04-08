class MicCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const channelData = input && input[0];

    if (channelData && channelData.length > 0) {
      const copy = new Float32Array(channelData);
      this.port.postMessage({ buffer: copy.buffer }, [copy.buffer]);
    }

    return true;
  }
}

registerProcessor('mic-capture-processor', MicCaptureProcessor);
