var util = require('util');
var path = require('path');
var url = require('url');
var iconv = require('iconv-lite');
var request = require('../util/http-mgr').request;
var isUtf8 = require('../util/is-utf8');
var ca = require('../https/ca');
var Storage = require('../rules/storage');
var getServer = require('hagent').create(null, 40500);
var Buffer = require('safe-buffer').Buffer;

var QUERY_RE = /\?.*$/;
var REQ_ID_RE = /^\d{13,15}-\d{1,5}$/;
var sessionOpts, sessionTimer, sessionPending;
var framesOpts, framesTimer, framesPending;
var customParserOpts, customParserTimer, customParserPending;
var reqCallbacks = {};
var resCallbacks = {};
var parserCallbacks = {};
var framesList = [];
var framesCallbacks = [];
var MAX_LENGTH = 100;
var MAX_BUF_LEN = 1024 * 200;
var TIMEOUT = 1000;
var pluginOpts, storage;
var pluginKeyMap = {};
var noop = function() {};
/* eslint-disable no-undef */
var REQ_ID_KEY = typeof Symbol === 'undefined' ? '$reqId_' + Date.now() : Symbol();
var SESSION_KEY = typeof Symbol === 'undefined' ? '$session_' + Date.now() : Symbol();
var FRAME_KEY = typeof Symbol === 'undefined' ? '$frame_' + Date.now() : Symbol();
var REQ_KEY = typeof Symbol === 'undefined' ? '$req_' + Date.now() : Symbol();
var CLOSED = typeof Symbol === 'undefined' ? '$colsed_' + Date.now() : Symbol();
/* eslint-enable no-undef */
var index = 1000;
var ctx;

var requestData = function(options, callback) {
  request(options, function(err, body) {
    if (err) {
      return callback(err);
    }
    try {
      return callback(null, JSON.parse(body));
    } catch(e) {
      return callback(e);
    }
  });
};

var getValue = function(req, name) {
  const value = req.headers[name] || '';
  try {
    return value ? decodeURIComponent(value) : '';
  } catch(e) {}
  return String(value);
};
var setContenxt = function(req) {
  if (ctx) {
    ctx.request = req;
    req.ctx = ctx;
  }
  req.localStorage = storage;
  req.Storage = Storage;
  req.clientIp = getValue(req, pluginOpts.CLIENT_IP_HEADER) || '127.0.0.1';
};

var initState = function(req, name) {
  switch(name) {
  case 'pauseSend':
    req.curSendState = 'pause';
    return;
  case 'ignoreSend':
    req.curSendState = 'ignore';
    return;
  case 'pauseReceive':
    req.curReceiveState = 'pause';
    return;
  case 'ignoreReceive':
    req.curReceiveState = 'ignore';
    return;
  }
};

var getFrameId = function () {
  ++index;
  if (index > 9990) {
    index = 1000;
  }
  if (index > 99) {
    return Date.now() + '-' + index;
  }
  if (index > 9) {
    return Date.now() + '-0' + index;
  }
  return Date.now() + '-00' + index;
};

var addFrame = function(frame) {
  framesList.push(frame);
  if (framesList.length > 600) {
    framesList.splice(0, 80);
  }
};

