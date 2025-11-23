var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/midi-file@1.2.4/node_modules/midi-file/lib/midi-parser.js
var require_midi_parser = __commonJS({
  "../../../.cache/deno/deno_esbuild/registry.npmjs.org/midi-file@1.2.4/node_modules/midi-file/lib/midi-parser.js"(exports, module) {
    function parseMidi2(data) {
      var p = new Parser(data);
      var headerChunk = p.readChunk();
      if (headerChunk.id != "MThd")
        throw "Bad MIDI file.  Expected 'MHdr', got: '" + headerChunk.id + "'";
      var header = parseHeader(headerChunk.data);
      var tracks = [];
      for (var i = 0; !p.eof() && i < header.numTracks; i++) {
        var trackChunk = p.readChunk();
        if (trackChunk.id != "MTrk")
          throw "Bad MIDI file.  Expected 'MTrk', got: '" + trackChunk.id + "'";
        var track = parseTrack(trackChunk.data);
        tracks.push(track);
      }
      return {
        header,
        tracks
      };
    }
    function parseHeader(data) {
      var p = new Parser(data);
      var format = p.readUInt16();
      var numTracks = p.readUInt16();
      var result = {
        format,
        numTracks
      };
      var timeDivision = p.readUInt16();
      if (timeDivision & 32768) {
        result.framesPerSecond = 256 - (timeDivision >> 8);
        result.ticksPerFrame = timeDivision & 255;
      } else {
        result.ticksPerBeat = timeDivision;
      }
      return result;
    }
    function parseTrack(data) {
      var p = new Parser(data);
      var events = [];
      while (!p.eof()) {
        var event = readEvent();
        events.push(event);
      }
      return events;
      var lastEventTypeByte = null;
      function readEvent() {
        var event2 = {};
        event2.deltaTime = p.readVarInt();
        var eventTypeByte = p.readUInt8();
        if ((eventTypeByte & 240) === 240) {
          if (eventTypeByte === 255) {
            event2.meta = true;
            var metatypeByte = p.readUInt8();
            var length = p.readVarInt();
            switch (metatypeByte) {
              case 0:
                event2.type = "sequenceNumber";
                if (length !== 2) throw "Expected length for sequenceNumber event is 2, got " + length;
                event2.number = p.readUInt16();
                return event2;
              case 1:
                event2.type = "text";
                event2.text = p.readString(length);
                return event2;
              case 2:
                event2.type = "copyrightNotice";
                event2.text = p.readString(length);
                return event2;
              case 3:
                event2.type = "trackName";
                event2.text = p.readString(length);
                return event2;
              case 4:
                event2.type = "instrumentName";
                event2.text = p.readString(length);
                return event2;
              case 5:
                event2.type = "lyrics";
                event2.text = p.readString(length);
                return event2;
              case 6:
                event2.type = "marker";
                event2.text = p.readString(length);
                return event2;
              case 7:
                event2.type = "cuePoint";
                event2.text = p.readString(length);
                return event2;
              case 32:
                event2.type = "channelPrefix";
                if (length != 1) throw "Expected length for channelPrefix event is 1, got " + length;
                event2.channel = p.readUInt8();
                return event2;
              case 33:
                event2.type = "portPrefix";
                if (length != 1) throw "Expected length for portPrefix event is 1, got " + length;
                event2.port = p.readUInt8();
                return event2;
              case 47:
                event2.type = "endOfTrack";
                if (length != 0) throw "Expected length for endOfTrack event is 0, got " + length;
                return event2;
              case 81:
                event2.type = "setTempo";
                if (length != 3) throw "Expected length for setTempo event is 3, got " + length;
                event2.microsecondsPerBeat = p.readUInt24();
                return event2;
              case 84:
                event2.type = "smpteOffset";
                if (length != 5) throw "Expected length for smpteOffset event is 5, got " + length;
                var hourByte = p.readUInt8();
                var FRAME_RATES = { 0: 24, 32: 25, 64: 29, 96: 30 };
                event2.frameRate = FRAME_RATES[hourByte & 96];
                event2.hour = hourByte & 31;
                event2.min = p.readUInt8();
                event2.sec = p.readUInt8();
                event2.frame = p.readUInt8();
                event2.subFrame = p.readUInt8();
                return event2;
              case 88:
                event2.type = "timeSignature";
                if (length != 2 && length != 4) throw "Expected length for timeSignature event is 4 or 2, got " + length;
                event2.numerator = p.readUInt8();
                event2.denominator = 1 << p.readUInt8();
                if (length === 4) {
                  event2.metronome = p.readUInt8();
                  event2.thirtyseconds = p.readUInt8();
                } else {
                  event2.metronome = 36;
                  event2.thirtyseconds = 8;
                }
                return event2;
              case 89:
                event2.type = "keySignature";
                if (length != 2) throw "Expected length for keySignature event is 2, got " + length;
                event2.key = p.readInt8();
                event2.scale = p.readUInt8();
                return event2;
              case 127:
                event2.type = "sequencerSpecific";
                event2.data = p.readBytes(length);
                return event2;
              default:
                event2.type = "unknownMeta";
                event2.data = p.readBytes(length);
                event2.metatypeByte = metatypeByte;
                return event2;
            }
          } else if (eventTypeByte == 240) {
            event2.type = "sysEx";
            var length = p.readVarInt();
            event2.data = p.readBytes(length);
            return event2;
          } else if (eventTypeByte == 247) {
            event2.type = "endSysEx";
            var length = p.readVarInt();
            event2.data = p.readBytes(length);
            return event2;
          } else {
            throw "Unrecognised MIDI event type byte: " + eventTypeByte;
          }
        } else {
          var param1;
          if ((eventTypeByte & 128) === 0) {
            if (lastEventTypeByte === null)
              throw "Running status byte encountered before status byte";
            param1 = eventTypeByte;
            eventTypeByte = lastEventTypeByte;
            event2.running = true;
          } else {
            param1 = p.readUInt8();
            lastEventTypeByte = eventTypeByte;
          }
          var eventType = eventTypeByte >> 4;
          event2.channel = eventTypeByte & 15;
          switch (eventType) {
            case 8:
              event2.type = "noteOff";
              event2.noteNumber = param1;
              event2.velocity = p.readUInt8();
              return event2;
            case 9:
              var velocity = p.readUInt8();
              event2.type = velocity === 0 ? "noteOff" : "noteOn";
              event2.noteNumber = param1;
              event2.velocity = velocity;
              if (velocity === 0) event2.byte9 = true;
              return event2;
            case 10:
              event2.type = "noteAftertouch";
              event2.noteNumber = param1;
              event2.amount = p.readUInt8();
              return event2;
            case 11:
              event2.type = "controller";
              event2.controllerType = param1;
              event2.value = p.readUInt8();
              return event2;
            case 12:
              event2.type = "programChange";
              event2.programNumber = param1;
              return event2;
            case 13:
              event2.type = "channelAftertouch";
              event2.amount = param1;
              return event2;
            case 14:
              event2.type = "pitchBend";
              event2.value = param1 + (p.readUInt8() << 7) - 8192;
              return event2;
            default:
              throw "Unrecognised MIDI event type: " + eventType;
          }
        }
      }
    }
    function Parser(data) {
      this.buffer = data;
      this.bufferLen = this.buffer.length;
      this.pos = 0;
    }
    Parser.prototype.eof = function() {
      return this.pos >= this.bufferLen;
    };
    Parser.prototype.readUInt8 = function() {
      var result = this.buffer[this.pos];
      this.pos += 1;
      return result;
    };
    Parser.prototype.readInt8 = function() {
      var u = this.readUInt8();
      if (u & 128)
        return u - 256;
      else
        return u;
    };
    Parser.prototype.readUInt16 = function() {
      var b0 = this.readUInt8(), b1 = this.readUInt8();
      return (b0 << 8) + b1;
    };
    Parser.prototype.readInt16 = function() {
      var u = this.readUInt16();
      if (u & 32768)
        return u - 65536;
      else
        return u;
    };
    Parser.prototype.readUInt24 = function() {
      var b0 = this.readUInt8(), b1 = this.readUInt8(), b2 = this.readUInt8();
      return (b0 << 16) + (b1 << 8) + b2;
    };
    Parser.prototype.readInt24 = function() {
      var u = this.readUInt24();
      if (u & 8388608)
        return u - 16777216;
      else
        return u;
    };
    Parser.prototype.readUInt32 = function() {
      var b0 = this.readUInt8(), b1 = this.readUInt8(), b2 = this.readUInt8(), b3 = this.readUInt8();
      return (b0 << 24) + (b1 << 16) + (b2 << 8) + b3;
    };
    Parser.prototype.readBytes = function(len) {
      var bytes = this.buffer.slice(this.pos, this.pos + len);
      this.pos += len;
      return bytes;
    };
    Parser.prototype.readString = function(len) {
      var bytes = this.readBytes(len);
      return String.fromCharCode.apply(null, bytes);
    };
    Parser.prototype.readVarInt = function() {
      var result = 0;
      while (!this.eof()) {
        var b = this.readUInt8();
        if (b & 128) {
          result += b & 127;
          result <<= 7;
        } else {
          return result + b;
        }
      }
      return result;
    };
    Parser.prototype.readChunk = function() {
      var id = this.readString(4);
      var length = this.readUInt32();
      var data = this.readBytes(length);
      return {
        id,
        length,
        data
      };
    };
    module.exports = parseMidi2;
  }
});

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/midi-file@1.2.4/node_modules/midi-file/lib/midi-writer.js
var require_midi_writer = __commonJS({
  "../../../.cache/deno/deno_esbuild/registry.npmjs.org/midi-file@1.2.4/node_modules/midi-file/lib/midi-writer.js"(exports, module) {
    function writeMidi(data, opts) {
      if (typeof data !== "object")
        throw "Invalid MIDI data";
      opts = opts || {};
      var header = data.header || {};
      var tracks = data.tracks || [];
      var i, len = tracks.length;
      var w = new Writer();
      writeHeader(w, header, len);
      for (i = 0; i < len; i++) {
        writeTrack(w, tracks[i], opts);
      }
      return w.buffer;
    }
    function writeHeader(w, header, numTracks) {
      var format = header.format == null ? 1 : header.format;
      var timeDivision = 128;
      if (header.timeDivision) {
        timeDivision = header.timeDivision;
      } else if (header.ticksPerFrame && header.framesPerSecond) {
        timeDivision = -(header.framesPerSecond & 255) << 8 | header.ticksPerFrame & 255;
      } else if (header.ticksPerBeat) {
        timeDivision = header.ticksPerBeat & 32767;
      }
      var h = new Writer();
      h.writeUInt16(format);
      h.writeUInt16(numTracks);
      h.writeUInt16(timeDivision);
      w.writeChunk("MThd", h.buffer);
    }
    function writeTrack(w, track, opts) {
      var t = new Writer();
      var i, len = track.length;
      var eventTypeByte = null;
      for (i = 0; i < len; i++) {
        if (opts.running === false || !opts.running && !track[i].running) eventTypeByte = null;
        eventTypeByte = writeEvent(t, track[i], eventTypeByte, opts.useByte9ForNoteOff);
      }
      w.writeChunk("MTrk", t.buffer);
    }
    function writeEvent(w, event, lastEventTypeByte, useByte9ForNoteOff) {
      var type = event.type;
      var deltaTime = event.deltaTime;
      var text = event.text || "";
      var data = event.data || [];
      var eventTypeByte = null;
      w.writeVarInt(deltaTime);
      switch (type) {
        // meta events
        case "sequenceNumber":
          w.writeUInt8(255);
          w.writeUInt8(0);
          w.writeVarInt(2);
          w.writeUInt16(event.number);
          break;
        case "text":
          w.writeUInt8(255);
          w.writeUInt8(1);
          w.writeVarInt(text.length);
          w.writeString(text);
          break;
        case "copyrightNotice":
          w.writeUInt8(255);
          w.writeUInt8(2);
          w.writeVarInt(text.length);
          w.writeString(text);
          break;
        case "trackName":
          w.writeUInt8(255);
          w.writeUInt8(3);
          w.writeVarInt(text.length);
          w.writeString(text);
          break;
        case "instrumentName":
          w.writeUInt8(255);
          w.writeUInt8(4);
          w.writeVarInt(text.length);
          w.writeString(text);
          break;
        case "lyrics":
          w.writeUInt8(255);
          w.writeUInt8(5);
          w.writeVarInt(text.length);
          w.writeString(text);
          break;
        case "marker":
          w.writeUInt8(255);
          w.writeUInt8(6);
          w.writeVarInt(text.length);
          w.writeString(text);
          break;
        case "cuePoint":
          w.writeUInt8(255);
          w.writeUInt8(7);
          w.writeVarInt(text.length);
          w.writeString(text);
          break;
        case "channelPrefix":
          w.writeUInt8(255);
          w.writeUInt8(32);
          w.writeVarInt(1);
          w.writeUInt8(event.channel);
          break;
        case "portPrefix":
          w.writeUInt8(255);
          w.writeUInt8(33);
          w.writeVarInt(1);
          w.writeUInt8(event.port);
          break;
        case "endOfTrack":
          w.writeUInt8(255);
          w.writeUInt8(47);
          w.writeVarInt(0);
          break;
        case "setTempo":
          w.writeUInt8(255);
          w.writeUInt8(81);
          w.writeVarInt(3);
          w.writeUInt24(event.microsecondsPerBeat);
          break;
        case "smpteOffset":
          w.writeUInt8(255);
          w.writeUInt8(84);
          w.writeVarInt(5);
          var FRAME_RATES = { 24: 0, 25: 32, 29: 64, 30: 96 };
          var hourByte = event.hour & 31 | FRAME_RATES[event.frameRate];
          w.writeUInt8(hourByte);
          w.writeUInt8(event.min);
          w.writeUInt8(event.sec);
          w.writeUInt8(event.frame);
          w.writeUInt8(event.subFrame);
          break;
        case "timeSignature":
          w.writeUInt8(255);
          w.writeUInt8(88);
          w.writeVarInt(4);
          w.writeUInt8(event.numerator);
          var denominator = Math.floor(Math.log(event.denominator) / Math.LN2) & 255;
          w.writeUInt8(denominator);
          w.writeUInt8(event.metronome);
          w.writeUInt8(event.thirtyseconds || 8);
          break;
        case "keySignature":
          w.writeUInt8(255);
          w.writeUInt8(89);
          w.writeVarInt(2);
          w.writeInt8(event.key);
          w.writeUInt8(event.scale);
          break;
        case "sequencerSpecific":
          w.writeUInt8(255);
          w.writeUInt8(127);
          w.writeVarInt(data.length);
          w.writeBytes(data);
          break;
        case "unknownMeta":
          if (event.metatypeByte != null) {
            w.writeUInt8(255);
            w.writeUInt8(event.metatypeByte);
            w.writeVarInt(data.length);
            w.writeBytes(data);
          }
          break;
        // system-exclusive
        case "sysEx":
          w.writeUInt8(240);
          w.writeVarInt(data.length);
          w.writeBytes(data);
          break;
        case "endSysEx":
          w.writeUInt8(247);
          w.writeVarInt(data.length);
          w.writeBytes(data);
          break;
        // channel events
        case "noteOff":
          var noteByte = useByte9ForNoteOff !== false && event.byte9 || useByte9ForNoteOff && event.velocity == 0 ? 144 : 128;
          eventTypeByte = noteByte | event.channel;
          if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte);
          w.writeUInt8(event.noteNumber);
          w.writeUInt8(event.velocity);
          break;
        case "noteOn":
          eventTypeByte = 144 | event.channel;
          if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte);
          w.writeUInt8(event.noteNumber);
          w.writeUInt8(event.velocity);
          break;
        case "noteAftertouch":
          eventTypeByte = 160 | event.channel;
          if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte);
          w.writeUInt8(event.noteNumber);
          w.writeUInt8(event.amount);
          break;
        case "controller":
          eventTypeByte = 176 | event.channel;
          if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte);
          w.writeUInt8(event.controllerType);
          w.writeUInt8(event.value);
          break;
        case "programChange":
          eventTypeByte = 192 | event.channel;
          if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte);
          w.writeUInt8(event.programNumber);
          break;
        case "channelAftertouch":
          eventTypeByte = 208 | event.channel;
          if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte);
          w.writeUInt8(event.amount);
          break;
        case "pitchBend":
          eventTypeByte = 224 | event.channel;
          if (eventTypeByte !== lastEventTypeByte) w.writeUInt8(eventTypeByte);
          var value14 = 8192 + event.value;
          var lsb14 = value14 & 127;
          var msb14 = value14 >> 7 & 127;
          w.writeUInt8(lsb14);
          w.writeUInt8(msb14);
          break;
        default:
          throw "Unrecognized event type: " + type;
      }
      return eventTypeByte;
    }
    function Writer() {
      this.buffer = [];
    }
    Writer.prototype.writeUInt8 = function(v) {
      this.buffer.push(v & 255);
    };
    Writer.prototype.writeInt8 = Writer.prototype.writeUInt8;
    Writer.prototype.writeUInt16 = function(v) {
      var b0 = v >> 8 & 255, b1 = v & 255;
      this.writeUInt8(b0);
      this.writeUInt8(b1);
    };
    Writer.prototype.writeInt16 = Writer.prototype.writeUInt16;
    Writer.prototype.writeUInt24 = function(v) {
      var b0 = v >> 16 & 255, b1 = v >> 8 & 255, b2 = v & 255;
      this.writeUInt8(b0);
      this.writeUInt8(b1);
      this.writeUInt8(b2);
    };
    Writer.prototype.writeInt24 = Writer.prototype.writeUInt24;
    Writer.prototype.writeUInt32 = function(v) {
      var b0 = v >> 24 & 255, b1 = v >> 16 & 255, b2 = v >> 8 & 255, b3 = v & 255;
      this.writeUInt8(b0);
      this.writeUInt8(b1);
      this.writeUInt8(b2);
      this.writeUInt8(b3);
    };
    Writer.prototype.writeInt32 = Writer.prototype.writeUInt32;
    Writer.prototype.writeBytes = function(arr) {
      this.buffer = this.buffer.concat(Array.prototype.slice.call(arr, 0));
    };
    Writer.prototype.writeString = function(str) {
      var i, len = str.length, arr = [];
      for (i = 0; i < len; i++) {
        arr.push(str.codePointAt(i));
      }
      this.writeBytes(arr);
    };
    Writer.prototype.writeVarInt = function(v) {
      if (v < 0) throw "Cannot write negative variable-length integer";
      if (v <= 127) {
        this.writeUInt8(v);
      } else {
        var i = v;
        var bytes = [];
        bytes.push(i & 127);
        i >>= 7;
        while (i) {
          var b = i & 127 | 128;
          bytes.push(b);
          i >>= 7;
        }
        this.writeBytes(bytes.reverse());
      }
    };
    Writer.prototype.writeChunk = function(id, data) {
      this.writeString(id);
      this.writeUInt32(data.length);
      this.writeBytes(data);
    };
    module.exports = writeMidi;
  }
});

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/midi-file@1.2.4/node_modules/midi-file/index.js
var require_midi_file = __commonJS({
  "../../../.cache/deno/deno_esbuild/registry.npmjs.org/midi-file@1.2.4/node_modules/midi-file/index.js"(exports) {
    exports.parseMidi = require_midi_parser();
    exports.writeMidi = require_midi_writer();
  }
});

