'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const manifest = require('./package.json');
const { loadConfig, getProjectPath, getProjectName, getProjectIdentity, getCocosVersion } = require('./lib/config');
const { McpServer } = require('./lib/server');
const { createToolRegistry } = require('./lib/tool-registry');
const { InteractionLog } = require('./lib/interaction-log');
const { RuntimeLog } = require('./lib/runtime-log');
const { normalizeSavedToolProfiles } = require('./lib/tool-profiles');
const generators = require('./lib/generators');

const EXTENSION_NAME = manifest.name || 'cocos-bridge';
const LOG_PREFIX = '[Cocos Bridge]';
const REPOSITORY_URL = 'https://github.com/chantezy/game-skills';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class ExtensionService {
  constructor() {
    this.config = null;
    this.server = null;
    this.toolRegistry = null;
    this.interactionLog = new InteractionLog();
    this.runtimeLog = new RuntimeLog();
  }

  log(level, message, details) {
    if (this.runtimeLog && typeof this.runtimeLog.add === 'function') {
      this.runtimeLog.add(level, message, details);
    }
    const output = `${LOG_PREFIX} ${message}`;
    if (level === 'error') {
      console.error(output);
    } else if (level === 'warn') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }

  load() {
    this.log('info', 'Extension loading...');
    this.reloadRuntime();
    let result;
    if (this.config.autostart) {
      this.log('info', 'Autostart is enabled, starting MCP server.');
      result = this.startServer();
    } else {
      this.log('info', 'Autostart is disabled. MCP server is idle.');
      result = this.getStatus();
    }

    return result;
  }

  unload() {
    this.log('info', 'Extension unloading...');
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    this.log('info', 'Extension unloaded.');
  }

  openPanel(panelName) {
    if (!global.Editor || !Editor.Panel || typeof Editor.Panel.open !== 'function') {
      throw new Error('Editor.Panel.open is unavailable in this Cocos extension host.');
    }
    const normalized = String(panelName || 'default').trim();
    const panelId = !normalized || normalized === 'default'
      ? EXTENSION_NAME
      : `${EXTENSION_NAME}.${normalized}`;
    return Editor.Panel.open(panelId);
  }

  reloadRuntime() {
    this.config = loadConfig();
    this.interactionLog = new InteractionLog(this.config.maxInteractionLogEntries);
    this.runtimeLog = new RuntimeLog(this.config.maxInteractionLogEntries);
    this.log(
      'info',
      `Runtime config loaded: host=${this.config.host}, port=${this.config.port}, ` +
      `profile=${this.config.toolProfile}, autostart=${this.config.autostart}`
    );
    const sceneBridge = {
      call: async (method, payload) => {
        if (!global.Editor || !Editor.Message || typeof Editor.Message.request !== 'function') {
          throw new Error('Editor.Message.request is unavailable in the Cocos extension host.');
        }

        return await Editor.Message.request('scene', 'execute-scene-script', {
          name: EXTENSION_NAME,
          method,
          args: [payload || {}],
        });
      },
    };

    const runtimeContext = () => ({
      extensionName: EXTENSION_NAME,
      version: manifest.version || '0.0.0',
      config: this.config,
      projectPath: getProjectPath(),
      projectName: getProjectName(),
      projectIdentity: getProjectIdentity(),
      cocosVersion: getCocosVersion(),
      packagePath: path.dirname(__filename),
      generators,
    });

    this.toolRegistry = createToolRegistry({
      getRuntimeContext: runtimeContext,
      getStatus: () => this.getStatus(),
      interactionLog: this.interactionLog,
      runtimeLog: this.runtimeLog,
      sceneBridge,
      editorExecutor: async (payload) => await this.executeEditorScript(payload, runtimeContext),
    });
  }

  async startServer() {
    if (this.server && this.server.isRunning()) {
      this.log('info', `Start requested but MCP server is already running at ${this.getStatus().url}`);
      return this.getStatus();
    }

    this.log('info', 'Starting MCP server...');
    this.reloadRuntime();
    this.server = new McpServer({
      config: this.config,
      interactionLog: this.interactionLog,
      runtimeLog: this.runtimeLog,
      toolRegistry: this.toolRegistry,
      resourceProvider: null,
      promptProvider: null,
      serverName: `Cocos Bridge - ${getProjectName()}`,
      serverVersion: manifest.version || '0.0.0',
      projectName: getProjectName(),
      projectIdentity: getProjectIdentity(),
    });

    await this.server.start();
    this.log('info', `MCP server started at ${this.getStatus().url}`);
    return this.getStatus();
  }

  async stopServer() {
    this.log('info', 'Stop requested.');
    if (this.server) {
      await this.server.stop();
      this.server = null;
      this.log('info', 'MCP server stopped.');
    } else {
      this.log('info', 'Stop requested but MCP server was not running.');
    }
    return this.getStatus();
  }

  async restartServer() {
    this.log('info', 'Restart requested.');
    await this.stopServer();
    const status = await this.startServer();
    this.log('info', `Restart completed. MCP server running=${status.running}, url=${status.url}`);
    return status;
  }

  getEffectiveServerConnection() {
    const port = this.server && this.server.isRunning() && typeof this.server.getPort === 'function'
      ? this.server.getPort()
      : this.config.port;
    return {
      host: this.config.host,
      port,
      url: `http://${this.config.host}:${port}/`,
    };
  }

  getStatus() {
    const effective = this.getEffectiveServerConnection();
    const fallbackInfo = this.server && this.server.isRunning() && typeof this.server.getPortFallbackInfo === 'function'
      ? this.server.getPortFallbackInfo()
      : null;
    const attachInfo = this.server && this.server.isRunning() && typeof this.server.getAttachInfo === 'function'
      ? this.server.getAttachInfo()
      : null;
    return {
      running: Boolean(this.server && this.server.isRunning()),
      attachedToExisting: Boolean(attachInfo),
      attachInfo,
      host: this.config.host,
      port: effective.port,
      requestedPort: this.config.port,
      portFallbackActive: Boolean(fallbackInfo),
      portFallbackInfo: fallbackInfo,
      toolProfile: this.config.toolProfile,
      enabledTools: this.config.enabledTools,
      disabledTools: this.config.disabledTools,
      enabledToolCategories: this.config.enabledToolCategories,
      disabledToolCategories: this.config.disabledToolCategories,
      enableSessions: this.config.enableSessions,
      executeJavascriptSafetyChecks: this.config.executeJavascriptSafetyChecks,
      autostart: this.config.autostart,
      activeToolProfileName: this.config.activeToolProfileName,
      savedToolProfiles: this.config.savedToolProfiles,
      version: manifest.version || '0.0.0',
      projectPath: getProjectPath(),
      projectName: getProjectName(),
      projectIdentity: getProjectIdentity(),
      cocosVersion: getCocosVersion(),
      url: effective.url,
    };
  }

  getPanelState() {
    this.ensureRuntime();
    const status = this.getStatus();
    const tools = this.toolRegistry.listTools();
    const toolCatalog = typeof this.toolRegistry.listToolCatalog === 'function'
      ? this.toolRegistry.listToolCatalog()
      : tools;
    const effective = this.getEffectiveServerConnection();
    const baseUrl = effective.url.replace(/\/$/, '');

    return {
      status,
      tools,
      toolCatalog,
      recentInteractions: this.interactionLog.list(20),
      recentRuntimeLogs: this.runtimeLog.list(20),
      config: this.config,
      clientConfig: {
        url: effective.url,
        json: JSON.stringify({
          mcpServers: {
            cocos_bridge: { url: effective.url },
          },
        }, null, 2),
        curl: {
          health: `curl ${baseUrl}/health`,
          tools: `curl ${baseUrl}/tools`,
        },
      },
    };
  }

  listToolsForPanel() {
    this.ensureRuntime();
    return this.toolRegistry.listTools();
  }

  async callToolFromPanel(name, args) {
    this.ensureRuntime();
    this.log('info', `Panel calling tool: ${name}`);
    return await this.toolRegistry.callTool(name, args || {});
  }

  openUrl(url) {
    const targetUrl = String(url || REPOSITORY_URL).trim();
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`Refusing to open non-HTTP URL: ${targetUrl}`);
    }

    try {
      const electron = require('electron');
      if (electron && electron.shell && typeof electron.shell.openExternal === 'function') {
        electron.shell.openExternal(targetUrl);
        return { opened: true, url: targetUrl, method: 'electron.shell.openExternal' };
      }
    } catch (error) {
      // Fall through to Editor or platform open commands.
    }

    if (global.Editor && Editor.Utils && Editor.Utils.Shell && typeof Editor.Utils.Shell.openExternal === 'function') {
      Editor.Utils.Shell.openExternal(targetUrl);
      return { opened: true, url: targetUrl, method: 'Editor.Utils.Shell.openExternal' };
    }

    const childProcess = require('child_process');
    const command = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', targetUrl] : [targetUrl];
    const child = childProcess.spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { opened: true, url: targetUrl, method: command };
  }

  scheduleExtensionReload(delayMs = 1200) {
    if (!global.Editor || !Editor.Package) {
      return { scheduled: false, reason: 'Editor.Package is unavailable' };
    }
    const canReload = typeof Editor.Package.reload === 'function';
    if (!canReload) {
      return {
        scheduled: false,
        reason: 'Cocos Creator does not expose a reliable package reload API; restart Cocos Creator to load the updated extension',
      };
    }

    setTimeout(async () => {
      try {
        this.log('info', 'Reloading Cocos Bridge extension.');
        await Editor.Package.reload(EXTENSION_NAME);
      } catch (error) {
        this.log('error', `Extension reload failed: ${error.message}`);
      }
    }, delayMs);
    return { scheduled: true, delayMs };
  }

  async executeEditorScript(payload, runtimeContext) {
    const code = String(payload && payload.code || '');
    if (!code.trim()) {
      throw new Error('code is required.');
    }

    const args = payload && payload.args ? payload.args : {};
    const context = runtimeContext();
    const helpers = {
      getStatus: () => this.getStatus(),
      listTools: () => this.toolRegistry.listTools(),
      callTool: async (name, toolArgs) => await this.toolRegistry.callTool(name, toolArgs || {}),
    };

    const runner = new AsyncFunction(
      'require',
      'Editor',
      'args',
      'context',
      'helpers',
      'fs',
      'path',
      'os',
      `
      const module = { exports: {} };
      const exports = module.exports;
      ${code}
      if (typeof run === 'function') {
        return await run({ Editor, args, context, helpers, fs, path, os, require });
      }
      if (typeof module.exports === 'function') {
        return await module.exports({ Editor, args, context, helpers, fs, path, os, require });
      }
      if (module.exports && typeof module.exports.run === 'function') {
        return await module.exports.run({ Editor, args, context, helpers, fs, path, os, require });
      }
      `
    );

    return await runner(require, global.Editor, args, context, helpers, fs, path, os);
  }

  async saveConfig(partialConfig) {
    this.ensureRuntime();
    const nextPort = partialConfig && partialConfig.port !== undefined
      ? Number(partialConfig.port)
      : this.config.port;
    const nextMaxEntries = partialConfig && partialConfig.maxInteractionLogEntries !== undefined
      ? Number(partialConfig.maxInteractionLogEntries)
      : this.config.maxInteractionLogEntries;
    const normalizeList = (value, fallback) => {
      if (Array.isArray(value)) {
        return value.map((item) => String(item || '').trim()).filter(Boolean);
      }
      if (typeof value === 'string') {
        return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
      }
      return fallback || [];
    };
    const normalizeCategories = (value, fallback) => normalizeList(value, fallback)
      .map((item) => item.toLowerCase());
    const nextProfile = partialConfig && partialConfig.toolProfile
      ? (partialConfig.toolProfile === 'full' || partialConfig.toolProfile === 'custom' ? partialConfig.toolProfile : 'core')
      : this.config.toolProfile;
    const nextConfig = {
      host: partialConfig && partialConfig.host ? String(partialConfig.host) : this.config.host,
      port: Number.isInteger(nextPort) && nextPort > 0 && nextPort <= 65535 ? nextPort : this.config.port,
      toolProfile: nextProfile,
      enabledTools: normalizeList(partialConfig && partialConfig.enabledTools, this.config.enabledTools),
      disabledTools: normalizeList(partialConfig && partialConfig.disabledTools, this.config.disabledTools),
      enabledToolCategories: normalizeCategories(
        partialConfig && partialConfig.enabledToolCategories,
        this.config.enabledToolCategories
      ),
      disabledToolCategories: normalizeCategories(
        partialConfig && partialConfig.disabledToolCategories,
        this.config.disabledToolCategories
      ),
      enableSessions: partialConfig && typeof partialConfig.enableSessions === 'boolean'
        ? partialConfig.enableSessions
        : this.config.enableSessions,
      executeJavascriptSafetyChecks: partialConfig && typeof partialConfig.executeJavascriptSafetyChecks === 'boolean'
        ? partialConfig.executeJavascriptSafetyChecks
        : this.config.executeJavascriptSafetyChecks,
      autostart: partialConfig && typeof partialConfig.autostart === 'boolean'
        ? partialConfig.autostart
        : this.config.autostart,
      maxInteractionLogEntries: Number.isInteger(nextMaxEntries)
        ? Math.max(10, Math.min(500, nextMaxEntries))
        : this.config.maxInteractionLogEntries,
      lastClientTargetId: partialConfig && partialConfig.lastClientTargetId
        ? String(partialConfig.lastClientTargetId)
        : this.config.lastClientTargetId,
      activeToolProfileName: partialConfig && typeof partialConfig.activeToolProfileName === 'string'
        ? String(partialConfig.activeToolProfileName)
        : this.config.activeToolProfileName,
      savedToolProfiles: partialConfig && Array.isArray(partialConfig.savedToolProfiles)
        ? normalizeSavedToolProfiles(partialConfig.savedToolProfiles)
        : this.config.savedToolProfiles,
    };

    const configPath = this.config.configPath;
    fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2) + '\n', 'utf8');
    const wasRunning = Boolean(this.server && this.server.isRunning());
    const requiresRestart = wasRunning && (
      nextConfig.host !== this.config.host ||
      nextConfig.port !== this.config.port ||
      nextConfig.toolProfile !== this.config.toolProfile ||
      nextConfig.enableSessions !== this.config.enableSessions ||
      nextConfig.executeJavascriptSafetyChecks !== this.config.executeJavascriptSafetyChecks ||
      JSON.stringify(nextConfig.enabledTools) !== JSON.stringify(this.config.enabledTools) ||
      JSON.stringify(nextConfig.disabledTools) !== JSON.stringify(this.config.disabledTools) ||
      JSON.stringify(nextConfig.enabledToolCategories) !== JSON.stringify(this.config.enabledToolCategories) ||
      JSON.stringify(nextConfig.disabledToolCategories) !== JSON.stringify(this.config.disabledToolCategories)
    );
    if (requiresRestart) {
      await this.stopServer();
    }
    this.reloadRuntime();
    if (requiresRestart) {
      await this.startServer();
    }
    return this.getPanelState();
  }

  ensureRuntime() {
    if (!this.config || !this.toolRegistry) {
      this.reloadRuntime();
    }
  }
}

const service = new ExtensionService();

module.exports = {
  load() {
    return service.load();
  },
  unload() {
    return service.unload();
  },
  methods: {
    openPanel(panelName) {
      return service.openPanel(panelName);
    },
    startServer() {
      return service.startServer();
    },
    stopServer() {
      return service.stopServer();
    },
    restartServer() {
      return service.restartServer();
    },
    getStatus() {
      return service.getStatus();
    },
    getPanelState() {
      return service.getPanelState();
    },
    saveConfig(config) {
      return service.saveConfig(config);
    },
    listToolsForPanel() {
      return service.listToolsForPanel();
    },
    callToolFromPanel(name, args) {
      return service.callToolFromPanel(name, args);
    },
    openUrl(url) {
      return service.openUrl(url);
    },
  },
};