var getFrameOpts = function(opts) {
  if (!opts) {
    return {};
  }
  if (opts === true) {
    return { ignore: true };
  }
  var result = {};
  if (opts.ignore === true) {
    result.ignore = true;
  }
  if (opts.compressed === true) {
    result.compressed = true;
  }
  if (opts.opcode > 0) {
    result.opcode = opts.opcode == 1 ? 1 : 2;
  }
  if (opts.isError) {
    result.isError = true;
  }
  if (typeof opts.charset === 'string') {
    result.charset = opts.charset;
  }
  return result;
};
var pushFrame = function(reqId, data, opts, isClient) {
  if (data == null) {
    return;
  }
  if (!Buffer.isBuffer(data)) {
    try {
      if (typeof data !== 'string') {
        data = JSON.stringify(data);
      }
      data = Buffer.from(data);
    } catch(e) {
      data = null;
    }
  }
  if (!data) {
    return;
  }
  opts = getFrameOpts(opts);
  opts.reqId = reqId;
  opts.frameId = getFrameId();
  opts.isClient = isClient;
  opts.length = data.length;
  if (opts.length > MAX_BUF_LEN) {
    data = data.slice(0, MAX_BUF_LEN);
  }
  opts.base64 = data.toString('base64');
  addFrame(opts);
};
var addParserApi = function(req, conn, state, reqId) {
  state = state.split(',').forEach(function(name) {
    initState(req, name);
  });
  req.on('clientFrame', function(data, opts) {
    pushFrame(reqId, data, opts, true);
  });
  req.on('serverFrame', function(data, opts) {
    pushFrame(reqId, data, opts);
  });
  var on = req.on;
  req.on = function(eventName) {
    on.apply(this, arguments);
    var curState, prevState;
    if (eventName === 'sendStateChange') {
      curState = req.curSendState;
      prevState = req.prevSendState;
    } else if (eventName === 'receiveStateChange') {
      curState = req.curReceiveState;
      prevState = req.prevReceiveState;
    }
    if (curState || prevState) {
      req.emit(eventName, curState, prevState);
    }
  };
  var disconnected;
  var emitDisconnect = function(err) {
    if (disconnected) {
      return;
    }
    req.isDisconnected = disconnected = true;
    addFrame({
      reqId: reqId,
      frameId: getFrameId(),
      closed: !err,
      err: err && err.message,
      bin: ''
    });
    delete parserCallbacks[reqId];
    req.emit('disconnect', err);
  };
  conn.on('error', emitDisconnect);
  conn.on('close', emitDisconnect);
  parserCallbacks[reqId] = function(data) {
    if (!data) {
      return conn.destroy();
    }
    var sendState, receiveState;
    if (data.sendStatus === 1) {
      sendState = 'pause';
    } else if (data.sendStatus === 2) {
      sendState = 'ignore';
    }
    if (data.receiveStatus === 1) {
      receiveState = 'pause';
    } else if (data.receiveStatus === 2) {
      receiveState = 'ignore';
    }
    var curSendState = req.curSendState;
    if (curSendState != sendState) {
      req.prevSendState = req.curSendState;
      req.curSendState = sendState;
      try {
        req.emit('sendStateChange', req.curSendState, req.prevSendState);
      } catch(e) {}
    }
    var curReceiveState = req.curReceiveState;
    if (curReceiveState != receiveState) {
      req.prevReceiveState = req.curReceiveState;
      req.curReceiveState = receiveState;
      try {
        req.emit('receiveStateChange', req.curReceiveState, req.prevReceiveState);
      } catch(e) {}
    }
    if (Array.isArray(data.toClient)) {
      data.toClient.forEach(function(frame) {
        var buf = toBuffer(frame.base64);
        try {
          buf && req.emit('sendToClient', buf, frame.binary);
        } catch(e) {}
      });
    }
    if (Array.isArray(data.toServer)) {
      data.toServer.forEach(function(frame) {
        var buf = toBuffer(frame.base64);
        try {
          buf && req.emit('sendToServer', buf, frame.binary);
        } catch(e) {}
      });
    }
  };
  retryCustomParser();
};
var initReq = function(req, res, isServer) {
  req.on('error', noop);
  res.on('error', noop);
  var reqId = getValue(req, pluginOpts.REQ_ID_HEADER);
  var oReq = req.originalReq = {};
  var oRes = req.originalRes = {};
  setContenxt(req);
  oReq.clientIp = req.clientIp;
  if (isServer) {
    var customParserHeader = req.headers[pluginOpts.CUSTOM_PARSER_HEADER];
    if (customParserHeader && typeof customParserHeader === 'string') {
      addParserApi(req, res, customParserHeader, reqId);
      req.customParser = oReq.customParser = true;
    }
  }
  var headers = {};
  Object.keys(req.headers).forEach(function(key) {
    if (!pluginKeyMap[key]) {
      headers[key] = req.headers[key];
    }
  });
  req[REQ_ID_KEY] = oReq.id = reqId;
  oReq.headers = headers;
  oReq.ruleValue = getValue(req, pluginOpts.RULE_VALUE_HEADER);
  oReq.url = oReq.fullUrl = getValue(req, pluginOpts.FULL_URL_HEADER);
  oReq.realUrl = getValue(req, pluginOpts.REAL_URL_HEADER);
  oReq.method = getValue(req, pluginOpts.METHOD_HEADER) || 'GET';
  oReq.clientPort = getValue(req, pluginOpts.CLIENT_PORT_HEAD);
  oReq.globalValue = getValue(req, pluginOpts.GLOBAL_VALUE_HEAD);
  oReq.proxyValue = getValue(req, pluginOpts.PROXY_VALUE_HEADER);
  oReq.pacValue = getValue(req, pluginOpts.PAC_VALUE_HEADER);
  oRes.serverIp = getValue(req, pluginOpts.HOST_IP_HEADER);
  oRes.statusCode = getValue(req, pluginOpts.STATUS_CODE_HEADER);
};
var toBuffer = function(base64) {
  if (base64) {
    try {
      return new Buffer(base64, 'base64');
    } catch(e) {}
  }
};
var getBuffer = function(item) {
  return toBuffer(item.base64);
};
var getText = function(item) {
  var body = toBuffer(item.base64) || '';
  if (body && !isUtf8(body)) {
    try {
      body = iconv.encode(body, 'GB18030');
    } catch(e) {}
  }
  return body + '';
};

