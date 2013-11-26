var q = require('queue-async'),
    stream = require('stream'),
    util = require('util'),
    events = require('events'),
    SPI = require('pi-spi'),
    GPIO = require("./gpio");

var COMMANDS = require("./magicnums").COMMANDS,
    REGISTER_MAP = require("./magicnums").REGISTER_MAP,
    REGISTER_DEFAULTS = require("./magicnums").REGISTER_DEFAULTS;

function forEachWithCB(fn, cb) {
    var arr = this,
        i = 0, len = arr.length;
    (function proceed() {
        if (i === len) cb(null);
        else fn(arr[i++], function (e) {
            if (e) cb(e);
            else proceed();
        });
    })();
};

function _extend(obj) {
    for (var i = 1, len = arguments.length; i < len; i++) {
        var nxt = arguments[i];
        Object.keys(nxt).forEach(function (k) { obj[k] = nxt[k]; });
    }
    return obj;
}

function blockMicroseconds(us) {      // NOTE: setImmediate/process.nextTick too slow (especially on Pi) so we just spinloop for µs
    var start = process.hrtime();
    while (1) {
        var diff = process.hrtime(start);
        if (diff[0] * 1e9 + diff[1] >= us*1e3) break;
    }
}


exports.connect = function (spi,ce,irq) {
    var nrf = new events.EventEmitter(),
        spi = SPI.initialize(spi),
        ce = GPIO.connect(ce),
        irq = (arguments.length > 2) && GPIO.connect(irq);
    
    nrf.execCommand = function (cmd, data, cb) {        // (can omit data, or specify readLen instead)
        if (typeof data === 'function') {
            cb = data;
            data = 0;
        }
        
        var cmdByte;
        if (typeof cmd === 'string') {
            cmdByte = COMMANDS[cmd];
        } else if (Array.isArray(cmd)) {
            cmdByte = COMMANDS[cmd[0]] | cmd[1];
        } else cmdByte = cmd;
        
        var writeBuf,
            readLen = 0;
        if (Buffer.isBuffer(data)) {
            writeBuf = Buffer(data.length+1);
            writeBuf[0] = cmdByte;
            data.copy(writeBuf,1);
        } else if (Array.isArray(data)) {
            writeBuf = Buffer([cmdByte].concat(data));
        } else {
            writeBuf = Buffer([cmdByte]);
            readLen = data;
        }
        
        spi.transfer(writeBuf, readLen && readLen+1, function (e,d) {
            if (e) return cb(e);
            else return cb(null, d && d.slice(1));
        });
    };   
    
    function registersForMnemonics(list) {
        var registersNeeded = Object.create(null);
        list.forEach(function (mnem) {
            var _r = REGISTER_MAP[mnem];
            if (!_r) return console.warn("Skipping uknown mnemonic '"+mnem+"'!");
            if (_r.length === 1) _r.push(0,8);
            
            var reg = _r[0],
                howManyBits = _r[2] || 1,
                iq = registersNeeded[reg] || (registersNeeded[reg] = {arr:[]});
            iq.len = (howManyBits / 8 >> 0) || 1;
            if (howManyBits < 8) iq.arr.push(mnem);
            else iq.solo = mnem;
        });
        return registersNeeded;
    }
    
    function maskForMnemonic(mnem) {
        var _r = REGISTER_MAP[mnem],
            howManyBits = _r[2] || 1,
            rightmostBit = _r[1],
            mask = 0xFF >> (8 - howManyBits) << rightmostBit;
        return {mask:mask, rightmostBit:rightmostBit};
    }
    
    nrf.getStates = function (list, cb) {
        var registersNeeded = registersForMnemonics(list),
            states = Object.create(null);
        function processInquiryForRegister(reg, cb) {
            // TODO: execCommand always reads register 0x07 but we're not optimizing for that
            var iq = registersNeeded[reg];
            nrf.execCommand(['R_REGISTER',reg], iq.len, function (e,d) {
                if (e) return cb(e);
                iq.arr.forEach(function (mnem) {
                    var m = maskForMnemonic(mnem);
                    states[mnem] = (d[0] & m.mask) >> m.rightmostBit;
                });
                if (iq.solo) states[iq.solo] = d;
                cb();
            });
        }
        forEachWithCB.call(Object.keys(registersNeeded), processInquiryForRegister, function (e) {
            cb(e,states);
        });
    };
    
    nrf.setStates = function (vals, cb) {
        var registersNeeded = registersForMnemonics(Object.keys(vals));
        function processInquiryForRegister(reg, cb) {
            var iq = registersNeeded[reg];
            // if a register is "full" we can simply overwrite, otherwise we must read+merge
            // NOTE: high bits in RF_CH/PX_PW_Pn are *reserved*, i.e. technically need merging
            if (!iq.arr.length || iq.arr[0]==='RF_CH' || iq.arr[0].indexOf('RX_PW_P')===0) {
                var val = vals[iq.solo || iq.arr[0]],
                    buf = (Buffer.isBuffer(val)) ? val : [val];
                nrf.execCommand(['W_REGISTER', reg], buf, cb);
            } else nrf.execCommand(['R_REGISTER', reg], 1, function (e,d) {
                if (e) return cb(e);
                var val = 0;
                if (iq.solo) val = vals[iq.solo];  // TODO: refactor so as not to fetch in the first place!
                iq.arr.forEach(function (mnem) {
                    var m = maskForMnemonic(mnem);
                    val &= ~m.mask;        // clear current value
                    val |= (vals[mnem] << m.rightmostBit) & m.mask;
                });
                nrf.execCommand(['W_REGISTER', reg], [val], cb);
            });
        }
        forEachWithCB.call(Object.keys(registersNeeded), processInquiryForRegister, cb);
    };
    
    nrf.pulseCE = function () {
        ce.value(true);     // pulse for at least 10µs
        blockMicroseconds(10);
        ce.value(false);
    };
    
    // expose:
    // ✓ low level interface (execCommand, getStates, setStates, pulseCE, 'interrupt')
    // - mid level interface (channel, datarate, power, …)
    // - high level PRX (addrs)
    // - high level PTX (addr)
    
    // caller must know pipe and provide its params!
    nrf.readPayload = function (opts, cb) {
        if (opts.width === 'auto') nrf.execCommand('R_RX_PL_WID', 1, function (e,d) {
            if (e) return finish(e);
            var width = d[0];
            if (width > 32) nrf.execCommand('FLUSH_RX', function (e,d) {
                finish(new Error("Invalid dynamic payload size, receive queue flushed."));  // per R_RX_PL_WID details, p.51
            }); else read(width);
        }); else read(opts.width);
        
        function read(width) {
            nrf.execCommand('R_RX_PAYLOAD', width, finish);
        }
        
        function finish(e,d) {  // see footnote c, p.62
            if (opts.leaveStatus) cb(e,d);
            else nrf.setStates({RX_DR:true}, function (e2) {    
                cb(e||e2,d);
            });
        }
    };
    
    // caller must set up any prerequisites (i.e. TX addr) and ensure no other send is pending
    nrf.sendPayload = function (data, opts, cb) {
        if (data.length > 32) throw Error("Maximum packet size exceeded. Smaller writes, Dash!");
        
        var cmd;
        if (opts.ackTo) {
            cmd = ['W_ACK_PAYLOAD',opts.ackTo];
        } else if (opts.noAck) {
            cmd = 'W_TX_PD_NOACK';
        } else {
            cmd = 'W_TX_PAYLOAD';
        }
        nrf.execCommand(cmd, data, function (e) {
            if (e) return cb(e);
            nrf.pulseCE();
            nrf.once('interrupt', function (d) {
                if (d.MAX_RT) nrf.execCommand('FLUSH_TX', function (e) {    // see p.56
                    finish(new Error("Packet timeout, transmit queue flushed."));
                });
                else if (!d.TX_DS) console.warn("Unexpected IRQ during transmit phase!");
                else finish();
                
                function finish(e) {        // clear our interrupts, leaving RX_DR
                    nrf.setStates({TX_DS:true,MAX_RT:true,RX_DR:false}, function () {
                        cb(e||null);
                    });
                }
            });
        });  
    };
    
    nrf.reset = function (states, cb) {
        if (arguments.length < 2) {
            cb = states;
            states = {};
        }
        ce.mode('low');
        q(1)
            .defer(nrf.execCommand, 'FLUSH_TX')
            .defer(nrf.execCommand, 'FLUSH_RX')
            .defer(nrf.setStates, _extend({}, REGISTER_DEFAULTS, states))
        .await(cb);
    };
    
    var irqListener = nrf._checkStatus.bind(nrf,true),
        irqOn = false;
    nrf._irqOn = function () {
        if (irqOn) return;
        else if (irq) {
            irq.mode('in');
            irq.addListener('fall', irqListener);
        } else {
            console.warn("Recommend use with IRQ pin, fallback handling is suboptimal.");
            irqListener = setInterval(function () {       // TODO: clear interval when there are no listeners
                if (nrf.listeners('interrupt').length) nrf._checkStatus(false);
            }, 0);  // (minimum 4ms is a looong time if hoping to quickly stream data!)
        }
        irqOn = true;
    };
    nrf._irqOff = function () {
        if (!irqOn) return;
        else if (irq) irq.removeListener('fall', irqListener);
        else clearInterval(irqListener);
        irqOn = false;
    };
    
    
    
    var mode = 'off',
        pipes = [];
    nrf.mode = function (newMode, cb) {
        if (arguments.length < 1) return mode;
        
        mode = newMode;
        pipes.forEach(function (pipe) { pipe.close(); });
        switch (mode) {
            case 'off':
                nrf._irqOff();
                nrf.reset(ready);
                break;
            case 'tx':
                nrf.reset({PWR_UP:true,CRCO:null,ARD:null,ARC:null,RF_CH:null,RF_PWR:null,EN_DPL:null}, function () {
                    
                    nrf._irqOn();
                    ready();
                });
            case 'rx':
                //ce.value(true);
            default:
                // TODO: start any switch over, emit event when complete
        }
        function ready() { nrf.emit('ready', mode); }
        if (cb) nrf.once('ready', cb);
    };
    nrf.openPipe = function (addr, opts) {
        var pipe;
        switch (mode) {
            case 'off':
                throw Error("Radio must be in transmit or receive mode to open a pipe.");
            case 'tx':
                pipe = new PTX(addr, opts);
                break;
            case 'rx':
                // TODO: choose radio pipe number
                pipe = new PRX(addr, opts);
                break;
            default:
                throw Error("Unknown mode '"+mode="', cannot open pipe!");
        }
        pipes.push(pipe);
        return pipe;
    };
    
    function PxX(pipe, addr, opts) {           // base for PTX/PRX
        stream.Duplex.call(this);
        this._pipe = pipe;
        this._addr = addr;
        this._size = opts.size || 'auto';
        this._wantsRead = false;
        this._sendOpts = {};
        
        var irqHandler = this._rx.bind(this);
        nrf.addListener('interrupt', irqHandler);
        this.once('close', function () {
            nrf.removeListener('interrupt', irqHandler);
        });
    }
    util.inherits(PxX, stream.Duplex);
    PxX.prototype._write = function (buff, _enc, cb) {
        // TODO: handle shared transmissions (but don't set RX_ADDR_P0 if simplex/no-ack)
        try {
            nrf.sendPayload(buff, this._sendOpts, cb);
        } catch (e) {
            process.nextTick(cb.bind(null, e));
        }
        
        /*
        var acking = true,
            states = {TX_ADDR:this._addr, PRIM_RX:false};
        if (acking) states.RX_ADDR_P0 = states.TX_ADDR;
        nrf.setStates(states, function (e) {
            if (e) return cb(e);
        });
        */
    };
    PxX.prototype._rx = function (d) {
        if (d.RX_P_NO !== this._pipe) return;
        if (!this._wantsRead) return;           // NOTE: this could starve other RX pipes!
        
        if (this._wantsRead) nrf.readPayload({width:this._size}, function (e,d) {
            if (e) this.emit('error', e);
            else this._wantsRead = this.push(d);
            nrf._checkStatus(false);         // see footnote c, p.63
        }.bind(this));
    };
    PxX.prototype._read = function () {
        this._wantsRead = true;
        nrf._checkStatus(false);
    };
    PxX.prototype.close = function () {
        this.push(null);
        this.emit('close');
    };
    
    function PTX(addr,opts) {
        opts = _extend({}, opts||{}, {size:'auto'});
        PxX.call(this, 0, addr, opts);
    }
    util.inherits(PTX, PxX);
    
    function PRX(pipe, addr, opts) {
        PxX.call(this, pipe, addr, opts);
        this._sendOpts = {ackTo:pipe};
    }
    util.inherits(PRX, PxX);
    
    nrf._checkStatus = function (irq) {
        nrf.getStates(['RX_P_NO','TX_DS','MAX_RT'], function (e,d) {
            if (e) nrf.emit('error', e);
            else if (irq || d.RX_P_NO !== 0x07 || d.TX_DS || d.MAX_RT) nrf.emit('interrupt', d);
        });
    };
    
    nrf.getStatus = function (cb) {
        nrf.getStates(['RX_DR','TX_DS','MAX_RT','RX_P_NO','TX_FULL'], function (e,d) {
            if (d) d.IRQ = irq.value();
            cb(e,d);
        });
    }
    
    return nrf;
}