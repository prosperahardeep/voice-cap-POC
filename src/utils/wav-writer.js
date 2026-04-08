const fs = require('node:fs');
const path = require('node:path');

function createWavHeader({ sampleRate, channels, bitsPerSample, dataSize }) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

function normalizeChunk(chunk) {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (chunk instanceof Int16Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }

  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }

  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }

  throw new TypeError('Unsupported PCM payload supplied to WavFileWriter.');
}

class WavFileWriter {
  constructor(filePath, { sampleRate, channels, bitsPerSample }) {
    this.filePath = path.resolve(filePath);
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bitsPerSample = bitsPerSample;
    this.dataSize = 0;

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.fd = fs.openSync(this.filePath, 'w');
    this.writeHeader();
  }

  writeHeader() {
    if (this.fd == null) {
      return;
    }

    const header = createWavHeader({
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitsPerSample: this.bitsPerSample,
      dataSize: this.dataSize
    });

    fs.writeSync(this.fd, header, 0, header.length, 0);
  }

  writePcmChunk(chunk) {
    if (this.fd == null) {
      throw new Error('Cannot write to a closed WAV file.');
    }

    const buffer = normalizeChunk(chunk);
    const position = 44 + this.dataSize;

    fs.writeSync(this.fd, buffer, 0, buffer.length, position);
    this.dataSize += buffer.length;
    this.writeHeader();
  }

  close() {
    if (this.fd == null) {
      return;
    }

    this.writeHeader();
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

module.exports = {
  WavFileWriter
};
