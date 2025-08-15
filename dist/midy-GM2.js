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

// src/midy-GM2.js
var import_midi_file = __toESM(require_midi_file());

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.1/node_modules/@marmooo/soundfont-parser/esm/Stream.js
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

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.1/node_modules/@marmooo/soundfont-parser/esm/RiffParser.js
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

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.1/node_modules/@marmooo/soundfont-parser/esm/Constants.js
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

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.1/node_modules/@marmooo/soundfont-parser/esm/Modulator.js
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

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.1/node_modules/@marmooo/soundfont-parser/esm/Structs.js
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
  transform(inputValue) {
    const newValue = this.value * inputValue;
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

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.1/node_modules/@marmooo/soundfont-parser/esm/Parser.js
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

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.1/node_modules/@marmooo/soundfont-parser/esm/Generator.js
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

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.1/node_modules/@marmooo/soundfont-parser/esm/Voice.js
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

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.1/node_modules/@marmooo/soundfont-parser/esm/DefaultModulators.js
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

// ../../../.cache/deno/deno_esbuild/registry.npmjs.org/@marmooo/soundfont-parser@0.1.1/node_modules/@marmooo/soundfont-parser/esm/SoundFont.js
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

// src/midy-GM2.js
var SparseMap = class {
  constructor(size) {
    this.data = new Array(size);
    this.activeIndices = [];
  }
  set(key, value) {
    if (this.data[key] === void 0) {
      this.activeIndices.push(key);
    }
    this.data[key] = value;
  }
  get(key) {
    return this.data[key];
  }
  delete(key) {
    if (this.data[key] !== void 0) {
      this.data[key] = void 0;
      const index = this.activeIndices.indexOf(key);
      if (index !== -1) {
        this.activeIndices.splice(index, 1);
      }
      return true;
    }
    return false;
  }
  has(key) {
    return this.data[key] !== void 0;
  }
  get size() {
    return this.activeIndices.length;
  }
  clear() {
    for (let i = 0; i < this.activeIndices.length; i++) {
      const key = this.activeIndices[i];
      this.data[key] = void 0;
    }
    this.activeIndices = [];
  }
  *[Symbol.iterator]() {
    for (let i = 0; i < this.activeIndices.length; i++) {
      const key = this.activeIndices[i];
      yield [key, this.data[key]];
    }
  }
  forEach(callback) {
    for (let i = 0; i < this.activeIndices.length; i++) {
      const key = this.activeIndices[i];
      callback(this.data[key], key, this);
    }
  }
};
var Note = class {
  bufferSource;
  filterNode;
  volumeEnvelopeNode;
  volumeNode;
  gainL;
  gainR;
  volumeDepth;
  modulationLFO;
  modulationDepth;
  vibratoLFO;
  vibratoDepth;
  reverbEffectsSend;
  chorusEffectsSend;
  portamento;
  constructor(noteNumber, velocity, startTime2, voice, voiceParams) {
    this.noteNumber = noteNumber;
    this.velocity = velocity;
    this.startTime = startTime2;
    this.voice = voice;
    this.voiceParams = voiceParams;
  }
};
var defaultControllerState = {
  noteOnVelocity: { type: 2, defaultValue: 0 },
  noteOnKeyNumber: { type: 3, defaultValue: 0 },
  channelPressure: { type: 13, defaultValue: 0 },
  pitchWheel: { type: 14, defaultValue: 8192 / 16383 },
  pitchWheelSensitivity: { type: 16, defaultValue: 2 / 128 },
  link: { type: 127, defaultValue: 0 },
  // bankMSB: { type: 128 + 0, defaultValue: 121, },
  modulationDepth: { type: 128 + 1, defaultValue: 0 },
  portamentoTime: { type: 128 + 5, defaultValue: 0 },
  // dataMSB: { type: 128 + 6, defaultValue: 0, },
  volume: { type: 128 + 7, defaultValue: 100 / 127 },
  pan: { type: 128 + 10, defaultValue: 0.5 },
  expression: { type: 128 + 11, defaultValue: 1 },
  // bankLSB: { type: 128 + 32, defaultValue: 0, },
  // dataLSB: { type: 128 + 38, defaultValue: 0, },
  sustainPedal: { type: 128 + 64, defaultValue: 0 },
  portamento: { type: 128 + 65, defaultValue: 0 },
  sostenutoPedal: { type: 128 + 66, defaultValue: 0 },
  softPedal: { type: 128 + 67, defaultValue: 0 },
  filterResonance: { type: 128 + 71, defaultValue: 0.5 },
  releaseTime: { type: 128 + 72, defaultValue: 0.5 },
  attackTime: { type: 128 + 73, defaultValue: 0.5 },
  brightness: { type: 128 + 74, defaultValue: 0.5 },
  decayTime: { type: 128 + 75, defaultValue: 0.5 },
  vibratoRate: { type: 128 + 76, defaultValue: 0.5 },
  vibratoDepth: { type: 128 + 77, defaultValue: 0.5 },
  vibratoDelay: { type: 128 + 78, defaultValue: 0.5 },
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
var filterEnvelopeKeys = [
  "modEnvToPitch",
  "initialFilterFc",
  "modEnvToFilterFc",
  "modDelay",
  "modAttack",
  "modHold",
  "modDecay",
  "modSustain",
  "modRelease",
  "playbackRate"
];
var filterEnvelopeKeySet = new Set(filterEnvelopeKeys);
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
var MidyGM2 = class {
  ticksPerBeat = 120;
  totalTime = 0;
  masterFineTuning = 0;
  // cb
  masterCoarseTuning = 0;
  // cb
  reverb = {
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
  mono = false;
  // CC#124, CC#125
  omni = false;
  // CC#126, CC#127
  noteCheckInterval = 0.1;
  lookAhead = 1;
  startDelay = 0.1;
  startTime = 0;
  resumeTime = 0;
  soundFonts = [];
  soundFontTable = this.initSoundFontTable();
  audioBufferCounter = /* @__PURE__ */ new Map();
  audioBufferCache = /* @__PURE__ */ new Map();
  isPlaying = false;
  isPausing = false;
  isPaused = false;
  isStopping = false;
  isSeeking = false;
  timeline = [];
  instruments = [];
  notePromises = [];
  exclusiveClassMap = new SparseMap(128);
  static channelSettings = {
    currentBufferSource: null,
    detune: 0,
    scaleOctaveTuningTable: new Int8Array(12),
    // [-64, 63] cent
    channelPressureTable: new Uint8Array([64, 64, 64, 0, 0, 0]),
    keyBasedInstrumentControlTable: new Int8Array(128 * 128),
    // [-64, 63]
    program: 0,
    bank: 121 * 128,
    bankMSB: 121,
    bankLSB: 0,
    dataMSB: 0,
    dataLSB: 0,
    rpnMSB: 127,
    rpnLSB: 127,
    fineTuning: 0,
    // cb
    coarseTuning: 0,
    // cb
    modulationDepthRange: 50
    // cent
  };
  defaultOptions = {
    reverbAlgorithm: (audioContext) => {
      const { time: rt60, feedback } = this.reverb;
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
  };
  constructor(audioContext, options = this.defaultOptions) {
    this.audioContext = audioContext;
    this.options = { ...this.defaultOptions, ...options };
    this.masterVolume = new GainNode(audioContext);
    this.voiceParamsHandlers = this.createVoiceParamsHandlers();
    this.controlChangeHandlers = this.createControlChangeHandlers();
    this.channels = this.createChannels(audioContext);
    this.reverbEffect = this.options.reverbAlgorithm(audioContext);
    this.chorusEffect = this.createChorusEffect(audioContext);
    this.chorusEffect.output.connect(this.masterVolume);
    this.reverbEffect.output.connect(this.masterVolume);
    this.masterVolume.connect(audioContext.destination);
    this.GM2SystemOn();
  }
  initSoundFontTable() {
    const table = new Array(128);
    for (let i = 0; i < 128; i++) {
      table[i] = new SparseMap(128);
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
  createChannels(audioContext) {
    const channels = Array.from({ length: 16 }, () => {
      return {
        ...this.constructor.channelSettings,
        state: new ControllerState(),
        controlTable: this.initControlTable(),
        ...this.setChannelAudioNodes(audioContext),
        scheduledNotes: new SparseMap(128),
        sostenutoNotes: new SparseMap(128)
      };
    });
    return channels;
  }
  async createNoteBuffer(voiceParams, isSF3) {
    const sampleStart = voiceParams.start;
    const sampleEnd = voiceParams.sample.length + voiceParams.end;
    if (isSF3) {
      const sample = voiceParams.sample;
      const start = sample.byteOffset + sampleStart;
      const end = sample.byteOffset + sampleEnd;
      const buffer = sample.buffer.slice(start, end);
      const audioBuffer = await this.audioContext.decodeAudioData(buffer);
      return audioBuffer;
    } else {
      const sample = voiceParams.sample;
      const start = sample.byteOffset + sampleStart;
      const end = sample.byteOffset + sampleEnd;
      const buffer = sample.buffer.slice(start, end);
      const audioBuffer = new AudioBuffer({
        numberOfChannels: 1,
        length: sample.length,
        sampleRate: voiceParams.sampleRate
      });
      const channelData = audioBuffer.getChannelData(0);
      const int16Array = new Int16Array(buffer);
      for (let i = 0; i < int16Array.length; i++) {
        channelData[i] = int16Array[i] / 32768;
      }
      return audioBuffer;
    }
  }
  createNoteBufferNode(audioBuffer, voiceParams) {
    const bufferSource = new AudioBufferSourceNode(this.audioContext);
    bufferSource.buffer = audioBuffer;
    bufferSource.loop = voiceParams.sampleModes % 2 !== 0;
    if (bufferSource.loop) {
      bufferSource.loopStart = voiceParams.loopStart / voiceParams.sampleRate;
      bufferSource.loopEnd = voiceParams.loopEnd / voiceParams.sampleRate;
    }
    return bufferSource;
  }
  findPortamentoTarget(queueIndex) {
    const endEvent = this.timeline[queueIndex];
    if (!this.channels[endEvent.channel].portamento) return;
    const endTime = endEvent.startTime;
    let target;
    while (++queueIndex < this.timeline.length) {
      const event = this.timeline[queueIndex];
      if (endTime !== event.startTime) break;
      if (event.type !== "noteOn") continue;
      if (!target || event.noteNumber < target.noteNumber) {
        target = event;
      }
    }
    return target;
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
              event.startTime + this.startDelay - offset,
              event.portamento
            );
            break;
          }
        /* falls through */
        case "noteOff": {
          const portamentoTarget = this.findPortamentoTarget(queueIndex);
          if (portamentoTarget) portamentoTarget.portamento = true;
          const notePromise = this.scheduleNoteRelease(
            this.omni ? 0 : event.channel,
            event.noteNumber,
            event.velocity,
            event.startTime + this.startDelay - offset,
            portamentoTarget?.noteNumber,
            false
            // force
          );
          if (notePromise) {
            this.notePromises.push(notePromise);
          }
          break;
        }
        case "controller":
          this.handleControlChange(
            this.omni ? 0 : event.channel,
            event.controllerType,
            event.value
          );
          break;
        case "programChange":
          this.handleProgramChange(event.channel, event.programNumber);
          break;
        case "channelAftertouch":
          this.handleChannelPressure(event.channel, event.amount);
          break;
        case "pitchBend":
          this.setPitchBend(event.channel, event.value + 8192);
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
          this.audioBufferCache.clear();
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
          this.notePromises = [];
          this.exclusiveClassMap.clear();
          this.audioBufferCache.clear();
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
  getAudioBufferId(programNumber, noteNumber, velocity) {
    return `${programNumber}:${noteNumber}:${velocity}`;
  }
  extractMidiData(midi) {
    const instruments = /* @__PURE__ */ new Set();
    const timeline = [];
    const tmpChannels = new Array(16);
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
            const audioBufferId = this.getAudioBufferId(
              channel2.programNumber,
              event.noteNumber,
              event.velocity
            );
            this.audioBufferCounter.set(
              audioBufferId,
              (this.audioBufferCounter.get(audioBufferId) ?? 0) + 1
            );
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
    for (const [audioBufferId, count] of this.audioBufferCounter) {
      if (count === 1) this.audioBufferCounter.delete(audioBufferId);
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
  async stopChannelNotes(channelNumber, velocity, force) {
    const now = this.audioContext.currentTime;
    const channel2 = this.channels[channelNumber];
    channel2.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        const promise = this.scheduleNoteRelease(
          channelNumber,
          note.noteNumber,
          velocity,
          now,
          void 0,
          // portamentoNoteNumber
          force
        );
        this.notePromises.push(promise);
      }
    });
    channel2.scheduledNotes.clear();
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
  getActiveNotes(channel2, time) {
    const activeNotes = new SparseMap(128);
    channel2.scheduledNotes.forEach((noteList) => {
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
    const input = new GainNode(audioContext);
    const convolverNode = new ConvolverNode(audioContext, {
      buffer: impulse
    });
    input.connect(convolverNode);
    return {
      input,
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
    const masterTuning = this.masterCoarseTuning + this.masterFineTuning;
    const channelTuning = channel2.coarseTuning + channel2.fineTuning;
    const tuning = masterTuning + channelTuning;
    const pitchWheel = channel2.state.pitchWheel * 2 - 1;
    const pitchWheelSensitivity = channel2.state.pitchWheelSensitivity * 12800;
    const pitch = pitchWheel * pitchWheelSensitivity;
    const pressureDepth = (channel2.channelPressureTable[0] - 64) / 37.5;
    const pressure = pressureDepth * channel2.state.channelPressure;
    return tuning + pitch + pressure;
  }
  calcNoteDetune(channel2, note) {
    return channel2.scaleOctaveTuningTable[note.noteNumber % 12];
  }
  updateChannelDetune(channel2) {
    channel2.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        this.updateDetune(channel2, note, 0);
      }
    });
  }
  updateDetune(channel2, note, pressure) {
    const now = this.audioContext.currentTime;
    const noteDetune = this.calcNoteDetune(channel2, note);
    const detune = channel2.detune + noteDetune + pressure;
    note.bufferSource.detune.cancelScheduledValues(now).setValueAtTime(detune, now);
  }
  getPortamentoTime(channel2) {
    const factor = 5 * Math.log(10) / 127;
    const time = channel2.state.portamentoTime;
    return Math.log(time) / factor;
  }
  setPortamentoStartVolumeEnvelope(channel2, note) {
    const now = this.audioContext.currentTime;
    const { voiceParams, startTime: startTime2 } = note;
    const attackVolume = this.cbToRatio(-voiceParams.initialAttenuation);
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelay = startTime2 + voiceParams.volDelay;
    const portamentoTime = volDelay + this.getPortamentoTime(channel2);
    note.volumeEnvelopeNode.gain.cancelScheduledValues(now).setValueAtTime(0, volDelay).linearRampToValueAtTime(sustainVolume, portamentoTime);
  }
  setVolumeEnvelope(note, pressure) {
    const now = this.audioContext.currentTime;
    const { voiceParams, startTime: startTime2 } = note;
    const attackVolume = this.cbToRatio(-voiceParams.initialAttenuation) * (1 + pressure);
    const sustainVolume = attackVolume * (1 - voiceParams.volSustain);
    const volDelay = startTime2 + voiceParams.volDelay;
    const volAttack = volDelay + voiceParams.volAttack;
    const volHold = volAttack + voiceParams.volHold;
    const volDecay = volHold + voiceParams.volDecay;
    note.volumeEnvelopeNode.gain.cancelScheduledValues(now).setValueAtTime(0, startTime2).setValueAtTime(1e-6, volDelay).exponentialRampToValueAtTime(attackVolume, volAttack).setValueAtTime(attackVolume, volHold).linearRampToValueAtTime(sustainVolume, volDecay);
  }
  setPitchEnvelope(note) {
    const now = this.audioContext.currentTime;
    const { voiceParams } = note;
    const baseRate = voiceParams.playbackRate;
    note.bufferSource.playbackRate.cancelScheduledValues(now).setValueAtTime(baseRate, now);
    const modEnvToPitch = voiceParams.modEnvToPitch;
    if (modEnvToPitch === 0) return;
    const basePitch = this.rateToCent(baseRate);
    const peekPitch = basePitch + modEnvToPitch;
    const peekRate = this.centToRate(peekPitch);
    const modDelay = startTime + voiceParams.modDelay;
    const modAttack = modDelay + voiceParams.modAttack;
    const modHold = modAttack + voiceParams.modHold;
    const modDecay = modHold + voiceParams.modDecay;
    note.bufferSource.playbackRate.setValueAtTime(baseRate, modDelay).exponentialRampToValueAtTime(peekRate, modAttack).setValueAtTime(peekRate, modHold).linearRampToValueAtTime(baseRate, modDecay);
  }
  clampCutoffFrequency(frequency) {
    const minFrequency = 20;
    const maxFrequency = 2e4;
    return Math.max(minFrequency, Math.min(frequency, maxFrequency));
  }
  setPortamentoStartFilterEnvelope(channel2, note) {
    const now = this.audioContext.currentTime;
    const state = channel2.state;
    const { voiceParams, noteNumber, startTime: startTime2 } = note;
    const softPedalFactor = 1 - (0.1 + noteNumber / 127 * 0.2) * state.softPedal;
    const baseFreq = this.centToHz(voiceParams.initialFilterFc) * softPedalFactor;
    const peekFreq = this.centToHz(
      voiceParams.initialFilterFc + voiceParams.modEnvToFilterFc
    ) * softPedalFactor;
    const sustainFreq = baseFreq + (peekFreq - baseFreq) * (1 - voiceParams.modSustain);
    const adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
    const adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
    const portamentoTime = startTime2 + this.getPortamentoTime(channel2);
    const modDelay = startTime2 + voiceParams.modDelay;
    note.filterNode.frequency.cancelScheduledValues(now).setValueAtTime(adjustedBaseFreq, startTime2).setValueAtTime(adjustedBaseFreq, modDelay).linearRampToValueAtTime(adjustedSustainFreq, portamentoTime);
  }
  setFilterEnvelope(channel2, note, pressure) {
    const now = this.audioContext.currentTime;
    const state = channel2.state;
    const { voiceParams, noteNumber, startTime: startTime2 } = note;
    const softPedalFactor = 1 - (0.1 + noteNumber / 127 * 0.2) * state.softPedal;
    const baseCent = voiceParams.initialFilterFc + pressure;
    const baseFreq = this.centToHz(baseCent) * softPedalFactor;
    const peekFreq = this.centToHz(baseCent + voiceParams.modEnvToFilterFc) * softPedalFactor;
    const sustainFreq = baseFreq + (peekFreq - baseFreq) * (1 - voiceParams.modSustain);
    const adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
    const adjustedPeekFreq = this.clampCutoffFrequency(peekFreq);
    const adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
    const modDelay = startTime2 + voiceParams.modDelay;
    const modAttack = modDelay + voiceParams.modAttack;
    const modHold = modAttack + voiceParams.modHold;
    const modDecay = modHold + voiceParams.modDecay;
    note.filterNode.frequency.cancelScheduledValues(now).setValueAtTime(adjustedBaseFreq, startTime2).setValueAtTime(adjustedBaseFreq, modDelay).exponentialRampToValueAtTime(adjustedPeekFreq, modAttack).setValueAtTime(adjustedPeekFreq, modHold).linearRampToValueAtTime(adjustedSustainFreq, modDecay);
  }
  startModulation(channel2, note, startTime2) {
    const { voiceParams } = note;
    note.modulationLFO = new OscillatorNode(this.audioContext, {
      frequency: this.centToHz(voiceParams.freqModLFO)
    });
    note.filterDepth = new GainNode(this.audioContext, {
      gain: voiceParams.modLfoToFilterFc
    });
    note.modulationDepth = new GainNode(this.audioContext);
    this.setModLfoToPitch(channel2, note, 0);
    note.volumeDepth = new GainNode(this.audioContext);
    this.setModLfoToVolume(note, 0);
    note.modulationLFO.start(startTime2 + voiceParams.delayModLFO);
    note.modulationLFO.connect(note.filterDepth);
    note.filterDepth.connect(note.filterNode.frequency);
    note.modulationLFO.connect(note.modulationDepth);
    note.modulationDepth.connect(note.bufferSource.detune);
    note.modulationLFO.connect(note.volumeDepth);
    note.volumeDepth.connect(note.volumeEnvelopeNode.gain);
  }
  startVibrato(channel2, note, startTime2) {
    const { voiceParams } = note;
    const state = channel2.state;
    note.vibratoLFO = new OscillatorNode(this.audioContext, {
      frequency: this.centToHz(voiceParams.freqVibLFO) * state.vibratoRate * 2
    });
    note.vibratoLFO.start(
      startTime2 + voiceParams.delayVibLFO * state.vibratoDelay * 2
    );
    note.vibratoDepth = new GainNode(this.audioContext);
    this.setVibLfoToPitch(channel2, note);
    note.vibratoLFO.connect(note.vibratoDepth);
    note.vibratoDepth.connect(note.bufferSource.detune);
  }
  async getAudioBuffer(program, noteNumber, velocity, voiceParams, isSF3) {
    const audioBufferId = this.getAudioBufferId(program, noteNumber, velocity);
    const cache = this.audioBufferCache.get(audioBufferId);
    if (cache) {
      cache.counter += 1;
      if (cache.maxCount <= cache.counter) {
        this.audioBufferCache.delete(audioBufferId);
      }
      return cache.audioBuffer;
    } else {
      const maxCount = this.audioBufferCounter.get(audioBufferId) ?? 0;
      const audioBuffer = await this.createNoteBuffer(voiceParams, isSF3);
      const cache2 = { audioBuffer, maxCount, counter: 1 };
      this.audioBufferCache.set(audioBufferId, cache2);
      return audioBuffer;
    }
  }
  async createNote(channel2, voice, noteNumber, velocity, startTime2, portamento, isSF3) {
    const state = channel2.state;
    const controllerState = this.getControllerState(
      channel2,
      noteNumber,
      velocity
    );
    const voiceParams = voice.getAllParams(controllerState);
    const note = new Note(noteNumber, velocity, startTime2, voice, voiceParams);
    const audioBuffer = await this.getAudioBuffer(
      channel2.program,
      noteNumber,
      velocity,
      voiceParams,
      isSF3
    );
    note.bufferSource = this.createNoteBufferNode(audioBuffer, voiceParams);
    note.volumeNode = new GainNode(this.audioContext);
    note.gainL = new GainNode(this.audioContext);
    note.gainR = new GainNode(this.audioContext);
    note.volumeEnvelopeNode = new GainNode(this.audioContext);
    note.filterNode = new BiquadFilterNode(this.audioContext, {
      type: "lowpass",
      Q: voiceParams.initialFilterQ / 10
      // dB
    });
    if (portamento) {
      note.portamento = true;
      this.setPortamentoStartVolumeEnvelope(channel2, note);
      this.setPortamentoStartFilterEnvelope(channel2, note);
    } else {
      note.portamento = false;
      this.setVolumeEnvelope(note, 0);
      this.setFilterEnvelope(channel2, note, 0);
    }
    if (0 < state.vibratoDepth) {
      this.startVibrato(channel2, note, startTime2);
    }
    this.setPitchEnvelope(note);
    if (0 < state.modulationDepth) {
      this.startModulation(channel2, note, startTime2);
    }
    if (this.mono && channel2.currentBufferSource) {
      channel2.currentBufferSource.stop(startTime2);
      channel2.currentBufferSource = note.bufferSource;
    }
    note.bufferSource.connect(note.filterNode);
    note.filterNode.connect(note.volumeEnvelopeNode);
    note.volumeEnvelopeNode.connect(note.volumeNode);
    note.volumeNode.connect(note.gainL);
    note.volumeNode.connect(note.gainR);
    if (0 < channel2.chorusSendLevel) {
      this.setChorusEffectsSend(channel2, note, 0);
    }
    if (0 < channel2.reverbSendLevel) {
      this.setReverbEffectsSend(channel2, note, 0);
    }
    note.bufferSource.start(startTime2);
    return note;
  }
  calcBank(channel2, channelNumber) {
    if (channel2.bankMSB === 121) {
      return 0;
    }
    if (channelNumber % 9 <= 1 && channel2.bankMSB === 120) {
      return 128;
    }
    return channel2.bank;
  }
  async scheduleNoteOn(channelNumber, noteNumber, velocity, startTime2, portamento) {
    const channel2 = this.channels[channelNumber];
    const bankNumber = this.calcBank(channel2, channelNumber);
    const soundFontIndex = this.soundFontTable[channel2.program].get(bankNumber);
    if (soundFontIndex === void 0) return;
    const soundFont = this.soundFonts[soundFontIndex];
    const voice = soundFont.getVoice(
      bankNumber,
      channel2.program,
      noteNumber,
      velocity
    );
    if (!voice) return;
    const isSF3 = soundFont.parsed.info.version.major === 3;
    const note = await this.createNote(
      channel2,
      voice,
      noteNumber,
      velocity,
      startTime2,
      portamento,
      isSF3
    );
    note.gainL.connect(channel2.gainL);
    note.gainR.connect(channel2.gainR);
    if (channel2.state.sostenutoPedal) {
      channel2.sostenutoNotes.set(noteNumber, note);
    }
    const exclusiveClass = note.voiceParams.exclusiveClass;
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
            startTime2,
            void 0,
            // portamentoNoteNumber
            true
            // force
          );
        }
      }
      this.exclusiveClassMap.set(exclusiveClass, [note, channelNumber]);
    }
    const scheduledNotes = channel2.scheduledNotes;
    if (scheduledNotes.has(noteNumber)) {
      scheduledNotes.get(noteNumber).push(note);
    } else {
      scheduledNotes.set(noteNumber, [note]);
    }
  }
  noteOn(channelNumber, noteNumber, velocity, portamento) {
    const now = this.audioContext.currentTime;
    return this.scheduleNoteOn(
      channelNumber,
      noteNumber,
      velocity,
      now,
      portamento
    );
  }
  stopNote(endTime, stopTime, scheduledNotes, index) {
    const note = scheduledNotes[index];
    note.volumeEnvelopeNode.gain.cancelScheduledValues(endTime).linearRampToValueAtTime(0, stopTime);
    note.ending = true;
    this.scheduleTask(() => {
      note.bufferSource.loop = false;
    }, stopTime);
    return new Promise((resolve) => {
      note.bufferSource.onended = () => {
        scheduledNotes[index] = null;
        note.bufferSource.disconnect();
        note.filterNode.disconnect();
        note.volumeEnvelopeNode.disconnect();
        note.volumeNode.disconnect();
        note.gainL.disconnect();
        note.gainR.disconnect();
        if (note.modulationDepth) {
          note.volumeDepth.disconnect();
          note.modulationDepth.disconnect();
          note.modulationLFO.stop();
        }
        if (note.vibratoDepth) {
          note.vibratoDepth.disconnect();
          note.vibratoLFO.stop();
        }
        if (note.reverbEffectsSend) {
          note.reverbEffectsSend.disconnect();
        }
        if (note.chorusEffectsSend) {
          note.chorusEffectsSend.disconnect();
        }
        resolve();
      };
      note.bufferSource.stop(stopTime);
    });
  }
  scheduleNoteRelease(channelNumber, noteNumber, _velocity, endTime, portamentoNoteNumber, force) {
    const channel2 = this.channels[channelNumber];
    const state = channel2.state;
    if (!force) {
      if (0.5 < state.sustainPedal) return;
      if (channel2.sostenutoNotes.has(noteNumber)) return;
    }
    if (!channel2.scheduledNotes.has(noteNumber)) return;
    const scheduledNotes = channel2.scheduledNotes.get(noteNumber);
    for (let i = 0; i < scheduledNotes.length; i++) {
      const note = scheduledNotes[i];
      if (!note) continue;
      if (note.ending) continue;
      if (portamentoNoteNumber === void 0) {
        const volRelease = endTime + note.voiceParams.volRelease;
        const modRelease = endTime + note.voiceParams.modRelease;
        note.filterNode.frequency.cancelScheduledValues(endTime).linearRampToValueAtTime(0, modRelease);
        const stopTime = Math.min(volRelease, modRelease);
        return this.stopNote(endTime, stopTime, scheduledNotes, i);
      } else {
        const portamentoTime = endTime + this.getPortamentoTime(channel2);
        const deltaNote = portamentoNoteNumber - noteNumber;
        const baseRate = note.voiceParams.playbackRate;
        const targetRate = baseRate * Math.pow(2, deltaNote / 12);
        note.bufferSource.playbackRate.cancelScheduledValues(endTime).linearRampToValueAtTime(targetRate, portamentoTime);
        return this.stopNote(endTime, portamentoTime, scheduledNotes, i);
      }
    }
  }
  releaseNote(channelNumber, noteNumber, velocity, portamentoNoteNumber) {
    const now = this.audioContext.currentTime;
    return this.scheduleNoteRelease(
      channelNumber,
      noteNumber,
      velocity,
      now,
      portamentoNoteNumber,
      false
    );
  }
  releaseSustainPedal(channelNumber, halfVelocity) {
    const velocity = halfVelocity * 2;
    const channel2 = this.channels[channelNumber];
    const promises = [];
    channel2.state.sustainPedal = halfVelocity;
    channel2.scheduledNotes.forEach((noteList) => {
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
  releaseSostenutoPedal(channelNumber, halfVelocity) {
    const velocity = halfVelocity * 2;
    const channel2 = this.channels[channelNumber];
    const promises = [];
    channel2.state.sostenutoPedal = 0;
    channel2.sostenutoNotes.forEach((activeNote) => {
      const { noteNumber } = activeNote;
      const promise = this.releaseNote(channelNumber, noteNumber, velocity);
      promises.push(promise);
    });
    channel2.sostenutoNotes.clear();
    return promises;
  }
  handleMIDIMessage(statusByte, data1, data2) {
    const channelNumber = omni ? 0 : statusByte & 15;
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
      case 208:
        return this.handleChannelPressure(channelNumber, data1);
      case 224:
        return this.handlePitchBendMessage(channelNumber, data1, data2);
      default:
        console.warn(`Unsupported MIDI message: ${messageType.toString(16)}`);
    }
  }
  handleProgramChange(channelNumber, program) {
    const channel2 = this.channels[channelNumber];
    channel2.bank = channel2.bankMSB * 128 + channel2.bankLSB;
    channel2.program = program;
  }
  handleChannelPressure(channelNumber, value) {
    const now = this.audioContext.currentTime;
    const channel2 = this.channels[channelNumber];
    const prev = channel2.state.channelPressure;
    const next = value / 127;
    channel2.state.channelPressure = next;
    if (channel2.channelPressureTable[0] !== 64) {
      const pressureDepth = (channel2.channelPressureTable[0] - 64) / 37.5;
      channel2.detune += pressureDepth * (next - prev);
    }
    const table = channel2.channelPressureTable;
    this.getActiveNotes(channel2, now).forEach((note) => {
      this.applyDestinationSettings(channel2, note, table);
    });
  }
  handlePitchBendMessage(channelNumber, lsb, msb) {
    const pitchBend = msb * 128 + lsb;
    this.setPitchBend(channelNumber, pitchBend);
  }
  setPitchBend(channelNumber, value) {
    const channel2 = this.channels[channelNumber];
    const state = channel2.state;
    const prev = state.pitchWheel * 2 - 1;
    const next = (value - 8192) / 8192;
    state.pitchWheel = value / 16383;
    channel2.detune += (next - prev) * state.pitchWheelSensitivity * 12800;
    this.updateChannelDetune(channel2);
    this.applyVoiceParams(channel2, 14);
  }
  setModLfoToPitch(channel2, note, pressure) {
    const now = this.audioContext.currentTime;
    const modLfoToPitch = note.voiceParams.modLfoToPitch + pressure;
    const baseDepth = Math.abs(modLfoToPitch) + channel2.state.modulationDepth;
    const modulationDepth = baseDepth * Math.sign(modLfoToPitch);
    note.modulationDepth.gain.cancelScheduledValues(now).setValueAtTime(modulationDepth, now);
  }
  setVibLfoToPitch(channel2, note) {
    const now = this.audioContext.currentTime;
    const vibLfoToPitch = note.voiceParams.vibLfoToPitch;
    const vibratoDepth = Math.abs(vibLfoToPitch) * channel2.state.vibratoDepth * 2;
    const vibratoDepthSign = 0 < vibLfoToPitch;
    note.vibratoDepth.gain.cancelScheduledValues(now).setValueAtTime(vibratoDepth * vibratoDepthSign, now);
  }
  setModLfoToFilterFc(note, pressure) {
    const now = this.audioContext.currentTime;
    const modLfoToFilterFc = note.voiceParams.modLfoToFilterFc + pressure;
    note.filterDepth.gain.cancelScheduledValues(now).setValueAtTime(modLfoToFilterFc, now);
  }
  setModLfoToVolume(note, pressure) {
    const now = this.audioContext.currentTime;
    const modLfoToVolume = note.voiceParams.modLfoToVolume;
    const baseDepth = this.cbToRatio(Math.abs(modLfoToVolume)) - 1;
    const volumeDepth = baseDepth * Math.sign(modLfoToVolume) * (1 + pressure);
    note.volumeDepth.gain.cancelScheduledValues(now).setValueAtTime(volumeDepth, now);
  }
  setReverbEffectsSend(channel2, note, prevValue) {
    if (0 < prevValue) {
      if (0 < note.voiceParams.reverbEffectsSend) {
        const now = this.audioContext.currentTime;
        const keyBasedValue = this.getKeyBasedInstrumentControlValue(
          channel2,
          note.noteNumber,
          91
        );
        const value = note.voiceParams.reverbEffectsSend + keyBasedValue;
        note.reverbEffectsSend.gain.cancelScheduledValues(now).setValueAtTime(value, now);
      } else {
        note.reverbEffectsSend.disconnect();
      }
    } else {
      if (0 < note.voiceParams.reverbEffectsSend) {
        if (!note.reverbEffectsSend) {
          note.reverbEffectsSend = new GainNode(this.audioContext, {
            gain: note.voiceParams.reverbEffectsSend
          });
          note.volumeNode.connect(note.reverbEffectsSend);
        }
        note.reverbEffectsSend.connect(this.reverbEffect.input);
      }
    }
  }
  setChorusEffectsSend(channel2, note, prevValue) {
    if (0 < prevValue) {
      if (0 < note.voiceParams.chorusEffectsSend) {
        const now = this.audioContext.currentTime;
        const keyBasedValue = this.getKeyBasedInstrumentControlValue(
          channel2,
          note.noteNumber,
          93
        );
        const value = note.voiceParams.chorusEffectsSend + keyBasedValue;
        note.chorusEffectsSend.gain.cancelScheduledValues(now).setValueAtTime(value, now);
      } else {
        note.chorusEffectsSend.disconnect();
      }
    } else {
      if (0 < note.voiceParams.chorusEffectsSend) {
        if (!note.chorusEffectsSend) {
          note.chorusEffectsSend = new GainNode(this.audioContext, {
            gain: note.voiceParams.chorusEffectsSend
          });
          note.volumeNode.connect(note.chorusEffectsSend);
        }
        note.chorusEffectsSend.connect(this.chorusEffect.input);
      }
    }
  }
  setDelayModLFO(note) {
    const now = this.audioContext.currentTime;
    const startTime2 = note.startTime;
    if (startTime2 < now) return;
    note.modulationLFO.stop(now);
    note.modulationLFO.start(startTime2 + note.voiceParams.delayModLFO);
    note.modulationLFO.connect(note.filterDepth);
  }
  setFreqModLFO(note) {
    const now = this.audioContext.currentTime;
    const freqModLFO = note.voiceParams.freqModLFO;
    note.modulationLFO.frequency.cancelScheduledValues(now).setValueAtTime(freqModLFO, now);
  }
  setFreqVibLFO(channel2, note) {
    const now = this.audioContext.currentTime;
    const freqVibLFO = note.voiceParams.freqVibLFO;
    note.vibratoLFO.frequency.cancelScheduledValues(now).setValueAtTime(freqVibLFO * channel2.state.vibratoRate * 2, now);
  }
  createVoiceParamsHandlers() {
    return {
      modLfoToPitch: (channel2, note, _prevValue) => {
        if (0 < channel2.state.modulationDepth) {
          this.setModLfoToPitch(channel2, note, 0);
        }
      },
      vibLfoToPitch: (channel2, note, _prevValue) => {
        if (0 < channel2.state.vibratoDepth) {
          this.setVibLfoToPitch(channel2, note);
        }
      },
      modLfoToFilterFc: (channel2, note, _prevValue) => {
        if (0 < channel2.state.modulationDepth) {
          this.setModLfoToFilterFc(note, 0);
        }
      },
      modLfoToVolume: (channel2, note, _prevValue) => {
        if (0 < channel2.state.modulationDepth) {
          this.setModLfoToVolume(note, 0);
        }
      },
      chorusEffectsSend: (channel2, note, prevValue) => {
        this.setChorusEffectsSend(channel2, note, prevValue);
      },
      reverbEffectsSend: (channel2, note, prevValue) => {
        this.setReverbEffectsSend(channel2, note, prevValue);
      },
      delayModLFO: (_channel, note, _prevValue) => this.setDelayModLFO(note),
      freqModLFO: (_channel, note, _prevValue) => this.setFreqModLFO(note),
      delayVibLFO: (channel2, note, prevValue) => {
        if (0 < channel2.state.vibratoDepth) {
          const now = this.audioContext.currentTime;
          const vibratoDelay = channel2.state.vibratoDelay * 2;
          const prevStartTime = note.startTime + prevValue * vibratoDelay;
          if (now < prevStartTime) return;
          const value = note.voiceParams.delayVibLFO;
          const startTime2 = note.startTime + value * vibratoDelay;
          note.vibratoLFO.stop(now);
          note.vibratoLFO.start(startTime2);
        }
      },
      freqVibLFO: (channel2, note, _prevValue) => {
        if (0 < channel2.state.vibratoDepth) {
          this.setFreqVibLFO(channel2, note);
        }
      }
    };
  }
  getControllerState(channel2, noteNumber, velocity) {
    const state = new Float32Array(channel2.state.array.length);
    state.set(channel2.state.array);
    state[2] = velocity / 127;
    state[3] = noteNumber / 127;
    return state;
  }
  applyVoiceParams(channel2, controllerType) {
    channel2.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        const controllerState = this.getControllerState(
          channel2,
          note.noteNumber,
          note.velocity
        );
        const voiceParams = note.voice.getParams(
          controllerType,
          controllerState
        );
        let appliedFilterEnvelope = false;
        let appliedVolumeEnvelope = false;
        for (const [key, value] of Object.entries(voiceParams)) {
          const prevValue = note.voiceParams[key];
          if (value === prevValue) continue;
          note.voiceParams[key] = value;
          if (key in this.voiceParamsHandlers) {
            this.voiceParamsHandlers[key](channel2, note, prevValue);
          } else if (filterEnvelopeKeySet.has(key)) {
            if (appliedFilterEnvelope) continue;
            appliedFilterEnvelope = true;
            const noteVoiceParams = note.voiceParams;
            for (let i2 = 0; i2 < filterEnvelopeKeys.length; i2++) {
              const key2 = filterEnvelopeKeys[i2];
              if (key2 in voiceParams) noteVoiceParams[key2] = voiceParams[key2];
            }
            if (note.portamento) {
              this.setPortamentoStartFilterEnvelope(channel2, note);
            } else {
              this.setFilterEnvelope(channel2, note, 0);
            }
            this.setPitchEnvelope(note);
          } else if (volumeEnvelopeKeySet.has(key)) {
            if (appliedVolumeEnvelope) continue;
            appliedVolumeEnvelope = true;
            const noteVoiceParams = note.voiceParams;
            for (let i2 = 0; i2 < volumeEnvelopeKeys.length; i2++) {
              const key2 = volumeEnvelopeKeys[i2];
              if (key2 in voiceParams) noteVoiceParams[key2] = voiceParams[key2];
            }
            this.setVolumeEnvelope(note, 0);
          }
        }
      }
    });
  }
  createControlChangeHandlers() {
    return {
      0: this.setBankMSB,
      1: this.setModulationDepth,
      5: this.setPortamentoTime,
      6: this.dataEntryMSB,
      7: this.setVolume,
      10: this.setPan,
      11: this.setExpression,
      32: this.setBankLSB,
      38: this.dataEntryLSB,
      64: this.setSustainPedal,
      65: this.setPortamento,
      66: this.setSostenutoPedal,
      67: this.setSoftPedal,
      91: this.setReverbSendLevel,
      93: this.setChorusSendLevel,
      100: this.setRPNLSB,
      101: this.setRPNMSB,
      120: this.allSoundOff,
      121: this.resetAllControllers,
      123: this.allNotesOff,
      124: this.omniOff,
      125: this.omniOn,
      126: this.monoOn,
      127: this.polyOn
    };
  }
  handleControlChange(channelNumber, controllerType, value) {
    const handler = this.controlChangeHandlers[controllerType];
    if (handler) {
      handler.call(this, channelNumber, value);
      const channel2 = this.channels[channelNumber];
      this.applyVoiceParams(channel2, controllerType + 128);
      this.applyControlTable(channel2, controllerType);
    } else {
      console.warn(
        `Unsupported Control change: controllerType=${controllerType} value=${value}`
      );
    }
  }
  setBankMSB(channelNumber, msb) {
    this.channels[channelNumber].bankMSB = msb;
  }
  updateModulation(channel2) {
    const now = this.audioContext.currentTime;
    const depth = channel2.state.modulationDepth * channel2.modulationDepthRange;
    channel2.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        if (note.modulationDepth) {
          note.modulationDepth.gain.setValueAtTime(depth, now);
        } else {
          this.setPitchEnvelope(note);
          this.startModulation(channel2, note, now);
        }
      }
    });
  }
  setModulationDepth(channelNumber, modulation) {
    const channel2 = this.channels[channelNumber];
    channel2.state.modulationDepth = modulation / 127;
    this.updateModulation(channel2);
  }
  setPortamentoTime(channelNumber, portamentoTime) {
    const channel2 = this.channels[channelNumber];
    const factor = 5 * Math.log(10) / 127;
    channel2.state.portamentoTime = Math.exp(factor * portamentoTime);
  }
  setKeyBasedVolume(channel2) {
    const now = this.audioContext.currentTime;
    channel2.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        const keyBasedValue = this.getKeyBasedInstrumentControlValue(
          channel2,
          note.noteNumber,
          7
        );
        if (keyBasedValue === 0) continue;
        note.volumeNode.gain.cancelScheduledValues(now).setValueAtTime(1 + keyBasedValue, now);
      }
    });
  }
  setVolume(channelNumber, volume) {
    const channel2 = this.channels[channelNumber];
    channel2.state.volume = volume / 127;
    this.updateChannelVolume(channel2);
    this.setKeyBasedVolume(channel2);
  }
  panToGain(pan) {
    const theta = Math.PI / 2 * Math.max(0, pan * 127 - 1) / 126;
    return {
      gainLeft: Math.cos(theta),
      gainRight: Math.sin(theta)
    };
  }
  setKeyBasedPan(channel2) {
    const now = this.audioContext.currentTime;
    channel2.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        const keyBasedValue = this.getKeyBasedInstrumentControlValue(
          channel2,
          note.noteNumber,
          10
        );
        if (keyBasedValue === 0) continue;
        const { gainLeft, gainRight } = this.panToGain((keyBasedValue + 1) / 2);
        note.gainL.gain.cancelScheduledValues(now).setValueAtTime(gainLeft, now);
        note.gainR.gain.cancelScheduledValues(now).setValueAtTime(gainRight, now);
      }
    });
  }
  setPan(channelNumber, pan) {
    const channel2 = this.channels[channelNumber];
    channel2.state.pan = pan / 127;
    this.updateChannelVolume(channel2);
    this.setKeyBasedPan(channel2);
  }
  setExpression(channelNumber, expression) {
    const channel2 = this.channels[channelNumber];
    channel2.state.expression = expression / 127;
    this.updateChannelVolume(channel2);
  }
  setBankLSB(channelNumber, lsb) {
    this.channels[channelNumber].bankLSB = lsb;
  }
  dataEntryLSB(channelNumber, value) {
    this.channels[channelNumber].dataLSB = value;
    this.handleRPN(channelNumber);
  }
  updateChannelVolume(channel2) {
    const now = this.audioContext.currentTime;
    const state = channel2.state;
    const volume = state.volume * state.expression;
    const { gainLeft, gainRight } = this.panToGain(state.pan);
    channel2.gainL.gain.cancelScheduledValues(now).setValueAtTime(volume * gainLeft, now);
    channel2.gainR.gain.cancelScheduledValues(now).setValueAtTime(volume * gainRight, now);
  }
  setSustainPedal(channelNumber, value) {
    this.channels[channelNumber].state.sustainPedal = value / 127;
    if (value < 64) {
      this.releaseSustainPedal(channelNumber, value);
    }
  }
  setPortamento(channelNumber, value) {
    this.channels[channelNumber].state.portamento = value / 127;
  }
  setSostenutoPedal(channelNumber, value) {
    const channel2 = this.channels[channelNumber];
    channel2.state.sostenutoPedal = value / 127;
    if (64 <= value) {
      const now = this.audioContext.currentTime;
      channel2.sostenutoNotes = this.getActiveNotes(channel2, now);
    } else {
      this.releaseSostenutoPedal(channelNumber, value);
    }
  }
  setSoftPedal(channelNumber, softPedal) {
    const channel2 = this.channels[channelNumber];
    channel2.state.softPedal = softPedal / 127;
  }
  setReverbSendLevel(channelNumber, reverbSendLevel) {
    const channel2 = this.channels[channelNumber];
    const state = channel2.state;
    const reverbEffect = this.reverbEffect;
    if (0 < state.reverbSendLevel) {
      if (0 < reverbSendLevel) {
        const now = this.audioContext.currentTime;
        state.reverbSendLevel = reverbSendLevel / 127;
        reverbEffect.input.gain.cancelScheduledValues(now);
        reverbEffect.input.gain.setValueAtTime(state.reverbSendLevel, now);
      } else {
        channel2.scheduledNotes.forEach((noteList) => {
          for (let i = 0; i < noteList.length; i++) {
            const note = noteList[i];
            if (!note) continue;
            if (note.voiceParams.reverbEffectsSend <= 0) continue;
            note.reverbEffectsSend.disconnect();
          }
        });
      }
    } else {
      if (0 < reverbSendLevel) {
        const now = this.audioContext.currentTime;
        channel2.scheduledNotes.forEach((noteList) => {
          for (let i = 0; i < noteList.length; i++) {
            const note = noteList[i];
            if (!note) continue;
            this.setReverbEffectsSend(channel2, note, 0);
          }
        });
        state.reverbSendLevel = reverbSendLevel / 127;
        reverbEffect.input.gain.cancelScheduledValues(now);
        reverbEffect.input.gain.setValueAtTime(state.reverbSendLevel, now);
      }
    }
  }
  setChorusSendLevel(channelNumber, chorusSendLevel) {
    const channel2 = this.channels[channelNumber];
    const state = channel2.state;
    const chorusEffect = this.chorusEffect;
    if (0 < state.chorusSendLevel) {
      if (0 < chorusSendLevel) {
        const now = this.audioContext.currentTime;
        state.chorusSendLevel = chorusSendLevel / 127;
        chorusEffect.input.gain.cancelScheduledValues(now);
        chorusEffect.input.gain.setValueAtTime(state.chorusSendLevel, now);
      } else {
        channel2.scheduledNotes.forEach((noteList) => {
          for (let i = 0; i < noteList.length; i++) {
            const note = noteList[i];
            if (!note) continue;
            if (note.voiceParams.chorusEffectsSend <= 0) continue;
            note.chorusEffectsSend.disconnect();
          }
        });
      }
    } else {
      if (0 < chorusSendLevel) {
        const now = this.audioContext.currentTime;
        channel2.scheduledNotes.forEach((noteList) => {
          for (let i = 0; i < noteList.length; i++) {
            const note = noteList[i];
            if (!note) continue;
            this.setChorusEffectsSend(channel2, note, 0);
          }
        });
        state.chorusSendLevel = chorusSendLevel / 127;
        chorusEffect.input.gain.cancelScheduledValues(now);
        chorusEffect.input.gain.setValueAtTime(state.chorusSendLevel, now);
      }
    }
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
  handleRPN(channelNumber) {
    const channel2 = this.channels[channelNumber];
    const rpn = channel2.rpnMSB * 128 + channel2.rpnLSB;
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
      case 5:
        this.handleModulationDepthRangeRPN(channelNumber);
        break;
      default:
        console.warn(
          `Channel ${channelNumber}: Unsupported RPN MSB=${channel2.rpnMSB} LSB=${channel2.rpnLSB}`
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
  handlePitchBendRangeRPN(channelNumber) {
    const channel2 = this.channels[channelNumber];
    this.limitData(channel2, 0, 127, 0, 99);
    const pitchBendRange = channel2.dataMSB + channel2.dataLSB / 100;
    this.setPitchBendRange(channelNumber, pitchBendRange);
  }
  setPitchBendRange(channelNumber, value) {
    const channel2 = this.channels[channelNumber];
    const state = channel2.state;
    const prev = state.pitchWheelSensitivity;
    const next = value / 128;
    state.pitchWheelSensitivity = next;
    channel2.detune += (state.pitchWheel * 2 - 1) * (next - prev) * 12800;
    this.updateChannelDetune(channel2);
    this.applyVoiceParams(channel2, 16);
  }
  handleFineTuningRPN(channelNumber) {
    const channel2 = this.channels[channelNumber];
    this.limitData(channel2, 0, 127, 0, 127);
    const fineTuning = channel2.dataMSB * 128 + channel2.dataLSB;
    this.setFineTuning(channelNumber, fineTuning);
  }
  setFineTuning(channelNumber, value) {
    const channel2 = this.channels[channelNumber];
    const prev = channel2.fineTuning;
    const next = (value - 8192) / 8.192;
    channel2.fineTuning = next;
    channel2.detune += next - prev;
    this.updateChannelDetune(channel2);
  }
  handleCoarseTuningRPN(channelNumber) {
    const channel2 = this.channels[channelNumber];
    this.limitDataMSB(channel2, 0, 127);
    const coarseTuning = channel2.dataMSB;
    this.setCoarseTuning(channelNumber, coarseTuning);
  }
  setCoarseTuning(channelNumber, value) {
    const channel2 = this.channels[channelNumber];
    const prev = channel2.coarseTuning;
    const next = (value - 64) * 100;
    channel2.coarseTuning = next;
    channel2.detune += next - prev;
    this.updateChannelDetune(channel2);
  }
  handleModulationDepthRangeRPN(channelNumber) {
    const channel2 = this.channels[channelNumber];
    this.limitData(channel2, 0, 127, 0, 127);
    const modulationDepthRange = (dataMSB + dataLSB / 128) * 100;
    this.setModulationDepthRange(channelNumber, modulationDepthRange);
  }
  setModulationDepthRange(channelNumber, modulationDepthRange) {
    const channel2 = this.channels[channelNumber];
    channel2.modulationDepthRange = modulationDepthRange;
    this.updateModulation(channel2);
  }
  allSoundOff(channelNumber) {
    return this.stopChannelNotes(channelNumber, 0, true);
  }
  resetAllControllers(channelNumber) {
    const stateTypes = [
      "expression",
      "modulationDepth",
      "sustainPedal",
      "portamento",
      "sostenutoPedal",
      "softPedal",
      "channelPressure",
      "pitchWheelSensitivity"
    ];
    const channel2 = this.channels[channelNumber];
    const state = channel2.state;
    for (let i = 0; i < stateTypes.length; i++) {
      const type = stateTypes[i];
      state[type] = defaultControllerState[type].defaultValue;
    }
    const settingTypes = [
      "rpnMSB",
      "rpnLSB"
    ];
    for (let i = 0; i < settingTypes.length; i++) {
      const type = settingTypes[i];
      channel2[type] = this.constructor.channelSettings[type];
    }
  }
  allNotesOff(channelNumber) {
    return this.stopChannelNotes(channelNumber, 0, false);
  }
  omniOff() {
    this.omni = false;
  }
  omniOn() {
    this.omni = true;
  }
  monoOn() {
    this.mono = true;
  }
  polyOn() {
    this.mono = false;
  }
  handleUniversalNonRealTimeExclusiveMessage(data) {
    switch (data[2]) {
      case 8:
        switch (data[3]) {
          case 8:
            return this.handleScaleOctaveTuning1ByteFormatSysEx(data, false);
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 9:
        switch (data[3]) {
          case 1:
            this.GM1SystemOn();
            break;
          case 2:
            break;
          case 3:
            this.GM2SystemOn();
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
      const channel2 = this.channels[i];
      channel2.bankMSB = 0;
      channel2.bankLSB = 0;
      channel2.bank = 0;
    }
    this.channels[9].bankMSB = 1;
    this.channels[9].bank = 128;
  }
  GM2SystemOn() {
    for (let i = 0; i < this.channels.length; i++) {
      const channel2 = this.channels[i];
      channel2.bankMSB = 121;
      channel2.bankLSB = 0;
      channel2.bank = 121 * 128;
    }
    this.channels[9].bankMSB = 120;
    this.channels[9].bank = 120 * 128;
  }
  handleUniversalRealTimeExclusiveMessage(data) {
    switch (data[2]) {
      case 4:
        switch (data[3]) {
          case 1:
            return this.handleMasterVolumeSysEx(data);
          case 3:
            return this.handleMasterFineTuningSysEx(data);
          case 4:
            return this.handleMasterCoarseTuningSysEx(data);
          case 5:
            return this.handleGlobalParameterControlSysEx(data);
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 9:
        switch (data[3]) {
          case 1:
            return this.handlePressureSysEx(data, "channelPressureTable");
          case 3:
            return this.handleControlChangeSysEx(data);
          default:
            console.warn(`Unsupported Exclusive Message: ${data}`);
        }
        break;
      case 10:
        switch (data[3]) {
          case 1:
            return this.handleKeyBasedInstrumentControlSysEx(data);
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
      this.masterVolume.gain.cancelScheduledValues(now);
      this.masterVolume.gain.setValueAtTime(volume * volume, now);
    }
  }
  handleMasterFineTuningSysEx(data) {
    const fineTuning = data[5] * 128 + data[4];
    this.setMasterFineTuning(fineTuning);
  }
  setMasterFineTuning(value) {
    const prev = this.masterFineTuning;
    const next = (value - 8192) / 8.192;
    this.masterFineTuning = next;
    channel.detune += next - prev;
    this.updateChannelDetune(channel);
  }
  handleMasterCoarseTuningSysEx(data) {
    const coarseTuning = data[4];
    this.setMasterCoarseTuning(coarseTuning);
  }
  setMasterCoarseTuning(value) {
    const prev = this.masterCoarseTuning;
    const next = (value - 64) * 100;
    this.masterCoarseTuning = next;
    channel.detune += next - prev;
    this.updateChannelDetune(channel);
  }
  handleGlobalParameterControlSysEx(data) {
    if (data[7] === 1) {
      switch (data[8]) {
        case 1:
          return this.handleReverbParameterSysEx(data);
        case 2:
          return this.handleChorusParameterSysEx(data);
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
    const { audioContext, options } = this;
    this.reverbEffect = options.reverbAlgorithm(audioContext);
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
    const { audioContext, options } = this;
    this.reverbEffect = options.reverbAlgorithm(audioContext);
  }
  getReverbTime(value) {
    return Math.pow(Math.E, (value - 40) * 0.025);
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
  handleChorusParameterSysEx(data) {
    switch (data[9]) {
      case 0:
        return this.setChorusType(data[10]);
      case 1:
        return this.setChorusModRate(data[10]);
      case 2:
        return this.setChorusModDepth(data[10]);
      case 3:
        return this.setChorusFeedback(data[10]);
      case 4:
        return this.setChorusSendToReverb(data[10]);
    }
  }
  setChorusType(type) {
    switch (type) {
      case 0:
        return this.setChorusParameter(3, 5, 0, 0);
      case 1:
        return this.setChorusParameter(9, 19, 5, 0);
      case 2:
        return this.setChorusParameter(3, 19, 8, 0);
      case 3:
        return this.setChorusParameter(9, 16, 16, 0);
      case 4:
        return this.setChorusParameter(2, 24, 64, 0);
      case 5:
        return this.setChorusParameter(1, 5, 112, 0);
      default:
        console.warn(`Unsupported Chorus Type: ${type}`);
    }
  }
  setChorusParameter(modRate, modDepth, feedback, sendToReverb) {
    this.setChorusModRate(modRate);
    this.setChorusModDepth(modDepth);
    this.setChorusFeedback(feedback);
    this.setChorusSendToReverb(sendToReverb);
  }
  setChorusModRate(value) {
    const now = this.audioContext.currentTime;
    const modRate = this.getChorusModRate(value);
    this.chorus.modRate = modRate;
    this.chorusEffect.lfo.frequency.setValueAtTime(modRate, now);
  }
  getChorusModRate(value) {
    return value * 0.122;
  }
  setChorusModDepth(value) {
    const now = this.audioContext.currentTime;
    const modDepth = this.getChorusModDepth(value);
    this.chorus.modDepth = modDepth;
    this.chorusEffect.lfoGain.gain.cancelScheduledValues(now).setValueAtTime(modDepth / 2, now);
  }
  getChorusModDepth(value) {
    return (value + 1) / 3200;
  }
  setChorusFeedback(value) {
    const now = this.audioContext.currentTime;
    const feedback = this.getChorusFeedback(value);
    this.chorus.feedback = feedback;
    const chorusEffect = this.chorusEffect;
    for (let i = 0; i < chorusEffect.feedbackGains.length; i++) {
      chorusEffect.feedbackGains[i].gain.cancelScheduledValues(now).setValueAtTime(feedback, now);
    }
  }
  getChorusFeedback(value) {
    return value * 763e-5;
  }
  setChorusSendToReverb(value) {
    const sendToReverb = this.getChorusSendToReverb(value);
    const sendGain = this.chorusEffect.sendGain;
    if (0 < this.chorus.sendToReverb) {
      this.chorus.sendToReverb = sendToReverb;
      if (0 < sendToReverb) {
        const now = this.audioContext.currentTime;
        sendGain.gain.cancelScheduledValues(now).setValueAtTime(sendToReverb, now);
      } else {
        sendGain.disconnect();
      }
    } else {
      this.chorus.sendToReverb = sendToReverb;
      if (0 < sendToReverb) {
        const now = this.audioContext.currentTime;
        sendGain.connect(this.reverbEffect.input);
        sendGain.gain.cancelScheduledValues(now).setValueAtTime(sendToReverb, now);
      }
    }
  }
  getChorusSendToReverb(value) {
    return value * 787e-5;
  }
  getChannelBitmap(data) {
    const bitmap = new Array(16).fill(false);
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
  handleScaleOctaveTuning1ByteFormatSysEx(data, realtime) {
    if (data.length < 19) {
      console.error("Data length is too short");
      return;
    }
    const channelBitmap = this.getChannelBitmap(data);
    for (let i = 0; i < channelBitmap.length; i++) {
      if (!channelBitmap[i]) continue;
      const channel2 = this.channels[i];
      for (let j = 0; j < 12; j++) {
        const centValue = data[j + 7] - 64;
        channel2.scaleOctaveTuningTable[j] = centValue;
      }
      if (realtime) this.updateChannelDetune(channel2);
    }
  }
  applyDestinationSettings(channel2, note, table) {
    if (table[0] !== 64) {
      this.updateDetune(channel2, note, 0);
    }
    if (!note.portamento) {
      if (table[1] !== 64) {
        const channelPressure = channel2.channelPressureTable[1] * channel2.state.channelPressure;
        const pressure = (channelPressure - 64) * 15;
        this.setFilterEnvelope(channel2, note, pressure);
      }
      if (table[2] !== 64) {
        const channelPressure = channel2.channelPressureTable[2] * channel2.state.channelPressure;
        const pressure = channelPressure / 64;
        this.setVolumeEnvelope(note, pressure);
      }
    }
    if (table[3] !== 0) {
      const channelPressure = channel2.channelPressureTable[3] * channel2.state.channelPressure;
      const pressure = channelPressure / 127 * 600;
      this.setModLfoToPitch(channel2, note, pressure);
    }
    if (table[4] !== 0) {
      const channelPressure = channel2.channelPressureTable[4] * channel2.state.channelPressure;
      const pressure = channelPressure / 127 * 2400;
      this.setModLfoToFilterFc(note, pressure);
    }
    if (table[5] !== 0) {
      const channelPressure = channel2.channelPressureTable[5] * channel2.state.channelPressure;
      const pressure = channelPressure / 127;
      this.setModLfoToVolume(note, pressure);
    }
  }
  handleChannelPressureSysEx(data, tableName) {
    const channelNumber = data[4];
    const table = this.channels[channelNumber][tableName];
    for (let i = 5; i < data.length - 1; i += 2) {
      const pp = data[i];
      const rr = data[i + 1];
      table[pp] = rr;
    }
  }
  initControlTable() {
    const channelCount = 128;
    const slotSize = 6;
    const defaultValues = [64, 64, 64, 0, 0, 0];
    const table = new Uint8Array(channelCount * slotSize);
    for (let ch = 0; ch < channelCount; ch++) {
      const offset = ch * slotSize;
      table.set(defaultValues, offset);
    }
    return table;
  }
  applyControlTable(channel2, controllerType) {
    const slotSize = 6;
    const offset = controllerType * slotSize;
    const table = channel2.controlTable.subarray(offset, offset + slotSize);
    channel2.scheduledNotes.forEach((noteList) => {
      for (let i = 0; i < noteList.length; i++) {
        const note = noteList[i];
        if (!note) continue;
        this.applyDestinationSettings(channel2, note, table);
      }
    });
  }
  handleControlChangeSysEx(data) {
    const channelNumber = data[4];
    const controllerType = data[5];
    const table = this.channels[channelNumber].controlTable[controllerType];
    for (let i = 6; i < data.length - 1; i += 2) {
      const pp = data[i];
      const rr = data[i + 1];
      table[pp] = rr;
    }
  }
  getKeyBasedInstrumentControlValue(channel2, keyNumber, controllerType) {
    const index = keyNumber * 128 + controllerType;
    const controlValue = channel2.keyBasedInstrumentControlTable[index];
    return (controlValue + 64) / 64;
  }
  handleKeyBasedInstrumentControlSysEx(data) {
    const channelNumber = data[4];
    const keyNumber = data[5];
    const table = this.channels[channelNumber].keyBasedInstrumentControlTable;
    for (let i = 6; i < data.length - 1; i += 2) {
      const controllerType = data[i];
      const value = data[i + 1];
      const index = keyNumber * 128 + controllerType;
      table[index] = value - 64;
    }
    this.handleChannelPressure(
      channelNumber,
      channel.state.channelPressure * 127
    );
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
  scheduleTask(callback, startTime2) {
    return new Promise((resolve) => {
      const bufferSource = new AudioBufferSourceNode(this.audioContext);
      bufferSource.onended = () => {
        callback();
        resolve();
      };
      bufferSource.start(startTime2);
      bufferSource.stop(startTime2);
    });
  }
};
export {
  MidyGM2
};