var defineProps = function(obj) {
  if (!obj) {
    return;
  }
  if (Object.defineProperties) {
    Object.defineProperties(obj, {
      body: {
        get: function() {
          return getText(obj);
        }
      },
      buffer: {
        get: function() {
          return getBuffer(obj);
        }
      }
    });
  } else {
    obj.body = getText(obj);
    obj.buffer = getBuffer(obj);
  }
};

var execCallback = function(id, cbs, item) {
  var cbList = cbs[id];
  if (cbList && (cbs === reqCallbacks || !item || item.endTime)) {
    item = item || '';
    defineProps(item.req);
    defineProps(item.res);
    delete cbs[id];
    cbList.forEach(function(cb) {
      try {
        cb(item);
      } catch(e) {}
    });
  }
};

var retryRequestSession = function(time) {
  if (!sessionTimer) {
    sessionTimer = setTimeout(requestSessions, time || TIMEOUT);
  }
};

var requestSessions = function() {
  clearTimeout(sessionTimer);
  sessionTimer = null;
  if (sessionPending) {
    return;
  }
  var reqList = Object.keys(reqCallbacks);
  var resList = Object.keys(resCallbacks);
  if (!reqList.length && !resList.length) {
    return;
  }
  sessionPending = true;
  var _reqList = reqList.slice(0, MAX_LENGTH);
  var _resList = resList.slice(0, MAX_LENGTH);
  var query = '?reqList=' + JSON.stringify(_reqList) + '&resList=' + JSON.stringify(_resList);
  sessionOpts.path = sessionOpts.path.replace(QUERY_RE, query);
  requestData(sessionOpts, function(err, result) {
    sessionPending = false;
    if (err || !result) {
      return retryRequestSession();
    }
    Object.keys(result).forEach(function(id) {
      var item = result[id];
      execCallback(id, reqCallbacks, item);
      execCallback(id, resCallbacks, item);
    });
    retryRequestSession(300);
  });
};

