'use strict';

const EXT = 'cocos-bridge';

function $(id) { return document.getElementById(id); }

function log(msg) {
  var el = $('log');
  var ts = new Date().toLocaleTimeString();
  el.textContent += '\n[' + ts + '] ' + msg;
  el.scrollTop = el.scrollHeight;
}

function updateUI(state) {
  if (!state) {
    log('Warning: received null/undefined state');
    return;
  }

  var s = state.status || state;
  var el = $('status');

  if (s.running) {
    el.className = 'status running';
    el.textContent = '\u25CF Running';
  } else {
    el.className = 'status stopped';
    el.textContent = '\u25CF Stopped';
  }

  $('url').textContent = s.running ? (s.url || s.host + ':' + s.port) : '(stopped)';
  $('tool-count').textContent = Array.isArray(state.tools) ? state.tools.length : (s.toolProfile ? 'loaded' : '-');
  $('profile').textContent = s.toolProfile || '-';
  $('version').textContent = s.version || '-';

  if (state.recentRuntimeLogs && state.recentRuntimeLogs.length > 0) {
    var lines = state.recentRuntimeLogs.slice(-15).map(function (l) {
      return '[' + l.level + '] ' + l.message;
    });
    $('log').textContent = lines.join('\n');
  }
}

async function tryRequest(msgName) {
  // Try Editor.Message.request first
  if (typeof Editor !== 'undefined' && Editor.Message && Editor.Message.request) {
    try {
      var result = await Editor.Message.request(EXT, msgName);
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: 'request failed: ' + e.message };
    }
  }
  // Try Editor.Message.call as fallback
  if (typeof Editor !== 'undefined' && Editor.Message && Editor.Message.call) {
    try {
      var result2 = Editor.Message.call(EXT, msgName);
      return { ok: true, data: result2 };
    } catch (e2) {
      return { ok: false, error: 'call failed: ' + e2.message };
    }
  }
  return { ok: false, error: 'Editor.Message is unavailable in this panel context' };
}

async function refresh() {
  // Try get-panel-state first, fall back to get-status
  var res = await tryRequest('get-panel-state');
  if (res.ok && res.data) {
    updateUI(res.data);
    return;
  }

  log('get-panel-state: ' + (res.error || 'no data'));

  var res2 = await tryRequest('get-status');
  if (res2.ok && res2.data) {
    updateUI({ status: res2.data, tools: [] });
    return;
  }

  log('get-status: ' + (res2.error || 'no data'));
  $('status').textContent = '\u25CF Connection Error';
  $('status').className = 'status stopped';
}

$('btn-start').addEventListener('click', async function () {
  log('Starting server...');
  var res = await tryRequest('start-server');
  if (res.ok) {
    log('Start command sent. Refreshing...');
    setTimeout(refresh, 1000);
  } else {
    log('Start failed: ' + res.error);
  }
});

$('btn-stop').addEventListener('click', async function () {
  log('Stopping server...');
  var res = await tryRequest('stop-server');
  if (res.ok) {
    log('Stop command sent. Refreshing...');
    setTimeout(refresh, 500);
  } else {
    log('Stop failed: ' + res.error);
  }
});

$('btn-restart').addEventListener('click', async function () {
  log('Restarting server...');
  var res = await tryRequest('restart-server');
  if (res.ok) {
    log('Restart command sent. Refreshing...');
    setTimeout(refresh, 1500);
  } else {
    log('Restart failed: ' + res.error);
  }
});

// Delay initial request to let Editor APIs initialize
log('Panel loaded, connecting...');
setTimeout(refresh, 500);
setInterval(refresh, 5000);
