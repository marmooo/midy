// Minimal WAV (RIFF/WAVE) reader. Supports the handful of formats we
// actually produce/consume in this toolchain:
//   - PCM, 8/16/24/32-bit integer
//   - IEEE float, 32/64-bit
//   - WAVE_FORMAT_EXTENSIBLE wrapping either of the above (fluidsynth emits
//     this for some format/channel combinations)
// Not a general-purpose WAV library — no ADPCM, no unusual chunk layouts
// beyond skipping ones we don't need (LIST, fact, PEAK, ...).

export interface WavData {
  sampleRate: number;
  numChannels: number;
  /** One Float32Array per channel, samples normalized to [-1, 1]. */
  channelData: Float32Array[];
  /** Frames (samples per channel), i.e. channelData[ch].length. */
  numFrames: number;
}

const FORMAT_PCM = 1;
const FORMAT_IEEE_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

function readString(view: DataView, offset: number, length: number): string {
  let str = "";
  for (let i = 0; i < length; i++) {
    str += String.fromCharCode(view.getUint8(offset + i));
  }
  return str;
}

export function readWav(bytes: Uint8Array): WavData {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );

  if (
    readString(view, 0, 4) !== "RIFF" || readString(view, 8, 4) !== "WAVE"
  ) {
    throw new Error("not a RIFF/WAVE file");
  }

  let offset = 12;
  let formatTag = -1;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = -1;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readString(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + 8;

    if (chunkId === "fmt ") {
      formatTag = view.getUint16(chunkDataOffset, true);
      numChannels = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
      if (formatTag === FORMAT_EXTENSIBLE && chunkSize >= 40) {
        // The sub-format GUID's first two bytes carry the real format tag
        // (KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT share the rest of the GUID).
        formatTag = view.getUint16(chunkDataOffset + 24, true);
      }
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
    }

    // Chunks are word-aligned: an odd-sized chunk has one pad byte after it.
    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0) throw new Error("no data chunk found");
  if (formatTag !== FORMAT_PCM && formatTag !== FORMAT_IEEE_FLOAT) {
    throw new Error(`unsupported WAV format tag: ${formatTag}`);
  }
  if (numChannels <= 0) throw new Error("invalid channel count");

  const bytesPerSample = bitsPerSample / 8;
  const numFrames = Math.floor(dataSize / (bytesPerSample * numChannels));
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channelData.push(new Float32Array(numFrames));
  }

  let readSample: (byteOffset: number) => number;
  if (formatTag === FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
    readSample = (o) => view.getFloat32(o, true);
  } else if (formatTag === FORMAT_IEEE_FLOAT && bitsPerSample === 64) {
    readSample = (o) => view.getFloat64(o, true);
  } else if (formatTag === FORMAT_PCM && bitsPerSample === 8) {
    // 8-bit PCM is stored unsigned, centered at 128.
    readSample = (o) => (view.getUint8(o) - 128) / 128;
  } else if (formatTag === FORMAT_PCM && bitsPerSample === 16) {
    readSample = (o) => view.getInt16(o, true) / 32768;
  } else if (formatTag === FORMAT_PCM && bitsPerSample === 24) {
    readSample = (o) => {
      const b0 = view.getUint8(o);
      const b1 = view.getUint8(o + 1);
      const b2 = view.getUint8(o + 2);
      let value = b0 | (b1 << 8) | (b2 << 16);
      if (value & 0x800000) value -= 0x1000000;
      return value / 8388608;
    };
  } else if (formatTag === FORMAT_PCM && bitsPerSample === 32) {
    readSample = (o) => view.getInt32(o, true) / 2147483648;
  } else {
    throw new Error(
      `unsupported PCM/float bit depth: ${bitsPerSample}-bit (formatTag=${formatTag})`,
    );
  }

  let pos = dataOffset;
  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < numChannels; ch++) {
      channelData[ch][frame] = readSample(pos);
      pos += bytesPerSample;
    }
  }

  return { sampleRate, numChannels, channelData, numFrames };
}

/** Mix all channels down to mono by averaging. */
export function toMono(wav: WavData): Float32Array {
  if (wav.numChannels === 1) return wav.channelData[0];
  const mono = new Float32Array(wav.numFrames);
  for (let frame = 0; frame < wav.numFrames; frame++) {
    let sum = 0;
    for (let ch = 0; ch < wav.numChannels; ch++) {
      sum += wav.channelData[ch][frame];
    }
    mono[frame] = sum / wav.numChannels;
  }
  return mono;
}