var retryRequestFrames = function(time) {
  if (!framesTimer) {
    framesTimer = setTimeout(requestFrames, time || TIMEOUT);
  }
};
var requestFrames = function() { 
  clearTimeout(framesTimer);
  framesTimer = null;
  if (framesPending) {
    return;
  }
  var cb = framesCallbacks.shift();
  if (!cb) {
    return;
  }
  var req = cb[REQ_KEY];
  framesPending = true;
  var query = '?curReqId=' + req[REQ_ID_KEY] + '&lastFrameId=' + (req[FRAME_KEY] || '');
  framesOpts.path = framesOpts.path.replace(QUERY_RE, query);
  requestData(framesOpts, function(err, result) {
    framesPending = false;
    if (err || !result) {
      framesCallbacks.push(cb);
      return retryRequestFrames();
    }
    var frames = result.frames;
    var closed = !frames;
    if (Array.isArray(frames)) {
      var last = frames[frames.length - 1];
      var frameId = last && last.frameId;
      if (frameId) {
        req[FRAME_KEY] = frameId;
        frames.forEach(defineProps);
        closed = !!(last.closed || last.err);
      }
    }
    if (!frames || frames.length) {
      try {
        cb(frames || '');
      } catch(e) {}
    } else {
      framesCallbacks.push(cb);
    }
    req[CLOSED] = closed;
    retryRequestFrames(300);
  });
};

var retryCustomParser = function(time) {
  if (!customParserTimer) {
    customParserTimer = setTimeout(customParser, time || TIMEOUT);
  }
};

var customParser = function() {
  clearTimeout(customParserTimer);
  customParserTimer = null;
  if (customParserPending) {
    return;
  }
  var idList = Object.keys(parserCallbacks);
  if (!idList.length && !framesList.length) {
    return;
  }
  customParserPending = true;
  customParserOpts.body = {
    idList: idList,
    frames: framesList.splice(0, 10)
  };
  requestData(customParserOpts, function(err, result) {
    customParserPending = false;
    customParserOpts.body = undefined;
    if (err || !result) {
      return retryCustomParser();
    }
    idList.forEach(function(reqId) {
      var cb = parserCallbacks[reqId];
      cb && cb(result[reqId]);
    });
    retryCustomParser(framesList.length> 0 ? 20 : 300);
  });
};

var getFrames = function(req, cb) {
  var reqId = req[REQ_ID_KEY];
  if (!REQ_ID_RE.test(reqId) || typeof cb !== 'function') {
    return;
  }
  var url = req.originalReq.url;
  var isTunnel = !req[CLOSED] && /^tunnel/.test(url);
  if (!isTunnel && !/^ws/.test(url)) {
    return cb('');
  }
  cb[REQ_KEY] = req;
  framesCallbacks.push(cb);
  getSession(req, function(session) {
    if (!session || session.reqError || session.resError
        || (isTunnel && !session.inspect)) {
      framesCallbacks.forEach(function(_cb) {
        req[CLOSED] = 1;
        _cb('');
      });
      framesCallbacks = [];
      return;
    }
    requestFrames();
  });
};

var getSession = function(req, cb, isReq) {
  var reqId = req[REQ_ID_KEY];
  if (!REQ_ID_RE.test(reqId) || typeof cb !== 'function') {
    return;
  }
  var session = req[SESSION_KEY];
  if (session != null) {
    if (isReq) {
      return cb(session);
    }
    if (!session || session.endTime) {
      return cb(session);
    }
  }
  var cbList = isReq ? reqCallbacks[reqId] : resCallbacks[reqId];
  if (cbList) {
    if (cbList.indexOf(cb) === -1) {
      cbList.push(cb);
    }
  } else {
    cbList = [function(s) {
      req[SESSION_KEY] = s;
      cb(s);
    }];
  }
  if (isReq) {
    reqCallbacks[reqId] = cbList;
  } else {
    resCallbacks[reqId] = cbList;
  }
  retryRequestSession(300);
};