// src/midy.js
var import_midi_file = __toESM(require_midi_file());

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.3/node_modules/@marmooo/soundfont-parser/esm/Stream.js
var Stream = class {
  constructor(data, offset) {
    Object.defineProperty(this, "data", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: data
    });
    Object.defineProperty(this, "offset", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: offset
    });
  }
  readString(size) {
    const start = this.offset;
    const end = start + size;
    const data = this.data;
    let nul = data.subarray(start, end).indexOf(0);
    if (nul < 0)
      nul = size;
    const arr = new Array(nul);
    for (let i = 0; i < nul; i++) {
      arr[i] = data[start + i];
    }
    this.offset = end;
    return String.fromCharCode(...arr);
  }
  readWORD() {
    return this.data[this.offset++] | this.data[this.offset++] << 8;
  }
  readDWORD(bigEndian = false) {
    if (bigEndian) {
      return (this.data[this.offset++] << 24 | this.data[this.offset++] << 16 | this.data[this.offset++] << 8 | this.data[this.offset++]) >>> 0;
    } else {
      return (this.data[this.offset++] | this.data[this.offset++] << 8 | this.data[this.offset++] << 16 | this.data[this.offset++] << 24) >>> 0;
    }
  }
  readByte() {
    return this.data[this.offset++];
  }
  readAt(offset) {
    return this.data[this.offset + offset];
  }
  /* helper */
  readUInt8() {
    return this.readByte();
  }
  readInt8() {
    return this.readByte() << 24 >> 24;
  }
  readUInt16() {
    return this.readWORD();
  }
  readInt16() {
    return this.readWORD() << 16 >> 16;
  }
  readUInt32() {
    return this.readDWORD();
  }
};

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.3/node_modules/@marmooo/soundfont-parser/esm/RiffParser.js
function parseChunk(input, offset, bigEndian) {
  const stream = new Stream(input, offset);
  const type = stream.readString(4);
  const size = stream.readDWORD(bigEndian);
  return new Chunk(type, size, stream.offset);
}
function parseRiff(input, index = 0, length, { padding = true, bigEndian = false } = {}) {
  const chunkList = [];
  const end = length + index;
  let offset = index;
  while (offset < end) {
    const chunk = parseChunk(input, offset, bigEndian);
    offset = chunk.offset + chunk.size;
    if (padding && (offset - index & 1) === 1) {
      offset++;
    }
    chunkList.push(chunk);
  }
  return chunkList;
}
var Chunk = class {
  constructor(type, size, offset) {
    Object.defineProperty(this, "type", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: type
    });
    Object.defineProperty(this, "size", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: size
    });
    Object.defineProperty(this, "offset", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: offset
    });
  }
};

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.3/node_modules/@marmooo/soundfont-parser/esm/Constants.js
var GeneratorKeys = [
  "startAddrsOffset",
  "endAddrsOffset",
  "startloopAddrsOffset",
  "endloopAddrsOffset",
  "startAddrsCoarseOffset",
  "modLfoToPitch",
  "vibLfoToPitch",
  "modEnvToPitch",
  "initialFilterFc",
  "initialFilterQ",
  "modLfoToFilterFc",
  "modEnvToFilterFc",
  "endAddrsCoarseOffset",
  "modLfoToVolume",
  void 0,
  // 14
  "chorusEffectsSend",
  "reverbEffectsSend",
  "pan",
  void 0,
  void 0,
  void 0,
  // 18,19,20
  "delayModLFO",
  "freqModLFO",
  "delayVibLFO",
  "freqVibLFO",
  "delayModEnv",
  "attackModEnv",
  "holdModEnv",
  "decayModEnv",
  "sustainModEnv",
  "releaseModEnv",
  "keynumToModEnvHold",
  "keynumToModEnvDecay",
  "delayVolEnv",
  "attackVolEnv",
  "holdVolEnv",
  "decayVolEnv",
  "sustainVolEnv",
  "releaseVolEnv",
  "keynumToVolEnvHold",
  "keynumToVolEnvDecay",
  "instrument",
  void 0,
  // 42
  "keyRange",
  "velRange",
  "startloopAddrsCoarseOffset",
  "keynum",
  "velocity",
  "initialAttenuation",
  void 0,
  // 49
  "endloopAddrsCoarseOffset",
  "coarseTune",
  "fineTune",
  "sampleID",
  "sampleModes",
  void 0,
  // 55
  "scaleTuning",
  "exclusiveClass",
  "overridingRootKey"
];

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.3/node_modules/@marmooo/soundfont-parser/esm/Modulator.js
var ModulatorSource = class _ModulatorSource {
  constructor(type, polarity, direction, cc, index) {
    Object.defineProperty(this, "type", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: type
    });
    Object.defineProperty(this, "polarity", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: polarity
    });
    Object.defineProperty(this, "direction", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: direction
    });
    Object.defineProperty(this, "cc", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: cc
    });
    Object.defineProperty(this, "index", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: index
    });
  }
  get controllerType() {
    return this.cc << 7 | this.index;
  }
  static parse(sourceOper) {
    const type = sourceOper >> 10 & 63;
    const index = sourceOper & 127;
    const cc = sourceOper >> 7 & 1;
    const direction = sourceOper >> 8 & 1;
    const polarity = sourceOper >> 9 & 1;
    return new _ModulatorSource(type, polarity, direction, cc, index);
  }
  map(normalizedValue) {
    let v = normalizedValue;
    if (this.polarity === 1) {
      v = (v - 0.5) * 2;
      if (this.direction === 1) {
        v *= -1;
      }
    } else if (this.direction === 1) {
      v = 1 - v;
    }
    switch (this.type) {
      case 0:
        break;
      case 1:
        v = Math.sign(v) * Math.log(Math.abs(v));
        break;
      case 2:
        v = Math.sign(v) * Math.exp(-Math.abs(v));
        break;
      case 3:
        v = v >= 0.5 ? 1 : 0;
        break;
      default:
        console.warn(`unexpected type: ${this.type}`);
        break;
    }
    return v;
  }
};

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.3/node_modules/@marmooo/soundfont-parser/esm/Structs.js
var VersionTag = class _VersionTag {
  constructor(major, minor) {
    Object.defineProperty(this, "major", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: major
    });
    Object.defineProperty(this, "minor", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: minor
    });
  }
  static parse(stream) {
    const major = stream.readInt8();
    const minor = stream.readInt8();
    return new _VersionTag(major, minor);
  }
};
var Info = class _Info {
  constructor(comment, copyright, creationDate, engineer, name, product, software, version, soundEngine, romName, romVersion) {
    Object.defineProperty(this, "comment", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: comment
    });
    Object.defineProperty(this, "copyright", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: copyright
    });
    Object.defineProperty(this, "creationDate", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: creationDate
    });
    Object.defineProperty(this, "engineer", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: engineer
    });
    Object.defineProperty(this, "name", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: name
    });
    Object.defineProperty(this, "product", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: product
    });
    Object.defineProperty(this, "software", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: software
    });
    Object.defineProperty(this, "version", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: version
    });
    Object.defineProperty(this, "soundEngine", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: soundEngine
    });
    Object.defineProperty(this, "romName", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: romName
    });
    Object.defineProperty(this, "romVersion", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: romVersion
    });
  }
  static parse(data, chunks) {
    function getChunk(type) {
      for (let i = 0; i < chunks.length; i++) {
        if (chunks[i].type === type)
          return chunks[i];
      }
      return void 0;
    }
    function toStream(chunk) {
      return new Stream(data, chunk.offset);
    }
    function readString(type) {
      const chunk = getChunk(type);
      if (!chunk)
        return null;
      return toStream(chunk).readString(chunk.size);
    }
    function readVersionTag(type) {
      const chunk = getChunk(type);
      if (!chunk)
        return null;
      return VersionTag.parse(toStream(chunk));
    }
    const comment = readString("ICMT");
    const copyright = readString("ICOP");
    const creationDate = readString("ICRD");
    const engineer = readString("IENG");
    const name = readString("INAM");
    const product = readString("IPRD");
    const software = readString("ISFT");
    const version = readVersionTag("ifil");
    const soundEngine = readString("isng");
    const romName = readString("irom");
    const romVersion = readVersionTag("iver");
    return new _Info(comment, copyright, creationDate, engineer, name, product, software, version, soundEngine, romName, romVersion);
  }
};
var Bag = class _Bag {
  constructor(generatorIndex, modulatorIndex) {
    Object.defineProperty(this, "generatorIndex", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: generatorIndex
    });
    Object.defineProperty(this, "modulatorIndex", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: modulatorIndex
    });
  }
  static parse(stream) {
    const generatorIndex = stream.readWORD();
    const modulatorIndex = stream.readWORD();
    return new _Bag(generatorIndex, modulatorIndex);
  }
};
var PresetHeader = class _PresetHeader {
  constructor(presetName, preset, bank, presetBagIndex, library, genre, morphology) {
    Object.defineProperty(this, "presetName", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: presetName
    });
    Object.defineProperty(this, "preset", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: preset
    });
    Object.defineProperty(this, "bank", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: bank
    });
    Object.defineProperty(this, "presetBagIndex", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: presetBagIndex
    });
    Object.defineProperty(this, "library", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: library
    });
    Object.defineProperty(this, "genre", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: genre
    });
    Object.defineProperty(this, "morphology", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: morphology
    });
  }
  get isEnd() {
    const { presetName, preset, bank, library, genre, morphology } = this;
    return (presetName === "" || presetName === "EOP") && preset + bank + library + genre + morphology === 0;
  }
  static parse(stream) {
    const presetName = stream.readString(20);
    const preset = stream.readWORD();
    const bank = stream.readWORD();
    const presetBagIndex = stream.readWORD();
    const library = stream.readDWORD();
    const genre = stream.readDWORD();
    const morphology = stream.readDWORD();
    return new _PresetHeader(presetName, preset, bank, presetBagIndex, library, genre, morphology);
  }
};
var RangeValue = class _RangeValue {
  constructor(lo, hi) {
    Object.defineProperty(this, "lo", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "hi", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this.lo = lo;
    this.hi = hi;
  }
  in(value) {
    return this.lo <= value && value <= this.hi;
  }
  static parse(stream) {
    const lo = stream.readByte();
    const hi = stream.readByte();
    return new _RangeValue(lo, hi);
  }
};
var ModulatorList = class _ModulatorList {
  constructor(sourceOper, destinationOper, amount, amountSourceOper, transOper) {
    Object.defineProperty(this, "sourceOper", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: sourceOper
    });
    Object.defineProperty(this, "destinationOper", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: destinationOper
    });
    Object.defineProperty(this, "amount", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: amount
    });
    Object.defineProperty(this, "amountSourceOper", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: amountSourceOper
    });
    Object.defineProperty(this, "transOper", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: transOper
    });
  }
  transform(inputValue) {
    const newValue = this.amount * inputValue;
    switch (this.transOper) {
      case 0:
        return newValue;
      case 2:
        return Math.abs(newValue);
      default:
        return newValue;
    }
  }
  static parse(stream) {
    const source = stream.readWORD();
    const destinationOper = stream.readWORD();
    const value = stream.readInt16();
    const amountSource = stream.readWORD();
    const transOper = stream.readWORD();
    const sourceOper = ModulatorSource.parse(source);
    const amountSourceOper = ModulatorSource.parse(amountSource);
    return new _ModulatorList(sourceOper, destinationOper, value, amountSourceOper, transOper);
  }
};
var GeneratorList = class _GeneratorList {
  constructor(code, value) {
    Object.defineProperty(this, "code", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: code
    });
    Object.defineProperty(this, "value", {
      enumerable: true,
      configurable: true,
      writable: true,
      value
    });
  }
  get type() {
    return GeneratorKeys[this.code];
  }
  get isEnd() {
    return this.code === 0 && this.value === 0;
  }
  static parse(stream) {
    const code = stream.readWORD();
    const type = GeneratorKeys[code];
    let value;
    switch (type) {
      case "keyRange":
      case "velRange":
        value = RangeValue.parse(stream);
        break;
      case "instrument":
      case "sampleID":
        value = stream.readUInt16();
        break;
      default:
        value = stream.readInt16();
        break;
    }
    return new _GeneratorList(code, value);
  }
};
var Instrument = class _Instrument {
  constructor() {
    Object.defineProperty(this, "instrumentName", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "instrumentBagIndex", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
  }
  get isEnd() {
    return this.instrumentName === "EOI";
  }
  static parse(stream) {
    const t = new _Instrument();
    t.instrumentName = stream.readString(20);
    t.instrumentBagIndex = stream.readWORD();
    return t;
  }
};
var SampleHeader = class _SampleHeader {
  constructor(sampleName, start, end, loopStart, loopEnd, sampleRate, originalPitch, pitchCorrection, sampleLink, sampleType) {
    Object.defineProperty(this, "sampleName", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: sampleName
    });
    Object.defineProperty(this, "start", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: start
    });
    Object.defineProperty(this, "end", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: end
    });
    Object.defineProperty(this, "loopStart", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: loopStart
    });
    Object.defineProperty(this, "loopEnd", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: loopEnd
    });
    Object.defineProperty(this, "sampleRate", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: sampleRate
    });
    Object.defineProperty(this, "originalPitch", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: originalPitch
    });
    Object.defineProperty(this, "pitchCorrection", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: pitchCorrection
    });
    Object.defineProperty(this, "sampleLink", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: sampleLink
    });
    Object.defineProperty(this, "sampleType", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: sampleType
    });
  }
  get isEnd() {
    return this.sampleName === "EOS";
  }
  static parse(stream, isSF3) {
    const sampleName = stream.readString(20);
    const start = stream.readDWORD();
    const end = stream.readDWORD();
    let loopStart = stream.readDWORD();
    let loopEnd = stream.readDWORD();
    const sampleRate = stream.readDWORD();
    const originalPitch = stream.readByte();
    const pitchCorrection = stream.readInt8();
    const sampleLink = stream.readWORD();
    const sampleType = stream.readWORD();
    if (!isSF3) {
      loopStart -= start;
      loopEnd -= start;
    }
    return new _SampleHeader(sampleName, start, end, loopStart, loopEnd, sampleRate, originalPitch, pitchCorrection, sampleLink, sampleType);
  }
};
var BoundedValue = class {
  constructor(min, defaultValue, max) {
    Object.defineProperty(this, "min", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "max", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "defaultValue", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this.min = min;
    this.defaultValue = defaultValue;
    this.max = max;
  }
  clamp(value) {
    return Math.max(this.min, Math.min(value, this.max));
  }
};

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.3/node_modules/@marmooo/soundfont-parser/esm/AudioData.js
var AudioDataTypes = ["pcm16", "pcm24", "compressed"];
var AudioTypesSet = new Set(AudioDataTypes);
var AudioData = class {
  constructor(type, sampleHeader, data) {
    Object.defineProperty(this, "type", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "sampleHeader", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "data", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    if (!AudioTypesSet.has(type)) {
      throw new Error(`Invalid AudioDataType: ${type}`);
    }
    this.type = type;
    this.sampleHeader = sampleHeader;
    this.data = data;
  }
  decodePCM(data) {
    const { type } = this;
    if (type === "pcm16") {
      const bytesPerSample = 2;
      const frameCount = data.byteLength / bytesPerSample;
      const result = new Float32Array(frameCount);
      const src = new Int16Array(data.buffer, data.byteOffset, data.byteLength / bytesPerSample);
      for (let i = 0; i < frameCount; i++) {
        result[i] = src[i] / 32768;
      }
      return result;
    } else {
      const bytesPerSample = 3;
      const frameCount = data.byteLength / bytesPerSample;
      const result = new Float32Array(frameCount);
      for (let i = 0; i < frameCount; i++) {
        const idx = i * bytesPerSample;
        let val = data[idx] | data[idx + 1] << 8 | data[idx + 2] << 16;
        if (val & 8388608)
          val |= 4278190080;
        result[i] = val / 8388608;
      }
      return result;
    }
  }
  async toAudioBuffer(audioContext, start, end) {
    if (this.type === "compressed") {
      const slice = this.data.slice(start, end);
      return await audioContext.decodeAudioData(slice.buffer);
    } else {
      const subarray = this.data.subarray(start, end);
      const pcm = this.decodePCM(subarray);
      const buffer = new AudioBuffer({
        numberOfChannels: 1,
        length: pcm.length,
        sampleRate: this.sampleHeader.sampleRate
      });
      buffer.getChannelData(0).set(pcm);
      return buffer;
    }
  }
};

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.3/node_modules/@marmooo/soundfont-parser/esm/Parser.js
function parse(input, option = {}) {
  const chunkList = parseRiff(input, 0, input.length, option);
  if (chunkList.length !== 1) {
    throw new Error("wrong chunk length");
  }
  const chunk = chunkList[0];
  if (chunk === null) {
    throw new Error("chunk not found");
  }
  function parseRiffChunk(chunk2, data, option2 = {}) {
    const chunkList2 = getChunkList(chunk2, data, "RIFF", "sfbk", option2);
    if (chunkList2.length !== 3) {
      throw new Error("invalid sfbk structure");
    }
    const info = parseInfoList(chunkList2[0], data);
    const isSF32 = info.version.major === 3;
    if (isSF32 && chunkList2[2].type !== "LIST") {
      chunkList2[2] = parseChunk(data, chunkList2[2].offset - 9, false);
    }
    return {
      // INFO-list
      info,
      // sdta-list
      samplingData: parseSdtaList(chunkList2[1], data),
      // pdta-list
      ...parsePdtaList(chunkList2[2], data, isSF32)
    };
  }
  function parsePdtaList(chunk2, data, isSF32) {
    const chunkList2 = getChunkList(chunk2, data, "LIST", "pdta");
    if (chunkList2.length !== 9) {
      throw new Error("invalid pdta chunk");
    }
    return {
      presetHeaders: parsePhdr(chunkList2[0], data),
      presetZone: parsePbag(chunkList2[1], data),
      presetModulators: parsePmod(chunkList2[2], data),
      presetGenerators: parsePgen(chunkList2[3], data),
      instruments: parseInst(chunkList2[4], data),
      instrumentZone: parseIbag(chunkList2[5], data),
      instrumentModulators: parseImod(chunkList2[6], data),
      instrumentGenerators: parseIgen(chunkList2[7], data),
      sampleHeaders: parseShdr(chunkList2[8], data, isSF32)
    };
  }
  const result = parseRiffChunk(chunk, input, option);
  const isSF3 = result.info.version.major === 3;
  return {
    ...result,
    samples: loadSamples(result.sampleHeaders, result.samplingData.offsetMSB, result.samplingData.offsetLSB, input, isSF3)
  };
}
function getChunkList(chunk, data, expectedType, expectedSignature, option = {}) {
  if (chunk.type !== expectedType) {
    throw new Error("invalid chunk type:" + chunk.type);
  }
  const stream = new Stream(data, chunk.offset);
  const signature = stream.readString(4);
  if (signature !== expectedSignature) {
    throw new Error("invalid signature:" + signature);
  }
  return parseRiff(data, stream.offset, chunk.size - 4, option);
}
function parseInfoList(chunk, data) {
  const chunkList = getChunkList(chunk, data, "LIST", "INFO");
  return Info.parse(data, chunkList);
}
function parseSdtaList(chunk, data) {
  const chunkList = getChunkList(chunk, data, "LIST", "sdta");
  return {
    offsetMSB: chunkList[0].offset,
    offsetLSB: chunkList[1]?.offset
  };
}
function parseChunkObjects(chunk, data, type, clazz, terminate, isSF3) {
  const result = [];
  if (chunk.type !== type) {
    throw new Error("invalid chunk type:" + chunk.type);
  }
  const stream = new Stream(data, chunk.offset);
  const size = chunk.offset + chunk.size;
  while (stream.offset < size) {
    const obj = clazz.parse(stream, isSF3);
    if (terminate && terminate(obj)) {
      break;
    }
    result.push(obj);
  }
  return result;
}
var parsePhdr = (chunk, data) => parseChunkObjects(chunk, data, "phdr", PresetHeader, (p) => p.isEnd);
var parsePbag = (chunk, data) => parseChunkObjects(chunk, data, "pbag", Bag);
var parseInst = (chunk, data) => parseChunkObjects(chunk, data, "inst", Instrument, (i) => i.isEnd);
var parseIbag = (chunk, data) => parseChunkObjects(chunk, data, "ibag", Bag);
var parsePmod = (chunk, data) => parseChunkObjects(chunk, data, "pmod", ModulatorList);
var parseImod = (chunk, data) => parseChunkObjects(chunk, data, "imod", ModulatorList);
var parsePgen = (chunk, data) => parseChunkObjects(chunk, data, "pgen", GeneratorList, (g) => g.isEnd);
var parseIgen = (chunk, data) => parseChunkObjects(chunk, data, "igen", GeneratorList);
var parseShdr = (chunk, data, isSF3) => parseChunkObjects(chunk, data, "shdr", SampleHeader, (s) => s.isEnd, isSF3);
function loadSamples(sampleHeader, samplingDataOffsetMSB, samplingDataOffsetLSB, data, isSF3) {
  const result = new Array(sampleHeader.length);
  const factor = isSF3 ? 1 : 2;
  const type = isSF3 ? "compressed" : samplingDataOffsetLSB ? "pcm24" : "pcm16";
  for (let i = 0; i < sampleHeader.length; i++) {
    const { start, end } = sampleHeader[i];
    const startOffset = samplingDataOffsetMSB + start * factor;
    const endOffset = samplingDataOffsetMSB + end * factor;
    const sampleData = data.subarray(startOffset, endOffset);
    result[i] = new AudioData(type, sampleHeader[i], sampleData);
  }
  return result;
}

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.3/node_modules/@marmooo/soundfont-parser/esm/Generator.js
var generatorKeyToIndex = /* @__PURE__ */ new Map();
for (let i = 0; i < GeneratorKeys.length; i++) {
  generatorKeyToIndex.set(GeneratorKeys[i], i);
}
var IndexGeneratorKeys = [
  "instrument",
  "sampleID"
];
var RangeGeneratorKeys = [
  "keyRange",
  "velRange"
];
var SubstitutionGeneratorKeys = [
  "keynum",
  "velocity"
];
var SampleGeneratorKeys = [
  "startAddrsOffset",
  "endAddrsOffset",
  "startloopAddrsOffset",
  "endloopAddrsOffset",
  "startAddrsCoarseOffset",
  "endAddrsCoarseOffset",
  "startloopAddrsCoarseOffset",
  "endloopAddrsCoarseOffset",
  "sampleModes",
  "exclusiveClass",
  "overridingRootKey"
];
var presetExcludedKeys = [
  ...SampleGeneratorKeys,
  ...SubstitutionGeneratorKeys
];
var presetExcludedIndices = /* @__PURE__ */ new Set();
for (let i = 0; i < presetExcludedKeys.length; i++) {
  const key = presetExcludedKeys[i];
  const index = generatorKeyToIndex.get(key);
  if (index !== void 0)
    presetExcludedIndices.add(index);
}
function convertToInstrumentGeneratorParams(input) {
  const output = {};
  const keys = Object.keys(input);
  for (const key of keys) {
    const value = input[key];
    if (isRangeGenerator(key)) {
      output[key] = value;
    } else {
      const boundedValue = value;
      output[key] = boundedValue.clamp(boundedValue.defaultValue);
    }
  }
  return output;
}
var fixedGenerators = [
  ["keynum", "keyRange"],
  ["velocity", "velRange"]
];
var RangeGeneratorKeysSet = new Set(RangeGeneratorKeys);
function isRangeGenerator(key) {
  return RangeGeneratorKeysSet.has(key);
}
var nonValueGeneratorKeysSet = /* @__PURE__ */ new Set([
  ...IndexGeneratorKeys,
  ...RangeGeneratorKeys,
  ...SubstitutionGeneratorKeys,
  ...SampleGeneratorKeys
]);
function extractValueGeneratorKeys() {
  const result = [];
  const length = GeneratorKeys.length;
  for (let i = 0; i < length; i++) {
    const key = GeneratorKeys[i];
    if (key !== void 0 && !nonValueGeneratorKeysSet.has(key)) {
      result.push(key);
    }
  }
  return result;
}
var ValueGeneratorKeys = extractValueGeneratorKeys();
var ValueGeneratorKeysSet = new Set(ValueGeneratorKeys);
function isValueGenerator(key) {
  return ValueGeneratorKeysSet.has(key);
}
function createPresetGeneratorObject(generators) {
  const result = {};
  for (let i = 0; i < generators.length; i++) {
    const gen = generators[i];
    const type = gen.type;
    if (type === void 0)
      continue;
    if (presetExcludedIndices.has(gen.code))
      continue;
    if (isRangeGenerator(type)) {
      result[type] = gen.value;
    } else {
      const key = type;
      result[key] = gen.value;
    }
  }
  return result;
}
function createInstrumentGeneratorObject(generators) {
  const result = {};
  for (let i = 0; i < generators.length; i++) {
    const gen = generators[i];
    const type = gen.type;
    if (type === void 0)
      continue;
    if (isRangeGenerator(type)) {
      result[type] = gen.value;
    } else {
      const key = type;
      result[key] = gen.value;
    }
  }
  for (let i = 0; i < fixedGenerators.length; i++) {
    const [src, dst] = fixedGenerators[i];
    const v = result[src];
    if (v === void 0)
      continue;
    result[dst] = new RangeValue(v, v);
  }
  return result;
}
var int16min = -32768;
var int16max = 32767;
var uint16min = 0;
var uint16max = 65535;
var DefaultInstrumentZone = {
  startAddrsOffset: new BoundedValue(0, 0, int16max),
  endAddrsOffset: new BoundedValue(int16min, 0, 0),
  startloopAddrsOffset: new BoundedValue(int16min, 0, int16max),
  endloopAddrsOffset: new BoundedValue(int16min, 0, int16max),
  startAddrsCoarseOffset: new BoundedValue(0, 0, int16max),
  modLfoToPitch: new BoundedValue(-12e3, 0, 12e3),
  vibLfoToPitch: new BoundedValue(-12e3, 0, 12e3),
  modEnvToPitch: new BoundedValue(-12e3, 0, 12e3),
  initialFilterFc: new BoundedValue(1500, 13500, 13500),
  initialFilterQ: new BoundedValue(0, 0, 960),
  modLfoToFilterFc: new BoundedValue(-12e3, 0, 12e3),
  modEnvToFilterFc: new BoundedValue(-12e3, 0, 12e3),
  endAddrsCoarseOffset: new BoundedValue(int16min, 0, 0),
  modLfoToVolume: new BoundedValue(-960, 0, 960),
  chorusEffectsSend: new BoundedValue(0, 0, 1e3),
  reverbEffectsSend: new BoundedValue(0, 0, 1e3),
  pan: new BoundedValue(-500, 0, 500),
  delayModLFO: new BoundedValue(-12e3, -12e3, 5e3),
  freqModLFO: new BoundedValue(-16e3, 0, 4500),
  delayVibLFO: new BoundedValue(-12e3, -12e3, 5e3),
  freqVibLFO: new BoundedValue(-16e3, 0, 4500),
  delayModEnv: new BoundedValue(-12e3, -12e3, 5e3),
  attackModEnv: new BoundedValue(-12e3, -12e3, 8e3),
  holdModEnv: new BoundedValue(-12e3, -12e3, 5e3),
  decayModEnv: new BoundedValue(-12e3, -12e3, 8e3),
  sustainModEnv: new BoundedValue(0, 0, 1e3),
  releaseModEnv: new BoundedValue(-12e3, -12e3, 8e3),
  keynumToModEnvHold: new BoundedValue(-1200, 0, 1200),
  keynumToModEnvDecay: new BoundedValue(-1200, 0, 1200),
  delayVolEnv: new BoundedValue(-12e3, -12e3, 5e3),
  attackVolEnv: new BoundedValue(-12e3, -12e3, 8e3),
  holdVolEnv: new BoundedValue(-12e3, -12e3, 5e3),
  decayVolEnv: new BoundedValue(-12e3, -12e3, 8e3),
  sustainVolEnv: new BoundedValue(0, 0, 1440),
  releaseVolEnv: new BoundedValue(-12e3, -12e3, 8e3),
  keynumToVolEnvHold: new BoundedValue(-1200, 0, 1200),
  keynumToVolEnvDecay: new BoundedValue(-1200, 0, 1200),
  instrument: new BoundedValue(uint16min, uint16max, uint16max),
  keyRange: new RangeValue(0, 127),
  velRange: new RangeValue(0, 127),
  startloopAddrsCoarseOffset: new BoundedValue(int16min, 0, int16max),
  keynum: new BoundedValue(-1, -1, 127),
  velocity: new BoundedValue(-1, -1, 127),
  initialAttenuation: new BoundedValue(0, 0, 1440),
  endloopAddrsCoarseOffset: new BoundedValue(int16min, 0, int16max),
  coarseTune: new BoundedValue(-120, 0, 120),
  fineTune: new BoundedValue(-99, 0, 99),
  sampleID: new BoundedValue(uint16min, uint16max, uint16max),
  sampleModes: new BoundedValue(0, 0, 3),
  scaleTuning: new BoundedValue(0, 100, 100),
  exclusiveClass: new BoundedValue(0, 0, 127),
  overridingRootKey: new BoundedValue(-1, -1, 127)
};

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.3/node_modules/@marmooo/soundfont-parser/esm/Voice.js
function timecentToSecond(value) {
  return Math.pow(2, value / 1200);
}
var Voice = class {
  constructor(key, generators, modulators, sample, sampleHeader) {
    Object.defineProperty(this, "key", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: key
    });
    Object.defineProperty(this, "generators", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: generators
    });
    Object.defineProperty(this, "modulators", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: modulators
    });
    Object.defineProperty(this, "sample", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: sample
    });
    Object.defineProperty(this, "sampleHeader", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: sampleHeader
    });
    Object.defineProperty(this, "controllerToDestinations", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: /* @__PURE__ */ new Map()
    });
    Object.defineProperty(this, "destinationToModulators", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: /* @__PURE__ */ new Map()
    });
    Object.defineProperty(this, "voiceHandlers", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        // startAddrsOffset
        // endAddrsOffset
        // startloopAddrsOffset
        // endloopAddrsOffset
        modLfoToPitch: (params, generators2) => {
          params.modLfoToPitch = this.clamp("modLfoToPitch", generators2);
        },
        vibLfoToPitch: (params, generators2) => {
          params.vibLfoToPitch = this.clamp("vibLfoToPitch", generators2);
        },
        modEnvToPitch: (params, generators2) => {
          params.modEnvToPitch = this.clamp("modEnvToPitch", generators2);
        },
        initialFilterFc: (params, generators2) => {
          params.initialFilterFc = this.clamp("initialFilterFc", generators2);
        },
        initialFilterQ: (params, generators2) => {
          params.initialFilterQ = this.clamp("initialFilterQ", generators2);
        },
        modLfoToFilterFc: (params, generators2) => {
          params.modLfoToFilterFc = this.clamp("modLfoToFilterFc", generators2);
        },
        modEnvToFilterFc: (params, generators2) => {
          params.modEnvToFilterFc = this.clamp("modEnvToFilterFc", generators2);
        },
        // endAddrsCoarseOffset
        modLfoToVolume: (params, generators2) => {
          params.modLfoToVolume = this.clamp("modLfoToVolume", generators2);
        },
        chorusEffectsSend: (params, generators2) => {
          params.chorusEffectsSend = this.clamp("chorusEffectsSend", generators2) / 1e3;
        },
        reverbEffectsSend: (params, generators2) => {
          params.reverbEffectsSend = this.clamp("reverbEffectsSend", generators2) / 1e3;
        },
        pan: (params, generators2) => {
          params.pan = this.clamp("pan", generators2) / 1e3;
        },
        delayModLFO: (params, generators2) => {
          params.delayModLFO = timecentToSecond(this.clamp("delayModLFO", generators2));
        },
        freqModLFO: (params, generators2) => {
          params.freqModLFO = this.clamp("freqModLFO", generators2);
        },
        delayVibLFO: (params, generators2) => {
          params.delayVibLFO = timecentToSecond(this.clamp("delayVibLFO", generators2));
        },
        freqVibLFO: (params, generators2) => {
          params.freqVibLFO = this.clamp("freqVibLFO", generators2);
        },
        delayModEnv: (params, generators2) => {
          params.modDelay = timecentToSecond(this.clamp("delayModEnv", generators2));
        },
        attackModEnv: (params, generators2) => {
          params.modAttack = timecentToSecond(this.clamp("attackModEnv", generators2));
        },
        holdModEnv: (params, generators2) => {
          const holdModEnv = this.clamp("holdModEnv", generators2);
          const keynumToModEnvHold = this.clamp("keynumToModEnvHold", generators2);
          params.modHold = this.getModHold(holdModEnv, keynumToModEnvHold);
        },
        decayModEnv: (params, generators2) => {
          const decayModEnv = this.clamp("decayModEnv", generators2);
          const keynumToModEnvDecay = this.clamp("keynumToModEnvDecay", generators2);
          params.modDecay = this.getModDecay(decayModEnv, keynumToModEnvDecay);
        },
        sustainModEnv: (params, generators2) => {
          params.modSustain = this.clamp("sustainModEnv", generators2) / 1e3;
        },
        releaseModEnv: (params, generators2) => {
          params.modRelease = timecentToSecond(this.clamp("releaseModEnv", generators2));
        },
        keynumToModEnvHold: (params, generators2) => {
          const holdModEnv = this.clamp("holdModEnv", generators2);
          const keynumToModEnvHold = this.clamp("keynumToModEnvHold", generators2);
          params.modHold = this.getModHold(holdModEnv, keynumToModEnvHold);
        },
        keynumToModEnvDecay: (params, generators2) => {
          const decayModEnv = this.clamp("decayModEnv", generators2);
          const keynumToModEnvDecay = this.clamp("keynumToModEnvDecay", generators2);
          params.modDecay = this.getModDecay(decayModEnv, keynumToModEnvDecay);
        },
        delayVolEnv: (params, generators2) => {
          params.volDelay = timecentToSecond(this.clamp("delayVolEnv", generators2));
        },
        attackVolEnv: (params, generators2) => {
          params.volAttack = timecentToSecond(this.clamp("attackVolEnv", generators2));
        },
        holdVolEnv: (params, generators2) => {
          const holdVolEnv = this.clamp("holdVolEnv", generators2);
          const keynumToVolEnvHold = this.clamp("keynumToVolEnvHold", generators2);
          params.volHold = this.getVolHold(holdVolEnv, keynumToVolEnvHold);
        },
        decayVolEnv: (params, generators2) => {
          const decayVolEnv = this.clamp("decayVolEnv", generators2);
          const keynumToVolEnvDecay = this.clamp("keynumToVolEnvDecay", generators2);
          params.volDecay = this.getVolDecay(decayVolEnv, keynumToVolEnvDecay);
        },
        sustainVolEnv: (params, generators2) => {
          params.volSustain = this.clamp("sustainVolEnv", generators2) / 1e3;
        },
        releaseVolEnv: (params, generators2) => {
          params.volRelease = timecentToSecond(this.clamp("releaseVolEnv", generators2));
        },
        keynumToVolEnvHold: (params, generators2) => {
          const holdVolEnv = this.clamp("holdVolEnv", generators2);
          const keynumToVolEnvHold = this.clamp("keynumToVolEnvHold", generators2);
          params.modHold = this.getVolHold(holdVolEnv, keynumToVolEnvHold);
        },
        keynumToVolEnvDecay: (params, generators2) => {
          const decayVolEnv = this.clamp("decayVolEnv", generators2);
          const keynumToVolEnvDecay = this.clamp("keynumToVolEnvDecay", generators2);
          params.modDecay = this.getVolDecay(decayVolEnv, keynumToVolEnvDecay);
        },
        // instrument
        // keyRange
        // velRange
        // startloopAddrsCoarseOffset
        // keynum
        // velocity
        initialAttenuation: (params, generators2) => {
          params.initialAttenuation = this.clamp("initialAttenuation", generators2);
        },
        // endloopAddrsCoarseOffset
        coarseTune: (params, generators2) => {
          params.playbackRate = this.getPlaybackRate(generators2);
        },
        fineTune: (params, generators2) => {
          params.playbackRate = this.getPlaybackRate(generators2);
        },
        // sampleID
        scaleTuning: (params, generators2) => {
          params.playbackRate = this.getPlaybackRate(generators2);
        }
        // exclusiveClass
        // overridingRootKey
      }
    });
    this.setControllerToDestinations();
    this.setDestinationToModulators();
  }
  setControllerToDestinations() {
    for (let i = 0; i < this.modulators.length; i++) {
      const modulator = this.modulators[i];
      const controllerType = modulator.sourceOper.controllerType;
      const destinationOper = modulator.destinationOper;
      const list = this.controllerToDestinations.get(controllerType);
      if (list) {
        list.add(modulator.destinationOper);
      } else {
        this.controllerToDestinations.set(controllerType, /* @__PURE__ */ new Set([destinationOper]));
      }
    }
  }
  setDestinationToModulators() {
    for (let i = 0; i < this.modulators.length; i++) {
      const modulator = this.modulators[i];
      const generatorKey = modulator.destinationOper;
      const list = this.destinationToModulators.get(generatorKey);
      if (list) {
        list.push(modulator);
      } else {
        this.destinationToModulators.set(generatorKey, [modulator]);
      }
    }
  }
  getModHold(holdModEnv, keynumToModEnvHold) {
    return timecentToSecond(holdModEnv + (this.key - 60) * keynumToModEnvHold);
  }
  getModDecay(decayModEnv, keynumToModEnvDecay) {
    return timecentToSecond(decayModEnv + (this.key - 60) * keynumToModEnvDecay);
  }
  getVolHold(holdVolEnv, keynumToVolEnvHold) {
    return timecentToSecond(holdVolEnv + (this.key - 60) * keynumToVolEnvHold);
  }
  getVolDecay(decayVolEnv, keynumToVolEnvDecay) {
    return timecentToSecond(decayVolEnv + (this.key - 60) * keynumToVolEnvDecay);
  }
  getPlaybackRate(generators) {
    const coarseTune = this.clamp("coarseTune", generators);
    const fineTune = this.clamp("fineTune", generators) / 100;
    const overridingRootKey = this.clamp("overridingRootKey", generators);
    const scaleTuning = this.clamp("scaleTuning", generators) / 100;
    const tune = coarseTune + fineTune;
    const rootKey = overridingRootKey === -1 ? this.sampleHeader.originalPitch : overridingRootKey;
    const basePitch = tune + this.sampleHeader.pitchCorrection / 100 - rootKey;
    return Math.pow(Math.pow(2, 1 / 12), (this.key + basePitch) * scaleTuning);
  }
  transformParams(controllerType, controllerState) {
    const params = {};
    const destinations = this.controllerToDestinations.get(controllerType);
    if (!destinations)
      return params;
    for (const destinationOper of destinations) {
      const generatorKey = GeneratorKeys[destinationOper];
      if (!generatorKey)
        continue;
      if (!isValueGenerator(generatorKey))
        continue;
      const modulators = this.destinationToModulators.get(destinationOper);
      if (!modulators)
        continue;
      params[generatorKey] = this.generators[generatorKey];
      for (const modulator of modulators) {
        const source = modulator.sourceOper;
        const primary = source.map(controllerState[source.controllerType]);
        let secondary = 1;
        const amountSource = modulator.amountSourceOper;
        if (!(amountSource.cc === 0 && amountSource.index === 0)) {
          const amount = controllerState[amountSource.controllerType];
          secondary = amountSource.map(amount);
        }
        const summingValue = modulator.transform(primary * secondary);
        if (Number.isNaN(summingValue))
          continue;
        params[generatorKey] += summingValue;
      }
    }
    return params;
  }
  transformAllParams(controllerState) {
    const params = structuredClone(this.generators);
    for (const modulator of this.modulators) {
      const controllerType = modulator.sourceOper.controllerType;
      const controllerValue = controllerState[controllerType];
      if (!controllerValue)
        continue;
      const generatorKey = GeneratorKeys[modulator.destinationOper];
      if (!generatorKey)
        continue;
      if (!isValueGenerator(generatorKey))
        continue;
      const source = modulator.sourceOper;
      const primary = source.map(controllerValue);
      let secondary = 1;
      const amountSource = modulator.amountSourceOper;
      if (!(amountSource.cc === 0 && amountSource.index === 0)) {
        const amount = controllerState[amountSource.controllerType];
        secondary = amountSource.map(amount);
      }
      const summingValue = modulator.transform(primary * secondary);
      if (Number.isNaN(summingValue))
        continue;
      params[generatorKey] += summingValue;
    }
    return params;
  }
  clamp(key, generators) {
    return DefaultInstrumentZone[key].clamp(generators[key]);
  }
  getParams(controllerType, controllerState) {
    const params = {};
    const generators = structuredClone(this.generators);
    const updatedParams = this.transformParams(controllerType, controllerState);
    const updatedKeys = Object.keys(updatedParams);
    for (const updatedKey of updatedKeys) {
      generators[updatedKey] = updatedParams[updatedKey];
    }
    for (const updatedKey of updatedKeys) {
      this.voiceHandlers[updatedKey](params, generators);
    }
    return params;
  }
  getAllParams(controllerValues) {
    const params = {
      start: this.generators.startAddrsCoarseOffset * 32768 + this.generators.startAddrsOffset,
      end: this.generators.endAddrsCoarseOffset * 32768 + this.generators.endAddrsOffset,
      loopStart: this.sampleHeader.loopStart + this.generators.startloopAddrsCoarseOffset * 32768 + this.generators.startloopAddrsOffset,
      loopEnd: this.sampleHeader.loopEnd + this.generators.endloopAddrsCoarseOffset * 32768 + this.generators.endloopAddrsOffset,
      instrument: this.generators.instrument,
      sampleID: this.generators.sampleID,
      sample: this.sample,
      sampleRate: this.sampleHeader.sampleRate,
      sampleName: this.sampleHeader.sampleName,
      sampleModes: this.generators.sampleModes,
      exclusiveClass: this.clamp("exclusiveClass", this.generators)
    };
    const generators = this.transformAllParams(controllerValues);
    for (let i = 0; i < ValueGeneratorKeys.length; i++) {
      const generatorKey = ValueGeneratorKeys[i];
      this.voiceHandlers[generatorKey](params, generators);
    }
    return params;
  }
};

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.3/node_modules/@marmooo/soundfont-parser/esm/DefaultModulators.js
var DefaultModulators = [
  new ModulatorList(ModulatorSource.parse(1282), 48, 960, ModulatorSource.parse(0), 0),
  new ModulatorList(ModulatorSource.parse(258), 8, -2400, ModulatorSource.parse(0), 0),
  new ModulatorList(ModulatorSource.parse(13), 6, 50, ModulatorSource.parse(0), 0),
  new ModulatorList(ModulatorSource.parse(129), 6, 50, ModulatorSource.parse(0), 0),
  new ModulatorList(ModulatorSource.parse(1415), 48, 960, ModulatorSource.parse(0), 0),
  // specification is wrong
  new ModulatorList(ModulatorSource.parse(650), 48, 1, ModulatorSource.parse(0), 0),
  new ModulatorList(ModulatorSource.parse(1419), 48, 960, ModulatorSource.parse(0), 0),
  new ModulatorList(ModulatorSource.parse(219), 16, 0.2, ModulatorSource.parse(0), 0),
  new ModulatorList(ModulatorSource.parse(221), 15, 0.2, ModulatorSource.parse(0), 0),
  new ModulatorList(ModulatorSource.parse(526), 51, 127, ModulatorSource.parse(16), 0)
];

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.3/node_modules/@marmooo/soundfont-parser/esm/SoundFont.js
var InstrumentZone = class {
  constructor(generators, modulators) {
    Object.defineProperty(this, "generators", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: generators
    });
    Object.defineProperty(this, "modulators", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: modulators
    });
  }
};
var PresetZone = class {
  constructor(generators, modulators) {
    Object.defineProperty(this, "generators", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: generators
    });
    Object.defineProperty(this, "modulators", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: modulators
    });
  }
};
var SoundFont = class {
  constructor(parsed) {
    Object.defineProperty(this, "parsed", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: parsed
    });
  }
  getGeneratorParams(generators, zone, from, to) {
    const result = new Array(to - from);
    for (let i = from; i < to; i++) {
      const segmentFrom = zone[i].generatorIndex;
      const segmentTo = zone[i + 1].generatorIndex;
      result[i - from] = generators.slice(segmentFrom, segmentTo);
    }
    return result;
  }
  getPresetGenerators(presetHeaderIndex) {
    const presetHeader = this.parsed.presetHeaders[presetHeaderIndex];
    const nextPresetHeader = this.parsed.presetHeaders[presetHeaderIndex + 1];
    const nextPresetBagIndex = nextPresetHeader ? nextPresetHeader.presetBagIndex : this.parsed.presetZone.length - 1;
    return this.getGeneratorParams(this.parsed.presetGenerators, this.parsed.presetZone, presetHeader.presetBagIndex, nextPresetBagIndex);
  }
  getInstrumentGenerators(instrumentID) {
    const instrument = this.parsed.instruments[instrumentID];
    const nextInstrument = this.parsed.instruments[instrumentID + 1];
    const nextInstrumentBagIndex = nextInstrument ? nextInstrument.instrumentBagIndex : this.parsed.instrumentZone.length - 1;
    return this.getGeneratorParams(this.parsed.instrumentGenerators, this.parsed.instrumentZone, instrument.instrumentBagIndex, nextInstrumentBagIndex);
  }
  getModulators(modulators, zone, from, to) {
    const result = new Array(to - from);
    for (let i = from; i < to; i++) {
      const segmentFrom = zone[i].modulatorIndex;
      const segmentTo = zone[i + 1].modulatorIndex;
      result[i - from] = modulators.slice(segmentFrom, segmentTo);
    }
    return result;
  }
  getPresetModulators(presetHeaderIndex) {
    const presetHeader = this.parsed.presetHeaders[presetHeaderIndex];
    const nextPresetHeader = this.parsed.presetHeaders[presetHeaderIndex + 1];
    const nextPresetBagIndex = nextPresetHeader ? nextPresetHeader.presetBagIndex : this.parsed.presetZone.length - 1;
    return this.getModulators(this.parsed.presetModulators, this.parsed.presetZone, presetHeader.presetBagIndex, nextPresetBagIndex);
  }
  getInstrumentModulators(instrumentID) {
    const instrument = this.parsed.instruments[instrumentID];
    const nextInstrument = this.parsed.instruments[instrumentID + 1];
    const nextInstrumentBagIndex = nextInstrument ? nextInstrument.instrumentBagIndex : this.parsed.instrumentZone.length - 1;
    return this.getModulators(this.parsed.instrumentModulators, this.parsed.instrumentZone, instrument.instrumentBagIndex, nextInstrumentBagIndex);
  }
  findInstrumentZone(instrumentID, key, velocity) {
    const instrumentGenerators = this.getInstrumentGenerators(instrumentID);
    const instrumentModulators = this.getInstrumentModulators(instrumentID);
    let globalGenerators;
    let globalModulators = [];
    for (let i = 0; i < instrumentGenerators.length; i++) {
      const generators = createInstrumentGeneratorObject(instrumentGenerators[i]);
      if (generators.sampleID === void 0) {
        globalGenerators = generators;
        globalModulators = instrumentModulators[i];
        continue;
      }
      if (generators.keyRange && !generators.keyRange.in(key))
        continue;
      if (generators.velRange && !generators.velRange.in(velocity))
        continue;
      if (globalGenerators) {
        const gen = { ...globalGenerators, ...generators };
        const mod = [...globalModulators, ...instrumentModulators[i]];
        return new InstrumentZone(gen, mod);
      } else {
        return new InstrumentZone(generators, instrumentModulators[i]);
      }
    }
    return;
  }
  findInstrument(presetHeaderIndex, key, velocity) {
    const presetGenerators = this.getPresetGenerators(presetHeaderIndex);
    const presetModulators = this.getPresetModulators(presetHeaderIndex);
    let globalGenerators;
    let globalModulators = [];
    for (let i = 0; i < presetGenerators.length; i++) {
      const generators = createPresetGeneratorObject(presetGenerators[i]);
      if (generators.instrument === void 0) {
        globalGenerators = generators;
        globalModulators = presetModulators[i];
        continue;
      }
      if (generators.keyRange && !generators.keyRange.in(key))
        continue;
      if (generators.velRange && !generators.velRange.in(velocity))
        continue;
      const instrumentZone = this.findInstrumentZone(generators.instrument, key, velocity);
      if (instrumentZone) {
        if (globalGenerators) {
          const gen = { ...globalGenerators, ...generators };
          const mod = [...globalModulators, ...presetModulators[i]];
          const presetZone = new PresetZone(gen, mod);
          return this.createVoice(key, presetZone, instrumentZone);
        } else {
          const presetZone = new PresetZone(generators, presetModulators[i]);
          return this.createVoice(key, presetZone, instrumentZone);
        }
      }
    }
    return null;
  }
  createVoice(key, presetZone, instrumentZone) {
    const instrumentGenerators = convertToInstrumentGeneratorParams(DefaultInstrumentZone);
    Object.assign(instrumentGenerators, instrumentZone.generators);
    const keys = Object.keys(presetZone.generators);
    for (let i = 0; i < keys.length; i++) {
      const key2 = keys[i];
      if (isRangeGenerator(key2))
        continue;
      instrumentGenerators[key2] += presetZone.generators[key2];
    }
    const modulators = [
      ...DefaultModulators,
      ...presetZone.modulators,
      ...instrumentZone.modulators
    ];
    const sampleID = instrumentGenerators.sampleID;
    const sample = this.parsed.samples[sampleID];
    const sampleHeader = this.parsed.sampleHeaders[sampleID];
    return new Voice(key, instrumentGenerators, modulators, sample, sampleHeader);
  }
  getVoice(bankNumber, instrumentNumber, key, velocity) {
    const presetHeaderIndex = this.parsed.presetHeaders.findIndex((p) => p.preset === instrumentNumber && p.bank === bankNumber);
    if (presetHeaderIndex < 0) {
      console.warn("preset not found: bank=%s instrument=%s", bankNumber, instrumentNumber);
      return null;
    }
    const instrument = this.findInstrument(presetHeaderIndex, key, velocity);
    if (!instrument) {
      console.warn("instrument not found: bank=%s instrument=%s", bankNumber, instrumentNumber);
      return null;
    }
    return instrument;
  }
  // presetNames[bankNumber][presetNumber] = presetName
  getPresetNames() {
    const bank = {};
    const presetHeaders = this.parsed.presetHeaders;
    for (let i = 0; i < presetHeaders.length; i++) {
      const preset = presetHeaders[i];
      if (!bank[preset.bank]) {
        bank[preset.bank] = {};
      }
      bank[preset.bank][preset.preset] = preset.presetName;
    }
    return bank;
  }
};

