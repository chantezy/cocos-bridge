'use strict';

exports.template = `
<div style="padding:16px;font-family:sans-serif;font-size:13px;">
  <h3 style="margin:0 0 12px;">Cocos Bridge MCP</h3>
  <div id="status" style="margin-bottom:12px;">Loading...</div>
  <div style="display:flex;gap:8px;margin-bottom:12px;">
    <ui-button id="btn-start">Start</ui-button>
    <ui-button id="btn-stop">Stop</ui-button>
    <ui-button id="btn-restart">Restart</ui-button>
  </div>
  <div style="margin-bottom:8px;">
    <strong>URL:</strong> <span id="url">-</span>
  </div>
  <div style="margin-bottom:8px;">
    <strong>Tools:</strong> <span id="tool-count">-</span>
  </div>
  <div style="margin-bottom:8px;">
    <strong>Profile:</strong> <span id="profile">-</span>
  </div>
  <div style="background:#1e1e1e;color:#ccc;padding:8px;border-radius:4px;font-family:monospace;font-size:11px;max-height:200px;overflow:auto;white-space:pre-wrap;" id="log"></div>
</div>
`;

exports.methods = {
  async refresh() {
    try {
      const state = await Editor.Message.request(
        'cocos-bridge', 'get-panel-state'
      );
      this.updateUI(state);
    } catch (e) {
      this.$('#status').textContent = `Error: ${e.message}`;
    }
  },

  updateUI(state) {
    if (!state || !state.status) return;
    const s = state.status;
    const running = s.running;

    this.$('#status').innerHTML = running
      ? '<span style="color:#4caf50;">&#9679; Running</span>'
      : '<span style="color:#f44336;">&#9679; Stopped</span>';
    this.$('#url').textContent = running ? s.url : '(stopped)';
    this.$('#tool-count').textContent = Array.isArray(state.tools) ? state.tools.length : '-';
    this.$('#profile').textContent = s.toolProfile || '-';

    if (state.recentRuntimeLogs && state.recentRuntimeLogs.length > 0) {
      const lines = state.recentRuntimeLogs.slice(-10).map(l =>
        `[${l.level}] ${l.message}`
      );
      this.$('#log').textContent = lines.join('\n');
    }
  },
};

exports.$ = {
  '#status': '#status',
  '#url': '#url',
  '#tool-count': '#tool-count',
  '#profile': '#profile',
  '#log': '#log',
  '#btn-start': '#btn-start',
  '#btn-stop': '#btn-stop',
  '#btn-restart': '#btn-restart',
};

exports.ready = function () {
  this.$('#btn-start').addEventListener('confirm', async () => {
    await Editor.Message.request('cocos-bridge', 'start-server');
    this.refresh();
  });
  this.$('#btn-stop').addEventListener('confirm', async () => {
    await Editor.Message.request('cocos-bridge', 'stop-server');
    this.refresh();
  });
  this.$('#btn-restart').addEventListener('confirm', async () => {
    await Editor.Message.request('cocos-bridge', 'restart-server');
    this.refresh();
  });
  this.refresh();
};