var handleStatsResponse = function(req, res) {
  initReq(req, res);
  req.getReqSession = function(cb) {
    return getSession(req, cb, true);
  };
  req.getSession = function(cb) {
    return getSession(req, cb);
  };
  req.getFrames = function(cb) {
    return getFrames(req, cb);
  };
  res.end();
};
var addSessionApi = function(req, res, isServer) {
  initReq(req, res, isServer);
  req.unsafe_getReqSession = function(cb) {
    return getSession(req, cb, true);
  };
  req.unsafe_getSession = function(cb) {
    return getSession(req, cb);
  };
  req.unsafe_getFrames = function(cb) {
    return getFrames(req, cb);
  };
};

var addServerApi = function(req, res) {
  addSessionApi(req, res, true);
};
var addConnectApi = function(req, res) {
  var established;
  req.sendEstablished = function(err) {
    if (established) {
      return;
    }
    established = true;
    var msg = err ? 'Bad Gateway' : 'Connection Established';
    var body = String((err && err.stack) || '');
    var length = Buffer.byteLength(body);
    var resCtn = [
      'HTTP/1.1 ' + (err ? 502 : 200) + ' ' + msg,
      'Content-Length: ' + length,
      'Proxy-Agent: ' + pluginOpts.shortName,
      '\r\n',
      body
    ].join('\r\n');
    res.write(resCtn);
  };
  addServerApi(req, res);
};

var loadModule = function(filepath) {
  try {
    return require(filepath);
  } catch (e) {}
};

