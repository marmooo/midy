function _array_like_to_array(arr, len) {
    if (len == null || len > arr.length) len = arr.length;
    for(var i = 0, arr2 = new Array(len); i < len; i++)arr2[i] = arr[i];
    return arr2;
}
function _array_with_holes(arr) {
    if (Array.isArray(arr)) return arr;
}
function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) {
    try {
        var info = gen[key](arg);
        var value = info.value;
    } catch (error) {
        reject(error);
        return;
    }
    if (info.done) {
        resolve(value);
    } else {
        Promise.resolve(value).then(_next, _throw);
    }
}
function _async_to_generator(fn) {
    return function() {
        var self = this, args = arguments;
        return new Promise(function(resolve, reject) {
            var gen = fn.apply(self, args);
            function _next(value) {
                asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value);
            }
            function _throw(err) {
                asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err);
            }
            _next(undefined);
        });
    };
}
function _class_call_check(instance, Constructor) {
    if (!(instance instanceof Constructor)) {
        throw new TypeError("Cannot call a class as a function");
    }
}
function _defineProperties(target, props) {
    for(var i = 0; i < props.length; i++){
        var descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ("value" in descriptor) descriptor.writable = true;
        Object.defineProperty(target, descriptor.key, descriptor);
    }
}
function _create_class(Constructor, protoProps, staticProps) {
    if (protoProps) _defineProperties(Constructor.prototype, protoProps);
    if (staticProps) _defineProperties(Constructor, staticProps);
    return Constructor;
}
function _define_property(obj, key, value) {
    if (key in obj) {
        Object.defineProperty(obj, key, {
            value: value,
            enumerable: true,
            configurable: true,
            writable: true
        });
    } else {
        obj[key] = value;
    }
    return obj;
}
function _iterable_to_array_limit(arr, i) {
    var _i = arr == null ? null : typeof Symbol !== "undefined" && arr[Symbol.iterator] || arr["@@iterator"];
    if (_i == null) return;
    var _arr = [];
    var _n = true;
    var _d = false;
    var _s, _e;
    try {
        for(_i = _i.call(arr); !(_n = (_s = _i.next()).done); _n = true){
            _arr.push(_s.value);
            if (i && _arr.length === i) break;
        }
    } catch (err) {
        _d = true;
        _e = err;
    } finally{
        try {
            if (!_n && _i["return"] != null) _i["return"]();
        } finally{
            if (_d) throw _e;
        }
    }
    return _arr;
}
function _non_iterable_rest() {
    throw new TypeError("Invalid attempt to destructure non-iterable instance.\\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
}
function _object_spread(target) {
    for(var i = 1; i < arguments.length; i++){
        var source = arguments[i] != null ? arguments[i] : {};
        var ownKeys = Object.keys(source);
        if (typeof Object.getOwnPropertySymbols === "function") {
            ownKeys = ownKeys.concat(Object.getOwnPropertySymbols(source).filter(function(sym) {
                return Object.getOwnPropertyDescriptor(source, sym).enumerable;
            }));
        }
        ownKeys.forEach(function(key) {
            _define_property(target, key, source[key]);
        });
    }
    return target;
}
function ownKeys(object, enumerableOnly) {
    var keys = Object.keys(object);
    if (Object.getOwnPropertySymbols) {
        var symbols = Object.getOwnPropertySymbols(object);
        if (enumerableOnly) {
            symbols = symbols.filter(function(sym) {
                return Object.getOwnPropertyDescriptor(object, sym).enumerable;
            });
        }
        keys.push.apply(keys, symbols);
    }
    return keys;
}
function _object_spread_props(target, source) {
    source = source != null ? source : {};
    if (Object.getOwnPropertyDescriptors) {
        Object.defineProperties(target, Object.getOwnPropertyDescriptors(source));
    } else {
        ownKeys(Object(source)).forEach(function(key) {
            Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
        });
    }
    return target;
}
function _sliced_to_array(arr, i) {
    return _array_with_holes(arr) || _iterable_to_array_limit(arr, i) || _unsupported_iterable_to_array(arr, i) || _non_iterable_rest();
}
function _unsupported_iterable_to_array(o, minLen) {
    if (!o) return;
    if (typeof o === "string") return _array_like_to_array(o, minLen);
    var n = Object.prototype.toString.call(o).slice(8, -1);
    if (n === "Object" && o.constructor) n = o.constructor.name;
    if (n === "Map" || n === "Set") return Array.from(n);
    if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return _array_like_to_array(o, minLen);
}
function _ts_generator(thisArg, body) {
    var f, y, t, _ = {
        label: 0,
        sent: function() {
            if (t[0] & 1) throw t[1];
            return t[1];
        },
        trys: [],
        ops: []
    }, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() {
        return this;
    }), g;
    function verb(n) {
        return function(v) {
            return step([
                n,
                v
            ]);
        };
    }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while(g && (g = 0, op[0] && (_ = 0)), _)try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [
                op[0] & 2,
                t.value
            ];
            switch(op[0]){
                case 0:
                case 1:
                    t = op;
                    break;
                case 4:
                    _.label++;
                    return {
                        value: op[1],
                        done: false
                    };
                case 5:
                    _.label++;
                    y = op[1];
                    op = [
                        0
                    ];
                    continue;
                case 7:
                    op = _.ops.pop();
                    _.trys.pop();
                    continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
                        _ = 0;
                        continue;
                    }
                    if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
                        _.label = op[1];
                        break;
                    }
                    if (op[0] === 6 && _.label < t[1]) {
                        _.label = t[1];
                        t = op;
                        break;
                    }
                    if (t && _.label < t[2]) {
                        _.label = t[2];
                        _.ops.push(op);
                        break;
                    }
                    if (t[2]) _.ops.pop();
                    _.trys.pop();
                    continue;
            }
            op = body.call(thisArg, _);
        } catch (e) {
            op = [
                6,
                e
            ];
            y = 0;
        } finally{
            f = t = 0;
        }
        if (op[0] & 5) throw op[1];
        return {
            value: op[0] ? op[1] : void 0,
            done: true
        };
    }
}
import { parseMidi } from "midi-file";
import { parse, SoundFont } from "@marmooo/soundfont-parser";
var Note = function Note(noteNumber, velocity, startTime, instrumentKey) {
    "use strict";
    _class_call_check(this, Note);
    _define_property(this, "bufferSource", void 0);
    _define_property(this, "filterNode", void 0);
    _define_property(this, "volumeNode", void 0);
    _define_property(this, "volumeDepth", void 0);
    _define_property(this, "modulationLFO", void 0);
    _define_property(this, "modulationDepth", void 0);
    this.noteNumber = noteNumber;
    this.velocity = velocity;
    this.startTime = startTime;
    this.instrumentKey = instrumentKey;
};
export var MidyGMLite = /*#__PURE__*/ function() {
    "use strict";
    function MidyGMLite(audioContext) {
        _class_call_check(this, MidyGMLite);
        _define_property(this, "ticksPerBeat", 120);
        _define_property(this, "totalTime", 0);
        _define_property(this, "noteCheckInterval", 0.1);
        _define_property(this, "lookAhead", 1);
        _define_property(this, "startDelay", 0.1);
        _define_property(this, "startTime", 0);
        _define_property(this, "resumeTime", 0);
        _define_property(this, "soundFonts", []);
        _define_property(this, "soundFontTable", this.initSoundFontTable());
        _define_property(this, "isPlaying", false);
        _define_property(this, "isPausing", false);
        _define_property(this, "isPaused", false);
        _define_property(this, "isStopping", false);
        _define_property(this, "isSeeking", false);
        _define_property(this, "timeline", []);
        _define_property(this, "instruments", []);
        _define_property(this, "notePromises", []);
        _define_property(this, "exclusiveClassMap", new Map());
        this.audioContext = audioContext;
        this.masterGain = new GainNode(audioContext);
        this.controlChangeHandlers = this.createControlChangeHandlers();
        this.channels = this.createChannels(audioContext);
        this.masterGain.connect(audioContext.destination);
        this.GM1SystemOn();
    }
    _create_class(MidyGMLite, [
        {
            key: "initSoundFontTable",
            value: function initSoundFontTable() {
                var table = new Array(128);
                for(var i = 0; i < 128; i++){
                    table[i] = new Map();
                }
                return table;
            }
        },
        {
            key: "addSoundFont",
            value: function addSoundFont(soundFont) {
                var index = this.soundFonts.length;
                this.soundFonts.push(soundFont);
                var presetHeaders = soundFont.parsed.presetHeaders;
                for(var i = 0; i < presetHeaders.length; i++){
                    var presetHeader = presetHeaders[i];
                    if (!presetHeader.presetName.startsWith("\u0000")) {
                        var banks = this.soundFontTable[presetHeader.preset];
                        banks.set(presetHeader.bank, index);
                    }
                }
            }
        },
        {
            key: "loadSoundFont",
            value: function loadSoundFont(soundFontUrl) {
                return _async_to_generator(function() {
                    var response, arrayBuffer, parsed, soundFont;
                    return _ts_generator(this, function(_state) {
                        switch(_state.label){
                            case 0:
                                return [
                                    4,
                                    fetch(soundFontUrl)
                                ];
                            case 1:
                                response = _state.sent();
                                return [
                                    4,
                                    response.arrayBuffer()
                                ];
                            case 2:
                                arrayBuffer = _state.sent();
                                parsed = parse(new Uint8Array(arrayBuffer));
                                soundFont = new SoundFont(parsed);
                                this.addSoundFont(soundFont);
                                return [
                                    2
                                ];
                        }
                    });
                }).call(this);
            }
        },
        {
            key: "loadMIDI",
            value: function loadMIDI(midiUrl) {
                return _async_to_generator(function() {
                    var response, arrayBuffer, midi, midiData;
                    return _ts_generator(this, function(_state) {
                        switch(_state.label){
                            case 0:
                                return [
                                    4,
                                    fetch(midiUrl)
                                ];
                            case 1:
                                response = _state.sent();
                                return [
                                    4,
                                    response.arrayBuffer()
                                ];
                            case 2:
                                arrayBuffer = _state.sent();
                                midi = parseMidi(new Uint8Array(arrayBuffer));
                                this.ticksPerBeat = midi.header.ticksPerBeat;
                                midiData = this.extractMidiData(midi);
                                this.instruments = midiData.instruments;
                                this.timeline = midiData.timeline;
                                this.totalTime = this.calcTotalTime();
                                return [
                                    2
                                ];
                        }
                    });
                }).call(this);
            }
        },
        {
            key: "setChannelAudioNodes",
            value: function setChannelAudioNodes(audioContext) {
                var _this_panToGain = this.panToGain(this.constructor.channelSettings.pan), gainLeft = _this_panToGain.gainLeft, gainRight = _this_panToGain.gainRight;
                var gainL = new GainNode(audioContext, {
                    gain: gainLeft
                });
                var gainR = new GainNode(audioContext, {
                    gain: gainRight
                });
                var merger = new ChannelMergerNode(audioContext, {
                    numberOfInputs: 2
                });
                gainL.connect(merger, 0, 0);
                gainR.connect(merger, 0, 1);
                merger.connect(this.masterGain);
                return {
                    gainL: gainL,
                    gainR: gainR,
                    merger: merger
                };
            }
        },
        {
            key: "createChannels",
            value: function createChannels(audioContext) {
                var _this = this;
                var channels = Array.from({
                    length: 16
                }, function() {
                    return _object_spread_props(_object_spread({}, _this.constructor.channelSettings, _this.constructor.effectSettings, _this.setChannelAudioNodes(audioContext)), {
                        scheduledNotes: new Map()
                    });
                });
                return channels;
            }
        },
        {
            key: "createNoteBuffer",
            value: function createNoteBuffer(instrumentKey, isSF3) {
                return _async_to_generator(function() {
                    var sampleStart, sampleEnd, sample, start, end, buffer, audioBuffer, sample1, start1, end1, buffer1, audioBuffer1, channelData, int16Array, i;
                    return _ts_generator(this, function(_state) {
                        switch(_state.label){
                            case 0:
                                sampleStart = instrumentKey.start;
                                sampleEnd = instrumentKey.sample.length + instrumentKey.end;
                                if (!isSF3) return [
                                    3,
                                    2
                                ];
                                sample = instrumentKey.sample;
                                start = sample.byteOffset + sampleStart;
                                end = sample.byteOffset + sampleEnd;
                                buffer = sample.buffer.slice(start, end);
                                return [
                                    4,
                                    this.audioContext.decodeAudioData(buffer)
                                ];
                            case 1:
                                audioBuffer = _state.sent();
                                return [
                                    2,
                                    audioBuffer
                                ];
                            case 2:
                                sample1 = instrumentKey.sample;
                                start1 = sample1.byteOffset + sampleStart;
                                end1 = sample1.byteOffset + sampleEnd;
                                buffer1 = sample1.buffer.slice(start1, end1);
                                audioBuffer1 = new AudioBuffer({
                                    numberOfChannels: 1,
                                    length: sample1.length,
                                    sampleRate: instrumentKey.sampleRate
                                });
                                channelData = audioBuffer1.getChannelData(0);
                                int16Array = new Int16Array(buffer1);
                                for(i = 0; i < int16Array.length; i++){
                                    channelData[i] = int16Array[i] / 32768;
                                }
                                return [
                                    2,
                                    audioBuffer1
                                ];
                            case 3:
                                return [
                                    2
                                ];
                        }
                    });
                }).call(this);
            }
        },
        {
            key: "createNoteBufferNode",
            value: function createNoteBufferNode(instrumentKey, isSF3) {
                return _async_to_generator(function() {
                    var bufferSource, audioBuffer;
                    return _ts_generator(this, function(_state) {
                        switch(_state.label){
                            case 0:
                                bufferSource = new AudioBufferSourceNode(this.audioContext);
                                return [
                                    4,
                                    this.createNoteBuffer(instrumentKey, isSF3)
                                ];
                            case 1:
                                audioBuffer = _state.sent();
                                bufferSource.buffer = audioBuffer;
                                bufferSource.loop = instrumentKey.sampleModes % 2 !== 0;
                                if (bufferSource.loop) {
                                    bufferSource.loopStart = instrumentKey.loopStart / instrumentKey.sampleRate;
                                    bufferSource.loopEnd = instrumentKey.loopEnd / instrumentKey.sampleRate;
                                }
                                return [
                                    2,
                                    bufferSource
                                ];
                        }
                    });
                }).call(this);
            }
        },
        {
            key: "scheduleTimelineEvents",
            value: function scheduleTimelineEvents(t, offset, queueIndex) {
                return _async_to_generator(function() {
                    var event, _, notePromise;
                    return _ts_generator(this, function(_state) {
                        switch(_state.label){
                            case 0:
                                if (!(queueIndex < this.timeline.length)) return [
                                    3,
                                    9
                                ];
                                event = this.timeline[queueIndex];
                                if (event.startTime > t + this.lookAhead) return [
                                    3,
                                    9
                                ];
                                _ = event.type;
                                switch(_){
                                    case "noteOn":
                                        return [
                                            3,
                                            1
                                        ];
                                    case "noteOff":
                                        return [
                                            3,
                                            3
                                        ];
                                    case "controller":
                                        return [
                                            3,
                                            4
                                        ];
                                    case "programChange":
                                        return [
                                            3,
                                            5
                                        ];
                                    case "pitchBend":
                                        return [
                                            3,
                                            6
                                        ];
                                    case "sysEx":
                                        return [
                                            3,
                                            7
                                        ];
                                }
                                return [
                                    3,
                                    8
                                ];
                            case 1:
                                if (!(event.velocity !== 0)) return [
                                    3,
                                    3
                                ];
                                return [
                                    4,
                                    this.scheduleNoteOn(event.channel, event.noteNumber, event.velocity, event.startTime + this.startDelay - offset)
                                ];
                            case 2:
                                _state.sent();
                                return [
                                    3,
                                    8
                                ];
                            case 3:
                                {
                                    notePromise = this.scheduleNoteRelease(event.channel, event.noteNumber, event.velocity, event.startTime + this.startDelay - offset);
                                    if (notePromise) {
                                        this.notePromises.push(notePromise);
                                    }
                                    return [
                                        3,
                                        8
                                    ];
                                }
                                _state.label = 4;
                            case 4:
                                this.handleControlChange(event.channel, event.controllerType, event.value);
                                return [
                                    3,
                                    8
                                ];
                            case 5:
                                this.handleProgramChange(event.channel, event.programNumber);
                                return [
                                    3,
                                    8
                                ];
                            case 6:
                                this.setPitchBend(event.channel, event.value);
                                return [
                                    3,
                                    8
                                ];
                            case 7:
                                this.handleSysEx(event.data);
                                _state.label = 8;
                            case 8:
                                queueIndex++;
                                return [
                                    3,
                                    0
                                ];
                            case 9:
                                return [
                                    2,
                                    queueIndex
                                ];
                        }
                    });
                }).call(this);
            }
        },
        {
            key: "getQueueIndex",
            value: function getQueueIndex(second) {
                for(var i = 0; i < this.timeline.length; i++){
                    if (second <= this.timeline[i].startTime) {
                        return i;
                    }
                }
                return 0;
            }
        },
        {
            key: "playNotes",
            value: function playNotes() {
                var _this = this;
                return new Promise(function(resolve) {
                    _this.isPlaying = true;
                    _this.isPaused = false;
                    _this.startTime = _this.audioContext.currentTime;
                    var queueIndex = _this.getQueueIndex(_this.resumeTime);
                    var offset = _this.resumeTime - _this.startTime;
                    _this.notePromises = [];
                    var schedulePlayback = function() {
                        return _async_to_generator(function() {
                            var t, now, waitTime;
                            return _ts_generator(this, function(_state) {
                                switch(_state.label){
                                    case 0:
                                        if (!(queueIndex >= this.timeline.length)) return [
                                            3,
                                            2
                                        ];
                                        return [
                                            4,
                                            Promise.all(this.notePromises)
                                        ];
                                    case 1:
                                        _state.sent();
                                        this.notePromises = [];
                                        this.exclusiveClassMap.clear();
                                        resolve();
                                        return [
                                            2
                                        ];
                                    case 2:
                                        t = this.audioContext.currentTime + offset;
                                        return [
                                            4,
                                            this.scheduleTimelineEvents(t, offset, queueIndex)
                                        ];
                                    case 3:
                                        queueIndex = _state.sent();
                                        if (!this.isPausing) return [
                                            3,
                                            5
                                        ];
                                        return [
                                            4,
                                            this.stopNotes(0, true)
                                        ];
                                    case 4:
                                        _state.sent();
                                        this.notePromises = [];
                                        resolve();
                                        this.isPausing = false;
                                        this.isPaused = true;
                                        return [
                                            2
                                        ];
                                    case 5:
                                        if (!this.isStopping) return [
                                            3,
                                            7
                                        ];
                                        return [
                                            4,
                                            this.stopNotes(0, true)
                                        ];
                                    case 6:
                                        _state.sent();
                                        this.exclusiveClassMap.clear();
                                        this.notePromises = [];
                                        resolve();
                                        this.isStopping = false;
                                        this.isPaused = false;
                                        return [
                                            2
                                        ];
                                    case 7:
                                        if (!this.isSeeking) return [
                                            3,
                                            9
                                        ];
                                        this.stopNotes(0, true);
                                        this.exclusiveClassMap.clear();
                                        this.startTime = this.audioContext.currentTime;
                                        queueIndex = this.getQueueIndex(this.resumeTime);
                                        offset = this.resumeTime - this.startTime;
                                        this.isSeeking = false;
                                        return [
                                            4,
                                            schedulePlayback()
                                        ];
                                    case 8:
                                        _state.sent();
                                        return [
                                            3,
                                            12
                                        ];
                                    case 9:
                                        now = this.audioContext.currentTime;
                                        waitTime = now + this.noteCheckInterval;
                                        return [
                                            4,
                                            this.scheduleTask(function() {}, waitTime)
                                        ];
                                    case 10:
                                        _state.sent();
                                        return [
                                            4,
                                            schedulePlayback()
                                        ];
                                    case 11:
                                        _state.sent();
                                        _state.label = 12;
                                    case 12:
                                        return [
                                            2
                                        ];
                                }
                            });
                        }).call(_this);
                    };
                    schedulePlayback();
                });
            }
        },
        {
            key: "ticksToSecond",
            value: function ticksToSecond(ticks, secondsPerBeat) {
                return ticks * secondsPerBeat / this.ticksPerBeat;
            }
        },
        {
            key: "secondToTicks",
            value: function secondToTicks(second, secondsPerBeat) {
                return second * this.ticksPerBeat / secondsPerBeat;
            }
        },
        {
            key: "extractMidiData",
            value: function extractMidiData(midi) {
                var instruments = new Set();
                var timeline = [];
                var tmpChannels = new Array(16);
                for(var i = 0; i < tmpChannels.length; i++){
                    tmpChannels[i] = {
                        programNumber: -1,
                        bank: this.channels[i].bank
                    };
                }
                for(var i1 = 0; i1 < midi.tracks.length; i1++){
                    var track = midi.tracks[i1];
                    var currentTicks = 0;
                    for(var j = 0; j < track.length; j++){
                        var event = track[j];
                        currentTicks += event.deltaTime;
                        event.ticks = currentTicks;
                        switch(event.type){
                            case "noteOn":
                                {
                                    var channel = tmpChannels[event.channel];
                                    if (channel.programNumber < 0) {
                                        instruments.add("".concat(channel.bank, ":0"));
                                        channel.programNumber = 0;
                                    }
                                    break;
                                }
                            case "programChange":
                                {
                                    var channel1 = tmpChannels[event.channel];
                                    channel1.programNumber = event.programNumber;
                                    instruments.add("".concat(channel1.bankNumber, ":").concat(channel1.programNumber));
                                }
                        }
                        delete event.deltaTime;
                        timeline.push(event);
                    }
                }
                var priority = {
                    controller: 0,
                    sysEx: 1
                };
                timeline.sort(function(a, b) {
                    if (a.ticks !== b.ticks) return a.ticks - b.ticks;
                    return (priority[a.type] || 2) - (priority[b.type] || 2);
                });
                var prevTempoTime = 0;
                var prevTempoTicks = 0;
                var secondsPerBeat = 0.5;
                for(var i2 = 0; i2 < timeline.length; i2++){
                    var event1 = timeline[i2];
                    var timeFromPrevTempo = this.ticksToSecond(event1.ticks - prevTempoTicks, secondsPerBeat);
                    event1.startTime = prevTempoTime + timeFromPrevTempo;
                    if (event1.type === "setTempo") {
                        prevTempoTime += this.ticksToSecond(event1.ticks - prevTempoTicks, secondsPerBeat);
                        secondsPerBeat = event1.microsecondsPerBeat / 1000000;
                        prevTempoTicks = event1.ticks;
                    }
                }
                return {
                    instruments: instruments,
                    timeline: timeline
                };
            }
        },
        {
            key: "stopChannelNotes",
            value: function stopChannelNotes(channelNumber, velocity, force) {
                return _async_to_generator(function() {
                    var _this, now, channel;
                    return _ts_generator(this, function(_state) {
                        switch(_state.label){
                            case 0:
                                _this = this;
                                now = this.audioContext.currentTime;
                                channel = this.channels[channelNumber];
                                channel.scheduledNotes.forEach(function(noteList) {
                                    for(var i = 0; i < noteList.length; i++){
                                        var note = noteList[i];
                                        if (!note) continue;
                                        var promise = _this.scheduleNoteRelease(channelNumber, note.noteNumber, velocity, now, force);
                                        _this.notePromises.push(promise);
                                    }
                                });
                                channel.scheduledNotes.clear();
                                return [
                                    4,
                                    Promise.all(this.notePromises)
                                ];
                            case 1:
                                _state.sent();
                                return [
                                    2
                                ];
                        }
                    });
                }).call(this);
            }
        },
        {
            key: "stopNotes",
            value: function stopNotes(velocity, force) {
                for(var i = 0; i < this.channels.length; i++){
                    this.stopChannelNotes(i, velocity, force);
                }
                return Promise.all(this.notePromises);
            }
        },
        {
            key: "start",
            value: function start() {
                return _async_to_generator(function() {
                    return _ts_generator(this, function(_state) {
                        switch(_state.label){
                            case 0:
                                if (this.isPlaying || this.isPaused) return [
                                    2
                                ];
                                this.resumeTime = 0;
                                return [
                                    4,
                                    this.playNotes()
                                ];
                            case 1:
                                _state.sent();
                                this.isPlaying = false;
                                return [
                                    2
                                ];
                        }
                    });
                }).call(this);
            }
        },
        {
            key: "stop",
            value: function stop() {
                if (!this.isPlaying) return;
                this.isStopping = true;
            }
        },
        {
            key: "pause",
            value: function pause() {
                if (!this.isPlaying || this.isPaused) return;
                var now = this.audioContext.currentTime;
                this.resumeTime += now - this.startTime - this.startDelay;
                this.isPausing = true;
            }
        },
        {
            key: "resume",
            value: function resume() {
                return _async_to_generator(function() {
                    return _ts_generator(this, function(_state) {
                        switch(_state.label){
                            case 0:
                                if (!this.isPaused) return [
                                    2
                                ];
                                return [
                                    4,
                                    this.playNotes()
                                ];
                            case 1:
                                _state.sent();
                                this.isPlaying = false;
                                return [
                                    2
                                ];
                        }
                    });
                }).call(this);
            }
        },
        {
            key: "seekTo",
            value: function seekTo(second) {
                this.resumeTime = second;
                if (this.isPlaying) {
                    this.isSeeking = true;
                }
            }
        },
        {
            key: "calcTotalTime",
            value: function calcTotalTime() {
                var totalTime = 0;
                for(var i = 0; i < this.timeline.length; i++){
                    var event = this.timeline[i];
                    if (totalTime < event.startTime) totalTime = event.startTime;
                }
                return totalTime;
            }
        },
        {
            key: "currentTime",
            value: function currentTime() {
                var now = this.audioContext.currentTime;
                return this.resumeTime + now - this.startTime - this.startDelay;
            }
        },
        {
            key: "getActiveNotes",
            value: function getActiveNotes(channel, time) {
                var _this = this;
                var activeNotes = new Map();
                channel.scheduledNotes.forEach(function(noteList) {
                    var activeNote = _this.getActiveNote(noteList, time);
                    if (activeNote) {
                        activeNotes.set(activeNote.noteNumber, activeNote);
                    }
                });
                return activeNotes;
            }
        },
        {
            key: "getActiveNote",
            value: function getActiveNote(noteList, time) {
                for(var i = noteList.length - 1; i >= 0; i--){
                    var note = noteList[i];
                    if (!note) return;
                    if (time < note.startTime) continue;
                    return note.ending ? null : note;
                }
                return noteList[0];
            }
        },
        {
            key: "cbToRatio",
            value: function cbToRatio(cb) {
                return Math.pow(10, cb / 200);
            }
        },
        {
            key: "centToHz",
            value: function centToHz(cent) {
                return 8.176 * Math.pow(2, cent / 1200);
            }
        },
        {
            key: "calcSemitoneOffset",
            value: function calcSemitoneOffset(channel) {
                return channel.pitchBend * channel.pitchBendRange;
            }
        },
        {
            key: "calcPlaybackRate",
            value: function calcPlaybackRate(instrumentKey, noteNumber, semitoneOffset) {
                return instrumentKey.playbackRate(noteNumber) * Math.pow(2, semitoneOffset / 12);
            }
        },
        {
            key: "setVolumeEnvelope",
            value: function setVolumeEnvelope(note) {
                var instrumentKey = note.instrumentKey, startTime = note.startTime;
                var attackVolume = this.cbToRatio(-instrumentKey.initialAttenuation);
                var sustainVolume = attackVolume * (1 - instrumentKey.volSustain);
                var volDelay = startTime + instrumentKey.volDelay;
                var volAttack = volDelay + instrumentKey.volAttack;
                var volHold = volAttack + instrumentKey.volHold;
                var volDecay = volHold + instrumentKey.volDecay;
                note.volumeNode.gain.cancelScheduledValues(startTime).setValueAtTime(0, startTime).setValueAtTime(1e-6, volDelay) // exponentialRampToValueAtTime() requires a non-zero value
                .exponentialRampToValueAtTime(attackVolume, volAttack).setValueAtTime(attackVolume, volHold).linearRampToValueAtTime(sustainVolume, volDecay);
            }
        },
        {
            key: "setPitch",
            value: function setPitch(note, semitoneOffset) {
                var instrumentKey = note.instrumentKey, noteNumber = note.noteNumber, startTime = note.startTime;
                var modEnvToPitch = instrumentKey.modEnvToPitch / 100;
                note.bufferSource.playbackRate.value = this.calcPlaybackRate(instrumentKey, noteNumber, semitoneOffset);
                if (modEnvToPitch === 0) return;
                var basePitch = note.bufferSource.playbackRate.value;
                var peekPitch = this.calcPlaybackRate(instrumentKey, noteNumber, semitoneOffset + modEnvToPitch);
                var modDelay = startTime + instrumentKey.modDelay;
                var modAttack = modDelay + instrumentKey.modAttack;
                var modHold = modAttack + instrumentKey.modHold;
                var modDecay = modHold + instrumentKey.modDecay;
                note.bufferSource.playbackRate.value.setValueAtTime(basePitch, modDelay).exponentialRampToValueAtTime(peekPitch, modAttack).setValueAtTime(peekPitch, modHold).linearRampToValueAtTime(basePitch, modDecay);
            }
        },
        {
            key: "clampCutoffFrequency",
            value: function clampCutoffFrequency(frequency) {
                var minFrequency = 20; // min Hz of initialFilterFc
                var maxFrequency = 20000; // max Hz of initialFilterFc
                return Math.max(minFrequency, Math.min(frequency, maxFrequency));
            }
        },
        {
            key: "setFilterEnvelope",
            value: function setFilterEnvelope(note) {
                var instrumentKey = note.instrumentKey, startTime = note.startTime;
                var baseFreq = this.centToHz(instrumentKey.initialFilterFc);
                var peekFreq = this.centToHz(instrumentKey.initialFilterFc + instrumentKey.modEnvToFilterFc);
                var sustainFreq = baseFreq + (peekFreq - baseFreq) * (1 - instrumentKey.modSustain);
                var adjustedBaseFreq = this.clampCutoffFrequency(baseFreq);
                var adjustedPeekFreq = this.clampCutoffFrequency(peekFreq);
                var adjustedSustainFreq = this.clampCutoffFrequency(sustainFreq);
                var modDelay = startTime + instrumentKey.modDelay;
                var modAttack = modDelay + instrumentKey.modAttack;
                var modHold = modAttack + instrumentKey.modHold;
                var modDecay = modHold + instrumentKey.modDecay;
                note.filterNode.frequency.cancelScheduledValues(startTime).setValueAtTime(adjustedBaseFreq, startTime).setValueAtTime(adjustedBaseFreq, modDelay).exponentialRampToValueAtTime(adjustedPeekFreq, modAttack).setValueAtTime(adjustedPeekFreq, modHold).linearRampToValueAtTime(adjustedSustainFreq, modDecay);
            }
        },
        {
            key: "startModulation",
            value: function startModulation(channel, note, startTime) {
                var instrumentKey = note.instrumentKey;
                var modLfoToPitch = instrumentKey.modLfoToPitch, modLfoToVolume = instrumentKey.modLfoToVolume;
                note.modulationLFO = new OscillatorNode(this.audioContext, {
                    frequency: this.centToHz(instrumentKey.freqModLFO)
                });
                note.filterDepth = new GainNode(this.audioContext, {
                    gain: instrumentKey.modLfoToFilterFc
                });
                var modulationDepth = Math.abs(modLfoToPitch) + channel.modulationDepth;
                var modulationDepthSign = 0 < modLfoToPitch ? 1 : -1;
                note.modulationDepth = new GainNode(this.audioContext, {
                    gain: modulationDepth * modulationDepthSign
                });
                var volumeDepth = this.cbToRatio(Math.abs(modLfoToVolume)) - 1;
                var volumeDepthSign = 0 < modLfoToVolume ? 1 : -1;
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
        },
        {
            key: "createNote",
            value: function createNote(channel, instrumentKey, noteNumber, velocity, startTime, isSF3) {
                return _async_to_generator(function() {
                    var semitoneOffset, note;
                    return _ts_generator(this, function(_state) {
                        switch(_state.label){
                            case 0:
                                semitoneOffset = this.calcSemitoneOffset(channel);
                                note = new Note(noteNumber, velocity, startTime, instrumentKey);
                                return [
                                    4,
                                    this.createNoteBufferNode(instrumentKey, isSF3)
                                ];
                            case 1:
                                note.bufferSource = _state.sent();
                                note.volumeNode = new GainNode(this.audioContext);
                                note.filterNode = new BiquadFilterNode(this.audioContext, {
                                    type: "lowpass",
                                    Q: instrumentKey.initialFilterQ / 10
                                });
                                this.setVolumeEnvelope(note);
                                this.setFilterEnvelope(note);
                                if (0 < channel.modulationDepth) {
                                    this.setPitch(note, semitoneOffset);
                                    this.startModulation(channel, note, startTime);
                                } else {
                                    note.bufferSource.playbackRate.value = this.calcPlaybackRate(instrumentKey, noteNumber, semitoneOffset);
                                }
                                note.bufferSource.connect(note.filterNode);
                                note.filterNode.connect(note.volumeNode);
                                note.bufferSource.start(startTime);
                                return [
                                    2,
                                    note
                                ];
                        }
                    });
                }).call(this);
            }
        },
        {
            key: "scheduleNoteOn",
            value: function scheduleNoteOn(channelNumber, noteNumber, velocity, startTime) {
                return _async_to_generator(function() {
                    var channel, bankNumber, soundFontIndex, soundFont, isSF3, instrumentKey, note, exclusiveClass, prevEntry, _prevEntry, prevNote, prevChannelNumber, scheduledNotes;
                    return _ts_generator(this, function(_state) {
                        switch(_state.label){
                            case 0:
                                channel = this.channels[channelNumber];
                                bankNumber = channel.bank;
                                soundFontIndex = this.soundFontTable[channel.program].get(bankNumber);
                                if (soundFontIndex === undefined) return [
                                    2
                                ];
                                soundFont = this.soundFonts[soundFontIndex];
                                isSF3 = soundFont.parsed.info.version.major === 3;
                                instrumentKey = soundFont.getInstrumentKey(bankNumber, channel.program, noteNumber, velocity);
                                if (!instrumentKey) return [
                                    2
                                ];
                                return [
                                    4,
                                    this.createNote(channel, instrumentKey, noteNumber, velocity, startTime, isSF3)
                                ];
                            case 1:
                                note = _state.sent();
                                note.volumeNode.connect(channel.gainL);
                                note.volumeNode.connect(channel.gainR);
                                exclusiveClass = instrumentKey.exclusiveClass;
                                if (exclusiveClass !== 0) {
                                    if (this.exclusiveClassMap.has(exclusiveClass)) {
                                        prevEntry = this.exclusiveClassMap.get(exclusiveClass);
                                        _prevEntry = _sliced_to_array(prevEntry, 2), prevNote = _prevEntry[0], prevChannelNumber = _prevEntry[1];
                                        if (!prevNote.ending) {
                                            this.scheduleNoteRelease(prevChannelNumber, prevNote.noteNumber, 0, startTime, undefined, true);
                                        }
                                    }
                                    this.exclusiveClassMap.set(exclusiveClass, [
                                        note,
                                        channelNumber
                                    ]);
                                }
                                scheduledNotes = channel.scheduledNotes;
                                if (scheduledNotes.has(noteNumber)) {
                                    scheduledNotes.get(noteNumber).push(note);
                                } else {
                                    scheduledNotes.set(noteNumber, [
                                        note
                                    ]);
                                }
                                return [
                                    2
                                ];
                        }
                    });
                }).call(this);
            }
        },
        {
            key: "noteOn",
            value: function noteOn(channelNumber, noteNumber, velocity) {
                var now = this.audioContext.currentTime;
                return this.scheduleNoteOn(channelNumber, noteNumber, velocity, now);
            }
        },
        {
            key: "stopNote",
            value: function stopNote(endTime, stopTime, scheduledNotes, index) {
                var note = scheduledNotes[index];
                note.volumeNode.gain.cancelScheduledValues(endTime).linearRampToValueAtTime(0, stopTime);
                note.ending = true;
                this.scheduleTask(function() {
                    note.bufferSource.loop = false;
                }, stopTime);
                return new Promise(function(resolve) {
                    note.bufferSource.onended = function() {
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
        },
        {
            key: "scheduleNoteRelease",
            value: function scheduleNoteRelease(channelNumber, noteNumber, _velocity, endTime, force) {
                var channel = this.channels[channelNumber];
                if (!force && channel.sustainPedal) return;
                if (!channel.scheduledNotes.has(noteNumber)) return;
                var scheduledNotes = channel.scheduledNotes.get(noteNumber);
                for(var i = 0; i < scheduledNotes.length; i++){
                    var note = scheduledNotes[i];
                    if (!note) continue;
                    if (note.ending) continue;
                    var volRelease = endTime + note.instrumentKey.volRelease;
                    var modRelease = endTime + note.instrumentKey.modRelease;
                    note.filterNode.frequency.cancelScheduledValues(endTime).linearRampToValueAtTime(0, modRelease);
                    var stopTime = Math.min(volRelease, modRelease);
                    return this.stopNote(endTime, stopTime, scheduledNotes, i);
                }
            }
        },
        {
            key: "releaseNote",
            value: function releaseNote(channelNumber, noteNumber, velocity) {
                var now = this.audioContext.currentTime;
                return this.scheduleNoteRelease(channelNumber, noteNumber, velocity, now);
            }
        },
        {
            key: "releaseSustainPedal",
            value: function releaseSustainPedal(channelNumber, halfVelocity) {
                var _this = this;
                var velocity = halfVelocity * 2;
                var channel = this.channels[channelNumber];
                var promises = [];
                channel.sustainPedal = false;
                channel.scheduledNotes.forEach(function(noteList) {
                    for(var i = 0; i < noteList.length; i++){
                        var note = noteList[i];
                        if (!note) continue;
                        var noteNumber = note.noteNumber;
                        var promise = _this.releaseNote(channelNumber, noteNumber, velocity);
                        promises.push(promise);
                    }
                });
                return promises;
            }
        },
        {
            key: "handleMIDIMessage",
            value: function handleMIDIMessage(statusByte, data1, data2) {
                var channelNumber = statusByte & 0x0F;
                var messageType = statusByte & 0xF0;
                switch(messageType){
                    case 0x80:
                        return this.releaseNote(channelNumber, data1, data2);
                    case 0x90:
                        return this.noteOn(channelNumber, data1, data2);
                    case 0xB0:
                        return this.handleControlChange(channelNumber, data1, data2);
                    case 0xC0:
                        return this.handleProgramChange(channelNumber, data1);
                    case 0xE0:
                        return this.handlePitchBendMessage(channelNumber, data1, data2);
                    default:
                        console.warn("Unsupported MIDI message: ".concat(messageType.toString(16)));
                }
            }
        },
        {
            key: "handleProgramChange",
            value: function handleProgramChange(channelNumber, program) {
                var channel = this.channels[channelNumber];
                channel.program = program;
            }
        },
        {
            key: "handlePitchBendMessage",
            value: function handlePitchBendMessage(channelNumber, lsb, msb) {
                var pitchBend = msb * 128 + lsb - 8192;
                this.setPitchBend(channelNumber, pitchBend);
            }
        },
        {
            key: "setPitchBend",
            value: function setPitchBend(channelNumber, pitchBend) {
                var channel = this.channels[channelNumber];
                var prevPitchBend = channel.pitchBend;
                channel.pitchBend = pitchBend / 8192;
                var detuneChange = (channel.pitchBend - prevPitchBend) * channel.pitchBendRange * 100;
                this.updateDetune(channel, detuneChange);
            }
        },
        {
            key: "createControlChangeHandlers",
            value: function createControlChangeHandlers() {
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
        },
        {
            key: "handleControlChange",
            value: function handleControlChange(channelNumber, controller, value) {
                var handler = this.controlChangeHandlers[controller];
                if (handler) {
                    handler.call(this, channelNumber, value);
                } else {
                    console.warn("Unsupported Control change: controller=".concat(controller, " value=").concat(value));
                }
            }
        },
        {
            key: "updateModulation",
            value: function updateModulation(channel) {
                var _this = this;
                var now = this.audioContext.currentTime;
                channel.scheduledNotes.forEach(function(noteList) {
                    for(var i = 0; i < noteList.length; i++){
                        var note = noteList[i];
                        if (!note) continue;
                        if (note.modulationDepth) {
                            note.modulationDepth.gain.setValueAtTime(channel.modulationDepth, now);
                        } else {
                            var semitoneOffset = _this.calcSemitoneOffset(channel);
                            _this.setPitch(note, semitoneOffset);
                            _this.startModulation(channel, note, now);
                        }
                    }
                });
            }
        },
        {
            key: "setModulationDepth",
            value: function setModulationDepth(channelNumber, modulation) {
                var channel = this.channels[channelNumber];
                channel.modulationDepth = modulation / 127 * channel.modulationDepthRange;
                this.updateModulation(channel);
            }
        },
        {
            key: "setVolume",
            value: function setVolume(channelNumber, volume) {
                var channel = this.channels[channelNumber];
                channel.volume = volume / 127;
                this.updateChannelVolume(channel);
            }
        },
        {
            key: "panToGain",
            value: function panToGain(pan) {
                var theta = Math.PI / 2 * Math.max(0, pan - 1) / 126;
                return {
                    gainLeft: Math.cos(theta),
                    gainRight: Math.sin(theta)
                };
            }
        },
        {
            key: "setPan",
            value: function setPan(channelNumber, pan) {
                var channel = this.channels[channelNumber];
                channel.pan = pan;
                this.updateChannelVolume(channel);
            }
        },
        {
            key: "setExpression",
            value: function setExpression(channelNumber, expression) {
                var channel = this.channels[channelNumber];
                channel.expression = expression / 127;
                this.updateChannelVolume(channel);
            }
        },
        {
            key: "dataEntryLSB",
            value: function dataEntryLSB(channelNumber, value) {
                this.channels[channelNumber].dataLSB = value;
                this.handleRPN(channelNumber);
            }
        },
        {
            key: "updateChannelVolume",
            value: function updateChannelVolume(channel) {
                var now = this.audioContext.currentTime;
                var volume = channel.volume * channel.expression;
                var _this_panToGain = this.panToGain(channel.pan), gainLeft = _this_panToGain.gainLeft, gainRight = _this_panToGain.gainRight;
                channel.gainL.gain.cancelScheduledValues(now).setValueAtTime(volume * gainLeft, now);
                channel.gainR.gain.cancelScheduledValues(now).setValueAtTime(volume * gainRight, now);
            }
        },
        {
            key: "setSustainPedal",
            value: function setSustainPedal(channelNumber, value) {
                var isOn = value >= 64;
                this.channels[channelNumber].sustainPedal = isOn;
                if (!isOn) {
                    this.releaseSustainPedal(channelNumber, value);
                }
            }
        },
        {
            key: "handleRPN",
            value: function handleRPN(channelNumber) {
                var channel = this.channels[channelNumber];
                var rpn = channel.rpnMSB * 128 + channel.rpnLSB;
                switch(rpn){
                    case 0:
                        this.handlePitchBendRangeRPN(channelNumber);
                        break;
                    default:
                        console.warn("Channel ".concat(channelNumber, ": Unsupported RPN MSB=").concat(channel.rpnMSB, " LSB=").concat(channel.rpnLSB));
                }
            }
        },
        {
            key: "setRPNMSB",
            value: function setRPNMSB(channelNumber, value) {
                this.channels[channelNumber].rpnMSB = value;
            }
        },
        {
            key: "setRPNLSB",
            value: function setRPNLSB(channelNumber, value) {
                this.channels[channelNumber].rpnLSB = value;
            }
        },
        {
            key: "dataEntryMSB",
            value: function dataEntryMSB(channelNumber, value) {
                this.channels[channelNumber].dataMSB = value;
                this.handleRPN(channelNumber);
            }
        },
        {
            key: "updateDetune",
            value: function updateDetune(channel, detuneChange) {
                var now = this.audioContext.currentTime;
                channel.scheduledNotes.forEach(function(noteList) {
                    for(var i = 0; i < noteList.length; i++){
                        var note = noteList[i];
                        if (!note) continue;
                        var bufferSource = note.bufferSource;
                        var detune = bufferSource.detune.value + detuneChange;
                        bufferSource.detune.cancelScheduledValues(now).setValueAtTime(detune, now);
                    }
                });
            }
        },
        {
            key: "handlePitchBendRangeRPN",
            value: function handlePitchBendRangeRPN(channelNumber) {
                var channel = this.channels[channelNumber];
                this.limitData(channel, 0, 127, 0, 99);
                var pitchBendRange = channel.dataMSB + channel.dataLSB / 100;
                this.setPitchBendRange(channelNumber, pitchBendRange);
            }
        },
        {
            key: "setPitchBendRange",
            value: function setPitchBendRange(channelNumber, pitchBendRange) {
                var channel = this.channels[channelNumber];
                var prevPitchBendRange = channel.pitchBendRange;
                channel.pitchBendRange = pitchBendRange;
                var detuneChange = (channel.pitchBendRange - prevPitchBendRange) * channel.pitchBend * 100;
                this.updateDetune(channel, detuneChange);
            }
        },
        {
            key: "allSoundOff",
            value: function allSoundOff(channelNumber) {
                return this.stopChannelNotes(channelNumber, 0, true);
            }
        },
        {
            key: "resetAllControllers",
            value: function resetAllControllers(channelNumber) {
                Object.assign(this.channels[channelNumber], this.effectSettings);
            }
        },
        {
            key: "allNotesOff",
            value: function allNotesOff(channelNumber) {
                return this.stopChannelNotes(channelNumber, 0, false);
            }
        },
        {
            key: "handleUniversalNonRealTimeExclusiveMessage",
            value: function handleUniversalNonRealTimeExclusiveMessage(data) {
                switch(data[2]){
                    case 9:
                        switch(data[3]){
                            case 1:
                                this.GM1SystemOn();
                                break;
                            case 2:
                                break;
                            default:
                                console.warn("Unsupported Exclusive Message: ".concat(data));
                        }
                        break;
                    default:
                        console.warn("Unsupported Exclusive Message: ".concat(data));
                }
            }
        },
        {
            key: "GM1SystemOn",
            value: function GM1SystemOn() {
                for(var i = 0; i < this.channels.length; i++){
                    var channel = this.channels[i];
                    channel.bankMSB = 0;
                    channel.bankLSB = 0;
                    channel.bank = 0;
                }
                this.channels[9].bankMSB = 1;
                this.channels[9].bank = 128;
            }
        },
        {
            key: "handleUniversalRealTimeExclusiveMessage",
            value: function handleUniversalRealTimeExclusiveMessage(data) {
                switch(data[2]){
                    case 4:
                        switch(data[3]){
                            case 1:
                                return this.handleMasterVolumeSysEx(data);
                            default:
                                console.warn("Unsupported Exclusive Message: ".concat(data));
                        }
                        break;
                    default:
                        console.warn("Unsupported Exclusive Message: ".concat(data));
                }
            }
        },
        {
            key: "handleMasterVolumeSysEx",
            value: function handleMasterVolumeSysEx(data) {
                var volume = (data[5] * 128 + data[4]) / 16383;
                this.setMasterVolume(volume);
            }
        },
        {
            key: "setMasterVolume",
            value: function setMasterVolume(volume) {
                if (volume < 0 && 1 < volume) {
                    console.error("Master Volume is out of range");
                } else {
                    var now = this.audioContext.currentTime;
                    this.masterGain.gain.cancelScheduledValues(now);
                    this.masterGain.gain.setValueAtTime(volume * volume, now);
                }
            }
        },
        {
            key: "handleExclusiveMessage",
            value: function handleExclusiveMessage(data) {
                console.warn("Unsupported Exclusive Message: ".concat(data));
            }
        },
        {
            key: "handleSysEx",
            value: function handleSysEx(data) {
                switch(data[0]){
                    case 126:
                        return this.handleUniversalNonRealTimeExclusiveMessage(data);
                    case 127:
                        return this.handleUniversalRealTimeExclusiveMessage(data);
                    default:
                        return this.handleExclusiveMessage(data);
                }
            }
        },
        {
            key: "scheduleTask",
            value: function scheduleTask(callback, startTime) {
                var _this = this;
                return new Promise(function(resolve) {
                    var bufferSource = new AudioBufferSourceNode(_this.audioContext);
                    bufferSource.onended = function() {
                        callback();
                        resolve();
                    };
                    bufferSource.start(startTime);
                    bufferSource.stop(startTime);
                });
            }
        }
    ]);
    return MidyGMLite;
}();
_define_property(MidyGMLite, "channelSettings", {
    volume: 100 / 127,
    pan: 64,
    bank: 0,
    dataMSB: 0,
    dataLSB: 0,
    program: 0,
    pitchBend: 0,
    modulationDepthRange: 50
});
_define_property(MidyGMLite, "effectSettings", {
    expression: 1,
    modulationDepth: 0,
    sustainPedal: false,
    rpnMSB: 127,
    rpnLSB: 127,
    pitchBendRange: 2
});
