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

// src/midy-GM1.js
var import_midi_file = __toESM(require_midi_file());

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.0.7/node_modules/@marmooo/soundfont-parser/esm/Stream.js
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
    this.offset = end;
    let nul = end;
    for (let i = start + 1; i < end; i++) {
      if (data[i] === 0) {
        nul = i;
        break;
      }
    }
    const len = nul - start;
    const arr = new Array(len);
    for (let i = 0; i < len; i++) {
      arr[i] = data[start + i];
    }
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

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.0.7/node_modules/@marmooo/soundfont-parser/esm/RiffParser.js
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

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.0.7/node_modules/@marmooo/soundfont-parser/esm/Constants.js
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

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.0.7/node_modules/@marmooo/soundfont-parser/esm/Structs.js
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
    return this.presetName === "EOP";
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
  constructor(sourceOper, destinationOper, value, amountSourceOper, transOper) {
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
    Object.defineProperty(this, "value", {
      enumerable: true,
      configurable: true,
      writable: true,
      value
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
  static parse(stream) {
    const sourceOper = stream.readWORD();
    const destinationOper = stream.readWORD();
    const value = stream.readInt16();
    const amountSourceOper = stream.readWORD();
    const transOper = stream.readWORD();
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
  constructor(min, value, max) {
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
    Object.defineProperty(this, "value", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this.min = min;
    this.value = value;
    this.max = max;
  }
  clamp() {
    return Math.max(this.min, Math.min(this.value, this.max));
  }
};

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.0.7/node_modules/@marmooo/soundfont-parser/esm/Parser.js
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
    samples: loadSample(result.sampleHeaders, result.samplingData.offsetMSB, result.samplingData.offsetLSB, input, isSF3)
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
function loadSample(sampleHeader, samplingDataOffsetMSB, _samplingDataOffsetLSB, data, isSF3) {
  const result = new Array(sampleHeader.length);
  const factor = isSF3 ? 1 : 2;
  for (let i = 0; i < sampleHeader.length; i++) {
    const { start, end } = sampleHeader[i];
    const startOffset = samplingDataOffsetMSB + start * factor;
    const endOffset = samplingDataOffsetMSB + end * factor;
    result[i] = data.subarray(startOffset, endOffset);
  }
  return result;
}

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.0.7/node_modules/@marmooo/soundfont-parser/esm/Generator.js
var generatorKeyToIndex = /* @__PURE__ */ new Map();
for (let i = 0; i < GeneratorKeys.length; i++) {
  generatorKeyToIndex.set(GeneratorKeys[i], i);
}
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
var fixedGenerators = [
  ["keynum", "keyRange"],
  ["velocity", "velRange"]
];
var RangeGeneratorKeysSet = new Set(RangeGeneratorKeys);
function isRangeGenerator(key) {
  return RangeGeneratorKeysSet.has(key);
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
      const defaultValue = defaultInstrumentZone[key];
      result[key] = new BoundedValue(defaultValue.min, gen.value, defaultValue.max);
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
      const defaultValue = defaultInstrumentZone[key];
      result[key] = new BoundedValue(defaultValue.min, gen.value, defaultValue.max);
    }
  }
  for (let i = 0; i < fixedGenerators.length; i++) {
    const [src, dst] = fixedGenerators[i];
    const v = result[src];
    if (v instanceof BoundedValue && 0 <= v.value) {
      result[dst] = new RangeValue(v.value, v.value);
    }
  }
  return result;
}
var int16min = -32768;
var int16max = 32767;
var defaultInstrumentZone = {
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
  instrument: new BoundedValue(-1, -1, int16max),
  keyRange: new RangeValue(0, 127),
  velRange: new RangeValue(0, 127),
  startloopAddrsCoarseOffset: new BoundedValue(int16min, 0, int16max),
  keynum: new BoundedValue(-1, -1, 127),
  velocity: new BoundedValue(-1, -1, 127),
  initialAttenuation: new BoundedValue(0, 0, 1440),
  endloopAddrsCoarseOffset: new BoundedValue(int16min, 0, int16max),
  coarseTune: new BoundedValue(-120, 0, 120),
  fineTune: new BoundedValue(-99, 0, 99),
  sampleID: new BoundedValue(-1, -1, int16max),
  sampleModes: new BoundedValue(0, 0, 3),
  scaleTuning: new BoundedValue(0, 100, 100),
  exclusiveClass: new BoundedValue(0, 0, 127),
  overridingRootKey: new BoundedValue(-1, -1, 127)
};

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.0.7/node_modules/@marmooo/soundfont-parser/esm/SoundFont.js
var SoundFont = class {
  constructor(parsed) {
    Object.defineProperty(this, "parsed", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this.parsed = parsed;
  }
  getGenerators(generators, zone, from, to) {
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
    return this.getGenerators(this.parsed.presetGenerators, this.parsed.presetZone, presetHeader.presetBagIndex, nextPresetBagIndex);
  }
  getInstrumentGenerators(instrumentID) {
    const instrument = this.parsed.instruments[instrumentID];
    const nextInstrument = this.parsed.instruments[instrumentID + 1];
    const nextInstrumentBagIndex = nextInstrument ? nextInstrument.instrumentBagIndex : this.parsed.instrumentZone.length - 1;
    return this.getGenerators(this.parsed.instrumentGenerators, this.parsed.instrumentZone, instrument.instrumentBagIndex, nextInstrumentBagIndex);
  }
  findInstrumentZone(instrumentID, key, velocity) {
    const instrumentGenerators = this.getInstrumentGenerators(instrumentID);
    let globalZone;
    for (let j = 0; j < instrumentGenerators.length; j++) {
      const zone = createInstrumentGeneratorObject(instrumentGenerators[j]);
      if (zone.sampleID === void 0) {
        globalZone = zone;
        continue;
      }
      if (zone.keyRange && !zone.keyRange.in(key))
        continue;
      if (zone.velRange && !zone.velRange.in(velocity))
        continue;
      if (globalZone) {
        return { ...globalZone, ...zone };
      } else {
        return zone;
      }
    }
    return;
  }
  findInstrument(presetHeaderIndex, key, velocity) {
    const presetGenerators = this.getPresetGenerators(presetHeaderIndex);
    let globalZone;
    for (let i = 0; i < presetGenerators.length; i++) {
      const zone = createPresetGeneratorObject(presetGenerators[i]);
      if (zone.instrument === void 0) {
        globalZone = zone;
        continue;
      }
      if (zone.keyRange && !zone.keyRange.in(key))
        continue;
      if (zone.velRange && !zone.velRange.in(velocity))
        continue;
      const instrumentZone = this.findInstrumentZone(zone.instrument.value, key, velocity);
      if (instrumentZone) {
        if (globalZone) {
          return this.getInstrument({ ...globalZone, ...zone }, instrumentZone);
        } else {
          return this.getInstrument(zone, instrumentZone);
        }
      }
    }
    return null;
  }
  getInstrument(presetZone, instrumentZone) {
    const instrument = {
      ...defaultInstrumentZone,
      ...instrumentZone
    };
    const keys = Object.keys(presetZone);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (isRangeGenerator(key))
        continue;
      const instrumentValue = instrument[key];
      const presetValue = presetZone[key];
      instrument[key] = new BoundedValue(instrumentValue.min, instrumentValue.value + presetValue.value, instrumentValue.max);
    }
    return instrument;
  }
  getInstrumentKey(bankNumber, instrumentNumber, key, velocity) {
    const presetHeaderIndex = this.parsed.presetHeaders.findIndex((p) => p.preset === instrumentNumber && p.bank === bankNumber);
    if (presetHeaderIndex < 0) {
      console.warn("preset not found: bank=%s instrument=%s", bankNumber, instrumentNumber);
      return null;
    }
    const gen = this.findInstrument(presetHeaderIndex, key, velocity);
    if (!gen) {
      console.warn("instrument not found: bank=%s instrument=%s", bankNumber, instrumentNumber);
      return null;
    }
    const clamped = {};
    const keys = Object.keys(gen);
    for (let i = 0; i < keys.length; i++) {
      const key2 = keys[i];
      if (isRangeGenerator(key2)) {
        clamped[key2] = gen[key2];
      } else {
        clamped[key2] = gen[key2].clamp();
      }
    }
    const modHold = timecentToSecond(clamped.holdModEnv + (key - 60) * clamped.keynumToModEnvHold);
    const modDecay = timecentToSecond(clamped.decayModEnv + (key - 60) * clamped.keynumToModEnvDecay);
    const volHold = timecentToSecond(clamped.holdVolEnv + (key - 60) * clamped.keynumToVolEnvHold);
    const volDecay = timecentToSecond(clamped.decayVolEnv + (key - 60) * clamped.keynumToVolEnvDecay);
    const sample = this.parsed.samples[clamped.sampleID];
    const sampleHeader = this.parsed.sampleHeaders[clamped.sampleID];
    const tune = clamped.coarseTune + clamped.fineTune / 100;
    const rootKey = clamped.overridingRootKey === -1 ? sampleHeader.originalPitch : clamped.overridingRootKey;
    const basePitch = tune + sampleHeader.pitchCorrection / 100 - rootKey;
    const scaleTuning = clamped.scaleTuning / 100;
    return {
      // startAddrsOffset: clamped.startAddrsOffset,
      // endAddrsOffset: clamped.endAddrsOffset,
      start: clamped.startAddrsCoarseOffset * 32768 + clamped.startAddrsOffset,
      end: clamped.endAddrsCoarseOffset * 32768 + clamped.endAddrsOffset,
      // startloopAddrsOffset: clamped.startloopAddrsOffset,
      // endloopAddrsOffset: clamped.endloopAddrsOffset,
      loopStart: sampleHeader.loopStart + clamped.startloopAddrsCoarseOffset * 32768 + clamped.startloopAddrsOffset,
      loopEnd: sampleHeader.loopEnd + clamped.endloopAddrsCoarseOffset * 32768 + clamped.endloopAddrsOffset,
      modLfoToPitch: clamped.modLfoToPitch,
      vibLfoToPitch: clamped.vibLfoToPitch,
      modEnvToPitch: clamped.modEnvToPitch,
      initialFilterFc: clamped.initialFilterFc,
      initialFilterQ: clamped.initialFilterQ,
      modLfoToFilterFc: clamped.modLfoToFilterFc,
      modEnvToFilterFc: clamped.modEnvToFilterFc,
      // endAddrsCoarseOffset: clamped.endAddrsCoarseOffset,
      modLfoToVolume: clamped.modLfoToVolume,
      chorusEffectsSend: clamped.chorusEffectsSend / 1e3,
      reverbEffectsSend: clamped.reverbEffectsSend / 1e3,
      pan: clamped.pan,
      delayModLFO: timecentToSecond(clamped.delayModLFO),
      freqModLFO: clamped.freqModLFO,
      delayVibLFO: timecentToSecond(clamped.delayVibLFO),
      freqVibLFO: clamped.freqVibLFO,
      // delayModEnv: clamped.delayModEnv,
      // attackModEnv: clamped.attackModEnv,
      // holdModEnv: clamped.holdModEnv,
      // decayModEnv: clamped.decayModEnv,
      // sustainModEnv: clamped.sustainModEnv,
      // releaseModEnv: clamped.releaseModEnv,
      modDelay: timecentToSecond(clamped.delayModEnv),
      modAttack: timecentToSecond(clamped.attackModEnv),
      modHold,
      modDecay,
      modSustain: clamped.sustainModEnv / 1e3,
      modRelease: timecentToSecond(clamped.releaseModEnv),
      // keynumToModEnvHold: clamped.keynumToModEnvHold,
      // keynumToModEnvDecay: clamped.keynumToModEnvDecay,
      // delayVolEnv: clamped.delayVolEnv,
      // attackVolEnv: clamped.attackVolEnv,
      // holdVolEnv: clamped.holdVolEnv,
      // decayVolEnv: clamped.decayVolEnv,
      // sustainVolEnv: clamped.sustainVolEnv,
      // releaseVolEnv: clamped.releaseVolEnv,
      volDelay: timecentToSecond(clamped.delayVolEnv),
      volAttack: timecentToSecond(clamped.attackVolEnv),
      volHold,
      volDecay,
      volSustain: clamped.sustainVolEnv / 1e3,
      volRelease: timecentToSecond(clamped.releaseVolEnv),
      // keynumToVolEnvHold: clamped.keynumToVolEnvHold,
      // keynumToVolEnvDecay: clamped.keynumToVolEnvDecay,
      // instrument: clamped.instrument,
      // keyRange: clamped.keyRange,
      // velRange: clamped.velRange,
      // startloopAddrsCoarseOffset: clamped.startloopAddrsCoarseOffset,
      // keynum: clamped.keynum,
      // velocity: clamped.velocity,
      initialAttenuation: clamped.initialAttenuation,
      // endloopAddrsCoarseOffset: clamped.endloopAddrsCoarseOffset,
      // coarseTune: clamped.coarseTune,
      // fineTune: clamped.fineTune,
      playbackRate: (key2) => Math.pow(Math.pow(2, 1 / 12), (key2 + basePitch) * scaleTuning),
      // sampleID: clamped.sampleID,
      sample,
      sampleRate: sampleHeader.sampleRate,
      sampleName: sampleHeader.sampleName,
      sampleModes: clamped.sampleModes,
      // scaleTuning,
      exclusiveClass: clamped.exclusiveClass
      // overridingRootKey: clamped.overridingRootKey,
    };
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
function timecentToSecond(value) {
  return Math.pow(2, value / 1200);
}

// src/midy-GM1.js
var Note = class {
  bufferSource;
  filterNode;
  volumeNode;
  volumeDepth;
  modulationLFO;
  modulationDepth;
  vibratoLFO;
  vibratoDepth;
  constructor(noteNumber, velocity, startTime, instrumentKey) {
    this.noteNumber = noteNumber;
    this.velocity = velocity;
    this.startTime = startTime;
    this.instrumentKey = instrumentKey;
  }
};
var MidyGM1 = class {
  ticksPerBeat = 120;
  totalTime = 0;
  noteCheckInterval = 0.1;
  lookAhead = 1;
  startDelay = 0.1;
  startTime = 0;
  resumeTime = 0;
  soundFonts = [];
  soundFontTable = this.initSoundFontTable();
  isPlaying = false;
  isPausing = false;
  isPaused = false;
  isStopping = false;
  isSeeking = false;
  timeline = [];
  instruments = [];
  notePromises = [];
  exclusiveClassMap = /* @__PURE__ */ new Map();
  static channelSettings = {
    volume: 100 / 127,
    pan: 64,
    bank: 0,
    dataMSB: 0,
    dataLSB: 0,
    program: 0,
    pitchBend: 0,
    fineTuning: 0,
    // cb
    coarseTuning: 0,
    // cb
    modulationDepthRange: 50
    // cent
  };
  static effectSettings = {
    expression: 1,
    modulationDepth: 0,
    sustainPedal: false,
    rpnMSB: 127,
    rpnLSB: 127,
    pitchBendRange: 2
  };
  constructor(audioContext) {
    this.audioContext = audioContext;
    this.masterGain = new GainNode(audioContext);
    this.controlChangeHandlers = this.createControlChangeHandlers();
    this.channels = this.createChannels(audioContext);
    this.masterGain.connect(audioContext.destination);
    this.GM1SystemOn();
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
      if (!presetHeader.presetName.startsWith("\0")) {
        const banks = this.soundFontTable[presetHeader.preset];
        banks.set(presetHeader.bank, index);
      }
    }
  }
  async loadSoundFont(soundFontUrl) {
    const response = await fetch(soundFontUrl);
    const arrayBuffer = await response.arrayBuffer();
    const parsed = parse(new Uint8Array(arrayBuffer));
    const soundFont = new SoundFont(parsed);
    this.addSoundFont(soundFont);
  }
  async loadMIDI(midiUrl) {
    const response = await fetch(midiUrl);
    const arrayBuffer = await response.arrayBuffer();
    const midi = (0, import_midi_file.parseMidi)(new Uint8Array(arrayBuffer));
    this.ticksPerBeat = midi.header.ticksPerBeat;
    const midiData = this.extractMidiData(midi);
    this.instruments = midiData.instruments;
    this.timeline = midiData.timeline;
    this.totalTime = this.calcTotalTime();
  }
  setChannelAudioNodes(audioContext) {
    const { gainLeft, gainRight } = this.panToGain(
      this.constructor.channelSettings.pan
    );
    const gainL = new GainNode(audioContext, { gain: gainLeft });
    const gainR = new GainNode(audioContext, { gain: gainRight });
    const merger = new ChannelMergerNode(audioContext, { numberOfInputs: 2 });
    gainL.connect(merger, 0, 0);
    gainR.connect(merger, 0, 1);
    merger.connect(this.masterGain);
    return {
      gainL,
      gainR,
      merger
    };
  }
  createChannels(audioContext) {
    const channels = Array.from({ length: 16 }, () => {
      return {
        ...this.constructor.channelSettings,
        ...this.constructor.effectSettings,
        ...this.setChannelAudioNodes(audioContext),
        scheduledNotes: /* @__PURE__ */ new Map()
      };
    });
    return channels;
  }
  async createNoteBuffer(instrumentKey, isSF3) {
    const sampleStart = instrumentKey.start;
    const sampleEnd = instrumentKey.sample.length + instrumentKey.end;
    if (isSF3) {
      const sample = instrumentKey.sample;
      const start = sample.byteOffset + sampleStart;
      const end = sample.byteOffset + sampleEnd;
      const buffer = sample.buffer.slice(start, end);
      const audioBuffer = await this.audioContext.decodeAudioData(buffer);
      return audioBuffer;
    } else {
      const sample = instrumentKey.sample;
      const start = sample.byteOffset + sampleStart;
      const end = sample.byteOffset + sampleEnd;
      const buffer = sample.buffer.slice(start, end);
      const audioBuffer = new AudioBuffer({
        numberOfChannels: 1,
        length: sample.length,
        sampleRate: instrumentKey.sampleRate
      });
      const channelData = audioBuffer.getChannelData(0);
      const int16Array = new Int16Array(buffer);
      for (let i = 0; i < int16Array.length; i++) {
        channelData[i] = int16Array[i] / 32768;
      }
      return audioBuffer;
    }
  }
  async createNoteBufferNode(instrumentKey, isSF3) {
    const bufferSource = new AudioBufferSourceNode(this.audioContext);
    const audioBuffer = await this.createNoteBuffer(instrumentKey, isSF3);
    bufferSource.buffer = audioBuffer;
    bufferSource.loop = instrumentKey.sampleModes % 2 !== 0;
    if (bufferSource.loop) {
      bufferSource.loopStart = instrumentKey.loopStart / instrumentKey.sampleRate;
      bufferSource.loopEnd = instrumentKey.loopEnd / instrumentKey.sampleRate;
    }
    return bufferSource;
  }
  async scheduleTimelineEvents(t, offset, queueIndex) {
    while (queueIndex < this.timeline.length) {
      const event = this.timeline[queueIndex];
      if (event.startTime > t + this.lookAhead) break;
      switch (event.type) {
        case "noteOn":
          if (event.velocity !== 0) {
            await this.scheduleNoteOn(
              event.channel,
              event.noteNumber,
              event.velocity,
              event.startTime + this.startDelay - offset
            );
            break;
          }
        /* falls through */
        case "noteOff": {
          const notePromise = this.scheduleNoteRelease(
            event.channel,
            event.noteNumber,
            event.velocity,
            event.startTime + this.startDelay - offset
          );
          if (notePromise) {
            this.notePromises.push(notePromise);
          }
          break;
        }
        case "controller":
          this.handleControlChange(
            event.channel,
            event.controllerType,
            event.value
          );
          break;
        case "programChange":
          this.handleProgramChange(event.channel, event.programNumber);
          break;
        case "pitchBend":
          this.setPitchBend(event.channel, event.value);
          break;
        case "sysEx":
          this.handleSysEx(event.data);
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
  playNotes() {
    return new Promise((resolve) => {
      this.isPlaying = true;
      this.isPaused = false;
      this.startTime = this.audioContext.currentTime;
      let queueIndex = this.getQueueIndex(this.resumeTime);
      let offset = this.resumeTime - this.startTime;
      this.notePromises = [];
      const schedulePlayback = async () => {
        if (queueIndex >= this.timeline.length) {
          await Promise.all(this.notePromises);
          this.notePromises = [];
          this.exclusiveClassMap.clear();
          resolve();
          return;
        }
        const t = this.audioContext.currentTime + offset;
        queueIndex = await this.scheduleTimelineEvents(t, offset, queueIndex);
        if (this.isPausing) {
          await this.stopNotes(0, true);
          this.notePromises = [];
          resolve();
          this.isPausing = false;
          this.isPaused = true;
          return;
        } else if (this.isStopping) {
          await this.stopNotes(0, true);
          this.exclusiveClassMap.clear();
          this.notePromises = [];
          resolve();
          this.isStopping = false;
          this.isPaused = false;
          return;
        } else if (this.isSeeking) {
          this.stopNotes(0, true);
          this.exclusiveClassMap.clear();
          this.startTime = this.audioContext.currentTime;
          queueIndex = this.getQueueIndex(this.resumeTime);
          offset = this.resumeTime - this.startTime;
          this.isSeeking = false;
          await schedulePlayback();
        } else {
          const now = this.audioContext.currentTime;
          const waitTime = now + this.noteCheckInterval;
          await this.scheduleTask(() => {
          }, waitTime);
          await schedulePlayback();
        }
      };
      schedulePlayback();
    });
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
    const tmpChannels = new Array(16);
    for (let i = 0; i < tmpChannels.length; i++) {
      tmpChannels[i] = {
        programNumber: -1,
        bank: this.channels[i].bank
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
            const channel = tmpChannels[event.channel];
            if (channel.programNumber < 0) {
              instruments.add(`${channel.bank}:0`);
              channel.programNumber = 0;
            }
            break;
          }
          case "programChange": {
            const channel = tmpChannels[event.channel];
            channel.programNumber = event.programNumber;
            instruments.add(`${channel.bankNumber}:${channel.programNumber}`);
          }
        }
        delete event.deltaTime;
        timeline.push(event);
      }
    }
    const priority = {
      controller: 0,
      sysEx: 1
    };
    timeline.sort((a, b) => {
      if (a.ticks !== b.ticks) return a.ticks - b.ticks;
      return (priority[a.type] || 2) - (priority[b.type] || 2);
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
  async stopChannelNotes(channelNumber, velocity, force) {
    const now = this.audioContext.currentTime;
    const channel = this.channels[channelNumber];
    channel.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        const promise = this.scheduleNoteRelease(
          channelNumber,
          note.noteNumber,
          velocity,
          now,
          force
        );
        this.notePromises.push(promise);
      }
    });
    channel.scheduledNotes.clear();
    await Promise.all(this.notePromises);
  }
  stopNotes(velocity, force) {
    for (let i = 0; i < this.channels.length; i++) {
      this.stopChannelNotes(i, velocity, force);
    }
    return Promise.all(this.notePromises);
  }
  async start() {
    if (this.isPlaying || this.isPaused) return;
    this.resumeTime = 0;
    await this.playNotes();
    this.isPlaying = false;
  }
  stop() {
    if (!this.isPlaying) return;
    this.isStopping = true;
  }
  pause() {
    if (!this.isPlaying || this.isPaused) return;
    const now = this.audioContext.currentTime;
    this.resumeTime += now - this.startTime - this.startDelay;
    this.isPausing = true;
  }
  async resume() {
    if (!this.isPaused) return;
    await this.playNotes();
    this.isPlaying = false;
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
  getActiveNotes(channel, time) {
    const activeNotes = /* @__PURE__ */ new Map();
    channel.scheduledNotes.forEach((noteList) => {
      const activeNote = this.getActiveNote(noteList, time);
      if (activeNote) {
        activeNotes.set(activeNote.noteNumber, activeNote);
      }
    });
    return activeNotes;
  }
  getActiveNote(noteList, time) {
    for (let i = noteList.length - 1; i >= 0; i--) {
      const note = noteList[i];
      if (!note) return;
      if (time < note.startTime) continue;
      return note.ending ? null : note;
    }
    return noteList[0];
  }
  cbToRatio(cb) {
    return Math.pow(10, cb / 200);
  }
  centToHz(cent) {
    return 8.176 * Math.pow(2, cent / 1200);
  }
  calcSemitoneOffset(channel) {
    const tuning = channel.coarseTuning + channel.fineTuning;
    return channel.pitchBend * channel.pitchBendRange + tuning;
  }
  calcPlaybackRate(instrumentKey, noteNumber, semitoneOffset) {
    return instrumentKey.playbackRate(noteNumber) * Math.pow(2, semitoneOffset / 12);
  }
  setVolumeEnvelope(note) {
    const { instrumentKey, startTime } = note;
    const attackVolume = this.cbToRatio(-instrumentKey.initialAttenuation);
    const sustainVolume = attackVolume * (1 - instrumentKey.volSustain);
    const volDelay = startTime + instrumentKey.volDelay;
    const volAttack = volDelay + instrumentKey.volAttack;
    const volHold = volAttack + instrumentKey.volHold;
    const volDecay = volHold + instrumentKey.volDecay;
    note.volumeNode.gain.cancelScheduledValues(startTime).setValueAtTime(0, startTime).setValueAtTime(1e-6, volDelay).exponentialRampToValueAtTime(attackVolume, volAttack).setValueAtTime(attackVolume, volHold).linearRampToValueAtTime(sustainVolume, volDecay);
  }
  setPitch(note, semitoneOffset) {
    const { instrumentKey, noteNumber, startTime } = note;
    const modEnvToPitch = instrumentKey.modEnvToPitch / 100;
    note.bufferSource.playbackRate.value = this.calcPlaybackRate(
      instrumentKey,
      noteNumber,
      semitoneOffset
    );
    if (modEnvToPitch === 0) return;
    const basePitch = note.bufferSource.playbackRate.value;
    const peekPitch = this.calcPlaybackRate(
      instrumentKey,
      noteNumber,
      semitoneOffset + modEnvToPitch
    );
    const modDelay = startTime + instrumentKey.modDelay;
    const modAttack = modDelay + instrumentKey.modAttack;
    const modHold = modAttack + instrumentKey.modHold;
    const modDecay = modHold + instrumentKey.modDecay;
    note.bufferSource.playbackRate.value.setValueAtTime(basePitch, modDelay).exponentialRampToValueAtTime(peekPitch, modAttack).setValueAtTime(peekPitch, modHold).linearRampToValueAtTime(basePitch, modDecay);
  }
  clampCutoffFrequency(frequency) {
    const minFrequency = 20;
    const maxFrequency = 2e4;
    return Math.max(minFrequency, Math.min(frequency, maxFrequency));
  }
  setFilterEnvelope(note) {
    const { instrumentKey, startTime } = note;
    const baseFreq = this.centToHz(instrumentKey.initialFilterFc);
    const peekFreq = this.centToHz(
      instrumentKey.initialFilterFc + instrumentKey.modEnvToFilterFc
    );
    const sustainFreq = baseFreq + (peekFreq - baseFreq) * (1 - instrumentKey.modSustain);
    const adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
    const adjustedPeekFreq = this.clampCutoffFrequency(peekFreq);
    const adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
    const modDelay = startTime + instrumentKey.modDelay;
    const modAttack = modDelay + instrumentKey.modAttack;
    const modHold = modAttack + instrumentKey.modHold;
    const modDecay = modHold + instrumentKey.modDecay;
    note.filterNode.frequency.cancelScheduledValues(startTime).setValueAtTime(adjustedBaseFreq, startTime).setValueAtTime(adjustedBaseFreq, modDelay).exponentialRampToValueAtTime(adjustedPeekFreq, modAttack).setValueAtTime(adjustedPeekFreq, modHold).linearRampToValueAtTime(adjustedSustainFreq, modDecay);
  }
  startModulation(channel, note, startTime) {
    const { instrumentKey } = note;
    const { modLfoToPitch, modLfoToVolume } = instrumentKey;
    note.modulationLFO = new OscillatorNode(this.audioContext, {
      frequency: this.centToHz(instrumentKey.freqModLFO)
    });
    note.filterDepth = new GainNode(this.audioContext, {
      gain: instrumentKey.modLfoToFilterFc
    });
    const modulationDepth = Math.abs(modLfoToPitch) + channel.modulationDepth;
    const modulationDepthSign = 0 < modLfoToPitch ? 1 : -1;
    note.modulationDepth = new GainNode(this.audioContext, {
      gain: modulationDepth * modulationDepthSign
    });
    const volumeDepth = this.cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const volumeDepthSign = 0 < modLfoToVolume ? 1 : -1;
    note.volumeDepth = new GainNode(this.audioContext, {
      gain: volumeDepth * volumeDepthSign
    });
    note.modulationLFO.start(startTime + instrumentKey.delayModLFO);
    note.modulationLFO.connect(note.filterDepth);
    note.filterDepth.connect(note.filterNode.frequency);
    note.modulationLFO.connect(note.modulationDepth);
    note.modulationDepth.connect(note.bufferSource.detune);
    note.modulationLFO.connect(note.volumeDepth);
    note.volumeDepth.connect(note.volumeNode.gain);
  }
  async createNote(channel, instrumentKey, noteNumber, velocity, startTime, isSF3) {
    const semitoneOffset = this.calcSemitoneOffset(channel);
    const note = new Note(noteNumber, velocity, startTime, instrumentKey);
    note.bufferSource = await this.createNoteBufferNode(instrumentKey, isSF3);
    note.volumeNode = new GainNode(this.audioContext);
    note.filterNode = new BiquadFilterNode(this.audioContext, {
      type: "lowpass",
      Q: instrumentKey.initialFilterQ / 10
      // dB
    });
    this.setVolumeEnvelope(note);
    this.setFilterEnvelope(note);
    if (0 < channel.modulationDepth) {
      this.setPitch(note, semitoneOffset);
      this.startModulation(channel, note, startTime);
    } else {
      note.bufferSource.playbackRate.value = this.calcPlaybackRate(
        instrumentKey,
        noteNumber,
        semitoneOffset
      );
    }
    note.bufferSource.connect(note.filterNode);
    note.filterNode.connect(note.volumeNode);
    note.bufferSource.start(startTime);
    return note;
  }
  async scheduleNoteOn(channelNumber, noteNumber, velocity, startTime) {
    const channel = this.channels[channelNumber];
    const bankNumber = 0;
    const soundFontIndex = this.soundFontTable[channel.program].get(bankNumber);
    if (soundFontIndex === void 0) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const isSF3 = soundFont.parsed.info.version.major === 3;
    const instrumentKey = soundFont.getInstrumentKey(
      bankNumber,
      channel.program,
      noteNumber,
      velocity
    );
    if (!instrumentKey) return;
    const note = await this.createNote(
      channel,
      instrumentKey,
      noteNumber,
      velocity,
      startTime,
      isSF3
    );
    note.volumeNode.connect(channel.gainL);
    note.volumeNode.connect(channel.gainR);
    const exclusiveClass = instrumentKey.exclusiveClass;
    if (exclusiveClass !== 0) {
      if (this.exclusiveClassMap.has(exclusiveClass)) {
        const prevEntry = this.exclusiveClassMap.get(exclusiveClass);
        const [prevNote, prevChannelNumber] = prevEntry;
        if (!prevNote.ending) {
          this.scheduleNoteRelease(
            prevChannelNumber,
            prevNote.noteNumber,
            0,
            // velocity,
            startTime,
            void 0,
            // portamentoNoteNumber
            true
            // force
          );
        }
      }
      this.exclusiveClassMap.set(exclusiveClass, [note, channelNumber]);
    }
    const scheduledNotes = channel.scheduledNotes;
    if (scheduledNotes.has(noteNumber)) {
      scheduledNotes.get(noteNumber).push(note);
    } else {
      scheduledNotes.set(noteNumber, [note]);
    }
  }
  noteOn(channelNumber, noteNumber, velocity) {
    const now = this.audioContext.currentTime;
    return this.scheduleNoteOn(channelNumber, noteNumber, velocity, now);
  }
  stopNote(endTime, stopTime, scheduledNotes, index) {
    const note = scheduledNotes[index];
    note.volumeNode.gain.cancelScheduledValues(endTime).linearRampToValueAtTime(0, stopTime);
    note.ending = true;
    this.scheduleTask(() => {
      note.bufferSource.loop = false;
    }, stopTime);
    return new Promise((resolve) => {
      note.bufferSource.onended = () => {
        scheduledNotes[index] = null;
        note.bufferSource.disconnect();
        note.volumeNode.disconnect();
        note.filterNode.disconnect();
        if (note.modulationDepth) {
          note.volumeDepth.disconnect();
          note.modulationDepth.disconnect();
          note.modulationLFO.stop();
        }
        if (note.vibratoDepth) {
          note.vibratoDepth.disconnect();
          note.vibratoLFO.stop();
        }
        resolve();
      };
      note.bufferSource.stop(stopTime);
    });
  }
  scheduleNoteRelease(channelNumber, noteNumber, _velocity, endTime, force) {
    const channel = this.channels[channelNumber];
    if (!force && channel.sustainPedal) return;
    if (!channel.scheduledNotes.has(noteNumber)) return;
    const scheduledNotes = channel.scheduledNotes.get(noteNumber);
    for (let i = 0; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      const volRelease = endTime + note.instrumentKey.volRelease;
      const modRelease = endTime + note.instrumentKey.modRelease;
      note.filterNode.frequency.cancelScheduledValues(endTime).linearRampToValueAtTime(0, modRelease);
      const stopTime = Math.min(volRelease, modRelease);
      return this.stopNote(endTime, stopTime, scheduledNotes, i);
    }
  }
  releaseNote(channelNumber, noteNumber, velocity) {
    const now = this.audioContext.currentTime;
    return this.scheduleNoteRelease(channelNumber, noteNumber, velocity, now);
  }
  releaseSustainPedal(channelNumber, halfVelocity) {
    const velocity = halfVelocity * 2;
    const channel = this.channels[channelNumber];
    const promises = [];
    channel.sustainPedal = false;
    channel.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        const { noteNumber } = note;
        const promise = this.releaseNote(channelNumber, noteNumber, velocity);
        promises.push(promise);
      }
    });
    return promises;
  }
  handleMIDIMessage(statusByte, data1, data2) {
    const channelNumber = statusByte & 15;
    const messageType = statusByte & 240;
    switch (messageType) {
      case 128:
        return this.releaseNote(channelNumber, data1, data2);
      case 144:
        return this.noteOn(channelNumber, data1, data2);
      case 176:
        return this.handleControlChange(channelNumber, data1, data2);
      case 192:
        return this.handleProgramChange(channelNumber, data1);
      case 224:
        return this.handlePitchBendMessage(channelNumber, data1, data2);
      default:
        console.warn(`Unsupported MIDI message: ${messageType.toString(16)}`);
    }
  }
  handleProgramChange(channelNumber, program) {
    const channel = this.channels[channelNumber];
    channel.program = program;
  }
  handlePitchBendMessage(channelNumber, lsb, msb) {
    const pitchBend = msb * 128 + lsb - 8192;
    this.setPitchBend(channelNumber, pitchBend);
  }
  setPitchBend(channelNumber, pitchBend) {
    const channel = this.channels[channelNumber];
    const prevPitchBend = channel.pitchBend;
    channel.pitchBend = pitchBend / 8192;
    const detuneChange = (channel.pitchBend - prevPitchBend) * channel.pitchBendRange * 100;
    this.updateDetune(channel, detuneChange);
  }
  createControlChangeHandlers() {
    return {
      1: this.setModulationDepth,
      6: this.dataEntryMSB,
      7: this.setVolume,
      10: this.setPan,
      11: this.setExpression,
      38: this.dataEntryLSB,
      64: this.setSustainPedal,
      100: this.setRPNLSB,
      101: this.setRPNMSB,
      120: this.allSoundOff,
      121: this.resetAllControllers,
      123: this.allNotesOff
    };
  }
  handleControlChange(channelNumber, controller, value) {
    const handler = this.controlChangeHandlers[controller];
    if (handler) {
      handler.call(this, channelNumber, value);
    } else {
      console.warn(
        `Unsupported Control change: controller=${controller} value=${value}`
      );
    }
  }
  updateModulation(channel) {
    const now = this.audioContext.currentTime;
    channel.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        if (note.modulationDepth) {
          note.modulationDepth.gain.setValueAtTime(
            channel.modulationDepth,
            now
          );
        } else {
          const semitoneOffset = this.calcSemitoneOffset(channel);
          this.setPitch(note, semitoneOffset);
          this.startModulation(channel, note, now);
        }
      }
    });
  }
  setModulationDepth(channelNumber, modulation) {
    const channel = this.channels[channelNumber];
    channel.modulationDepth = modulation / 127 * channel.modulationDepthRange;
    this.updateModulation(channel);
  }
  setVolume(channelNumber, volume) {
    const channel = this.channels[channelNumber];
    channel.volume = volume / 127;
    this.updateChannelVolume(channel);
  }
  panToGain(pan) {
    const theta = Math.PI / 2 * Math.max(0, pan - 1) / 126;
    return {
      gainLeft: Math.cos(theta),
      gainRight: Math.sin(theta)
    };
  }
  setPan(channelNumber, pan) {
    const channel = this.channels[channelNumber];
    channel.pan = pan;
    this.updateChannelVolume(channel);
  }
  setExpression(channelNumber, expression) {
    const channel = this.channels[channelNumber];
    channel.expression = expression / 127;
    this.updateChannelVolume(channel);
  }
  dataEntryLSB(channelNumber, value) {
    this.channels[channelNumber].dataLSB = value;
    this.handleRPN(channelNumber, 0);
  }
  updateChannelVolume(channel) {
    const now = this.audioContext.currentTime;
    const volume = channel.volume * channel.expression;
    const { gainLeft, gainRight } = this.panToGain(channel.pan);
    channel.gainL.gain.cancelScheduledValues(now).setValueAtTime(volume * gainLeft, now);
    channel.gainR.gain.cancelScheduledValues(now).setValueAtTime(volume * gainRight, now);
  }
  setSustainPedal(channelNumber, value) {
    const isOn = value >= 64;
    this.channels[channelNumber].sustainPedal = isOn;
    if (!isOn) {
      this.releaseSustainPedal(channelNumber, value);
    }
  }
  limitData(channel, minMSB, maxMSB, minLSB, maxLSB) {
    if (maxLSB < channel.dataLSB) {
      channel.dataMSB++;
      channel.dataLSB = minLSB;
    } else if (channel.dataLSB < 0) {
      channel.dataMSB--;
      channel.dataLSB = maxLSB;
    }
    if (maxMSB < channel.dataMSB) {
      channel.dataMSB = maxMSB;
      channel.dataLSB = maxLSB;
    } else if (channel.dataMSB < 0) {
      channel.dataMSB = minMSB;
      channel.dataLSB = minLSB;
    }
  }
  limitDataMSB(channel, minMSB, maxMSB) {
    if (maxMSB < channel.dataMSB) {
      channel.dataMSB = maxMSB;
    } else if (channel.dataMSB < 0) {
      channel.dataMSB = minMSB;
    }
  }
  handleRPN(channelNumber) {
    const channel = this.channels[channelNumber];
    const rpn = channel.rpnMSB * 128 + channel.rpnLSB;
    switch (rpn) {
      case 0:
        this.handlePitchBendRangeRPN(channelNumber);
        break;
      case 1:
        this.handleFineTuningRPN(channelNumber);
        break;
      case 2:
        this.handleCoarseTuningRPN(channelNumber);
        break;
      default:
        console.warn(
          `Channel ${channelNumber}: Unsupported RPN MSB=${channel.rpnMSB} LSB=${channel.rpnLSB}`
        );
    }
  }
  setRPNMSB(channelNumber, value) {
    this.channels[channelNumber].rpnMSB = value;
  }
  setRPNLSB(channelNumber, value) {
    this.channels[channelNumber].rpnLSB = value;
  }
  dataEntryMSB(channelNumber, value) {
    this.channels[channelNumber].dataMSB = value;
    this.handleRPN(channelNumber);
  }
  updateDetune(channel, detuneChange) {
    const now = this.audioContext.currentTime;
    channel.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        const { bufferSource } = note;
        const detune = bufferSource.detune.value + detuneChange;
        bufferSource.detune.cancelScheduledValues(now).setValueAtTime(detune, now);
      }
    });
  }
  handlePitchBendRangeRPN(channelNumber) {
    const channel = this.channels[channelNumber];
    this.limitData(channel, 0, 127, 0, 99);
    const pitchBendRange = channel.dataMSB + channel.dataLSB / 100;
    this.setPitchBendRange(channelNumber, pitchBendRange);
  }
  setPitchBendRange(channelNumber, pitchBendRange) {
    const channel = this.channels[channelNumber];
    const prevPitchBendRange = channel.pitchBendRange;
    channel.pitchBendRange = pitchBendRange;
    const detuneChange = (channel.pitchBendRange - prevPitchBendRange) * channel.pitchBend * 100;
    this.updateDetune(channel, detuneChange);
  }
  handleFineTuningRPN(channelNumber) {
    const channel = this.channels[channelNumber];
    this.limitData(channel, 0, 127, 0, 127);
    const fineTuning = (channel.dataMSB * 128 + channel.dataLSB - 8192) / 8192;
    this.setFineTuning(channelNumber, fineTuning);
  }
  setFineTuning(channelNumber, fineTuning) {
    const channel = this.channels[channelNumber];
    const prevFineTuning = channel.fineTuning;
    channel.fineTuning = fineTuning;
    const detuneChange = channel.fineTuning - prevFineTuning;
    this.updateDetune(channel, detuneChange);
  }
  handleCoarseTuningRPN(channelNumber) {
    const channel = this.channels[channelNumber];
    this.limitDataMSB(channel, 0, 127);
    const coarseTuning = channel.dataMSB - 64;
    this.setFineTuning(channelNumber, coarseTuning);
  }
  setCoarseTuning(channelNumber, coarseTuning) {
    const channel = this.channels[channelNumber];
    const prevCoarseTuning = channel.coarseTuning;
    channel.coarseTuning = coarseTuning;
    const detuneChange = channel.coarseTuning - prevCoarseTuning;
    this.updateDetune(channel, detuneChange);
  }
  allSoundOff(channelNumber) {
    return this.stopChannelNotes(channelNumber, 0, true);
  }
  resetAllControllers(channelNumber) {
    Object.assign(this.channels[channelNumber], this.effectSettings);
  }
  allNotesOff(channelNumber) {
    return this.stopChannelNotes(channelNumber, 0, false);
  }
  handleUniversalNonRealTimeExclusiveMessage(data) {
    switch (data[2]) {
      case 9:
        switch (data[3]) {
          case 1:
            this.GM1SystemOn();
            break;
          case 2:
            break;
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }
  GM1SystemOn() {
    for (let i = 0; i < this.channels.length; i++) {
      const channel = this.channels[i];
      channel.bankMSB = 0;
      channel.bankLSB = 0;
      channel.bank = 0;
    }
    this.channels[9].bankMSB = 1;
    this.channels[9].bank = 128;
  }
  handleUniversalRealTimeExclusiveMessage(data) {
    switch (data[2]) {
      case 4:
        switch (data[3]) {
          case 1:
            return this.handleMasterVolumeSysEx(data);
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      default:
        console.warn(`Unsupported Exclusive Message: ${data}`);
    }
  }
  handleMasterVolumeSysEx(data) {
    const volume = (data[5] * 128 + data[4]) / 16383;
    this.setMasterVolume(volume);
  }
  setMasterVolume(volume) {
    if (volume < 0 && 1 < volume) {
      console.error("Master Volume is out of range");
    } else {
      const now = this.audioContext.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(volume * volume, now);
    }
  }
  handleExclusiveMessage(data) {
    console.warn(`Unsupported Exclusive Message: ${data}`);
  }
  handleSysEx(data) {
    switch (data[0]) {
      case 126:
        return this.handleUniversalNonRealTimeExclusiveMessage(data);
      case 127:
        return this.handleUniversalRealTimeExclusiveMessage(data);
      default:
        return this.handleExclusiveMessage(data);
    }
  }
  scheduleTask(callback, startTime) {
    return new Promise((resolve) => {
      const bufferSource = new AudioBufferSourceNode(this.audioContext);
      bufferSource.onended = () => {
        callback();
        resolve();
      };
      bufferSource.start(startTime);
      bufferSource.stop(startTime);
    });
  }
};
export {
  MidyGM1
};
