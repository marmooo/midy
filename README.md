# Midy

A MIDI player/synthesizer written in JavaScript that supports GM-Lite/GM1 and
SF2/SF3.

This library provides several files depending on the implementation level. GM2
support is in progress and should be completed soon.

- midy-GMLite.js: support minimal GM-Lite (ref:
  [en](https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/gml-v1.pdf),
  [ja](https://amei.or.jp/midistandardcommittee/Recommended_Practice/General_MIDI_Lite_v1.0_japanese.pdf))
- midy-GM1.js: support minimal GM1 (ref:
  [en](https://archive.org/details/complete_midi_96-1-3/page/n1/mode/2up),
  [ja](https://amei.or.jp/midistandardcommittee/MIDI1.0.pdf))
- midy-GM2.js: support minimal GM2 (ref:
  [en v1.2a](https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/GM2-v12a.pdf),
  [en v1.0](https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp24(e).pdf),
  [ja v1.0](https://amei.or.jp/midistandardcommittee/Recommended_Practice/GM2_japanese.pdf))
  (in progress)
- midy.js: full implementation (in progress)

## Usage

### Initialization

```
// import { MidyGMLite as Midy } from "midy-GMLite.js";
// import { MidyGM1 as Midy } from "midy-GM1.js";
// import { MidyGM2 as Midy } from "midy-GM2.js";
import { Midy } from "midy.js";

const audioContext = new AudioContext();
const midy = new Midy(audioContext);
await midy.loadMIDI("test.mid");
await midy.loadSoundFont("test.sf3");
await midy.start();
```

### Playback

```
await midy.start();
midy.stop();
midy.pause();
await midy.resume();
midy.seekTo(second);
```

### MIDI Message

There are functions that handle MIDI messages as they are, as well as simplified
functions.

```
midy.handleMIDIMessage(statusByte, data1, data2);
midy.noteOn(channelNumber, noteNumber, velocity);
midy.handleProgramChange(channelNumber, program);
```

### Control Change

There are functions that handle control changes as they are, as well as
simplified functions.

```
midy.handleControlChange(channelNumber, controller, value); // [0-127] value
midy.setModulation(channelNumber, modulation);              // [0-127] modulation
midy.setVolume(channelNumber, volume);                      // [0-127] volume
```

### System Exclusive Message

There are functions that handle SysEx data as is, as well as simplified
functions.

```
midy.handleSysEx(data);             // [F0 F6 04 01 xx xx F7] data
midy.handleMasterVolumeSysEx(data); // [F0 F6 04 01 xx xx F7] data
midy.handleMasterVolume(volume);    // [0-1] volume
```

### Multiple Soundfonts

This library supports SF2 and SF3. In addition, it supports multiple soundfonts
and [splitted soundfonts](https://github.com/marmooo/free-soundfonts) that are
optimized for playback on the web. The following example loads only the minimum
presets required for playback.

```
const baseUrl = "https://soundfonts.pages.dev/GeneralUser_GS_v1.471";
for (const instrument of midy.instruments) {
  const [bankNumber, programNumber] = instrument.split(":").map(Number);
  if (midy.soundFontTable[programNumber].has(bankNumber)) continue;
  const program = programNumber.toString().padStart(3, "0");
  if (bankNumber === 128) {
    await midy.loadSoundFont(`${baseUrl}/128.sf3`);
  } else {
    await midy.loadSoundFont(`${baseUrl}/${program}.sf3`);
  }
}
```

## Build

```
deno task build
```

## Test

WebAudio only works on web browsers currently, so we are testing this library
using the following GUI libraries.

- [@marmooo/midi-player](https://github.com/marmooo/midi-player)

## License

Apache-2.0
