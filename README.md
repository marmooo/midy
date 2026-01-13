# Midy

A MIDI player/synthesizer written in JavaScript that supports GM-Lite/GM1/GM2
and SF2/SF3.

This library provides several files depending on the implementation level.

- midy-GMLite.js: support minimal GM-Lite (ref:
  [en](https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/gml-v1.pdf),
  [ja](https://amei.or.jp/midistandardcommittee/Recommended_Practice/General_MIDI_Lite_v1.0_japanese.pdf))
- midy-GM1.js: support minimal GM1 (ref:
  [en](https://midi.org/midi-1-0-detailed-specification),
  [en full](https://archive.org/details/complete_midi_96-1-3/page/n1/mode/2up),
  [ja](https://amei.or.jp/midistandardcommittee/MIDI1.0.pdf))
- midy-GM2.js: support minimal GM2 (ref:
  [en v1.2a](https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/GM2-v12a.pdf),
  [en v1.0](https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp24(e).pdf),
  [ja v1.0](https://amei.or.jp/midistandardcommittee/Recommended_Practice/GM2_japanese.pdf))
- midy.js: full implementation (in progress)

## Demo

- [@marmooo/midi-player](https://marmooo.github.io/midi-player/) - GUI library
- [Humidy](https://marmooo.github.io/humidy/) - GM2 MIDI mixer app
- [Timidy](https://marmooo.github.io/timidy/) - Timidity++ style MIDI player
- [4x4pad](https://marmooo.github.io/4x4pad/) - 4x4 grid style MIDI controller

## Support Status

All implementations follow the specification.

| Message                  | Support | Notes    |
| :----------------------- | :-----: | :------- |
| Note Off                 |   ✔️    |          |
| Note On                  |   ✔️    |          |
| Polyphonic Key Pressure  |   ✔️    | full GM2 |
| Controller Change        |   ✔️    | full GM2 |
| Program Change           |   ✔️    | full GM2 |
| Channel Pressure         |   ✔️    | full GM2 |
| Pitch Bend               |   ✔️    |          |
| System Exclusive Message |   ✔️    | full GM2 |
| System Common Message    |   ❌    |          |
| System Real Time Message |   ✔️    | full GM2 |
| MIDI Time Code           |   ❌    |          |
| MIDI Show Control        |   ❌    |          |
| MIDI Machine Control     |   ❌    |          |

## Usage

### Initialization

```js
// import { MidyGMLite as Midy } from "midy-GMLite.js";
// import { MidyGM1 as Midy } from "midy-GM1.js";
// import { MidyGM2 as Midy } from "midy-GM2.js";
import { Midy } from "midy.js";

const audioContext = new AudioContext();
if (audioContext.state === "running") await audioContext.suspend();
const midy = new Midy(audioContext);
await midy.loadMIDI("test.mid");
await midy.loadSoundFont("test.sf3");
await midy.start();
```

### Playback

```js
midy.loop = true;
await midy.start();
await midy.stop();
await midy.pause();
await midy.resume();
midy.seekTo(second);
```

### Events

```js
midy.addEventListener("looped", func);
midy.addEventListener("started", func);
midy.addEventListener("stopped", func);
midy.addEventListener("paused", func);
midy.addEventListener("resumed", func);
midy.addEventListener("seeked", func);
```

### MIDI Message

There are functions that handle MIDI messages as they are, as well as simplified
functions.

```js
midy.handleMessage(data, scheduleTime);
midy.noteOn(channelNumber, noteNumber, velocity);
midy.setProgramChange(channelNumber, programNumber);
```

### Control Change

There are functions that handle control changes as they are, as well as
simplified functions.

```js
midy.setControlChange(
  channelNumber,
  controller,
  value,
  scheduleTime,
); // [0-127] value
midy.setModulation(channelNumber, modulation); // [0-127] modulation
midy.setVolume(channelNumber, volume); // [0-127] volume
```

### System Exclusive Message

There are functions that handle SysEx data as is, as well as simplified
functions.

```js
midy.handleSysEx(data, scheduleTime); // [F0 F6 04 01 xx xx F7] data
midy.handleMasterVolumeSysEx(data, scheduleTime); // [F0 F6 04 01 xx xx F7] data
midy.setMasterVolume(volume); // [0-1] volume
```

### Multiple Soundfonts

This library supports SF2 and SF3. In addition, it supports multiple soundfonts
and [splitted soundfonts](https://github.com/marmooo/free-soundfonts) that are
optimized for playback on the web. The following example loads only the minimum
presets required for playback.

```js
const soundFontURL = "https://soundfonts.pages.dev/GeneralUser_GS_v1.471";

function getSoundFontPaths() {
  const paths = [];
  for (const instrument of midy.instruments) {
    const [bank, program] = instrument.split(":");
    const bankNumber = Number(bank);
    const programNumber = Number(program);
    const index = midy.soundFontTable[programNumber][bankNumber];
    if (index !== undefined) continue;
    const baseName = bankNumber === 128 ? "128" : program;
    paths.push(`${soundFontURL}/${baseName}.sf3`);
  }
  return paths;
}

const paths = getSoundFontPaths();
await midy.loadSoundFont(paths);
```

## Build

```
deno task build
```

## License

Apache-2.0