module.exports = function(options, callback) {
  options.getRootCAFile = ca.getRootCAFile;
  options.createCertificate = ca.createCertificate;
  options.Storage = Storage;
  var name = options.name;
  options.shortName = name.substring(name.indexOf('/') + 1);
  storage = new Storage(path.join(options.config.baseDir, '.plugins', options.name));
  options.storage = options.localStorage = storage;
  var config = options.config;
  pluginOpts = options;
  Object.keys(options).forEach(function(key) {
    key = options[key];
    if (typeof key === 'string' && !key.indexOf('x-whistle-')) {
      pluginKeyMap[key] = 1;
    }
  });
  var headers = {
    'x-whistle-auth-key': config.authKey,
    'content-type': 'application/json'
  };
  var baseUrl = 'http://127.0.0.1:' + config.uiport + '/cgi-bin/';
  sessionOpts = url.parse(baseUrl + 'get-session?');
  sessionOpts.headers = headers;
  framesOpts = url.parse(baseUrl + 'get-frames?');
  framesOpts.headers = headers;
  customParserOpts = url.parse(baseUrl + 'custom-frames?');
  customParserOpts.headers = headers;
  customParserOpts.method = 'POST';
  delete config.authKey;
  if (options.debugMode) {
    var cacheLogs = [];
    /*eslint no-console: "off"*/
    console.log = function() {
      var msg = util.format.apply(this, arguments);
      if (cacheLogs) {
        cacheLogs.push(msg);
      } else {
        process.sendData({
          type: 'console.log',
          message: msg
        });
      }
    };
    process.on('data', function(data) {
      if (cacheLogs && data && data.type == 'console.log' && data.status == 'ready') {
        var _cacheLogs = cacheLogs;
        cacheLogs = null;
        _cacheLogs.forEach(function(msg) {
          process.sendData({
            type: 'console.log',
            message: msg
          });
        });
      }
    });
    process.on('uncaughtException', function(err) {
      console.log(err);
      setTimeout(function() {
        process.exit(1);
      }, 160);
    });
  }

  var port, statsPort, resStatsPort, uiPort, rulesPort, resRulesPort, tunnelRulesPort, tunnelPort;
  var count = 0;
  var callbackHandler = function() {
    if (--count <= 0) {
      callback(null, {
        port: port,
        statsPort: statsPort,
        resStatsPort: resStatsPort,
        uiPort: uiPort,
        rulesPort: rulesPort,
        resRulesPort: resRulesPort,
        tunnelRulesPort: tunnelRulesPort,
        tunnelPort: tunnelPort
      });
    }
  };

  try {
    require.resolve(options.value);
  } catch(e) {
    return callbackHandler();
  }

  var initServers = function(_ctx) {
    ctx = _ctx || ctx;
    var execPlugin = require(options.value);
    var startServer = execPlugin.pluginServer || execPlugin.server || execPlugin;
    if (typeof startServer == 'function') {
      ++count;
      getServer(function(server, _port) {
        server.on('request', addServerApi);
        server.on('upgrade', addServerApi);
        server.on('connect', addConnectApi);
        startServer(server, options);
        port = _port;
        callbackHandler();
      });
    }

    var startStatsServer = execPlugin.statServer || execPlugin.statsServer
      || execPlugin.reqStatServer || execPlugin.reqStatsServer;
    if (typeof startStatsServer == 'function') {
      ++count;
      getServer(function(server, _port) {
        server.on('request', handleStatsResponse);
        startStatsServer(server, options);
        statsPort = _port;
        callbackHandler();
      });
    }

    var startResStatsServer = execPlugin.resStatServer || execPlugin.resStatsServer;
    if (typeof startResStatsServer == 'function') {
      ++count;
      getServer(function(server, _port) {
        server.on('request', handleStatsResponse);
        startResStatsServer(server, options);
        resStatsPort = _port;
        callbackHandler();
      });
    }

    var startUIServer = execPlugin.uiServer || execPlugin.innerServer || execPlugin.internalServer;
    if (typeof startUIServer == 'function') {
      ++count;
      getServer(function(server, _port) {
        server.on('request', setContenxt);
        startUIServer(server, options);
        uiPort = _port;
        callbackHandler();
      });
    }

    var startRulesServer = execPlugin.pluginRulesServer || execPlugin.rulesServer || execPlugin.reqRulesServer;
    if (typeof startRulesServer == 'function') {
      ++count;
      getServer(function(server, _port) {
        server.on('request', addSessionApi);
        startRulesServer(server, options);
        rulesPort = _port;
        callbackHandler();
      });
    }

    var startResRulesServer = execPlugin.resRulesServer;
    if (typeof startResRulesServer == 'function') {
      ++count;
      getServer(function(server, _port) {
        server.on('request', function(req, res) {
          initReq(req, res);
          req.getReqSession = function(cb) {
            return getSession(req, cb, true);
          };
          req.unsafe_getSession = function(cb) {
            return getSession(req, cb);
          };
          req.unsafe_getFrames = function(cb) {
            return getFrames(req, cb);
          };
        });
        startResRulesServer(server, options);
        resRulesPort = _port;
        callbackHandler();
      });
    }

    var startTunnelRulesServer = execPlugin.pluginRulesServer || execPlugin.tunnelRulesServer;
    if (typeof startTunnelRulesServer == 'function') {
      ++count;
      getServer(function(server, _port) {
        server.on('request', addSessionApi);
        startTunnelRulesServer(server, options);
        tunnelRulesPort = _port;
        callbackHandler();
      });
    }

    var startTunnelServer = execPlugin.pluginServer || execPlugin.tunnelServer || execPlugin.connectServer;
    if (typeof startTunnelServer == 'function') {
      ++count;
      getServer(function(server, _port) {
        server.on('request', addServerApi);
        server.on('connect', addConnectApi);
        startTunnelServer(server, options);
        tunnelPort = _port;
        callbackHandler();
      });
    }

    if (!count) {
      callbackHandler();
    }
  };
  var initial = loadModule(path.join(options.value, 'initial.js'));
  if (typeof initial === 'function') {
    if (initial.length === 2) {
      ctx = initial(options, initServers);
      return ctx;
    }
    ctx = initial(options);
  }
  initServers();
};