// src/midy.js
var Note = class {
  index = -1;
  ending = false;
  bufferSource;
  filterNode;
  filterDepth;
  volumeEnvelopeNode;
  volumeDepth;
  modulationLFO;
  modulationDepth;
  vibratoLFO;
  vibratoDepth;
  reverbSend;
  chorusSend;
  portamentoNoteNumber = -1;
  pressure = 0;
  constructor(noteNumber, velocity, startTime, voice, voiceParams) {
    this.noteNumber = noteNumber;
    this.velocity = velocity;
    this.startTime = startTime;
    this.voice = voice;
    this.voiceParams = voiceParams;
  }
};
var drumExclusiveClassesByKit = new Array(57);
var drumExclusiveClassCount = 10;
var standardSet = new Uint8Array(128);
standardSet[42] = 1;
standardSet[44] = 1;
standardSet[46] = 1;
standardSet[71] = 2;
standardSet[72] = 2;
standardSet[73] = 3;
standardSet[74] = 3;
standardSet[78] = 4;
standardSet[79] = 4;
standardSet[80] = 5;
standardSet[81] = 5;
standardSet[29] = 6;
standardSet[30] = 6;
standardSet[86] = 7;
standardSet[87] = 7;
drumExclusiveClassesByKit[0] = standardSet;
var analogSet = new Uint8Array(128);
analogSet[42] = 8;
analogSet[44] = 8;
analogSet[46] = 8;
drumExclusiveClassesByKit[25] = analogSet;
var orchestraSet = new Uint8Array(128);
orchestraSet[27] = 9;
orchestraSet[28] = 9;
orchestraSet[29] = 9;
drumExclusiveClassesByKit[48] = orchestraSet;
var sfxSet = new Uint8Array(128);
sfxSet[41] = 10;
sfxSet[42] = 10;
drumExclusiveClassesByKit[56] = sfxSet;
var defaultControllerState = {
  noteOnVelocity: { type: 2, defaultValue: 0 },
  noteOnKeyNumber: { type: 3, defaultValue: 0 },
  polyphonicKeyPressure: { type: 10, defaultValue: 0 },
  channelPressure: { type: 13, defaultValue: 0 },
  pitchWheel: { type: 14, defaultValue: 8192 / 16383 },
  pitchWheelSensitivity: { type: 16, defaultValue: 2 / 128 },
  link: { type: 127, defaultValue: 0 },
  // bankMSB: { type: 128 + 0, defaultValue: 121, },
  modulationDepth: { type: 128 + 1, defaultValue: 0 },
  portamentoTime: { type: 128 + 5, defaultValue: 0 },
  // dataMSB: { type: 128 + 6, defaultValue: 0, },
  volume: { type: 128 + 7, defaultValue: 100 / 127 },
  pan: { type: 128 + 10, defaultValue: 64 / 127 },
  expression: { type: 128 + 11, defaultValue: 1 },
  // bankLSB: { type: 128 + 32, defaultValue: 0, },
  // dataLSB: { type: 128 + 38, defaultValue: 0, },
  sustainPedal: { type: 128 + 64, defaultValue: 0 },
  portamento: { type: 128 + 65, defaultValue: 0 },
  sostenutoPedal: { type: 128 + 66, defaultValue: 0 },
  softPedal: { type: 128 + 67, defaultValue: 0 },
  filterResonance: { type: 128 + 71, defaultValue: 64 / 127 },
  releaseTime: { type: 128 + 72, defaultValue: 64 / 127 },
  attackTime: { type: 128 + 73, defaultValue: 64 / 127 },
  brightness: { type: 128 + 74, defaultValue: 64 / 127 },
  decayTime: { type: 128 + 75, defaultValue: 64 / 127 },
  vibratoRate: { type: 128 + 76, defaultValue: 64 / 127 },
  vibratoDepth: { type: 128 + 77, defaultValue: 64 / 127 },
  vibratoDelay: { type: 128 + 78, defaultValue: 64 / 127 },
  reverbSendLevel: { type: 128 + 91, defaultValue: 0 },
  chorusSendLevel: { type: 128 + 93, defaultValue: 0 }
  // dataIncrement: { type: 128 + 96, defaultValue: 0 },
  // dataDecrement: { type: 128 + 97, defaultValue: 0 },
  // rpnLSB: { type: 128 + 100, defaultValue: 127 },
  // rpnMSB: { type: 128 + 101, defaultValue: 127 },
  // allSoundOff: { type: 128 + 120, defaultValue: 0 },
  // resetAllControllers: { type: 128 + 121, defaultValue: 0 },
  // allNotesOff: { type: 128 + 123, defaultValue: 0 },
  // omniOff: { type: 128 + 124, defaultValue: 0 },
  // omniOn: { type: 128 + 125, defaultValue: 0 },
  // monoOn: { type: 128 + 126, defaultValue: 0 },
  // polyOn: { type: 128 + 127, defaultValue: 0 },
};
var ControllerState = class {
  array = new Float32Array(256);
  constructor() {
    const entries = Object.entries(defaultControllerState);
    for (const [name, { type, defaultValue }] of entries) {
      this.array[type] = defaultValue;
      Object.defineProperty(this, name, {
        get: () => this.array[type],
        set: (value) => this.array[type] = value,
        enumerable: true,
        configurable: true
      });
    }
  }
};
var volumeEnvelopeKeys = [
  "volDelay",
  "volAttack",
  "volHold",
  "volDecay",
  "volSustain",
  "volRelease",
  "initialAttenuation"
];
var volumeEnvelopeKeySet = new Set(volumeEnvelopeKeys);
var filterEnvelopeKeys = [
  "modEnvToPitch",
  "initialFilterFc",
  "modEnvToFilterFc",
  "modDelay",
  "modAttack",
  "modHold",
  "modDecay",
  "modSustain"
];
var filterEnvelopeKeySet = new Set(filterEnvelopeKeys);
var pitchEnvelopeKeys = [
  "modEnvToPitch",
  "modDelay",
  "modAttack",
  "modHold",
  "modDecay",
  "modSustain",
  "playbackRate"
];
var pitchEnvelopeKeySet = new Set(pitchEnvelopeKeys);
var Midy = class {
  mode = "GM2";
  masterFineTuning = 0;
  // cent
  masterCoarseTuning = 0;
  // cent
  reverb = {
    algorithm: "SchroederReverb",
    time: this.getReverbTime(64),
    feedback: 0.8
  };
  chorus = {
    modRate: this.getChorusModRate(3),
    modDepth: this.getChorusModDepth(19),
    feedback: this.getChorusFeedback(8),
    sendToReverb: this.getChorusSendToReverb(0),
    delayTimes: this.generateDistributedArray(0.02, 2, 0.5)
  };
  numChannels = 16;
  ticksPerBeat = 120;
  totalTime = 0;
  noteCheckInterval = 0.1;
  lookAhead = 1;
  startDelay = 0.1;
  startTime = 0;
  resumeTime = 0;
  soundFonts = [];
  soundFontTable = this.initSoundFontTable();
  voiceCounter = /* @__PURE__ */ new Map();
  voiceCache = /* @__PURE__ */ new Map();
  isPlaying = false;
  isPausing = false;
  isPaused = false;
  isStopping = false;
  isSeeking = false;
  playPromise;
  timeline = [];
  notePromises = [];
  instruments = /* @__PURE__ */ new Set();
  exclusiveClassNotes = new Array(128);
  drumExclusiveClassNotes = new Array(
    this.numChannels * drumExclusiveClassCount
  );
  static channelSettings = {
    scheduleIndex: 0,
    detune: 0,
    programNumber: 0,
    bank: 121 * 128,
    bankMSB: 121,
    bankLSB: 0,
    dataMSB: 0,
    dataLSB: 0,
    rpnMSB: 127,
    rpnLSB: 127,
    mono: false,
    // CC#124, CC#125
    modulationDepthRange: 50,
    // cent
    fineTuning: 0,
    // cent
    coarseTuning: 0
    // cent
  };
  constructor(audioContext) {
    this.audioContext = audioContext;
    this.masterVolume = new GainNode(audioContext);
    this.scheduler = new GainNode(audioContext, { gain: 0 });
    this.schedulerBuffer = new AudioBuffer({
      length: 1,
      sampleRate: audioContext.sampleRate
    });
    this.voiceParamsHandlers = this.createVoiceParamsHandlers();
    this.controlChangeHandlers = this.createControlChangeHandlers();
    this.channels = this.createChannels(audioContext);
    this.reverbEffect = this.createReverbEffect(audioContext);
    this.chorusEffect = this.createChorusEffect(audioContext);
    this.chorusEffect.output.connect(this.masterVolume);
    this.reverbEffect.output.connect(this.masterVolume);
    this.masterVolume.connect(audioContext.destination);
    this.scheduler.connect(audioContext.destination);
    this.GM2SystemOn();
  }
  initSoundFontTable() {
    const table = new Array(128);
    for (let i = 0; i < 128; i++) {
      table[i] = /* @__PURE__ */ new Map();
    }
    return table;
  }
  addSoundFont(soundFont) {
    const index = this.soundFonts.length;
    this.soundFonts.push(soundFont);
    const presetHeaders = soundFont.parsed.presetHeaders;
    for (let i = 0; i < presetHeaders.length; i++) {
      const presetHeader = presetHeaders[i];
      const banks = this.soundFontTable[presetHeader.preset];
      banks.set(presetHeader.bank, index);
    }
  }
  async toUint8Array(input) {
    let uint8Array;
    if (typeof input === "string") {
      const response = await fetch(input);
      const arrayBuffer = await response.arrayBuffer();
      uint8Array = new Uint8Array(arrayBuffer);
    } else if (input instanceof Uint8Array) {
      uint8Array = input;
    } else {
      throw new TypeError("input must be a URL string or Uint8Array");
    }
    return uint8Array;
  }
  async loadSoundFont(input) {
    this.voiceCounter.clear();
    if (Array.isArray(input)) {
      const promises = new Array(input.length);
      for (let i = 0; i < input.length; i++) {
        promises[i] = this.toUint8Array(input[i]);
      }
      const uint8Arrays = await Promise.all(promises);
      for (let i = 0; i < uint8Arrays.length; i++) {
        const parsed = parse(uint8Arrays[i]);
        const soundFont = new SoundFont(parsed);
        this.addSoundFont(soundFont);
      }
    } else {
      const uint8Array = await this.toUint8Array(input);
      const parsed = parse(uint8Array);
      const soundFont = new SoundFont(parsed);
      this.addSoundFont(soundFont);
    }
  }
  async loadMIDI(input) {
    this.voiceCounter.clear();
    const uint8Array = await this.toUint8Array(input);
    const midi = (0, import_midi_file.parseMidi)(uint8Array);
    this.ticksPerBeat = midi.header.ticksPerBeat;
    const midiData = this.extractMidiData(midi);
    this.instruments = midiData.instruments;
    this.timeline = midiData.timeline;
    this.totalTime = this.calcTotalTime();
  }
  cacheVoiceIds() {
    const timeline = this.timeline;
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      switch (event.type) {
        case "noteOn": {
          const audioBufferId = this.getVoiceId(
            this.channels[event.channel],
            event.noteNumber,
            event.velocity
          );
          this.voiceCounter.set(
            audioBufferId,
            (this.voiceCounter.get(audioBufferId) ?? 0) + 1
          );
          break;
        }
        case "controller":
          if (event.controllerType === 0) {
            this.setBankMSB(event.channel, event.value);
          } else if (event.controllerType === 32) {
            this.setBankLSB(event.channel, event.value);
          }
          break;
        case "programChange":
          this.setProgramChange(
            event.channel,
            event.programNumber,
            event.startTime
          );
      }
    }
    for (const [audioBufferId, count] of this.voiceCounter) {
      if (count === 1) this.voiceCounter.delete(audioBufferId);
    }
    this.GM2SystemOn();
  }
  getVoiceId(channel2, noteNumber, velocity) {
    const bankNumber = this.calcBank(channel2);
    const soundFontIndex = this.soundFontTable[channel2.programNumber].get(bankNumber);
    if (soundFontIndex === void 0) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const voice = soundFont.getVoice(
      bankNumber,
      channel2.programNumber,
      noteNumber,
      velocity
    );
    const { instrument, sampleID } = voice.generators;
    return soundFontIndex * 2 ** 32 + (instrument << 16) + sampleID;
  }
  createChannelAudioNodes(audioContext) {
    const { gainLeft, gainRight } = this.panToGain(
      defaultControllerState.pan.defaultValue
    );
    const gainL = new GainNode(audioContext, { gain: gainLeft });
    const gainR = new GainNode(audioContext, { gain: gainRight });
    const merger = new ChannelMergerNode(audioContext, { numberOfInputs: 2 });
    gainL.connect(merger, 0, 0);
    gainR.connect(merger, 0, 1);
    merger.connect(this.masterVolume);
    return {
      gainL,
      gainR,
      merger
    };
  }
  resetChannelTable(channel2) {
    channel2.controlTable.fill(-1);
    channel2.scaleOctaveTuningTable.fill(0);
    channel2.channelPressureTable.fill(-1);
    channel2.polyphonicKeyPressureTable.fill(-1);
    channel2.keyBasedTable.fill(-1);
  }
  createChannels(audioContext) {
    const channels = Array.from({ length: this.numChannels }, () => {
      return {
        currentBufferSource: null,
        isDrum: false,
        state: new ControllerState(),
        ...this.constructor.channelSettings,
        ...this.createChannelAudioNodes(audioContext),
        scheduledNotes: [],
        sustainNotes: [],
        sostenutoNotes: [],
        controlTable: this.initControlTable(),
        scaleOctaveTuningTable: new Float32Array(12),
        // [-100, 100] cent
        channelPressureTable: new Int8Array(6).fill(-1),
        polyphonicKeyPressureTable: new Int8Array(6).fill(-1),
        keyBasedTable: new Int8Array(128 * 128).fill(-1),
        keyBasedGainLs: new Array(128),
        keyBasedGainRs: new Array(128)
      };
    });
    return channels;
  }
  async createAudioBuffer(voiceParams) {
    const sample = voiceParams.sample;
    const sampleStart = voiceParams.start;
    const sampleEnd = sample.data.length + voiceParams.end;
    const audioBuffer = await sample.toAudioBuffer(
      this.audioContext,
      sampleStart,
      sampleEnd
    );
    return audioBuffer;
  }
  isLoopDrum(channel2, noteNumber) {
    const programNumber = channel2.programNumber;
    return programNumber === 48 && noteNumber === 88 || programNumber === 56 && 47 <= noteNumber && noteNumber <= 84;
  }
  createBufferSource(channel2, noteNumber, voiceParams, audioBuffer) {
    const bufferSource = new AudioBufferSourceNode(this.audioContext);
    bufferSource.buffer = audioBuffer;
    bufferSource.loop = channel2.isDrum ? this.isLoopDrum(channel2, noteNumber) : voiceParams.sampleModes % 2 !== 0;
    if (bufferSource.loop) {
      bufferSource.loopStart = voiceParams.loopStart / voiceParams.sampleRate;
      bufferSource.loopEnd = voiceParams.loopEnd / voiceParams.sampleRate;
    }
    return bufferSource;
  }
  async scheduleTimelineEvents(t, resumeTime, queueIndex) {
    while (queueIndex < this.timeline.length) {
      const event = this.timeline[queueIndex];
      if (event.startTime > t + this.lookAhead) break;
      const delay = this.startDelay - resumeTime;
      const startTime = event.startTime + delay;
      switch (event.type) {
        case "noteOn":
          await this.scheduleNoteOn(
            event.channel,
            event.noteNumber,
            event.velocity,
            startTime
          );
          break;
        case "noteOff": {
          const notePromise = this.scheduleNoteOff(
            event.channel,
            event.noteNumber,
            event.velocity,
            startTime,
            false
            // force
          );
          if (notePromise) this.notePromises.push(notePromise);
          break;
        }
        case "noteAftertouch":
          this.setPolyphonicKeyPressure(
            event.channel,
            event.noteNumber,
            event.amount,
            startTime
          );
          break;
        case "controller":
          this.setControlChange(
            event.channel,
            event.controllerType,
            event.value,
            startTime
          );
          break;
        case "programChange":
          this.setProgramChange(
            event.channel,
            event.programNumber,
            startTime
          );
          break;
        case "channelAftertouch":
          this.setChannelPressure(event.channel, event.amount, startTime);
          break;
        case "pitchBend":
          this.setPitchBend(event.channel, event.value + 8192, startTime);
          break;
        case "sysEx":
          this.handleSysEx(event.data, startTime);
      }
      queueIndex++;
    }
    return queueIndex;
  }
  getQueueIndex(second) {
    for (let i = 0; i < this.timeline.length; i++) {
      if (second <= this.timeline[i].startTime) {
        return i;
      }
    }
    return 0;
  }
  resetAllStates() {
    this.exclusiveClassNotes.fill(void 0);
    this.drumExclusiveClassNotes.fill(void 0);
    this.voiceCache.clear();
    for (let i = 0; i < this.channels.length; i++) {
      this.channels[i].scheduledNotes = [];
      this.resetChannelStates(i);
    }
  }
  updateStates(queueIndex, nextQueueIndex) {
    if (nextQueueIndex < queueIndex) queueIndex = 0;
    for (let i = queueIndex; i < nextQueueIndex; i++) {
      const event = this.timeline[i];
      switch (event.type) {
        case "controller":
          this.setControlChange(
            event.channel,
            event.controllerType,
            event.value,
            0
          );
          break;
        case "programChange":
          this.setProgramChange(
            event.channel,
            event.programNumber,
            0
          );
          break;
        case "pitchBend":
          this.setPitchBend(event.channel, event.value + 8192, 0);
          break;
        case "sysEx":
          this.handleSysEx(event.data, 0);
      }
    }
  }
  async playNotes() {
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    this.isPlaying = true;
    this.isPaused = false;
    this.startTime = this.audioContext.currentTime;
    let queueIndex = this.getQueueIndex(this.resumeTime);
    let resumeTime = this.resumeTime - this.startTime;
    let finished = false;
    this.notePromises = [];
    while (queueIndex < this.timeline.length) {
      const now = this.audioContext.currentTime;
      const t = now + resumeTime;
      queueIndex = await this.scheduleTimelineEvents(
        t,
        resumeTime,
        queueIndex
      );
      if (this.isPausing) {
        await this.stopNotes(0, true, now);
        await this.audioContext.suspend();
        this.notePromises = [];
        break;
      } else if (this.isStopping) {
        await this.stopNotes(0, true, now);
        await this.audioContext.suspend();
        finished = true;
        break;
      } else if (this.isSeeking) {
        await this.stopNotes(0, true, now);
        this.startTime = this.audioContext.currentTime;
        const nextQueueIndex = this.getQueueIndex(this.resumeTime);
        this.updateStates(queueIndex, nextQueueIndex);
        queueIndex = nextQueueIndex;
        resumeTime = this.resumeTime - this.startTime;
        this.isSeeking = false;
        continue;
      }
      const waitTime = now + this.noteCheckInterval;
      await this.scheduleTask(() => {
      }, waitTime);
    }
    if (finished) {
      this.notePromises = [];
      this.resetAllStates();
    }
    this.isPlaying = false;
  }
  ticksToSecond(ticks, secondsPerBeat) {
    return ticks * secondsPerBeat / this.ticksPerBeat;
  }
  secondToTicks(second, secondsPerBeat) {
    return second * this.ticksPerBeat / secondsPerBeat;
  }
  extractMidiData(midi) {
    const instruments = /* @__PURE__ */ new Set();
    const timeline = [];
    const tmpChannels = new Array(this.channels.length);
    for (let i = 0; i < tmpChannels.length; i++) {
      tmpChannels[i] = {
        programNumber: -1,
        bankMSB: this.channels[i].bankMSB,
        bankLSB: this.channels[i].bankLSB
      };
    }
    for (let i = 0; i < midi.tracks.length; i++) {
      const track = midi.tracks[i];
      let currentTicks = 0;
      for (let j = 0; j < track.length; j++) {
        const event = track[j];
        currentTicks += event.deltaTime;
        event.ticks = currentTicks;
        switch (event.type) {
          case "noteOn": {
            const channel2 = tmpChannels[event.channel];
            if (channel2.programNumber < 0) {
              channel2.programNumber = event.programNumber;
              switch (channel2.bankMSB) {
                case 120:
                  instruments.add(`128:0`);
                  break;
                case 121:
                  instruments.add(`${channel2.bankLSB}:0`);
                  break;
                default: {
                  const bankNumber = channel2.bankMSB * 128 + channel2.bankLSB;
                  instruments.add(`${bankNumber}:0`);
                }
              }
              channel2.programNumber = 0;
            }
            break;
          }
          case "controller":
            switch (event.controllerType) {
              case 0:
                tmpChannels[event.channel].bankMSB = event.value;
                break;
              case 32:
                tmpChannels[event.channel].bankLSB = event.value;
                break;
            }
            break;
          case "programChange": {
            const channel2 = tmpChannels[event.channel];
            channel2.programNumber = event.programNumber;
            switch (channel2.bankMSB) {
              case 120:
                instruments.add(`128:${channel2.programNumber}`);
                break;
              case 121:
                instruments.add(`${channel2.bankLSB}:${channel2.programNumber}`);
                break;
              default: {
                const bankNumber = channel2.bankMSB * 128 + channel2.bankLSB;
                instruments.add(`${bankNumber}:${channel2.programNumber}`);
              }
            }
          }
        }
        delete event.deltaTime;
        timeline.push(event);
      }
    }
    const priority = {
      controller: 0,
      sysEx: 1,
      noteOff: 2,
      // for portamento
      noteOn: 3
    };
    timeline.sort((a, b) => {
      if (a.ticks !== b.ticks) return a.ticks - b.ticks;
      return (priority[a.type] || 4) - (priority[b.type] || 4);
    });
    let prevTempoTime = 0;
    let prevTempoTicks = 0;
    let secondsPerBeat = 0.5;
    for (let i = 0; i < timeline.length; i++) {
      const event = timeline[i];
      const timeFromPrevTempo = this.ticksToSecond(
        event.ticks - prevTempoTicks,
        secondsPerBeat
      );
      event.startTime = prevTempoTime + timeFromPrevTempo;
      if (event.type === "setTempo") {
        prevTempoTime += this.ticksToSecond(
          event.ticks - prevTempoTicks,
          secondsPerBeat
        );
        secondsPerBeat = event.microsecondsPerBeat / 1e6;
        prevTempoTicks = event.ticks;
      }
    }
    return { instruments, timeline };
  }
  stopActiveNotes(channelNumber, velocity, force, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    const promises = [];
    this.processActiveNotes(channel2, scheduleTime, (note2) => {
      const promise = this.scheduleNoteOff(
        channelNumber,
        note2.noteNumber,
        velocity,
        scheduleTime,
        force
      );
      this.notePromises.push(promise);
      promises.push(promise);
    });
    return Promise.all(promises);
  }
  stopChannelNotes(channelNumber, velocity, force, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    const promises = [];
    this.processScheduledNotes(channel2, (note2) => {
      const promise = this.scheduleNoteOff(
        channelNumber,
        note2.noteNumber,
        velocity,
        scheduleTime,
        force
      );
      this.notePromises.push(promise);
      promises.push(promise);
    });
    return Promise.all(promises);
  }
  stopNotes(velocity, force, scheduleTime) {
    const promises = [];
    for (let i = 0; i < this.channels.length; i++) {
      promises.push(this.stopChannelNotes(i, velocity, force, scheduleTime));
    }
    return Promise.all(this.notePromises);
  }
  async start() {
    if (this.isPlaying || this.isPaused) return;
    this.resumeTime = 0;
    if (this.voiceCounter.size === 0) this.cacheVoiceIds();
    this.playPromise = this.playNotes();
    await this.playPromise;
  }
  async stop() {
    if (!this.isPlaying) return;
    this.isStopping = true;
    await this.playPromise;
    this.isStopping = false;
  }
  async pause() {
    if (!this.isPlaying || this.isPaused) return;
    const now = this.audioContext.currentTime;
    this.resumeTime += now - this.startTime - this.startDelay;
    this.isPausing = true;
    await this.playPromise;
    this.isPausing = false;
    this.isPaused = true;
  }
  async resume() {
    if (!this.isPaused) return;
    this.playPromise = this.playNotes();
    await this.playPromise;
    this.isPaused = false;
  }
  seekTo(second) {
    this.resumeTime = second;
    if (this.isPlaying) {
      this.isSeeking = true;
    }
  }
  calcTotalTime() {
    let totalTime = 0;
    for (let i = 0; i < this.timeline.length; i++) {
      const event = this.timeline[i];
      if (totalTime < event.startTime) totalTime = event.startTime;
    }
    return totalTime;
  }
  currentTime() {
    const now = this.audioContext.currentTime;
    return this.resumeTime + now - this.startTime - this.startDelay;
  }
  processScheduledNotes(channel2, callback) {
    const scheduledNotes = channel2.scheduledNotes;
    for (let i = channel2.scheduleIndex; i < scheduledNotes.length; i++) {
      const note2 = scheduledNotes[i];
      if (!note2) continue;
      if (note2.ending) continue;
      callback(note2);
    }
  }
  processActiveNotes(channel2, scheduleTime, callback) {
    const scheduledNotes = channel2.scheduledNotes;
    for (let i = channel2.scheduleIndex; i < scheduledNotes.length; i++) {
      const note2 = scheduledNotes[i];
      if (!note2) continue;
      if (note2.ending) continue;
      if (scheduleTime < note2.startTime) break;
      callback(note2);
    }
  }
  createConvolutionReverbImpulse(audioContext, decay, preDecay) {
    const sampleRate = audioContext.sampleRate;
    const length = sampleRate * decay;
    const impulse = new AudioBuffer({
      numberOfChannels: 2,
      length,
      sampleRate
    });
    const preDecayLength = Math.min(sampleRate * preDecay, length);
    for (let channel2 = 0; channel2 < impulse.numberOfChannels; channel2++) {
      const channelData = impulse.getChannelData(channel2);
      for (let i = 0; i < preDecayLength; i++) {
        channelData[i] = Math.random() * 2 - 1;
      }
      const attenuationFactor = 1 / (sampleRate * decay);
      for (let i = preDecayLength; i < length; i++) {
        const attenuation = Math.exp(
          -(i - preDecayLength) * attenuationFactor
        );
        channelData[i] = (Math.random() * 2 - 1) * attenuation;
      }
    }
    return impulse;
  }
  createConvolutionReverb(audioContext, impulse) {
    const convolverNode = new ConvolverNode(audioContext, {
      buffer: impulse
    });
    return {
      input: convolverNode,
      output: convolverNode,
      convolverNode
    };
  }
  createCombFilter(audioContext, input, delay, feedback) {
    const delayNode = new DelayNode(audioContext, {
      maxDelayTime: delay,
      delayTime: delay
    });
    const feedbackGain = new GainNode(audioContext, { gain: feedback });
    input.connect(delayNode);
    delayNode.connect(feedbackGain);
    feedbackGain.connect(delayNode);
    return delayNode;
  }
  createAllpassFilter(audioContext, input, delay, feedback) {
    const delayNode = new DelayNode(audioContext, {
      maxDelayTime: delay,
      delayTime: delay
    });
    const feedbackGain = new GainNode(audioContext, { gain: feedback });
    const passGain = new GainNode(audioContext, { gain: 1 - feedback });
    input.connect(delayNode);
    delayNode.connect(feedbackGain);
    feedbackGain.connect(delayNode);
    delayNode.connect(passGain);
    return passGain;
  }
  generateDistributedArray(center, count, varianceRatio = 0.1, randomness = 0.05) {
    const variance = center * varianceRatio;
    const array = new Array(count);
    for (let i = 0; i < count; i++) {
      const fraction = i / (count - 1 || 1);
      const value = center - variance + fraction * 2 * variance;
      array[i] = value * (1 - (Math.random() * 2 - 1) * randomness);
    }
    return array;
  }
  // https://hajim.rochester.edu/ece/sites/zduan/teaching/ece472/reading/Schroeder_1962.pdf
  //   M.R.Schroeder, "Natural Sounding Artificial Reverberation", J.Audio Eng. Soc., vol.10, p.219, 1962
  createSchroederReverb(audioContext, combFeedbacks, combDelays, allpassFeedbacks, allpassDelays) {
    const input = new GainNode(audioContext);
    const mergerGain = new GainNode(audioContext);
    for (let i = 0; i < combDelays.length; i++) {
      const comb = this.createCombFilter(
        audioContext,
        input,
        combDelays[i],
        combFeedbacks[i]
      );
      comb.connect(mergerGain);
    }
    const allpasses = [];
    for (let i = 0; i < allpassDelays.length; i++) {
      const allpass = this.createAllpassFilter(
        audioContext,
        i === 0 ? mergerGain : allpasses.at(-1),
        allpassDelays[i],
        allpassFeedbacks[i]
      );
      allpasses.push(allpass);
    }
    const output = allpasses.at(-1);
    return { input, output };
  }
  createReverbEffect(audioContext) {
    const { algorithm, time: rt60, feedback } = this.reverb;
    switch (algorithm) {
      case "ConvolutionReverb": {
        const impulse = this.createConvolutionReverbImpulse(
          audioContext,
          rt60,
          this.calcDelay(rt60, feedback)
        );
        return this.createConvolutionReverb(audioContext, impulse);
      }
      case "SchroederReverb": {
        const combFeedbacks = this.generateDistributedArray(feedback, 4);
        const combDelays = combFeedbacks.map(
          (feedback2) => this.calcDelay(rt60, feedback2)
        );
        const allpassFeedbacks = this.generateDistributedArray(feedback, 4);
        const allpassDelays = allpassFeedbacks.map(
          (feedback2) => this.calcDelay(rt60, feedback2)
        );
        return this.createSchroederReverb(
          audioContext,
          combFeedbacks,
          combDelays,
          allpassFeedbacks,
          allpassDelays
        );
      }
    }
  }
  createChorusEffect(audioContext) {
    const input = new GainNode(audioContext);
    const output = new GainNode(audioContext);
    const sendGain = new GainNode(audioContext);
    const lfo = new OscillatorNode(audioContext, {
      frequency: this.chorus.modRate
    });
    const lfoGain = new GainNode(audioContext, {
      gain: this.chorus.modDepth / 2
    });
    const delayTimes = this.chorus.delayTimes;
    const delayNodes = [];
    const feedbackGains = [];
    for (let i = 0; i < delayTimes.length; i++) {
      const delayTime = delayTimes[i];
      const delayNode = new DelayNode(audioContext, {
        maxDelayTime: 0.1,
        // generally, 5ms < delayTime < 50ms
        delayTime
      });
      const feedbackGain = new GainNode(audioContext, {
        gain: this.chorus.feedback
      });
      delayNodes.push(delayNode);
      feedbackGains.push(feedbackGain);
      input.connect(delayNode);
      lfoGain.connect(delayNode.delayTime);
      delayNode.connect(feedbackGain);
      feedbackGain.connect(delayNode);
      delayNode.connect(output);
    }
    output.connect(sendGain);
    lfo.connect(lfoGain);
    lfo.start();
    return {
      input,
      output,
      sendGain,
      lfo,
      lfoGain,
      delayNodes,
      feedbackGains
    };
  }
  cbToRatio(cb) {
    return Math.pow(10, cb / 200);
  }
  rateToCent(rate) {
    return 1200 * Math.log2(rate);
  }
  centToRate(cent) {
    return Math.pow(2, cent / 1200);
  }
  centToHz(cent) {
    return 8.176 * this.centToRate(cent);
  }
  calcChannelDetune(channel2) {
    const masterTuning = channel2.isDrum ? 0 : this.masterCoarseTuning + this.masterFineTuning;
    const channelTuning = channel2.coarseTuning + channel2.fineTuning;
    const tuning = masterTuning + channelTuning;
    const pitchWheel = channel2.state.pitchWheel * 2 - 1;
    const pitchWheelSensitivity = channel2.state.pitchWheelSensitivity * 12800;
    const pitch = pitchWheel * pitchWheelSensitivity;
    const channelPressureRaw = channel2.channelPressureTable[0];
    if (0 <= channelPressureRaw) {
      const channelPressureDepth = (channelPressureRaw - 64) / 37.5;
      const channelPressure = channelPressureDepth * channel2.state.channelPressure;
      return tuning + pitch + channelPressure;
    } else {
      return tuning + pitch;
    }
  }
  calcNoteDetune(channel2, note2) {
    return channel2.scaleOctaveTuningTable[note2.noteNumber % 12];
  }
  updateChannelDetune(channel2, scheduleTime) {
    this.processScheduledNotes(channel2, (note2) => {
      this.updateDetune(channel2, note2, scheduleTime);
    });
  }
  updateDetune(channel2, note2, scheduleTime) {
    const noteDetune = this.calcNoteDetune(channel2, note2);
    const pitchControl = this.getPitchControl(channel2, note2);
    const detune = channel2.detune + noteDetune + pitchControl;
    if (0.5 <= channel2.state.portamento && 0 <= note2.portamentoNoteNumber) {
      const startTime = note2.startTime;
      const deltaCent = (note2.noteNumber - note2.portamentoNoteNumber) * 100;
      const portamentoTime = startTime + this.getPortamentoTime(channel2, note2);
      note2.bufferSource.detune.cancelScheduledValues(scheduleTime).setValueAtTime(detune - deltaCent, scheduleTime).linearRampToValueAtTime(detune, portamentoTime);
    } else {
      note2.bufferSource.detune.cancelScheduledValues(scheduleTime).setValueAtTime(detune, scheduleTime);
    }
  }
  getPortamentoTime(channel2, note2) {
    const deltaSemitone = Math.abs(note2.noteNumber - note2.portamentoNoteNumber);
    const value = Math.ceil(channel2.state.portamentoTime * 127);
    return deltaSemitone / this.getPitchIncrementSpeed(value) / 10;
  }
  getPitchIncrementSpeed(value) {
    const points = [
      [0, 1e3],
      [6, 100],
      [16, 20],
      [32, 10],
      [48, 5],
      [64, 2.5],
      [80, 1],
      [96, 0.4],
      [112, 0.15],
      [127, 0.01]
    ];
    const logPoints = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      const [x, y2] = points[i];
      if (value === x) return y2;
      logPoints[i] = [x, Math.log(y2)];
    }
    let startIndex = 0;
    for (let i = 1; i < logPoints.length; i++) {
      if (value <= logPoints[i][0]) {
        startIndex = i - 1;
        break;
      }
    }
    const [x0, y0] = logPoints[startIndex];
    const [x1, y1] = logPoints[startIndex + 1];
    const h = x1 - x0;
    const t = (value - x0) / h;
    let m0, m1;
    if (startIndex === 0) {
      m0 = (y1 - y0) / h;
    } else {
      const [xPrev, yPrev] = logPoints[startIndex - 1];
      m0 = (y1 - yPrev) / (x1 - xPrev);
    }
    if (startIndex === logPoints.length - 2) {
      m1 = (y1 - y0) / h;
    } else {
      const [xNext, yNext] = logPoints[startIndex + 2];
      m1 = (yNext - y0) / (xNext - x0);
    }
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const y = h00 * y0 + h01 * y1 + h * (h10 * m0 + h11 * m1);
    return Math.exp(y);
  }
  setPortamentoVolumeEnvelope(channel2, note2, scheduleTime) {
    const { voiceParams, startTime } = note2;
    const attackVolume = this.cbToRatio(-voiceParams.initialAttenuation) * (1 + this.getAmplitudeControl(channel2, note2));
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelay = startTime + voiceParams.volDelay;
    const attackTime = this.getRelativeKeyBasedValue(channel2, note2, 73) * 2;
    const volAttack = volDelay + voiceParams.volAttack * attackTime;
    const volHold = volAttack + voiceParams.volHold;
    note2.volumeEnvelopeNode.gain.cancelScheduledValues(scheduleTime).setValueAtTime(sustainVolume, volHold);
  }
  setVolumeEnvelope(channel2, note2, scheduleTime) {
    const { voiceParams, startTime } = note2;
    const attackVolume = this.cbToRatio(-voiceParams.initialAttenuation) * (1 + this.getAmplitudeControl(channel2, note2));
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelay = startTime + voiceParams.volDelay;
    const attackTime = this.getRelativeKeyBasedValue(channel2, note2, 73) * 2;
    const volAttack = volDelay + voiceParams.volAttack * attackTime;
    const volHold = volAttack + voiceParams.volHold;
    const decayTime = this.getRelativeKeyBasedValue(channel2, note2, 75) * 2;
    const volDecay = volHold + voiceParams.volDecay * decayTime;
    note2.volumeEnvelopeNode.gain.cancelScheduledValues(scheduleTime).setValueAtTime(0, startTime).setValueAtTime(1e-6, volDelay).exponentialRampToValueAtTime(attackVolume, volAttack).setValueAtTime(attackVolume, volHold).linearRampToValueAtTime(sustainVolume, volDecay);
  }
  setPortamentoPitchEnvelope(note2, scheduleTime) {
    const baseRate = note2.voiceParams.playbackRate;
    note2.bufferSource.playbackRate.cancelScheduledValues(scheduleTime).setValueAtTime(baseRate, scheduleTime);
  }
  setPitchEnvelope(note2, scheduleTime) {
    const { voiceParams } = note2;
    const baseRate = voiceParams.playbackRate;
    note2.bufferSource.playbackRate.cancelScheduledValues(scheduleTime).setValueAtTime(baseRate, scheduleTime);
    const modEnvToPitch = voiceParams.modEnvToPitch;
    if (modEnvToPitch === 0) return;
    const basePitch = this.rateToCent(baseRate);
    const peekPitch = basePitch + modEnvToPitch;
    const peekRate = this.centToRate(peekPitch);
    const modDelay = note2.startTime + voiceParams.modDelay;
    const modAttack = modDelay + voiceParams.modAttack;
    const modHold = modAttack + voiceParams.modHold;
    const modDecay = modHold + voiceParams.modDecay;
    note2.bufferSource.playbackRate.setValueAtTime(baseRate, modDelay).exponentialRampToValueAtTime(peekRate, modAttack).setValueAtTime(peekRate, modHold).linearRampToValueAtTime(baseRate, modDecay);
  }
  clampCutoffFrequency(frequency) {
    const minFrequency = 20;
    const maxFrequency = 2e4;
    return Math.max(minFrequency, Math.min(frequency, maxFrequency));
  }
  setPortamentoFilterEnvelope(channel2, note2, scheduleTime) {
    const { voiceParams, startTime } = note2;
    const softPedalFactor = this.getSoftPedalFactor(channel2, note2);
    const baseCent = voiceParams.initialFilterFc + this.getFilterCutoffControl(channel2, note2);
    const brightness = this.getRelativeKeyBasedValue(channel2, note2, 74) * 2;
    const baseFreq = this.centToHz(baseCent) * softPedalFactor * brightness;
    const peekFreq = this.centToHz(
      voiceParams.initialFilterFc + voiceParams.modEnvToFilterFc
    ) * brightness;
    const sustainFreq = baseFreq + (peekFreq - baseFreq) * (1 - voiceParams.modSustain);
    const adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
    const adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
    const portamentoTime = startTime + this.getPortamentoTime(channel2, note2);
    const modDelay = startTime + voiceParams.modDelay;
    note2.filterNode.frequency.cancelScheduledValues(scheduleTime).setValueAtTime(adjustedBaseFreq, startTime).setValueAtTime(adjustedBaseFreq, modDelay).linearRampToValueAtTime(adjustedSustainFreq, portamentoTime);
  }
  setFilterEnvelope(channel2, note2, scheduleTime) {
    const { voiceParams, startTime } = note2;
    const softPedalFactor = this.getSoftPedalFactor(channel2, note2);
    const baseCent = voiceParams.initialFilterFc + this.getFilterCutoffControl(channel2, note2);
    const brightness = this.getRelativeKeyBasedValue(channel2, note2, 74) * 2;
    const baseFreq = this.centToHz(baseCent) * softPedalFactor * brightness;
    const peekFreq = this.centToHz(baseCent + voiceParams.modEnvToFilterFc) * softPedalFactor * brightness;
    const sustainFreq = baseFreq + (peekFreq - baseFreq) * (1 - voiceParams.modSustain);
    const adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
    const adjustedPeekFreq = this.clampCutoffFrequency(peekFreq);
    const adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
    const modDelay = startTime + voiceParams.modDelay;
    const modAttack = modDelay + voiceParams.modAttack;
    const modHold = modAttack + voiceParams.modHold;
    const modDecay = modHold + voiceParams.modDecay;
    note2.filterNode.frequency.cancelScheduledValues(scheduleTime).setValueAtTime(adjustedBaseFreq, startTime).setValueAtTime(adjustedBaseFreq, modDelay).exponentialRampToValueAtTime(adjustedPeekFreq, modAttack).setValueAtTime(adjustedPeekFreq, modHold).linearRampToValueAtTime(adjustedSustainFreq, modDecay);
  }
  startModulation(channel2, note2, scheduleTime) {
    const { voiceParams } = note2;
    note2.modulationLFO = new OscillatorNode(this.audioContext, {
      frequency: this.centToHz(voiceParams.freqModLFO)
    });
    note2.filterDepth = new GainNode(this.audioContext, {
      gain: voiceParams.modLfoToFilterFc
    });
    note2.modulationDepth = new GainNode(this.audioContext);
    this.setModLfoToPitch(channel2, note2, scheduleTime);
    note2.volumeDepth = new GainNode(this.audioContext);
    this.setModLfoToVolume(channel2, note2, scheduleTime);
    note2.modulationLFO.start(note2.startTime + voiceParams.delayModLFO);
    note2.modulationLFO.connect(note2.filterDepth);
    note2.filterDepth.connect(note2.filterNode.frequency);
    note2.modulationLFO.connect(note2.modulationDepth);
    note2.modulationDepth.connect(note2.bufferSource.detune);
    note2.modulationLFO.connect(note2.volumeDepth);
    note2.volumeDepth.connect(note2.volumeEnvelopeNode.gain);
  }
  startVibrato(channel2, note2, scheduleTime) {
    const { voiceParams } = note2;
    const vibratoRate = this.getRelativeKeyBasedValue(channel2, note2, 76) * 2;
    const vibratoDelay = this.getRelativeKeyBasedValue(channel2, note2, 78) * 2;
    note2.vibratoLFO = new OscillatorNode(this.audioContext, {
      frequency: this.centToHz(voiceParams.freqVibLFO) * vibratoRate
    });
    note2.vibratoLFO.start(
      note2.startTime + voiceParams.delayVibLFO * vibratoDelay
    );
    note2.vibratoDepth = new GainNode(this.audioContext);
    this.setVibLfoToPitch(channel2, note2, scheduleTime);
    note2.vibratoLFO.connect(note2.vibratoDepth);
    note2.vibratoDepth.connect(note2.bufferSource.detune);
  }
  async getAudioBuffer(channel2, noteNumber, velocity, voiceParams) {
    const audioBufferId = this.getVoiceId(
      channel2,
      noteNumber,
      velocity
    );
    const cache = this.voiceCache.get(audioBufferId);
    if (cache) {
      cache.counter += 1;
      if (cache.maxCount <= cache.counter) {
        this.voiceCache.delete(audioBufferId);
      }
      return cache.audioBuffer;
    } else {
      const maxCount = this.voiceCounter.get(audioBufferId) ?? 0;
      const audioBuffer = await this.createAudioBuffer(voiceParams);
      const cache2 = { audioBuffer, maxCount, counter: 1 };
      this.voiceCache.set(audioBufferId, cache2);
      return audioBuffer;
    }
  }
  async createNote(channel2, voice, noteNumber, velocity, startTime) {
    const now = this.audioContext.currentTime;
    const state = channel2.state;
    const controllerState = this.getControllerState(
      channel2,
      noteNumber,
      velocity,
      0
      // polyphonicKeyPressure
    );
    const voiceParams = voice.getAllParams(controllerState);
    const note2 = new Note(noteNumber, velocity, startTime, voice, voiceParams);
    const audioBuffer = await this.getAudioBuffer(
      channel2,
      noteNumber,
      velocity,
      voiceParams
    );
    note2.bufferSource = this.createBufferSource(
      channel2,
      noteNumber,
      voiceParams,
      audioBuffer
    );
    note2.volumeEnvelopeNode = new GainNode(this.audioContext);
    const filterResonance = this.getRelativeKeyBasedValue(channel2, note2, 71);
    note2.filterNode = new BiquadFilterNode(this.audioContext, {
      type: "lowpass",
      Q: voiceParams.initialFilterQ / 5 * filterResonance
      // dB
    });
    const prevNote = channel2.scheduledNotes.at(-1);
    if (prevNote && prevNote.noteNumber !== noteNumber) {
      note2.portamentoNoteNumber = prevNote.noteNumber;
    }
    if (0.5 <= channel2.state.portamento && 0 <= note2.portamentoNoteNumber) {
      this.setPortamentoVolumeEnvelope(channel2, note2, now);
      this.setPortamentoFilterEnvelope(channel2, note2, now);
      this.setPortamentoPitchEnvelope(note2, now);
    } else {
      this.setVolumeEnvelope(channel2, note2, now);
      this.setFilterEnvelope(channel2, note2, now);
      this.setPitchEnvelope(note2, now);
    }
    this.updateDetune(channel2, note2, now);
    if (0 < state.vibratoDepth) {
      this.startVibrato(channel2, note2, now);
    }
    if (0 < state.modulationDepth) {
      this.startModulation(channel2, note2, now);
    }
    if (channel2.mono && channel2.currentBufferSource) {
      channel2.currentBufferSource.stop(startTime);
      channel2.currentBufferSource = note2.bufferSource;
    }
    note2.bufferSource.connect(note2.filterNode);
    note2.filterNode.connect(note2.volumeEnvelopeNode);
    this.setChorusSend(channel2, note2, now);
    this.setReverbSend(channel2, note2, now);
    note2.bufferSource.start(startTime);
    return note2;
  }
  calcBank(channel2) {
    switch (this.mode) {
      case "GM1":
        if (channel2.isDrum) return 128;
        return 0;
      case "GM2":
        if (channel2.bankMSB === 121) return 0;
        if (channel2.isDrum) return 128;
        return channel2.bank;
      default:
        return channel2.bank;
    }
  }
  handleExclusiveClass(note2, channelNumber, startTime) {
    const exclusiveClass = note2.voiceParams.exclusiveClass;
    if (exclusiveClass === 0) return;
    const prev = this.exclusiveClassNotes[exclusiveClass];
    if (prev) {
      const [prevNote, prevChannelNumber] = prev;
      if (prevNote && !prevNote.ending) {
        this.scheduleNoteOff(
          prevChannelNumber,
          prevNote.noteNumber,
          0,
          // velocity,
          startTime,
          true
          // force
        );
      }
    }
    this.exclusiveClassNotes[exclusiveClass] = [note2, channelNumber];
  }
  handleDrumExclusiveClass(note2, channelNumber, startTime) {
    const channel2 = this.channels[channelNumber];
    if (!channel2.isDrum) return;
    const kitTable = drumExclusiveClassesByKit[channel2.programNumber];
    if (!kitTable) return;
    const drumExclusiveClass = kitTable[note2.noteNumber];
    if (drumExclusiveClass === 0) return;
    const index = (drumExclusiveClass - 1) * this.channels.length + channelNumber;
    const prevNote = this.drumExclusiveClassNotes[index];
    if (prevNote && !prevNote.ending) {
      this.scheduleNoteOff(
        channelNumber,
        prevNote.noteNumber,
        0,
        // velocity,
        startTime,
        true
        // force
      );
    }
    this.drumExclusiveClassNotes[index] = note2;
  }
  async scheduleNoteOn(channelNumber, noteNumber, velocity, startTime) {
    const channel2 = this.channels[channelNumber];
    const bankNumber = this.calcBank(channel2, channelNumber);
    const soundFontIndex = this.soundFontTable[channel2.programNumber].get(bankNumber);
    if (soundFontIndex === void 0) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const voice = soundFont.getVoice(
      bankNumber,
      channel2.programNumber,
      noteNumber,
      velocity
    );
    if (!voice) return;
    const note2 = await this.createNote(
      channel2,
      voice,
      noteNumber,
      velocity,
      startTime
    );
    if (channel2.isDrum) {
      const { keyBasedGainLs, keyBasedGainRs } = channel2;
      let gainL = keyBasedGainLs[noteNumber];
      let gainR = keyBasedGainRs[noteNumber];
      if (!gainL) {
        const audioNodes = this.createChannelAudioNodes(this.audioContext);
        gainL = keyBasedGainLs[noteNumber] = audioNodes.gainL;
        gainR = keyBasedGainRs[noteNumber] = audioNodes.gainR;
      }
      note2.volumeEnvelopeNode.connect(gainL);
      note2.volumeEnvelopeNode.connect(gainR);
    } else {
      note2.volumeEnvelopeNode.connect(channel2.gainL);
      note2.volumeEnvelopeNode.connect(channel2.gainR);
    }
    if (0.5 <= channel2.state.sustainPedal) {
      channel2.sustainNotes.push(note2);
    }
    this.handleExclusiveClass(note2, channelNumber, startTime);
    this.handleDrumExclusiveClass(note2, channelNumber, startTime);
    const scheduledNotes = channel2.scheduledNotes;
    note2.index = scheduledNotes.length;
    scheduledNotes.push(note2);
  }
  noteOn(channelNumber, noteNumber, velocity, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    return this.scheduleNoteOn(
      channelNumber,
      noteNumber,
      velocity,
      scheduleTime,
      void 0
      // noteOff event
    );
  }
  disconnectNote(note2) {
    note2.bufferSource.disconnect();
    note2.filterNode.disconnect();
    note2.volumeEnvelopeNode.disconnect();
    if (note2.modulationDepth) {
      note2.volumeDepth.disconnect();
      note2.modulationDepth.disconnect();
      note2.modulationLFO.stop();
    }
    if (note2.vibratoDepth) {
      note2.vibratoDepth.disconnect();
      note2.vibratoLFO.stop();
    }
    if (note2.reverbSend) {
      note2.reverbSend.disconnect();
    }
    if (note2.chorusSend) {
      note2.chorusSend.disconnect();
    }
  }
  releaseNote(channel2, note2, endTime) {
    const releaseTime = this.getRelativeKeyBasedValue(channel2, note2, 72) * 2;
    const volRelease = endTime + note2.voiceParams.volRelease * releaseTime;
    const modRelease = endTime + note2.voiceParams.modRelease;
    const stopTime = Math.min(volRelease, modRelease);
    note2.filterNode.frequency.cancelScheduledValues(endTime).linearRampToValueAtTime(0, modRelease);
    note2.volumeEnvelopeNode.gain.cancelScheduledValues(endTime).linearRampToValueAtTime(0, volRelease);
    return new Promise((resolve) => {
      this.scheduleTask(() => {
        const bufferSource = note2.bufferSource;
        bufferSource.loop = false;
        bufferSource.stop(stopTime);
        this.disconnectNote(note2);
        channel2.scheduledNotes[note2.index] = void 0;
        resolve();
      }, stopTime);
    });
  }
  scheduleNoteOff(channelNumber, noteNumber, _velocity, endTime, force) {
    const channel2 = this.channels[channelNumber];
    const state = channel2.state;
    if (!force) {
      if (channel2.isDrum) {
        if (!this.isLoopDrum(channel2, noteNumber)) return;
      } else {
        if (0.5 <= state.sustainPedal) return;
        if (0.5 <= state.sostenutoPedal) return;
      }
    }
    const index = this.findNoteOffIndex(channel2, noteNumber);
    if (index < 0) return;
    const note2 = channel2.scheduledNotes[index];
    note2.ending = true;
    this.setNoteIndex(channel2, index);
    this.releaseNote(channel2, note2, endTime);
  }
  setNoteIndex(channel2, index) {
    let allEnds = true;
    for (let i = channel2.scheduleIndex; i < index; i++) {
      const note2 = channel2.scheduledNotes[i];
      if (note2 && !note2.ending) {
        allEnds = false;
        break;
      }
    }
    if (allEnds) channel2.scheduleIndex = index + 1;
  }
  findNoteOffIndex(channel2, noteNumber) {
    const scheduledNotes = channel2.scheduledNotes;
    for (let i = channel2.scheduleIndex; i < scheduledNotes.length; i++) {
      const note2 = scheduledNotes[i];
      if (!note2) continue;
      if (note2.ending) continue;
      if (note2.noteNumber !== noteNumber) continue;
      return i;
    }
    return -1;
  }
  noteOff(channelNumber, noteNumber, velocity, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    return this.scheduleNoteOff(
      channelNumber,
      noteNumber,
      velocity,
      scheduleTime,
      false
      // force
    );
  }
  releaseSustainPedal(channelNumber, halfVelocity, scheduleTime) {
    const velocity = halfVelocity * 2;
    const channel2 = this.channels[channelNumber];
    const promises = [];
    for (let i = 0; i < channel2.sustainNotes.length; i++) {
      const promise = this.scheduleNoteOff(
        channelNumber,
        channel2.sustainNotes[i].noteNumber,
        velocity,
        scheduleTime
      );
      promises.push(promise);
    }
    channel2.sustainNotes = [];
    return promises;
  }
  releaseSostenutoPedal(channelNumber, halfVelocity, scheduleTime) {
    const velocity = halfVelocity * 2;
    const channel2 = this.channels[channelNumber];
    const promises = [];
    const sostenutoNotes = channel2.sostenutoNotes;
    channel2.state.sostenutoPedal = 0;
    for (let i = 0; i < sostenutoNotes.length; i++) {
      const note2 = sostenutoNotes[i];
      const promise = this.scheduleNoteOff(
        channelNumber,
        note2.noteNumber,
        velocity,
        scheduleTime
      );
      promises.push(promise);
    }
    channel2.sostenutoNotes = [];
    return promises;
  }
  handleMIDIMessage(statusByte, data1, data2, scheduleTime) {
    const channelNumber = statusByte & 15;
    const messageType = statusByte & 240;
    switch (messageType) {
      case 128:
        return this.noteOff(channelNumber, data1, data2, scheduleTime);
      case 144:
        return this.noteOn(channelNumber, data1, data2, scheduleTime);
      case 160:
        return this.setPolyphonicKeyPressure(
          channelNumber,
          data1,
          data2,
          scheduleTime
        );
      case 176:
        return this.setControlChange(
          channelNumber,
          data1,
          data2,
          scheduleTime
        );
      case 192:
        return this.setProgramChange(channelNumber, data1, scheduleTime);
      case 208:
        return this.setChannelPressure(channelNumber, data1, scheduleTime);
      case 224:
        return this.handlePitchBendMessage(
          channelNumber,
          data1,
          data2,
          scheduleTime
        );
      default:
        console.warn(`Unsupported MIDI message: ${messageType.toString(16)}`);
    }
  }
  setPolyphonicKeyPressure(channelNumber, noteNumber, pressure, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    const table = channel2.polyphonicKeyPressureTable;
    this.processActiveNotes(channel2, scheduleTime, (note2) => {
      if (note2.noteNumber === noteNumber) {
        note2.pressure = pressure;
        this.setEffects(channel2, note2, table, scheduleTime);
      }
    });
    this.applyVoiceParams(channel2, 10);
  }
  setProgramChange(channelNumber, programNumber, _scheduleTime) {
    const channel2 = this.channels[channelNumber];
    channel2.bank = channel2.bankMSB * 128 + channel2.bankLSB;
    channel2.programNumber = programNumber;
    if (this.mode === "GM2") {
      switch (channel2.bankMSB) {
        case 120:
          channel2.isDrum = true;
          break;
        case 121:
          channel2.isDrum = false;
          break;
      }
    }
    channel2.keyBasedTable.fill(-1);
  }
  setChannelPressure(channelNumber, value, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    const prev = channel2.state.channelPressure;
    const next = value / 127;
    channel2.state.channelPressure = next;
    const channelPressureRaw = channel2.channelPressureTable[0];
    if (0 <= channelPressureRaw) {
      const channelPressureDepth = (channelPressureRaw - 64) / 37.5;
      channel2.detune += channelPressureDepth * (next - prev);
    }
    const table = channel2.channelPressureTable;
    this.processActiveNotes(channel2, scheduleTime, (note2) => {
      this.setEffects(channel2, note2, table, scheduleTime);
    });
    this.applyVoiceParams(channel2, 13);
  }
  handlePitchBendMessage(channelNumber, lsb, msb, scheduleTime) {
    const pitchBend = msb * 128 + lsb;
    this.setPitchBend(channelNumber, pitchBend, scheduleTime);
  }
  setPitchBend(channelNumber, value, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    const state = channel2.state;
    const prev = state.pitchWheel * 2 - 1;
    const next = (value - 8192) / 8192;
    state.pitchWheel = value / 16383;
    channel2.detune += (next - prev) * state.pitchWheelSensitivity * 12800;
    this.updateChannelDetune(channel2, scheduleTime);
    this.applyVoiceParams(channel2, 14, scheduleTime);
  }
  setModLfoToPitch(channel2, note2, scheduleTime) {
    if (note2.modulationDepth) {
      const modLfoToPitch = note2.voiceParams.modLfoToPitch + this.getLFOPitchDepth(channel2, note2);
      const baseDepth = Math.abs(modLfoToPitch) + channel2.state.modulationDepth;
      const depth = baseDepth * Math.sign(modLfoToPitch);
      note2.modulationDepth.gain.cancelScheduledValues(scheduleTime).setValueAtTime(depth, scheduleTime);
    } else {
      this.startModulation(channel2, note2, scheduleTime);
    }
  }
  setVibLfoToPitch(channel2, note2, scheduleTime) {
    if (note2.vibratoDepth) {
      const vibratoDepth = this.getKeyBasedValue(channel2, note2.noteNumber, 77) * 2;
      const vibLfoToPitch = note2.voiceParams.vibLfoToPitch;
      const baseDepth = Math.abs(vibLfoToPitch) * vibratoDepth;
      const depth = baseDepth * Math.sign(vibLfoToPitch);
      note2.vibratoDepth.gain.cancelScheduledValues(scheduleTime).setValueAtTime(depth, scheduleTime);
    } else {
      this.startVibrato(channel2, note2, scheduleTime);
    }
  }
  setModLfoToFilterFc(channel2, note2, scheduleTime) {
    const modLfoToFilterFc = note2.voiceParams.modLfoToFilterFc + this.getLFOFilterDepth(channel2, note2);
    note2.filterDepth.gain.cancelScheduledValues(scheduleTime).setValueAtTime(modLfoToFilterFc, scheduleTime);
  }
  setModLfoToVolume(channel2, note2, scheduleTime) {
    const modLfoToVolume = note2.voiceParams.modLfoToVolume;
    const baseDepth = this.cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const volumeDepth = baseDepth * Math.sign(modLfoToVolume) * (1 + this.getLFOAmplitudeDepth(channel2, note2));
    note2.volumeDepth.gain.cancelScheduledValues(scheduleTime).setValueAtTime(volumeDepth, scheduleTime);
  }
  setReverbSend(channel2, note2, scheduleTime) {
    let value = note2.voiceParams.reverbEffectsSend * channel2.state.reverbSendLevel;
    if (channel2.isDrum) {
      const keyBasedValue = this.getKeyBasedValue(channel2, note2.noteNumber, 91);
      if (0 <= keyBasedValue) value = keyBasedValue / 127;
    }
    if (!note2.reverbSend) {
      if (0 < value) {
        note2.reverbSend = new GainNode(this.audioContext, { gain: value });
        note2.volumeEnvelopeNode.connect(note2.reverbSend);
        note2.reverbSend.connect(this.reverbEffect.input);
      }
    } else {
      note2.reverbSend.gain.cancelScheduledValues(scheduleTime).setValueAtTime(value, scheduleTime);
      if (0 < value) {
        note2.volumeEnvelopeNode.connect(note2.reverbSend);
      } else {
        try {
          note2.volumeEnvelopeNode.disconnect(note2.reverbSend);
        } catch {
        }
      }
    }
  }
  setChorusSend(channel2, note2, scheduleTime) {
    let value = note2.voiceParams.chorusEffectsSend * channel2.state.chorusSendLevel;
    if (channel2.isDrum) {
      const keyBasedValue = this.getKeyBasedValue(channel2, note2.noteNumber, 93);
      if (0 <= keyBasedValue) value = keyBasedValue / 127;
    }
    if (!note2.chorusSend) {
      if (0 < value) {
        note2.chorusSend = new GainNode(this.audioContext, { gain: value });
        note2.volumeEnvelopeNode.connect(note2.chorusSend);
        note2.chorusSend.connect(this.chorusEffect.input);
      }
    } else {
      note2.chorusSend.gain.cancelScheduledValues(scheduleTime).setValueAtTime(value, scheduleTime);
      if (0 < value) {
        note2.volumeEnvelopeNode.connect(note2.chorusSend);
      } else {
        try {
          note2.volumeEnvelopeNode.disconnect(note2.chorusSend);
        } catch {
        }
      }
    }
  }
  setDelayModLFO(note2) {
    const startTime = note2.startTime + note2.voiceParams.delayModLFO;
    try {
      note2.modulationLFO.start(startTime);
    } catch {
    }
  }
  setFreqModLFO(note2, scheduleTime) {
    const freqModLFO = note2.voiceParams.freqModLFO;
    note2.modulationLFO.frequency.cancelScheduledValues(scheduleTime).setValueAtTime(freqModLFO, scheduleTime);
  }
  setFreqVibLFO(channel2, note2, scheduleTime) {
    const vibratoRate = this.getRelativeKeyBasedValue(channel2, note2, 76) * 2;
    const freqVibLFO = note2.voiceParams.freqVibLFO;
    note2.vibratoLFO.frequency.cancelScheduledValues(scheduleTime).setValueAtTime(freqVibLFO * vibratoRate, scheduleTime);
  }
  setDelayVibLFO(channel2, note2) {
    const vibratoDelay = this.getRelativeKeyBasedValue(channel2, note2, 78) * 2;
    const value = note2.voiceParams.delayVibLFO;
    const startTime = note2.startTime + value * vibratoDelay;
    try {
      note2.vibratoLFO.start(startTime);
    } catch {
    }
  }
  createVoiceParamsHandlers() {
    return {
      modLfoToPitch: (channel2, note2, scheduleTime) => {
        if (0 < channel2.state.modulationDepth) {
          this.setModLfoToPitch(channel2, note2, scheduleTime);
        }
      },
      vibLfoToPitch: (channel2, note2, scheduleTime) => {
        if (0 < channel2.state.vibratoDepth) {
          this.setVibLfoToPitch(channel2, note2, scheduleTime);
        }
      },
      modLfoToFilterFc: (channel2, note2, scheduleTime) => {
        if (0 < channel2.state.modulationDepth) {
          this.setModLfoToFilterFc(channel2, note2, scheduleTime);
        }
      },
      modLfoToVolume: (channel2, note2, scheduleTime) => {
        if (0 < channel2.state.modulationDepth) {
          this.setModLfoToVolume(channel2, note2, scheduleTime);
        }
      },
      chorusEffectsSend: (channel2, note2, scheduleTime) => {
        this.setChorusSend(channel2, note2, scheduleTime);
      },
      reverbEffectsSend: (channel2, note2, scheduleTime) => {
        this.setReverbSend(channel2, note2, scheduleTime);
      },
      delayModLFO: (_channel, note2, _scheduleTime) => {
        if (0 < channel.state.modulationDepth) {
          this.setDelayModLFO(note2);
        }
      },
      freqModLFO: (_channel, note2, scheduleTime) => {
        if (0 < channel.state.modulationDepth) {
          this.setFreqModLFO(note2, scheduleTime);
        }
      },
      delayVibLFO: (channel2, note2, _scheduleTime) => {
        if (0 < channel2.state.vibratoDepth) {
          setDelayVibLFO(channel2, note2);
        }
      },
      freqVibLFO: (channel2, note2, scheduleTime) => {
        if (0 < channel2.state.vibratoDepth) {
          this.setFreqVibLFO(channel2, note2, scheduleTime);
        }
      }
    };
  }
  getControllerState(channel2, noteNumber, velocity, polyphonicKeyPressure) {
    const state = new Float32Array(channel2.state.array.length);
    state.set(channel2.state.array);
    state[2] = velocity / 127;
    state[3] = noteNumber / 127;
    state[10] = polyphonicKeyPressure / 127;
    state[13] = state.channelPressure / 127;
    return state;
  }
  applyVoiceParams(channel2, controllerType, scheduleTime) {
    this.processScheduledNotes(channel2, (note2) => {
      const controllerState = this.getControllerState(
        channel2,
        note2.noteNumber,
        note2.velocity,
        note2.pressure
      );
      const voiceParams = note2.voice.getParams(controllerType, controllerState);
      let applyVolumeEnvelope = false;
      let applyFilterEnvelope = false;
      let applyPitchEnvelope = false;
      for (const [key, value] of Object.entries(voiceParams)) {
        const prevValue = note2.voiceParams[key];
        if (value === prevValue) continue;
        note2.voiceParams[key] = value;
        if (key in this.voiceParamsHandlers) {
          this.voiceParamsHandlers[key](channel2, note2, scheduleTime);
        } else {
          if (volumeEnvelopeKeySet.has(key)) applyVolumeEnvelope = true;
          if (filterEnvelopeKeySet.has(key)) applyFilterEnvelope = true;
          if (pitchEnvelopeKeySet.has(key)) applyPitchEnvelope = true;
        }
      }
      if (applyVolumeEnvelope) {
        this.setVolumeEnvelope(channel2, note2, scheduleTime);
      }
      if (applyFilterEnvelope) {
        this.setFilterEnvelope(channel2, note2, scheduleTime);
      }
      if (applyPitchEnvelope) this.setPitchEnvelope(note2, scheduleTime);
    });
  }
  createControlChangeHandlers() {
    const handlers = new Array(128);
    handlers[0] = this.setBankMSB;
    handlers[1] = this.setModulationDepth;
    handlers[5] = this.setPortamentoTime;
    handlers[6] = this.dataEntryMSB;
    handlers[7] = this.setVolume;
    handlers[10] = this.setPan;
    handlers[11] = this.setExpression;
    handlers[32] = this.setBankLSB;
    handlers[38] = this.dataEntryLSB;
    handlers[64] = this.setSustainPedal;
    handlers[65] = this.setPortamento;
    handlers[66] = this.setSostenutoPedal;
    handlers[67] = this.setSoftPedal;
    handlers[71] = this.setFilterResonance;
    handlers[72] = this.setReleaseTime;
    handlers[73] = this.setAttackTime;
    handlers[74] = this.setBrightness;
    handlers[75] = this.setDecayTime;
    handlers[76] = this.setVibratoRate;
    handlers[77] = this.setVibratoDepth;
    handlers[78] = this.setVibratoDelay;
    handlers[91] = this.setReverbSendLevel;
    handlers[93] = this.setChorusSendLevel;
    handlers[96] = this.dataIncrement;
    handlers[97] = this.dataDecrement;
    handlers[100] = this.setRPNLSB;
    handlers[101] = this.setRPNMSB;
    handlers[120] = this.allSoundOff;
    handlers[121] = this.resetAllControllers;
    handlers[123] = this.allNotesOff;
    handlers[124] = this.omniOff;
    handlers[125] = this.omniOn;
    handlers[126] = this.monoOn;
    handlers[127] = this.polyOn;
    return handlers;
  }
  setControlChange(channelNumber, controllerType, value, scheduleTime) {
    const handler = this.controlChangeHandlers[controllerType];
    if (handler) {
      handler.call(this, channelNumber, value, scheduleTime);
      const channel2 = this.channels[channelNumber];
      this.applyVoiceParams(channel2, controllerType + 128, scheduleTime);
      this.setControlChangeEffects(channel2, controllerType, scheduleTime);
    } else {
      console.warn(
        `Unsupported Control change: controllerType=${controllerType} value=${value}`
      );
    }
  }
  setBankMSB(channelNumber, msb) {
    this.channels[channelNumber].bankMSB = msb;
  }
  updateModulation(channel2, scheduleTime) {
    const depth = channel2.state.modulationDepth * channel2.modulationDepthRange;
    this.processScheduledNotes(channel2, (note2) => {
      if (note2.modulationDepth) {
        note2.modulationDepth.gain.setValueAtTime(depth, scheduleTime);
      } else {
        this.startModulation(channel2, note2, scheduleTime);
      }
    });
  }
  setModulationDepth(channelNumber, modulation, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel2.state.modulationDepth = modulation / 127;
    this.updateModulation(channel2, scheduleTime);
  }
  updatePortamento(channel2, scheduleTime) {
    this.processScheduledNotes(channel2, (note2) => {
      if (0.5 <= channel2.state.portamento) {
        if (0 <= note2.portamentoNoteNumber) {
          this.setPortamentoVolumeEnvelope(channel2, note2, scheduleTime);
          this.setPortamentoFilterEnvelope(channel2, note2, scheduleTime);
          this.setPortamentoPitchEnvelope(note2, scheduleTime);
          this.updateDetune(channel2, note2, scheduleTime);
        }
      } else {
        if (0 <= note2.portamentoNoteNumber) {
          this.setVolumeEnvelope(channel2, note2, scheduleTime);
          this.setFilterEnvelope(channel2, note2, scheduleTime);
          this.setPitchEnvelope(note2, scheduleTime);
          this.updateDetune(channel2, note2, scheduleTime);
        }
      }
    });
  }
  setPortamentoTime(channelNumber, portamentoTime, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    scheduleTime ??= this.audioContext.currentTime;
    channel2.state.portamentoTime = portamentoTime / 127;
    if (channel2.isDrum) return;
    this.updatePortamento(channel2, scheduleTime);
  }
  setVolume(channelNumber, volume, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel2 = this.channels[channelNumber];
    channel2.state.volume = volume / 127;
    if (channel2.isDrum) {
      for (let i = 0; i < 128; i++) {
        this.updateKeyBasedVolume(channel2, i, scheduleTime);
      }
    } else {
      this.updateChannelVolume(channel2, scheduleTime);
    }
  }
  panToGain(pan) {
    const theta = Math.PI / 2 * Math.max(0, pan * 127 - 1) / 126;
    return {
      gainLeft: Math.cos(theta),
      gainRight: Math.sin(theta)
    };
  }
  setPan(channelNumber, pan, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel2 = this.channels[channelNumber];
    channel2.state.pan = pan / 127;
    if (channel2.isDrum) {
      for (let i = 0; i < 128; i++) {
        this.updateKeyBasedVolume(channel2, i, scheduleTime);
      }
    } else {
      this.updateChannelVolume(channel2, scheduleTime);
    }
  }
  setExpression(channelNumber, expression, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel2 = this.channels[channelNumber];
    channel2.state.expression = expression / 127;
    this.updateChannelVolume(channel2, scheduleTime);
  }
  setBankLSB(channelNumber, lsb) {
    this.channels[channelNumber].bankLSB = lsb;
  }
  dataEntryLSB(channelNumber, value, scheduleTime) {
    this.channels[channelNumber].dataLSB = value;
    this.handleRPN(channelNumber, 0, scheduleTime);
  }
  updateChannelVolume(channel2, scheduleTime) {
    const state = channel2.state;
    const volume = state.volume * state.expression;
    const { gainLeft, gainRight } = this.panToGain(state.pan);
    channel2.gainL.gain.cancelScheduledValues(scheduleTime).setValueAtTime(volume * gainLeft, scheduleTime);
    channel2.gainR.gain.cancelScheduledValues(scheduleTime).setValueAtTime(volume * gainRight, scheduleTime);
  }
  updateKeyBasedVolume(channel2, keyNumber, scheduleTime) {
    const gainL = channel2.keyBasedGainLs[keyNumber];
    if (!gainL) return;
    const gainR = channel2.keyBasedGainRs[keyNumber];
    const state = channel2.state;
    const defaultVolume = state.volume * state.expression;
    const defaultPan = state.pan;
    const keyBasedVolume = this.getKeyBasedValue(channel2, keyNumber, 7);
    const volume = 0 <= keyBasedVolume ? defaultVolume * keyBasedVolume / 64 : defaultVolume;
    const keyBasedPan = this.getKeyBasedValue(channel2, keyNumber, 10);
    const pan = 0 <= keyBasedPan ? keyBasedPan / 127 : defaultPan;
    const { gainLeft, gainRight } = this.panToGain(pan);
    gainL.gain.cancelScheduledValues(scheduleTime).setValueAtTime(volume * gainLeft, scheduleTime);
    gainR.gain.cancelScheduledValues(scheduleTime).setValueAtTime(volume * gainRight, scheduleTime);
  }
  setSustainPedal(channelNumber, value, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel2.state.sustainPedal = value / 127;
    if (64 <= value) {
      this.processScheduledNotes(channel2, (note2) => {
        channel2.sustainNotes.push(note2);
      });
    } else {
      this.releaseSustainPedal(channelNumber, value, scheduleTime);
    }
  }
  setPortamento(channelNumber, value, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel2.state.portamento = value / 127;
    this.updatePortamento(channel2, scheduleTime);
  }
  setSostenutoPedal(channelNumber, value, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel2.state.sostenutoPedal = value / 127;
    if (64 <= value) {
      const sostenutoNotes = [];
      this.processActiveNotes(channel2, scheduleTime, (note2) => {
        sostenutoNotes.push(note2);
      });
      channel2.sostenutoNotes = sostenutoNotes;
    } else {
      this.releaseSostenutoPedal(channelNumber, value, scheduleTime);
    }
  }
  getSoftPedalFactor(channel2, note2) {
    return 1 - (0.1 + note2.noteNumber / 127 * 0.2) * channel2.state.softPedal;
  }
  setSoftPedal(channelNumber, softPedal, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    const state = channel2.state;
    scheduleTime ??= this.audioContext.currentTime;
    state.softPedal = softPedal / 127;
    this.processScheduledNotes(channel2, (note2) => {
      if (0.5 <= state.portamento && 0 <= note2.portamentoNoteNumber) {
        this.setPortamentoVolumeEnvelope(channel2, note2, scheduleTime);
        this.setPortamentoFilterEnvelope(channel2, note2, scheduleTime);
      } else {
        this.setVolumeEnvelope(channel2, note2, scheduleTime);
        this.setFilterEnvelope(channel2, note2, scheduleTime);
      }
    });
  }
  setFilterResonance(channelNumber, ccValue, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    const state = channel2.state;
    state.filterResonance = ccValue / 127;
    const filterResonance = this.getRelativeKeyBasedValue(channel2, note, 71);
    this.processScheduledNotes(channel2, (note2) => {
      const Q = note2.voiceParams.initialFilterQ / 5 * filterResonance;
      note2.filterNode.Q.setValueAtTime(Q, scheduleTime);
    });
  }
  getRelativeKeyBasedValue(channel2, note2, controllerType) {
    const ccState = channel2.state.array[128 + controllerType];
    const keyBasedValue = this.getKeyBasedValue(
      channel2,
      note2.noteNumber,
      controllerType
    );
    if (keyBasedValue < 0) return ccState;
    const keyValue = ccState + keyBasedValue / 127 - 0.5;
    return keyValue < 0 ? keyValue : 0;
  }
  setReleaseTime(channelNumber, releaseTime, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel2.state.releaseTime = releaseTime / 127;
  }
  setAttackTime(channelNumber, attackTime, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel2.state.attackTime = attackTime / 127;
    this.processScheduledNotes(channel2, (note2) => {
      if (scheduleTime < note2.startTime) {
        this.setVolumeEnvelope(channel2, note2, scheduleTime);
      }
    });
  }
  setBrightness(channelNumber, brightness, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    const state = channel2.state;
    scheduleTime ??= this.audioContext.currentTime;
    state.brightness = brightness / 127;
    this.processScheduledNotes(channel2, (note2) => {
      if (0.5 <= state.portamento && 0 <= note2.portamentoNoteNumber) {
        this.setPortamentoFilterEnvelope(channel2, note2, scheduleTime);
      } else {
        this.setFilterEnvelope(channel2, note2, scheduleTime);
      }
    });
  }
  setDecayTime(channelNumber, dacayTime, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel2.state.decayTime = dacayTime / 127;
    this.processScheduledNotes(channel2, (note2) => {
      this.setVolumeEnvelope(channel2, note2, scheduleTime);
    });
  }
  setVibratoRate(channelNumber, vibratoRate, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel2.state.vibratoRate = vibratoRate / 127;
    if (channel2.vibratoDepth <= 0) return;
    this.processScheduledNotes(channel2, (note2) => {
      this.setVibLfoToPitch(channel2, note2, scheduleTime);
    });
  }
  setVibratoDepth(channelNumber, vibratoDepth, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    const prev = channel2.state.vibratoDepth;
    channel2.state.vibratoDepth = vibratoDepth / 127;
    if (0 < prev) {
      this.processScheduledNotes(channel2, (note2) => {
        this.setFreqVibLFO(channel2, note2, scheduleTime);
      });
    } else {
      this.processScheduledNotes(channel2, (note2) => {
        this.startVibrato(channel2, note2, scheduleTime);
      });
    }
  }
  setVibratoDelay(channelNumber, vibratoDelay, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel2.state.vibratoDelay = vibratoDelay / 127;
    if (0 < channel2.state.vibratoDepth) {
      this.processScheduledNotes(channel2, (note2) => {
        this.startVibrato(channel2, note2, scheduleTime);
      });
    }
  }
  setReverbSendLevel(channelNumber, reverbSendLevel, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel2 = this.channels[channelNumber];
    const state = channel2.state;
    state.reverbSendLevel = reverbSendLevel / 127;
    this.processScheduledNotes(channel2, (note2) => {
      this.setReverbSend(channel2, note2, scheduleTime);
    });
  }
  setChorusSendLevel(channelNumber, chorusSendLevel, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    const channel2 = this.channels[channelNumber];
    const state = channel2.state;
    state.chorusSendLevel = chorusSendLevel / 127;
    this.processScheduledNotes(channel2, (note2) => {
      this.setChorusSend(channel2, note2, scheduleTime);
    });
  }
  limitData(channel2, minMSB, maxMSB, minLSB, maxLSB) {
    if (maxLSB < channel2.dataLSB) {
      channel2.dataMSB++;
      channel2.dataLSB = minLSB;
    } else if (channel2.dataLSB < 0) {
      channel2.dataMSB--;
      channel2.dataLSB = maxLSB;
    }
    if (maxMSB < channel2.dataMSB) {
      channel2.dataMSB = maxMSB;
      channel2.dataLSB = maxLSB;
    } else if (channel2.dataMSB < 0) {
      channel2.dataMSB = minMSB;
      channel2.dataLSB = minLSB;
    }
  }
  limitDataMSB(channel2, minMSB, maxMSB) {
    if (maxMSB < channel2.dataMSB) {
      channel2.dataMSB = maxMSB;
    } else if (channel2.dataMSB < 0) {
      channel2.dataMSB = minMSB;
    }
  }
  handleRPN(channelNumber, value, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    const rpn = channel2.rpnMSB * 128 + channel2.rpnLSB;
    switch (rpn) {
      case 0:
        channel2.dataLSB += value;
        this.handlePitchBendRangeRPN(channelNumber, scheduleTime);
        break;
      case 1:
        channel2.dataLSB += value;
        this.handleFineTuningRPN(channelNumber, scheduleTime);
        break;
      case 2:
        channel2.dataMSB += value;
        this.handleCoarseTuningRPN(channelNumber, scheduleTime);
        break;
      case 5:
        channel2.dataLSB += value;
        this.handleModulationDepthRangeRPN(channelNumber, scheduleTime);
        break;
      default:
        console.warn(
          `Channel ${channelNumber}: Unsupported RPN MSB=${channel2.rpnMSB} LSB=${channel2.rpnLSB}`
        );
    }
  }
  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp18.pdf
  dataIncrement(channelNumber, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    this.handleRPN(channelNumber, 1, scheduleTime);
  }
  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp18.pdf
  dataDecrement(channelNumber, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    this.handleRPN(channelNumber, -1, scheduleTime);
  }
  setRPNMSB(channelNumber, value) {
    this.channels[channelNumber].rpnMSB = value;
  }
  setRPNLSB(channelNumber, value) {
    this.channels[channelNumber].rpnLSB = value;
  }
  dataEntryMSB(channelNumber, value, scheduleTime) {
    this.channels[channelNumber].dataMSB = value;
    this.handleRPN(channelNumber, 0, scheduleTime);
  }
  handlePitchBendRangeRPN(channelNumber, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    this.limitData(channel2, 0, 127, 0, 127);
    const pitchBendRange = (channel2.dataMSB + channel2.dataLSB / 128) * 100;
    this.setPitchBendRange(channelNumber, pitchBendRange, scheduleTime);
  }
  setPitchBendRange(channelNumber, value, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    const state = channel2.state;
    const prev = state.pitchWheelSensitivity;
    const next = value / 12800;
    state.pitchWheelSensitivity = next;
    channel2.detune += (state.pitchWheel * 2 - 1) * (next - prev) * 12800;
    this.updateChannelDetune(channel2, scheduleTime);
    this.applyVoiceParams(channel2, 16, scheduleTime);
  }
  handleFineTuningRPN(channelNumber, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    this.limitData(channel2, 0, 127, 0, 127);
    const value = channel2.dataMSB * 128 + channel2.dataLSB;
    const fineTuning = (value - 8192) / 8192 * 100;
    this.setFineTuning(channelNumber, fineTuning, scheduleTime);
  }
  setFineTuning(channelNumber, value, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    const prev = channel2.fineTuning;
    const next = value;
    channel2.fineTuning = next;
    channel2.detune += next - prev;
    this.updateChannelDetune(channel2, scheduleTime);
  }
  handleCoarseTuningRPN(channelNumber, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    this.limitDataMSB(channel2, 0, 127);
    const coarseTuning = (channel2.dataMSB - 64) * 100;
    this.setCoarseTuning(channelNumber, coarseTuning, scheduleTime);
  }
  setCoarseTuning(channelNumber, value, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    const prev = channel2.coarseTuning;
    const next = value;
    channel2.coarseTuning = next;
    channel2.detune += next - prev;
    this.updateChannelDetune(channel2, scheduleTime);
  }
  handleModulationDepthRangeRPN(channelNumber, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    this.limitData(channel2, 0, 127, 0, 127);
    const value = (channel2.dataMSB + channel2.dataLSB / 128) * 100;
    this.setModulationDepthRange(channelNumber, value, scheduleTime);
  }
  setModulationDepthRange(channelNumber, value, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    scheduleTime ??= this.audioContext.currentTime;
    channel2.modulationDepthRange = value;
    this.updateModulation(channel2, scheduleTime);
  }
  allSoundOff(channelNumber, _value, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    return this.stopActiveNotes(channelNumber, 0, true, scheduleTime);
  }
  resetChannelStates(channelNumber) {
    const scheduleTime = this.audioContext.currentTime;
    const channel2 = this.channels[channelNumber];
    const state = channel2.state;
    const entries = Object.entries(defaultControllerState);
    for (const [key, { type, defaultValue }] of entries) {
      if (128 <= type) {
        this.setControlChange(
          channelNumber,
          type - 128,
          Math.ceil(defaultValue * 127),
          scheduleTime
        );
      } else {
        state[key] = defaultValue;
      }
    }
    for (const key of Object.keys(this.constructor.channelSettings)) {
      channel2[key] = this.constructor.channelSettings[key];
    }
    this.resetChannelTable(channel2);
    this.mode = "GM2";
    this.masterFineTuning = 0;
    this.masterCoarseTuning = 0;
  }
  // https://amei.or.jp/midistandardcommittee/Recommended_Practice/e/rp15.pdf
  resetAllControllers(channelNumber, _value, scheduleTime) {
    const keys = [
      "polyphonicKeyPressure",
      "channelPressure",
      "pitchWheel",
      "expression",
      "modulationDepth",
      "sustainPedal",
      "portamento",
      "sostenutoPedal",
      "softPedal"
    ];
    const channel2 = this.channels[channelNumber];
    const state = channel2.state;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const { type, defaultValue } = defaultControllerState[key];
      if (128 <= type) {
        this.setControlChange(
          channelNumber,
          type - 128,
          Math.ceil(defaultValue * 127),
          scheduleTime
        );
      } else {
        state[key] = defaultValue;
      }
    }
    this.setPitchBend(channelNumber, 8192, scheduleTime);
    const settingTypes = [
      "rpnMSB",
      "rpnLSB"
    ];
    for (let i = 0; i < settingTypes.length; i++) {
      const type = settingTypes[i];
      channel2[type] = this.constructor.channelSettings[type];
    }
  }
  allNotesOff(channelNumber, _value, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    return this.stopActiveNotes(channelNumber, 0, false, scheduleTime);
  }
  omniOff(channelNumber, value, scheduleTime) {
    this.allNotesOff(channelNumber, value, scheduleTime);
  }
  omniOn(channelNumber, value, scheduleTime) {
    this.allNotesOff(channelNumber, value, scheduleTime);
  }
  monoOn(channelNumber, value, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    this.allNotesOff(channelNumber, value, scheduleTime);
    channel2.mono = true;
  }
  polyOn(channelNumber, value, scheduleTime) {
    const channel2 = this.channels[channelNumber];
    this.allNotesOff(channelNumber, value, scheduleTime);
    channel2.mono = false;
  }
  handleUniversalNonRealTimeExclusiveMessage(data, scheduleTime) {
    switch (data[2]) {
      case 8:
        switch (data[3]) {
          case 8:
            return this.handleScaleOctaveTuning1ByteFormatSysEx(
              data,
              false,
              scheduleTime
            );
          case 9:
            return this.handleScaleOctaveTuning2ByteFormatSysEx(
              data,
              false,
              scheduleTime
            );
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 9:
        switch (data[3]) {
          case 1:
            this.GM1SystemOn(scheduleTime);
            break;
          case 2:
            break;
          case 3:
            this.GM2SystemOn(scheduleTime);
            break;
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }
  GM1SystemOn(scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    this.mode = "GM1";
    for (let i = 0; i < this.channels.length; i++) {
      this.allSoundOff(i, 0, scheduleTime);
      const channel2 = this.channels[i];
      channel2.bankMSB = 0;
      channel2.bankLSB = 0;
      channel2.bank = 0;
      channel2.isDrum = false;
    }
    this.channels[9].bankMSB = 1;
    this.channels[9].bank = 128;
    this.channels[9].isDrum = true;
  }
  GM2SystemOn(scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    this.mode = "GM2";
    for (let i = 0; i < this.channels.length; i++) {
      this.allSoundOff(i, 0, scheduleTime);
      const channel2 = this.channels[i];
      channel2.bankMSB = 121;
      channel2.bankLSB = 0;
      channel2.bank = 121 * 128;
      channel2.isDrum = false;
    }
    this.channels[9].bankMSB = 120;
    this.channels[9].bank = 120 * 128;
    this.channels[9].isDrum = true;
  }
  handleUniversalRealTimeExclusiveMessage(data, scheduleTime) {
    switch (data[2]) {
      case 4:
        switch (data[3]) {
          case 1:
            return this.handleMasterVolumeSysEx(data, scheduleTime);
          case 3:
            return this.handleMasterFineTuningSysEx(data, scheduleTime);
          case 4:
            return this.handleMasterCoarseTuningSysEx(data, scheduleTime);
          case 5:
            return this.handleGlobalParameterControlSysEx(data, scheduleTime);
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 8:
        switch (data[3]) {
          case 8:
            return this.handleScaleOctaveTuning1ByteFormatSysEx(
              data,
              true,
              scheduleTime
            );
          case 9:
            return this.handleScaleOctaveTuning2ByteFormatSysEx(
              data,
              true,
              scheduleTime
            );
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 9:
        switch (data[3]) {
          case 1:
            return this.handlePressureSysEx(
              data,
              "channelPressureTable",
              scheduleTime
            );
          case 2:
            return this.handlePressureSysEx(
              data,
              "polyphonicKeyPressureTable",
              scheduleTime
            );
          case 3:
            return this.handleControlChangeSysEx(data, scheduleTime);
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 10:
        switch (data[3]) {
          case 1:
            return this.handleKeyBasedInstrumentControlSysEx(
              data,
              scheduleTime
            );
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }
  handleMasterVolumeSysEx(data, scheduleTime) {
    const volume = (data[5] * 128 + data[4]) / 16383;
    this.setMasterVolume(volume, scheduleTime);
  }
  setMasterVolume(volume, scheduleTime) {
    scheduleTime ??= this.audioContext.currentTime;
    if (volume < 0 && 1 < volume) {
      console.error("Master Volume is out of range");
    } else {
      this.masterVolume.gain.cancelScheduledValues(scheduleTime).setValueAtTime(volume * volume, scheduleTime);
    }
  }
  handleMasterFineTuningSysEx(data, scheduleTime) {
    const value = (data[5] * 128 + data[4]) / 16383;
    const fineTuning = (value - 8192) / 8192 * 100;
    this.setMasterFineTuning(fineTuning, scheduleTime);
  }
  setMasterFineTuning(value, scheduleTime) {
    const prev = this.masterFineTuning;
    const next = value;
    this.masterFineTuning = next;
    const detuneChange = next - prev;
    for (let i = 0; i < this.channels.length; i++) {
      const channel2 = this.channels[i];
      if (channel2.isDrum) continue;
      channel2.detune += detuneChange;
      this.updateChannelDetune(channel2, scheduleTime);
    }
  }
  handleMasterCoarseTuningSysEx(data, scheduleTime) {
    const coarseTuning = (data[4] - 64) * 100;
    this.setMasterCoarseTuning(coarseTuning, scheduleTime);
  }
  setMasterCoarseTuning(value, scheduleTime) {
    const prev = this.masterCoarseTuning;
    const next = value;
    this.masterCoarseTuning = next;
    const detuneChange = next - prev;
    for (let i = 0; i < this.channels.length; i++) {
      const channel2 = this.channels[i];
      if (channel2.isDrum) continue;
      channel2.detune += detuneChange;
      this.updateChannelDetune(channel2, scheduleTime);
    }
  }
  handleGlobalParameterControlSysEx(data, scheduleTime) {
    if (data[7] === 1) {
      switch (data[8]) {
        case 1:
          return this.handleReverbParameterSysEx(data);
        case 2:
          return this.handleChorusParameterSysEx(data, scheduleTime);
        default:
          console.warn(
            `Unsupported Global Parameter Control Message: ${data}`
          );
      }
    } else {
      console.warn(`Unsupported Global Parameter Control Message: ${data}`);
    }
  }
  handleReverbParameterSysEx(data) {
    switch (data[9]) {
      case 0:
        return this.setReverbType(data[10]);
      case 1:
        return this.setReverbTime(data[10]);
    }
  }
  setReverbType(type) {
    this.reverb.time = this.getReverbTimeFromType(type);
    this.reverb.feedback = type === 8 ? 0.9 : 0.8;
    this.reverbEffect = this.createReverbEffect(this.audioContext);
  }
  getReverbTimeFromType(type) {
    switch (type) {
      case 0:
        return this.getReverbTime(44);
      case 1:
        return this.getReverbTime(50);
      case 2:
        return this.getReverbTime(56);
      case 3:
        return this.getReverbTime(64);
      case 4:
        return this.getReverbTime(64);
      case 8:
        return this.getReverbTime(50);
      default:
        console.warn(`Unsupported Reverb Time: ${type}`);
    }
  }
  setReverbTime(value) {
    this.reverb.time = this.getReverbTime(value);
    this.reverbEffect = this.createReverbEffect(this.audioContext);
  }
  getReverbTime(value) {
    return Math.exp((value - 40) * 0.025);
  }
  // mean free path equation
  //   https://repository.dl.itc.u-tokyo.ac.jp/record/8550/files/A31912.pdf
  //     江田和司, 拡散性制御に基づく室内音響設計に向けた音場解析に関する研究, 2015
  //   V: room size (m^3)
  //   S: room surface area (m^2)
  //   meanFreePath = 4V / S (m)
  // delay estimation using mean free path
  //   t: degree Celsius, generally used 20
  //   c: speed of sound = 331.5 + 0.61t = 331.5 * 0.61 * 20 = 343.7 (m/s)
  //   delay = meanFreePath / c (s)
  // feedback equation
  //   RT60 means that the energy is reduced to Math.pow(10, -6).
  //   Since energy is proportional to the square of the amplitude,
  //   the amplitude is reduced to Math.pow(10, -3).
  //   When this is done through n feedbacks,
  //   Math.pow(feedback, n) = Math.pow(10, -3)
  //   Math.pow(feedback, RT60 / delay) = Math.pow(10, -3)
  //   RT60 / delay * Math.log10(feedback) = -3
  //   RT60 = -3 * delay / Math.log10(feedback)
  //   feedback = Math.pow(10, -3 * delay / RT60)
  // delay estimation using ideal feedback
  //   The structure of a concert hall is complex,
  //   so estimates based on mean free path are unstable.
  //   It is easier to determine the delay based on ideal feedback.
  //   The average sound absorption coefficient
  //   suitable for playing musical instruments is 0.18 to 0.28.
  //   delay = -RT60 * Math.log10(feedback) / 3
  calcDelay(rt60, feedback) {
    return -rt60 * Math.log10(feedback) / 3;
  }
  handleChorusParameterSysEx(data, scheduleTime) {
    switch (data[9]) {
      case 0:
        return this.setChorusType(data[10], scheduleTime);
      case 1:
        return this.setChorusModRate(data[10], scheduleTime);
      case 2:
        return this.setChorusModDepth(data[10], scheduleTime);
      case 3:
        return this.setChorusFeedback(data[10], scheduleTime);
      case 4:
        return this.setChorusSendToReverb(data[10], scheduleTime);
    }
  }
  setChorusType(type, scheduleTime) {
    switch (type) {
      case 0:
        return this.setChorusParameter(3, 5, 0, 0, scheduleTime);
      case 1:
        return this.setChorusParameter(9, 19, 5, 0, scheduleTime);
      case 2:
        return this.setChorusParameter(3, 19, 8, 0, scheduleTime);
      case 3:
        return this.setChorusParameter(9, 16, 16, 0, scheduleTime);
      case 4:
        return this.setChorusParameter(2, 24, 64, 0, scheduleTime);
      case 5:
        return this.setChorusParameter(1, 5, 112, 0, scheduleTime);
      default:
        console.warn(`Unsupported Chorus Type: ${type}`);
    }
  }
  setChorusParameter(modRate, modDepth, feedback, sendToReverb, scheduleTime) {
    this.setChorusModRate(modRate, scheduleTime);
    this.setChorusModDepth(modDepth, scheduleTime);
    this.setChorusFeedback(feedback, scheduleTime);
    this.setChorusSendToReverb(sendToReverb, scheduleTime);
  }
  setChorusModRate(value, scheduleTime) {
    const modRate = this.getChorusModRate(value);
    this.chorus.modRate = modRate;
    this.chorusEffect.lfo.frequency.setValueAtTime(modRate, scheduleTime);
  }
  getChorusModRate(value) {
    return value * 0.122;
  }
  setChorusModDepth(value, scheduleTime) {
    const modDepth = this.getChorusModDepth(value);
    this.chorus.modDepth = modDepth;
    this.chorusEffect.lfoGain.gain.cancelScheduledValues(scheduleTime).setValueAtTime(modDepth / 2, scheduleTime);
  }
  getChorusModDepth(value) {
    return (value + 1) / 3200;
  }
  setChorusFeedback(value, scheduleTime) {
    const feedback = this.getChorusFeedback(value);
    this.chorus.feedback = feedback;
    const chorusEffect = this.chorusEffect;
    for (let i = 0; i < chorusEffect.feedbackGains.length; i++) {
      chorusEffect.feedbackGains[i].gain.cancelScheduledValues(scheduleTime).setValueAtTime(feedback, scheduleTime);
    }
  }
  getChorusFeedback(value) {
    return value * 763e-5;
  }
  setChorusSendToReverb(value, scheduleTime) {
    const sendToReverb = this.getChorusSendToReverb(value);
    const sendGain = this.chorusEffect.sendGain;
    if (0 < this.chorus.sendToReverb) {
      this.chorus.sendToReverb = sendToReverb;
      if (0 < sendToReverb) {
        sendGain.gain.cancelScheduledValues(scheduleTime).setValueAtTime(sendToReverb, scheduleTime);
      } else {
        sendGain.disconnect();
      }
    } else {
      this.chorus.sendToReverb = sendToReverb;
      if (0 < sendToReverb) {
        sendGain.connect(this.reverbEffect.input);
        sendGain.gain.cancelScheduledValues(scheduleTime).setValueAtTime(sendToReverb, scheduleTime);
      }
    }
  }
  getChorusSendToReverb(value) {
    return value * 787e-5;
  }
  getChannelBitmap(data) {
    const bitmap = new Array(this.channels.length).fill(false);
    const ff = data[4] & 3;
    const gg = data[5] & 127;
    const hh = data[6] & 127;
    for (let bit = 0; bit < 7; bit++) {
      if (hh & 1 << bit) bitmap[bit] = true;
    }
    for (let bit = 0; bit < 7; bit++) {
      if (gg & 1 << bit) bitmap[bit + 7] = true;
    }
    for (let bit = 0; bit < 2; bit++) {
      if (ff & 1 << bit) bitmap[bit + 14] = true;
    }
    return bitmap;
  }
  handleScaleOctaveTuning1ByteFormatSysEx(data, realtime, scheduleTime) {
    if (data.length < 19) {
      console.error("Data length is too short");
      return;
    }
    const channelBitmap = this.getChannelBitmap(data);
    for (let i = 0; i < channelBitmap.length; i++) {
      if (!channelBitmap[i]) continue;
      const channel2 = this.channels[i];
      if (channel2.isDrum) continue;
      for (let j = 0; j < 12; j++) {
        const centValue = data[j + 7] - 64;
        channel2.scaleOctaveTuningTable[j] = centValue;
      }
      if (realtime) this.updateChannelDetune(channel2, scheduleTime);
    }
  }
  handleScaleOctaveTuning2ByteFormatSysEx(data, realtime, scheduleTime) {
    if (data.length < 31) {
      console.error("Data length is too short");
      return;
    }
    const channelBitmap = this.getChannelBitmap(data);
    for (let i = 0; i < channelBitmap.length; i++) {
      if (!channelBitmap[i]) continue;
      const channel2 = this.channels[i];
      if (channel2.isDrum) continue;
      for (let j = 0; j < 12; j++) {
        const index = 7 + j * 2;
        const msb = data[index] & 127;
        const lsb = data[index + 1] & 127;
        const value14bit = msb * 128 + lsb;
        const centValue = (value14bit - 8192) / 8.192;
        channel2.scaleOctaveTuningTable[j] = centValue;
      }
      if (realtime) this.updateChannelDetune(channel2, scheduleTime);
    }
  }
  getPitchControl(channel2, note2) {
    const polyphonicKeyPressureRaw = channel2.polyphonicKeyPressureTable[0];
    if (polyphonicKeyPressureRaw < 0) return 0;
    const polyphonicKeyPressure = (polyphonicKeyPressureRaw - 64) * note2.pressure;
    return polyphonicKeyPressure * note2.pressure / 37.5;
  }
  getFilterCutoffControl(channel2, note2) {
    const channelPressureRaw = channel2.channelPressureTable[1];
    const channelPressure = 0 <= channelPressureRaw ? (channelPressureRaw - 64) * channel2.state.channelPressure : 0;
    const polyphonicKeyPressureRaw = channel2.polyphonicKeyPressureTable[1];
    const polyphonicKeyPressure = 0 <= polyphonicKeyPressureRaw ? (polyphonicKeyPressureRaw - 64) * note2.pressure : 0;
    return (channelPressure + polyphonicKeyPressure) * 15;
  }
  getAmplitudeControl(channel2, note2) {
    const channelPressureRaw = channel2.channelPressureTable[2];
    const channelPressure = 0 <= channelPressureRaw ? channelPressureRaw * channel2.state.channelPressure : 0;
    const polyphonicKeyPressureRaw = channel2.polyphonicKeyPressureTable[2];
    const polyphonicKeyPressure = 0 <= polyphonicKeyPressureRaw ? polyphonicKeyPressureRaw * note2.pressure : 0;
    return (channelPressure + polyphonicKeyPressure) / 128;
  }
  getLFOPitchDepth(channel2, note2) {
    const channelPressureRaw = channel2.channelPressureTable[3];
    const channelPressure = 0 <= channelPressureRaw ? channelPressureRaw * channel2.state.channelPressure : 0;
    const polyphonicKeyPressureRaw = channel2.polyphonicKeyPressureTable[3];
    const polyphonicKeyPressure = 0 <= polyphonicKeyPressureRaw ? polyphonicKeyPressureRaw * note2.pressure : 0;
    return (channelPressure + polyphonicKeyPressure) / 254 * 600;
  }
  getLFOFilterDepth(channel2, note2) {
    const channelPressureRaw = channel2.channelPressureTable[4];
    const channelPressure = 0 <= channelPressureRaw ? channelPressureRaw * channel2.state.channelPressure : 0;
    const polyphonicKeyPressureRaw = channel2.polyphonicKeyPressureTable[4];
    const polyphonicKeyPressure = 0 <= polyphonicKeyPressureRaw ? polyphonicKeyPressureRaw * note2.pressure : 0;
    return (channelPressure + polyphonicKeyPressure) / 254 * 2400;
  }
  getLFOAmplitudeDepth(channel2, note2) {
    const channelPressureRaw = channel2.channelPressureTable[5];
    const channelPressure = 0 <= channelPressureRaw ? channelPressureRaw * channel2.state.channelPressure : 0;
    const polyphonicKeyPressureRaw = channel2.polyphonicKeyPressureTable[5];
    const polyphonicKeyPressure = 0 <= polyphonicKeyPressureRaw ? polyphonicKeyPressureRaw * note2.pressure : 0;
    return (channelPressure + polyphonicKeyPressure) / 254;
  }
  setEffects(channel2, note2, table, scheduleTime) {
    if (0 <= table[0]) this.updateDetune(channel2, note2, scheduleTime);
    if (0.5 <= channel2.state.portamemento && 0 <= note2.portamentoNoteNumber) {
      if (0 <= table[1]) {
        this.setPortamentoFilterEnvelope(channel2, note2, scheduleTime);
      }
      if (0 <= table[2]) {
        this.setPortamentoVolumeEnvelope(channel2, note2, scheduleTime);
      }
    } else {
      if (0 <= table[1]) this.setFilterEnvelope(channel2, note2, scheduleTime);
      if (0 <= table[2]) this.setVolumeEnvelope(channel2, note2, scheduleTime);
    }
    if (0 <= table[3]) this.setModLfoToPitch(channel2, note2, scheduleTime);
    if (0 <= table[4]) this.setModLfoToFilterFc(channel2, note2, scheduleTime);
    if (0 <= table[5]) this.setModLfoToVolume(channel2, note2, scheduleTime);
  }
  handlePressureSysEx(data, tableName, scheduleTime) {
    const channelNumber = data[4];
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    const table = channel2[tableName];
    for (let i = 5; i < data.length - 1; i += 2) {
      const pp = data[i];
      const rr = data[i + 1];
      table[pp] = rr;
    }
    this.processActiveNotes(channel2, scheduleTime, (note2) => {
      this.setEffects(channel2, note2, table, scheduleTime);
    });
  }
  initControlTable() {
    const ccCount = 128;
    const slotSize = 6;
    return new Int8Array(ccCount * slotSize).fill(-1);
  }
  setControlChangeEffects(channel2, controllerType, scheduleTime) {
    const slotSize = 6;
    const offset = controllerType * slotSize;
    const table = channel2.controlTable.subarray(offset, offset + slotSize);
    this.processScheduledNotes(channel2, (note2) => {
      this.setEffects(channel2, note2, table, scheduleTime);
    });
  }
  handleControlChangeSysEx(data, scheduleTime) {
    const channelNumber = data[4];
    const channel2 = this.channels[channelNumber];
    if (channel2.isDrum) return;
    const slotSize = 6;
    const controllerType = data[5];
    const offset = controllerType * slotSize;
    const table = channel2.controlTable;
    for (let i = 6; i < data.length; i += 2) {
      const pp = data[i];
      const rr = data[i + 1];
      table[offset + pp] = rr;
    }
    this.setControlChangeEffects(channel2, controllerType, scheduleTime);
  }
  getKeyBasedValue(channel2, keyNumber, controllerType) {
    const index = keyNumber * 128 + controllerType;
    const controlValue = channel2.keyBasedTable[index];
    return controlValue;
  }
  handleKeyBasedInstrumentControlSysEx(data, scheduleTime) {
    const channelNumber = data[4];
    const channel2 = this.channels[channelNumber];
    if (!channel2.isDrum) return;
    const keyNumber = data[5];
    const table = channel2.keyBasedTable;
    for (let i = 6; i < data.length; i += 2) {
      const controllerType = data[i];
      const value = data[i + 1];
      const index = keyNumber * 128 + controllerType;
      table[index] = value;
      switch (controllerType) {
        case 7:
        case 10:
          this.updateKeyBasedVolume(channel2, keyNumber, scheduleTime);
          break;
        case 71:
          this.processScheduledNotes(channel2, (note2) => {
            const filterResonance = this.getRelativeKeyBasedValue(
              channel2,
              note2,
              71
            );
            if (note2.noteNumber === keyNumber) {
              const Q = note2.voiceParams.initialFilterQ / 5 * filterResonance;
              note2.filterNode.Q.setValueAtTime(Q, scheduleTime);
            }
          });
          break;
        case 73:
          this.processScheduledNotes(channel2, (note2) => {
            if (note2.noteNumber === keyNumber) {
              if (0.5 <= channel2.state.portamento && 0 <= note2.portamentoNoteNumber) {
                this.setPortamentoVolumeEnvelope(channel2, note2, scheduleTime);
              } else {
                this.setVolumeEnvelope(channel2, note2, scheduleTime);
              }
            }
          });
          break;
        case 74:
          this.processScheduledNotes(channel2, (note2) => {
            if (note2.noteNumber === keyNumber) {
              if (0.5 <= channel2.state.portamento && 0 <= note2.portamentoNoteNumber) {
                this.setPortamentoFilterEnvelope(channel2, note2, scheduleTime);
              } else {
                this.setFilterEnvelope(channel2, note2, scheduleTime);
              }
            }
          });
          break;
        case 75:
          this.processScheduledNotes(channel2, (note2) => {
            if (note2.noteNumber === keyNumber) {
              this.setVolumeEnvelope(channel2, note2, scheduleTime);
            }
          });
          break;
        case 76:
          if (channel2.state.vibratoDepth <= 0) break;
          this.processScheduledNotes(channel2, (note2) => {
            if (note2.noteNumber === keyNumber) {
              this.setFreqVibLFO(channel2, note2, scheduleTime);
            }
          });
          break;
        case 77:
          if (channel2.state.vibratoDepth <= 0) break;
          this.processScheduledNotes(channel2, (note2) => {
            if (note2.noteNumber === keyNumber) {
              this.setVibLfoToPitch(channel2, note2, scheduleTime);
            }
          });
          break;
        case 78:
          if (channel2.state.vibratoDepth <= 0) break;
          this.processScheduledNotes(channel2, (note2) => {
            if (note2.noteNumber === keyNumber) {
              this.setDelayVibLFO(channel2, note2);
            }
          });
          break;
        case 91:
          this.processScheduledNotes(channel2, (note2) => {
            if (note2.noteNumber === keyNumber) {
              this.setReverbSend(channel2, note2, scheduleTime);
            }
          });
          break;
        case 93:
          this.processScheduledNotes(channel2, (note2) => {
            if (note2.noteNumber === keyNumber) {
              this.setChorusSend(channel2, note2, scheduleTime);
            }
          });
          break;
      }
    }
  }
  handleSysEx(data, scheduleTime) {
    switch (data[0]) {
      case 126:
        return this.handleUniversalNonRealTimeExclusiveMessage(
          data,
          scheduleTime
        );
      case 127:
        return this.handleUniversalRealTimeExclusiveMessage(data, scheduleTime);
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }
  // https://github.com/marmooo/js-timer-benchmark
  scheduleTask(callback, scheduleTime) {
    return new Promise((resolve) => {
      const bufferSource = new AudioBufferSourceNode(this.audioContext, {
        buffer: this.schedulerBuffer
      });
      bufferSource.connect(this.scheduler);
      bufferSource.onended = () => {
        try {
          callback();
        } finally {
          bufferSource.disconnect();
          resolve();
        }
      };
      bufferSource.start(scheduleTime);
    });
  }
};
export {
  Midy
};
