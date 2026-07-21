'use strict';

// ============================================================================
// tool-registry.js — Intent-level MCP tool registry (18 tools)
//
// Replaces the original 105-tool registry with 17 intent-level tools plus
// 1 fallback (execute_script). Organised into five groups:
//   - Generator tools  (Channel A, filesystem, delegated to runtimeContext.generators)
//   - Scene builder tools  (Channel B, compose sceneBridge calls)
//   - Resource management tools  (Channel B)
//   - Diagnostics tools  (Channel B)
//   - Editor state tools  (Channel B)
//   - Fallback tool  (Channel B, arbitrary JS execution)
// ============================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveProjectPath } = require('./path-safety');
const { assertJavascriptSafety } = require('./javascript-safety');
const { safeStringify } = require('./utils');

const IMAGE_DATA_URI_PREFIX = 'data:image/png;base64,';

// ============================================================================
// Tool category inference
// ============================================================================

const TOOL_CATEGORY_RULES = [
  ['generator', /^generate_/],
  ['scene-builder', /^build_|^populate_/],
  ['resources', /^import_|^validate_asset|^apply_naming/],
  ['diagnostics', /^check_|^audit_|^inspect_scene/],
  ['editor-state', /^get_project|^capture_scene/],
  ['execution', /^execute_/],
];

function inferToolCategory(toolName) {
  for (const [category, pattern] of TOOL_CATEGORY_RULES) {
    if (pattern.test(toolName)) {
      return category;
    }
  }
  return 'other';
}

// ============================================================================
// Schema helpers
// ============================================================================

function createSchema(properties, required) {
  const schema = { type: 'object', properties };
  if (required && required.length) {
    schema.required = required;
  }
  return schema;
}

function createOutputSchema(dataSchema = {}) {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'Whether the tool call completed successfully.' },
      tool: { type: 'string', description: 'Tool name that produced this result.' },
      callId: { type: 'string', description: 'Stable identifier for this tool call result.' },
      timestamp: { type: 'string', description: 'ISO timestamp when the result envelope was produced.' },
      summary: { type: 'string', description: 'Short human-readable result summary.' },
      data: dataSchema,
      refs: {
        type: 'array',
        description: 'Stable references discovered in the result for follow-up tool calls.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            id: { type: 'string' },
            path: { type: 'string' },
            name: { type: 'string' },
          },
        },
      },
    },
    required: ['ok', 'tool', 'callId', 'timestamp', 'data'],
  };
}

// ============================================================================
// Filtering & exposure
// ============================================================================

function normalizeNameSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
}

function normalizeCategorySet(values) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  );
}

function toolCategory(tool) {
  return tool.category || inferToolCategory(tool.name);
}

function isToolExposed(config, tool) {
  const profile = config && config.toolProfile === 'full'
    ? 'full'
    : config && config.toolProfile === 'custom'
      ? 'custom'
      : 'core';
  const category = toolCategory(tool);
  const enabledTools = normalizeNameSet(config && config.enabledTools);
  const disabledTools = normalizeNameSet(config && config.disabledTools);
  const enabledCategories = normalizeCategorySet(config && config.enabledToolCategories);
  const disabledCategories = normalizeCategorySet(config && config.disabledToolCategories);

  let exposed = profile === 'full' || tool.profile === 'core';
  if (profile === 'custom') {
    exposed = tool.profile === 'core' || enabledTools.has(tool.name) || enabledCategories.has(category);
  } else if (enabledTools.has(tool.name) || enabledCategories.has(category)) {
    exposed = true;
  }

  if (disabledTools.has(tool.name) || disabledCategories.has(category)) {
    exposed = false;
  }

  return exposed;
}

// ============================================================================
// Annotations
// ============================================================================

function inferToolAnnotations(tool) {
  const name = tool.name;
  const category = toolCategory(tool);
  const readOnly = /^(get|list|inspect|find|read|search|check|validate|exists|capture|audit)/.test(name);
  const destructive = /(delete|remove|clear|replace|write|reset|set_|execute|run_scene|invoke|emit|simulate|build|populate|generate|import|apply)/.test(name);
  const idempotent = readOnly || /^(set|select|open|pause|resume|stop|refresh)/.test(name);

  return {
    title: name
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '),
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : destructive,
    idempotentHint: idempotent,
    openWorldHint: false,
    ...(tool.annotations || {}),
  };
}

// ============================================================================
// Result envelope
// ============================================================================

function hashObject(value) {
  return crypto
    .createHash('sha256')
    .update(safeStringify(value))
    .digest('hex')
    .slice(0, 16);
}

function summarizeResult(result) {
  if (typeof result === 'string') {
    if (result.startsWith(IMAGE_DATA_URI_PREFIX)) {
      return 'Image payload returned.';
    }
    return result.length > 160 ? `${result.slice(0, 160)}...` : result;
  }
  if (!result || typeof result !== 'object') {
    return String(result);
  }
  if (typeof result.summary === 'string') {
    return result.summary;
  }
  for (const key of ['message', 'path', 'url', 'sceneName', 'projectName']) {
    if (typeof result[key] === 'string' && result[key]) {
      return `${key}: ${result[key]}`;
    }
  }
  if (Number.isFinite(result.count)) {
    return `count: ${result.count}`;
  }
  return 'Structured result returned.';
}

function normalizeEnvelopeData(result) {
  if (typeof result === 'string' && result.startsWith(IMAGE_DATA_URI_PREFIX)) {
    return {
      image: true,
      mimeType: 'image/png',
      byteLength: Buffer.byteLength(result.slice(IMAGE_DATA_URI_PREFIX.length), 'base64'),
    };
  }
  return result;
}

function addRef(refs, type, id, extra = {}) {
  if (!id) return;
  const key = `${type}:${id}`;
  if (refs.some((ref) => ref.key === key)) return;
  refs.push({ key, type, id: String(id), ...extra });
}

function collectRefs(value, refs = [], depth = 0, seen = new WeakSet()) {
  if (!value || depth > 5) return refs;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs, depth + 1, seen);
    }
    return refs;
  }
  if (typeof value !== 'object') return refs;
  if (seen.has(value)) return refs;
  seen.add(value);

  const uuid = value.uuid || value.prefabUuid || value.sceneUuid || value.assetUuid;
  const pathValue = value.path || value.node || value.url;
  if (uuid) {
    addRef(refs, pathValue && String(pathValue).startsWith('db://') ? 'asset' : 'uuid', uuid, {
      path: pathValue ? String(pathValue) : undefined,
      name: value.name ? String(value.name) : undefined,
    });
  }
  if (typeof pathValue === 'string' && pathValue) {
    addRef(refs, pathValue.startsWith('db://') ? 'asset' : 'path', pathValue, {
      name: value.name ? String(value.name) : undefined,
    });
  }

  for (const item of Object.values(value)) {
    collectRefs(item, refs, depth + 1, seen);
  }
  return refs;
}

function createResultEnvelope(tool, args, result, options = {}) {
  const data = normalizeEnvelopeData(result);
  const refs = collectRefs(data).map(({ key, ...ref }) => ref);
  const timestamp = new Date().toISOString();
  const summary = options.summary || summarizeResult(result);
  const callId = `fp_${hashObject({ tool: tool.name, args: args || {}, result: data })}`;
  return {
    ok: options.ok !== false,
    tool: tool.name,
    callId,
    timestamp,
    summary,
    data,
    refs,
  };
}

// ============================================================================
// Output formatting
// ============================================================================

function toOutput(value) {
  if (typeof value === 'string') return value;
  return safeStringify(value);
}

// ============================================================================
// JavaScript safety helpers
// ============================================================================

function useJavascriptSafetyChecks(args, runtimeContext) {
  if (args && typeof args.safety_checks === 'boolean') return args.safety_checks;
  if (args && typeof args.safetyChecks === 'boolean') return args.safetyChecks;
  const config = runtimeContext && runtimeContext.config;
  if (config && typeof config.executeJavascriptSafetyChecks === 'boolean') {
    return config.executeJavascriptSafetyChecks;
  }
  return true;
}

function assertToolJavascriptSafety(args, runtimeContext) {
  if (!useJavascriptSafetyChecks(args, runtimeContext)) return;
  assertJavascriptSafety(args && args.code, {
    projectPath: runtimeContext && runtimeContext.projectPath,
  });
}

// ============================================================================
// Filesystem helpers (used by generator & scene-builder handlers)
// ============================================================================

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function writeFileSafe(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

function ensureProjectPath(runtimeContext, relativePath) {
  const projectPath = runtimeContext.projectPath;
  if (!projectPath) {
    throw new Error('No Cocos project is currently open.');
  }
  return resolveProjectPath(projectPath, relativePath);
}

// ============================================================================
// createToolRegistry — factory function
// ============================================================================

function createToolRegistry({ getRuntimeContext, getStatus, interactionLog, runtimeLog, sceneBridge, editorExecutor }) {

  // ==========================================================================
  // Tool definitions
  // ==========================================================================
  const tools = [

    // ========================================================================
    // GENERATOR TOOLS (Channel A — filesystem, no sceneBridge needed)
    // These delegate to runtimeContext.generators.{name}(args)
    // ========================================================================

    {
      name: 'generate_project_scaffold',
      profile: 'core',
      category: 'generator',
      description: 'Generate a Cocos Creator project directory structure based on a game type definition. Creates the assets/, scenes/, scripts/, prefabs/, configs/ directories and a starter tsconfig.json, package.json, and main scene file.',
      inputSchema: createSchema({
        gameType: {
          type: 'string',
          description: 'Game archetype: platformer, shooter, puzzle, rpg, racing, idle, tower_defense, or a custom identifier.',
        },
        projectName: {
          type: 'string',
          description: 'Name for the project directory and package.',
        },
        outputPath: {
          type: 'string',
          description: 'Absolute or project-relative directory where the scaffold will be created.',
        },
        overwrite: {
          type: 'boolean',
          description: 'When true, overwrite existing files. Default false.',
        },
      }, ['gameType', 'projectName']),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        const generators = runtimeContext.generators;
        if (generators && typeof generators.generate_project_scaffold === 'function') {
          return await generators.generate_project_scaffold(args);
        }

        // Inline fallback implementation
        const gameType = String(args.gameType || 'platformer').toLowerCase();
        const projectName = String(args.projectName || 'MyGame');
        const baseDir = args.outputPath
          ? ensureProjectPath(runtimeContext, args.outputPath)
          : path.join(runtimeContext.projectPath || process.cwd(), projectName);

        if (fs.existsSync(baseDir) && !args.overwrite) {
          throw new Error(`Directory already exists: ${baseDir}. Set overwrite=true to replace.`);
        }

        const dirs = [
          'assets/scripts',
          'assets/scenes',
          'assets/prefabs',
          'assets/resources',
          'assets/configs',
          'assets/sprites',
          'assets/audio',
        ];

        for (const dir of dirs) {
          fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
        }

        // package.json
        writeFileSafe(path.join(baseDir, 'package.json'), JSON.stringify({
          name: projectName,
          version: '1.0.0',
          description: `Cocos Creator project — ${gameType}`,
          type: 'module',
        }, null, 2));

        // tsconfig.json
        writeFileSafe(path.join(baseDir, 'tsconfig.json'), JSON.stringify({
          compilerOptions: {
            target: 'ES2015',
            module: 'ES2015',
            strict: true,
            esModuleInterop: true,
            moduleResolution: 'node',
            sourceMap: true,
            outDir: './build',
            baseUrl: '.',
            paths: { 'cc': ['./temp/declarations/cc'] },
          },
          include: ['assets/**/*.ts'],
        }, null, 2));

        // Game-type config
        writeFileSafe(path.join(baseDir, 'assets/configs/game.json'), JSON.stringify({
          gameType,
          projectName,
          version: '1.0.0',
          generatedAt: new Date().toISOString(),
        }, null, 2));

        return {
          generated: true,
          projectPath: baseDir,
          gameType,
          projectName,
          directoriesCreated: dirs.length,
          summary: `Scaffolded ${gameType} project "${projectName}" at ${baseDir}`,
        };
      },
    },

    {
      name: 'generate_config_files',
      profile: 'core',
      category: 'generator',
      description: 'Generate JSON configuration files and TypeScript interfaces from a Game Design Document (GDD) schema. Reads the GDD schema file, then produces typed config files for levels, enemies, items, UI, and game rules.',
      inputSchema: createSchema({
        schemaPath: {
          type: 'string',
          description: 'Project-relative path to the GDD schema JSON file.',
        },
        outputDir: {
          type: 'string',
          description: 'Project-relative directory to write generated configs. Default: assets/configs.',
        },
        sections: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of schema sections to generate (e.g. ["levels","enemies"]). Generates all by default.',
        },
      }, ['schemaPath']),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        const generators = runtimeContext.generators;
        if (generators && typeof generators.generate_config_files === 'function') {
          return await generators.generate_config_files(args);
        }

        // Inline fallback
        const schemaPath = ensureProjectPath(runtimeContext, args.schemaPath);
        if (!fs.existsSync(schemaPath)) {
          throw new Error(`GDD schema not found: ${schemaPath}`);
        }

        const schema = readJsonFile(schemaPath);
        const outDir = ensureProjectPath(runtimeContext, args.outputDir || 'assets/configs');
        fs.mkdirSync(outDir, { recursive: true });

        const sections = Array.isArray(args.sections) && args.sections.length > 0
          ? args.sections
          : Object.keys(schema);

        const generated = [];

        for (const section of sections) {
          const sectionData = schema[section];
          if (!sectionData) continue;

          // Write JSON config
          const configPath = path.join(outDir, `${section}.json`);
          writeFileSafe(configPath, JSON.stringify(sectionData, null, 2));
          generated.push({ section, configPath, type: 'json' });

          // Write TS interface stub
          const interfaceName = section.charAt(0).toUpperCase() + section.slice(1) + 'Config';
          const tsPath = path.join(outDir, `${section}.interface.ts`);
          const fields = typeof sectionData === 'object' && sectionData !== null
            ? Object.entries(sectionData)
                .map(([k, v]) => `  ${k}: ${typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string'};`)
                .join('\n')
            : '  [key: string]: unknown;';
          writeFileSafe(tsPath, `// Auto-generated from GDD schema\nexport interface ${interfaceName} {\n${fields}\n}\n`);
          generated.push({ section, configPath: tsPath, type: 'typescript' });
        }

        return {
          generated: true,
          outputDir: outDir,
          fileCount: generated.length,
          files: generated,
          summary: `Generated ${generated.length} config files from GDD schema.`,
        };
      },
    },

    {
      name: 'generate_component_scripts',
      profile: 'core',
      category: 'generator',
      description: 'Generate TypeScript component script scaffolds for a Cocos Creator project. Produces .ts files with @ccclass/@property decorators for each requested component.',
      inputSchema: createSchema({
        components: {
          type: 'array',
          description: 'Array of component definitions, each with name, baseClass, and optional properties.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Component class name (e.g. PlayerController).' },
              baseClass: { type: 'string', description: 'Base class to extend. Default: Component.' },
              properties: {
                type: 'array',
                description: 'Typed property declarations.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string', description: 'TypeScript type (number, string, Vec3, Node, etc.).' },
                    default: { type: 'string', description: 'Default value expression as a string.' },
                  },
                  required: ['name', 'type'],
                },
              },
            },
            required: ['name'],
          },
        },
        outputDir: {
          type: 'string',
          description: 'Project-relative directory. Default: assets/scripts/components.',
        },
      }, ['components']),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        const generators = runtimeContext.generators;
        if (generators && typeof generators.generate_component_scripts === 'function') {
          return await generators.generate_component_scripts(args);
        }

        // Inline fallback
        const outDir = ensureProjectPath(runtimeContext, args.outputDir || 'assets/scripts/components');
        fs.mkdirSync(outDir, { recursive: true });

        const results = [];
        for (const comp of args.components) {
          const className = String(comp.name || '').trim();
          if (!className) continue;
          const baseClass = String(comp.baseClass || 'Component');
          const props = Array.isArray(comp.properties) ? comp.properties : [];

          const needsVec3 = props.some((p) => p.type === 'Vec3');
          const needsNode = props.some((p) => p.type === 'Node');

          const imports = [
            "import { _decorator, Component } from 'cc';",
            needsVec3 ? "import { Vec3 } from 'cc';" : null,
            needsNode ? "import { Node } from 'cc';" : null,
          ].filter(Boolean).join('\n');

          const decorators = props.map((p) => {
            const defaultVal = p.default !== undefined ? ` = ${p.default}` : '';
            return `  @property\n  ${p.name}${defaultVal}: ${p.type};`;
          }).join('\n\n');

          const content = [
            `// Auto-generated component scaffold`,
            imports,
            `const { ccclass, property } = _decorator;`,
            ``,
            `@ccclass('${className}')`,
            `export class ${className} extends ${baseClass} {`,
            decorators ? `\n${decorators}\n` : '',
            `  onLoad() {`,
            `    // Initialization`,
            `  }`,
            ``,
            `  update(deltaTime: number) {`,
            `    // Per-frame logic`,
            `  }`,
            `}`,
            '',
          ].join('\n');

          const filePath = path.join(outDir, `${className}.ts`);
          writeFileSafe(filePath, content);
          results.push({ name: className, path: filePath });
        }

        return {
          generated: true,
          outputDir: outDir,
          componentCount: results.length,
          components: results,
          summary: `Generated ${results.length} component script scaffolds.`,
        };
      },
    },

    {
      name: 'generate_state_machine',
      profile: 'core',
      category: 'generator',
      description: 'Generate a TypeScript finite state machine implementation. Produces a state enum, transition table, and a StateMachine class with enter/exit/update hooks.',
      inputSchema: createSchema({
        name: {
          type: 'string',
          description: 'State machine name (e.g. PlayerFSM, EnemyAI).',
        },
        states: {
          type: 'array',
          description: 'List of state names.',
          items: { type: 'string' },
        },
        transitions: {
          type: 'array',
          description: 'Transition rules: { from, to, trigger }.',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
              trigger: { type: 'string' },
            },
            required: ['from', 'to', 'trigger'],
          },
        },
        outputDir: {
          type: 'string',
          description: 'Project-relative directory. Default: assets/scripts/fsm.',
        },
      }, ['name', 'states']),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        const generators = runtimeContext.generators;
        if (generators && typeof generators.generate_state_machine === 'function') {
          return await generators.generate_state_machine(args);
        }

        // Inline fallback
        const outDir = ensureProjectPath(runtimeContext, args.outputDir || 'assets/scripts/fsm');
        fs.mkdirSync(outDir, { recursive: true });

        const fsmName = String(args.name || 'StateMachine');
        const states = Array.isArray(args.states) ? args.states : [];
        const transitions = Array.isArray(args.transitions) ? args.transitions : [];

        // Generate state enum
        const enumEntries = states.map((s) => `  ${s} = '${s}',`).join('\n');
        const enumCode = `export enum ${fsmName}State {\n${enumEntries}\n}`;

        // Generate transition table
        const transitionMap = {};
        for (const t of transitions) {
          const key = `${t.from}:${t.trigger}`;
          transitionMap[key] = t.to;
        }
        const transitionEntries = Object.entries(transitionMap)
          .map(([k, v]) => `  '${k}': ${fsmName}State.${v},`)
          .join('\n');
        const transitionCode = `const transitionTable: Record<string, ${fsmName}State> = {\n${transitionEntries}\n};`;

        // State machine class
        const className = `${fsmName}`;
        const classCode = [
          `export interface StateHooks {`,
          `  enter?: () => void;`,
          `  exit?: () => void;`,
          `  update?: (dt: number) => void;`,
          `}`,
          ``,
          `export class ${className} {`,
          `  private _current: ${fsmName}State;`,
          `  private _hooks: Record<string, StateHooks> = {};`,
          ``,
          `  constructor(initialState: ${fsmName}State) {`,
          `    this._current = initialState;`,
          `  }`,
          ``,
          `  get current(): ${fsmName}State { return this._current; }`,
          ``,
          `  registerHooks(state: ${fsmName}State, hooks: StateHooks): void {`,
          `    this._hooks[state] = hooks;`,
          `  }`,
          ``,
          `  trigger(event: string): boolean {`,
          `    const key = \`\${this._current}:\${event}\`;`,
          `    const next = transitionTable[key];`,
          `    if (!next) return false;`,
          `    this.transitionTo(next);`,
          `    return true;`,
          `  }`,
          ``,
          `  transitionTo(next: ${fsmName}State): void {`,
          `    const prev = this._hooks[this._current];`,
          `    if (prev && prev.exit) prev.exit();`,
          `    this._current = next;`,
          `    const incoming = this._hooks[next];`,
          `    if (incoming && incoming.enter) incoming.enter();`,
          `  }`,
          ``,
          `  update(dt: number): void {`,
          `    const hooks = this._hooks[this._current];`,
          `    if (hooks && hooks.update) hooks.update(dt);`,
          `  }`,
          `}`,
        ].join('\n');

        const filePath = path.join(outDir, `${className}.ts`);
        const content = [
          `// Auto-generated state machine: ${fsmName}`,
          `// States: ${states.join(', ')}`,
          ``,
          enumCode,
          ``,
          transitionCode,
          ``,
          classCode,
          '',
        ].join('\n');
        writeFileSafe(filePath, content);

        return {
          generated: true,
          fsmName: className,
          stateCount: states.length,
          transitionCount: transitions.length,
          path: filePath,
          summary: `Generated state machine "${className}" with ${states.length} states and ${transitions.length} transitions.`,
        };
      },
    },

    // ========================================================================
    // SCENE BUILDER TOOLS (Channel B — compose sceneBridge calls)
    // ========================================================================

    {
      name: 'build_scene_from_config',
      profile: 'core',
      category: 'scene-builder',
      description: 'Build a complete scene hierarchy from a level configuration JSON file. Reads the config, then creates nodes for each area, spawn point, checkpoint, and decoration defined in the config by composing multiple sceneBridge calls.',
      inputSchema: createSchema({
        configPath: {
          type: 'string',
          description: 'Project-relative path to the level config JSON file.',
        },
        clearExisting: {
          type: 'boolean',
          description: 'When true, delete all existing child nodes before building. Default false.',
        },
        sceneName: {
          type: 'string',
          description: 'Optional scene root name override.',
        },
      }, ['configPath']),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        const configPath = ensureProjectPath(runtimeContext, args.configPath);
        if (!fs.existsSync(configPath)) {
          throw new Error(`Level config not found: ${configPath}`);
        }

        const config = readJsonFile(configPath);
        const created = [];
        const errors = [];

        // Optionally clear existing children
        if (args.clearExisting) {
          const info = await sceneBridge.call('getSceneInfo', { maxDepth: 1, includeComponents: false });
          for (const node of (info.nodes || [])) {
            try {
              await sceneBridge.call('deleteNode', { uuid: node.uuid });
            } catch (e) {
              errors.push({ node: node.name, error: e.message });
            }
          }
        }

        // Create area containers
        const areas = Array.isArray(config.areas) ? config.areas : [];
        for (const area of areas) {
          try {
            const areaNode = await sceneBridge.call('createNode', {
              name: area.name || 'Area',
              position: area.position || null,
            });
            created.push({ type: 'area', ...areaNode });

            // Spawn points within the area
            const spawns = Array.isArray(area.spawns) ? area.spawns : [];
            for (const spawn of spawns) {
              const spawnNode = await sceneBridge.call('createNode', {
                name: spawn.name || 'SpawnPoint',
                parentPath: areaNode.path,
                position: spawn.position || null,
              });
              created.push({ type: 'spawn', ...spawnNode });
            }

            // Decorations within the area
            const decorations = Array.isArray(area.decorations) ? area.decorations : [];
            for (const deco of decorations) {
              const decoNode = await sceneBridge.call('createNode', {
                name: deco.name || 'Decoration',
                parentPath: areaNode.path,
                position: deco.position || null,
                scale: deco.scale || null,
              });
              created.push({ type: 'decoration', ...decoNode });

              if (deco.spriteFrameUuid) {
                await sceneBridge.call('createSprite', {
                  name: `${deco.name || 'Decoration'}_Sprite`,
                  parentPath: decoNode.path,
                  spriteFrameUuid: deco.spriteFrameUuid,
                });
              }
            }
          } catch (e) {
            errors.push({ area: area.name, error: e.message });
          }
        }

        // Checkpoints (top-level)
        const checkpoints = Array.isArray(config.checkpoints) ? config.checkpoints : [];
        for (const cp of checkpoints) {
          try {
            const cpNode = await sceneBridge.call('createNode', {
              name: cp.name || 'Checkpoint',
              position: cp.position || null,
            });
            created.push({ type: 'checkpoint', ...cpNode });
          } catch (e) {
            errors.push({ checkpoint: cp.name, error: e.message });
          }
        }

        // Camera setup
        if (config.camera) {
          try {
            await sceneBridge.call('createCamera', {
              name: config.camera.name || 'MainCamera',
              position: config.camera.position || { x: 0, y: 0, z: 10 },
              priority: config.camera.priority || 1,
            });
            created.push({ type: 'camera', name: config.camera.name || 'MainCamera' });
          } catch (e) {
            errors.push({ camera: config.camera.name, error: e.message });
          }
        }

        return {
          built: true,
          configPath,
          sceneName: args.sceneName || config.sceneName || 'Scene',
          nodeCount: created.length,
          nodes: created,
          errorCount: errors.length,
          errors,
          summary: `Built scene with ${created.length} nodes from ${configPath}. ${errors.length} error(s).`,
        };
      },
    },

    {
      name: 'build_ui_layout',
      profile: 'core',
      category: 'scene-builder',
      description: 'Build a UI hierarchy from a layout definition. Creates a Canvas root, then recursively creates child nodes (buttons, labels, sprites, containers) with appropriate components attached.',
      inputSchema: createSchema({
        layout: {
          type: 'object',
          description: 'UI layout tree. Root node with name, type, children[], and component-specific properties.',
        },
        canvasWidth: {
          type: 'number',
          description: 'Canvas width. Default 1280.',
        },
        canvasHeight: {
          type: 'number',
          description: 'Canvas height. Default 720.',
        },
        parentPath: {
          type: 'string',
          description: 'Parent path for the Canvas node. Default: scene root.',
        },
      }, ['layout']),
      handler: async (args) => {
        const layout = args.layout;
        if (!layout || typeof layout !== 'object') {
          throw new Error('layout must be an object describing the UI tree.');
        }

        const canvasW = Number.isFinite(args.canvasWidth) ? args.canvasWidth : 1280;
        const canvasH = Number.isFinite(args.canvasHeight) ? args.canvasHeight : 720;
        const created = [];

        // Create canvas root
        const canvasResult = await sceneBridge.call('createCanvas', {
          name: layout.name || 'UICanvas',
          parentPath: args.parentPath || undefined,
          width: canvasW,
          height: canvasH,
        });
        created.push({ type: 'canvas', ...canvasResult });
        const canvasPath = canvasResult.path;

        // Recursive builder
        async function buildChildren(parentPath, children) {
          if (!Array.isArray(children)) return;

          for (const child of children) {
            const childType = String(child.type || 'node').toLowerCase();
            let result;

            try {
              switch (childType) {
                case 'label':
                  result = await sceneBridge.call('createLabel', {
                    name: child.name || 'Label',
                    parentPath,
                    text: child.text || '',
                    fontSize: child.fontSize,
                    lineHeight: child.lineHeight,
                    color: child.color,
                    width: child.width,
                    height: child.height,
                    position: child.position,
                  });
                  break;

                case 'button':
                  result = await sceneBridge.call('createButton', {
                    name: child.name || 'Button',
                    parentPath,
                    text: child.text || 'Button',
                    width: child.width,
                    height: child.height,
                    fontSize: child.fontSize,
                    backgroundColor: child.backgroundColor,
                    textColor: child.textColor,
                    position: child.position,
                  });
                  break;

                case 'sprite':
                  result = await sceneBridge.call('createSprite', {
                    name: child.name || 'Sprite',
                    parentPath,
                    spriteFrameUuid: child.spriteFrameUuid,
                    color: child.color,
                    width: child.width,
                    height: child.height,
                    position: child.position,
                  });
                  break;

                default:
                  // Generic container node
                  result = await sceneBridge.call('createNode', {
                    name: child.name || 'Node',
                    parentPath,
                    position: child.position,
                    scale: child.scale,
                  });
                  break;
              }

              created.push({ type: childType, ...result });

              // Recurse into children
              if (Array.isArray(child.children) && child.children.length > 0) {
                await buildChildren(result.path, child.children);
              }
            } catch (e) {
              created.push({ type: childType, name: child.name, error: e.message });
            }
          }
        }

        await buildChildren(canvasPath, layout.children);

        return {
          built: true,
          canvasPath,
          canvasSize: { width: canvasW, height: canvasH },
          nodeCount: created.length,
          nodes: created,
          summary: `Built UI layout with ${created.length} nodes under ${canvasPath}.`,
        };
      },
    },

    {
      name: 'build_combat_setup',
      profile: 'core',
      category: 'scene-builder',
      description: 'Set up a combat scene with arena bounds, player/enemy spawn points, a combat camera, and a HUD canvas with health bar, score label, and action buttons.',
      inputSchema: createSchema({
        arenaWidth: { type: 'number', description: 'Arena width. Default 1920.' },
        arenaHeight: { type: 'number', description: 'Arena height. Default 1080.' },
        playerSpawns: {
          type: 'array',
          description: 'Player spawn positions [{name, position}].',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
            },
            required: ['name'],
          },
        },
        enemySpawns: {
          type: 'array',
          description: 'Enemy spawn positions [{name, position}].',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
            },
            required: ['name'],
          },
        },
        hudElements: {
          type: 'array',
          description: 'HUD element definitions [{type: "healthBar"|"score"|"button", name, text}].',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              name: { type: 'string' },
              text: { type: 'string' },
            },
            required: ['type', 'name'],
          },
        },
      }, []),
      handler: async (args) => {
        const arenaW = Number.isFinite(args.arenaWidth) ? args.arenaWidth : 1920;
        const arenaH = Number.isFinite(args.arenaHeight) ? args.arenaHeight : 1080;
        const created = [];

        // Arena bounds node
        const arena = await sceneBridge.call('createNode', { name: 'Arena', position: { x: 0, y: 0, z: 0 } });
        created.push({ type: 'arena', ...arena });

        // Arena floor sprite
        await sceneBridge.call('createSprite', {
          name: 'ArenaFloor',
          parentPath: arena.path,
          width: arenaW,
          height: arenaH,
        });
        created.push({ type: 'sprite', name: 'ArenaFloor' });

        // Player spawn points
        const playerSpawns = Array.isArray(args.playerSpawns) ? args.playerSpawns : [{ name: 'PlayerSpawn', position: { x: -400, y: 0, z: 0 } }];
        for (const spawn of playerSpawns) {
          const node = await sceneBridge.call('createNode', {
            name: spawn.name || 'PlayerSpawn',
            parentPath: arena.path,
            position: spawn.position || null,
          });
          created.push({ type: 'playerSpawn', ...node });
        }

        // Enemy spawn points
        const enemySpawns = Array.isArray(args.enemySpawns) ? args.enemySpawns : [{ name: 'EnemySpawn', position: { x: 400, y: 0, z: 0 } }];
        for (const spawn of enemySpawns) {
          const node = await sceneBridge.call('createNode', {
            name: spawn.name || 'EnemySpawn',
            parentPath: arena.path,
            position: spawn.position || null,
          });
          created.push({ type: 'enemySpawn', ...node });
        }

        // Combat camera
        const cam = await sceneBridge.call('createCamera', {
          name: 'CombatCamera',
          position: { x: 0, y: 0, z: 10 },
          priority: 10,
        });
        created.push({ type: 'camera', ...cam });

        // HUD canvas
        const hud = await sceneBridge.call('createCanvas', {
          name: 'HUD',
          width: arenaW,
          height: arenaH,
        });
        created.push({ type: 'canvas', ...hud });

        // HUD elements
        const hudElements = Array.isArray(args.hudElements) ? args.hudElements : [
          { type: 'healthBar', name: 'HealthBar' },
          { type: 'score', name: 'ScoreLabel', text: 'Score: 0' },
        ];

        for (const elem of hudElements) {
          const elemType = String(elem.type || '').toLowerCase();
          try {
            let result;
            if (elemType === 'button' || elemType === 'actionbutton') {
              result = await sceneBridge.call('createButton', {
                name: elem.name || 'ActionButton',
                parentPath: hud.path,
                text: elem.text || 'Action',
                position: elem.position || null,
              });
            } else {
              // Label for score, health bar text, etc.
              result = await sceneBridge.call('createLabel', {
                name: elem.name || 'Label',
                parentPath: hud.path,
                text: elem.text || elem.name || '',
                fontSize: elem.fontSize || 24,
                position: elem.position || null,
              });
            }
            created.push({ type: elemType, ...result });
          } catch (e) {
            created.push({ type: elemType, name: elem.name, error: e.message });
          }
        }

        return {
          built: true,
          arenaSize: { width: arenaW, height: arenaH },
          nodeCount: created.length,
          nodes: created,
          summary: `Built combat setup with ${created.length} nodes (arena + spawns + camera + HUD).`,
        };
      },
    },

    {
      name: 'populate_level_enemies',
      profile: 'core',
      category: 'scene-builder',
      description: 'Populate a level with enemy nodes from a configuration file. Creates enemy container nodes with patrol paths (waypoint children) and optional component attachments.',
      inputSchema: createSchema({
        configPath: {
          type: 'string',
          description: 'Project-relative path to the enemy config JSON.',
        },
        parentPath: {
          type: 'string',
          description: 'Scene path to the parent node under which enemies are placed. Default: scene root.',
        },
        enemies: {
          type: 'array',
          description: 'Inline enemy definitions (used when configPath is not provided).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
              patrolPath: {
                type: 'array',
                items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
                description: 'Waypoint positions for patrol movement.',
              },
              components: { type: 'array', items: { type: 'string' }, description: 'Component class names to attach.' },
            },
            required: ['name'],
          },
        },
      }, []),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        let enemyList;

        if (args.configPath) {
          const configPath = ensureProjectPath(runtimeContext, args.configPath);
          if (!fs.existsSync(configPath)) {
            throw new Error(`Enemy config not found: ${configPath}`);
          }
          const config = readJsonFile(configPath);
          enemyList = Array.isArray(config.enemies) ? config.enemies : [];
        } else if (Array.isArray(args.enemies)) {
          enemyList = args.enemies;
        } else {
          throw new Error('Provide either configPath or enemies array.');
        }

        const parentPath = args.parentPath || undefined;
        const created = [];
        const errors = [];

        // Create enemy container
        const container = await sceneBridge.call('createNode', {
          name: 'EnemyContainer',
          parentPath,
        });
        created.push({ type: 'container', ...container });

        for (const enemy of enemyList) {
          try {
            // Create enemy node
            const enemyNode = await sceneBridge.call('createNode', {
              name: enemy.name || 'Enemy',
              parentPath: container.path,
              position: enemy.position || null,
            });
            created.push({ type: 'enemy', ...enemyNode });

            // Create patrol waypoints
            const waypoints = Array.isArray(enemy.patrolPath) ? enemy.patrolPath : [];
            if (waypoints.length > 0) {
              const patrolParent = await sceneBridge.call('createNode', {
                name: 'PatrolPath',
                parentPath: enemyNode.path,
              });

              for (let i = 0; i < waypoints.length; i++) {
                await sceneBridge.call('createNode', {
                  name: `Waypoint_${i}`,
                  parentPath: patrolParent.path,
                  position: waypoints[i],
                });
              }
            }

            // Attach components
            const components = Array.isArray(enemy.components) ? enemy.components : [];
            for (const compName of components) {
              try {
                await sceneBridge.call('addComponent', {
                  uuid: enemyNode.uuid,
                  componentName: compName,
                });
              } catch (e) {
                errors.push({ enemy: enemy.name, component: compName, error: e.message });
              }
            }
          } catch (e) {
            errors.push({ enemy: enemy.name, error: e.message });
          }
        }

        return {
          populated: true,
          enemyCount: enemyList.length,
          nodeCount: created.length,
          nodes: created,
          errorCount: errors.length,
          errors,
          summary: `Populated ${enemyList.length} enemies with ${created.length} nodes. ${errors.length} error(s).`,
        };
      },
    },

    // ========================================================================
    // RESOURCE MANAGEMENT TOOLS (Channel B)
    // ========================================================================

    {
      name: 'import_and_organize_assets',
      profile: 'core',
      category: 'resources',
      description: 'Import assets from a source directory into the Cocos project, applying naming conventions and organizing them into the correct subdirectories (sprites/, audio/, prefabs/, etc.).',
      inputSchema: createSchema({
        sourceDir: {
          type: 'string',
          description: 'Absolute or project-relative source directory containing assets to import.',
        },
        targetDir: {
          type: 'string',
          description: 'Project-relative target directory. Default: assets/resources.',
        },
        namingConvention: {
          type: 'string',
          description: 'Naming pattern: snake_case, camelCase, or kebab-case. Default: snake_case.',
        },
        dryRun: {
          type: 'boolean',
          description: 'When true, report what would happen without moving files. Default false.',
        },
      }, ['sourceDir']),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        const sourceDir = ensureProjectPath(runtimeContext, args.sourceDir);
        if (!fs.existsSync(sourceDir)) {
          throw new Error(`Source directory not found: ${sourceDir}`);
        }

        const targetDir = ensureProjectPath(runtimeContext, args.targetDir || 'assets/resources');
        const namingConvention = String(args.namingConvention || 'snake_case').toLowerCase();
        const dryRun = args.dryRun === true;

        // Classify files by extension into subdirectories
        const EXTENSION_MAP = {
          '.png': 'sprites', '.jpg': 'sprites', '.jpeg': 'sprites', '.webp': 'sprites', '.svg': 'sprites',
          '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.flac': 'audio',
          '.prefab': 'prefabs',
          '.anim': 'animations', '.json': 'configs',
          '.ttf': 'fonts', '.otf': 'fonts', '.fnt': 'fonts',
        };

        function normalizeFilename(name) {
          const ext = path.extname(name);
          const base = path.basename(name, ext);
          let normalized = base;
          if (namingConvention === 'snake_case') {
            normalized = base.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase();
          } else if (namingConvention === 'camelCase') {
            normalized = base.replace(/[-_\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : '');
          } else if (namingConvention === 'kebab-case') {
            normalized = base.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase();
          }
          return normalized + ext;
        }

        const files = fs.readdirSync(sourceDir);
        const imported = [];
        const skipped = [];
        const warnings = [];

        for (const file of files) {
          const srcPath = path.join(sourceDir, file);
          if (!fs.statSync(srcPath).isFile()) continue;

          const ext = path.extname(file).toLowerCase();
          const subDir = EXTENSION_MAP[ext] || 'misc';
          const normalized = normalizeFilename(file);
          const destDir = path.join(targetDir, subDir);
          const destPath = path.join(destDir, normalized);

          if (normalized !== file) {
            warnings.push({ original: file, renamed: normalized, reason: `Applied ${namingConvention}` });
          }

          if (dryRun) {
            imported.push({ source: srcPath, destination: destPath, renamed: normalized !== file });
          } else {
            fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(srcPath, destPath);
            imported.push({ source: srcPath, destination: destPath, renamed: normalized !== file });
          }
        }

        return {
          imported: !dryRun,
          dryRun,
          fileCount: imported.length,
          files: imported,
          skippedCount: skipped.length,
          skipped,
          warningCount: warnings.length,
          warnings,
          summary: `${dryRun ? 'Would import' : 'Imported'} ${imported.length} assets into ${targetDir}. ${warnings.length} naming warning(s).`,
        };
      },
    },

    {
      name: 'validate_asset_references',
      profile: 'core',
      category: 'resources',
      description: 'Scan the project for broken or orphan asset references. Checks that all referenced assets exist and reports unused (orphan) assets.',
      inputSchema: createSchema({
        scanDir: {
          type: 'string',
          description: 'Project-relative directory to scan. Default: assets.',
        },
        checkBroken: {
          type: 'boolean',
          description: 'Check for references to non-existent assets. Default true.',
        },
        checkOrphans: {
          type: 'boolean',
          description: 'Check for assets not referenced by any file. Default true.',
        },
      }, []),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        const scanDir = ensureProjectPath(runtimeContext, args.scanDir || 'assets');
        if (!fs.existsSync(scanDir)) {
          throw new Error(`Scan directory not found: ${scanDir}`);
        }

        const checkBroken = args.checkBroken !== false;
        const checkOrphans = args.checkOrphans !== false;

        const allFiles = [];
        const allRefs = new Map(); // file -> set of referenced uuids/paths

        // Walk the directory tree
        function walkDir(dir) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walkDir(fullPath);
            } else if (entry.isFile()) {
              allFiles.push(fullPath);
            }
          }
        }
        walkDir(scanDir);

        const assetFiles = new Set();
        const referencingFiles = new Set();
        const brokenRefs = [];
        const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
        const dbRefPattern = /db:\/\/[^\s"']+/g;

        // Collect all asset files and scan for references
        for (const filePath of allFiles) {
          const ext = path.extname(filePath).toLowerCase();
          if (ext === '.meta') continue; // skip meta files for asset collection
          assetFiles.add(filePath);

          if (ext === '.json' || ext === '.scene' || ext === '.prefab' || ext === '.ts' || ext === '.js') {
            referencingFiles.add(filePath);
            try {
              const content = fs.readFileSync(filePath, 'utf-8');
              const uuidMatches = content.match(uuidPattern) || [];
              const dbMatches = content.match(dbRefPattern) || [];
              const refs = new Set([...uuidMatches, ...dbMatches]);
              allRefs.set(filePath, refs);
            } catch (e) {
              // Skip unreadable files
            }
          }
        }

        // Check broken references
        if (checkBroken) {
          const knownUuids = new Set();
          for (const filePath of allFiles) {
            if (path.extname(filePath) === '.meta') {
              try {
                const meta = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                if (meta.uuid) knownUuids.add(meta.uuid);
              } catch (e) { /* skip */ }
            }
          }

          for (const [filePath, refs] of allRefs.entries()) {
            for (const ref of refs) {
              if (ref.startsWith('db://')) continue; // skip db:// for broken check
              if (!knownUuids.has(ref)) {
                brokenRefs.push({ file: filePath, reference: ref });
              }
            }
          }
        }

        // Check orphans — assets not referenced by any .scene/.prefab/.json
        const orphanedAssets = [];
        if (checkOrphans) {
          const allReferencedUuids = new Set();
          for (const refs of allRefs.values()) {
            for (const ref of refs) {
              allReferencedUuids.add(ref);
            }
          }

          for (const filePath of assetFiles) {
            const relPath = path.relative(scanDir, filePath);
            const isReferenced = Array.from(allReferencedUuids).some((ref) => {
              return filePath.includes(ref) || relPath.includes(ref);
            });
            if (!isReferenced) {
              const ext = path.extname(filePath).toLowerCase();
              if (['.png', '.jpg', '.mp3', '.wav', '.prefab', '.ttf'].includes(ext)) {
                orphanedAssets.push(filePath);
              }
            }
          }
        }

        return {
          scanned: true,
          scanDir,
          totalFiles: allFiles.length,
          brokenRefCount: brokenRefs.length,
          brokenRefs: brokenRefs.slice(0, 100),
          orphanCount: orphanedAssets.length,
          orphanedAssets: orphanedAssets.slice(0, 100),
          summary: `Scanned ${allFiles.length} files. ${brokenRefs.length} broken ref(s), ${orphanedAssets.length} orphan(s).`,
        };
      },
    },

    {
      name: 'apply_naming_convention',
      profile: 'core',
      category: 'resources',
      description: 'Rename asset files in a directory to match a specified naming convention (snake_case, camelCase, kebab-case). Reports all renames and can run as a dry run.',
      inputSchema: createSchema({
        targetDir: {
          type: 'string',
          description: 'Project-relative directory of assets to rename.',
        },
        convention: {
          type: 'string',
          description: 'Target convention: snake_case, camelCase, or kebab-case.',
        },
        extensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only rename files with these extensions (e.g. [".png",".jpg"]). All files if omitted.',
        },
        recursive: {
          type: 'boolean',
          description: 'Rename files in subdirectories. Default true.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview renames without applying. Default false.',
        },
      }, ['targetDir', 'convention']),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        const targetDir = ensureProjectPath(runtimeContext, args.targetDir);
        if (!fs.existsSync(targetDir)) {
          throw new Error(`Directory not found: ${targetDir}`);
        }

        const convention = String(args.convention || 'snake_case').toLowerCase();
        const extensions = Array.isArray(args.extensions) ? args.extensions.map((e) => e.toLowerCase()) : null;
        const recursive = args.recursive !== false;
        const dryRun = args.dryRun === true;

        function normalizeName(name) {
          const ext = path.extname(name);
          const base = path.basename(name, ext);
          let normalized;
          if (convention === 'snake_case') {
            normalized = base.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase();
          } else if (convention === 'camelCase') {
            normalized = base.replace(/[-_\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : '');
          } else if (convention === 'kebab-case') {
            normalized = base.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase();
          } else {
            normalized = base;
          }
          return normalized + ext;
        }

        const renames = [];

        function processDir(dir) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory() && recursive) {
              processDir(fullPath);
              continue;
            }
            if (!entry.isFile()) continue;
            if (entry.name.endsWith('.meta')) continue; // skip meta files

            const ext = path.extname(entry.name).toLowerCase();
            if (extensions && !extensions.includes(ext)) continue;

            const newName = normalizeName(entry.name);
            if (newName !== entry.name) {
              const newPath = path.join(dir, newName);
              renames.push({ from: fullPath, to: newPath, fromName: entry.name, toName: newName });
            }
          }
        }

        processDir(targetDir);

        if (!dryRun) {
          for (const rename of renames) {
            fs.renameSync(rename.from, rename.to);
            // Rename corresponding .meta file if it exists
            const metaFrom = rename.from + '.meta';
            const metaTo = rename.to + '.meta';
            if (fs.existsSync(metaFrom)) {
              fs.renameSync(metaFrom, metaTo);
            }
          }
        }

        return {
          applied: !dryRun,
          dryRun,
          renameCount: renames.length,
          renames: renames.map((r) => ({ from: r.fromName, to: r.toName })),
          summary: `${dryRun ? 'Would rename' : 'Renamed'} ${renames.length} asset(s) to ${convention}.`,
        };
      },
    },

    // ========================================================================
    // DIAGNOSTICS TOOLS (Channel B)
    // ========================================================================

    {
      name: 'check_config_consistency',
      profile: 'core',
      category: 'diagnostics',
      description: 'Validate all JSON config files in the project against the GDD schema. Reports missing fields, type mismatches, and cross-reference inconsistencies.',
      inputSchema: createSchema({
        schemaPath: {
          type: 'string',
          description: 'Project-relative path to the GDD schema JSON.',
        },
        configDir: {
          type: 'string',
          description: 'Project-relative directory containing config files. Default: assets/configs.',
        },
        strictMode: {
          type: 'boolean',
          description: 'Report warnings as errors. Default false.',
        },
      }, ['schemaPath']),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        const schemaPath = ensureProjectPath(runtimeContext, args.schemaPath);
        if (!fs.existsSync(schemaPath)) {
          throw new Error(`Schema file not found: ${schemaPath}`);
        }

        const configDir = ensureProjectPath(runtimeContext, args.configDir || 'assets/configs');
        const schema = readJsonFile(schemaPath);
        const strictMode = args.strictMode === true;
        const issues = [];
        const checked = [];

        if (!fs.existsSync(configDir)) {
          return {
            checked: true,
            configDir,
            fileCount: 0,
            issues: [],
            summary: `Config directory does not exist: ${configDir}`,
          };
        }

        const configFiles = fs.readdirSync(configDir)
          .filter((f) => f.endsWith('.json') && !f.endsWith('.interface.ts'))
          .map((f) => path.join(configDir, f));

        for (const configFile of configFiles) {
          const sectionName = path.basename(configFile, '.json');
          checked.push({ file: configFile, section: sectionName });

          try {
            const config = readJsonFile(configFile);
            const schemaDef = schema[sectionName];

            if (!schemaDef) {
              issues.push({
                severity: 'warning',
                file: configFile,
                section: sectionName,
                issue: 'No matching schema section found.',
              });
              continue;
            }

            if (typeof schemaDef === 'object' && schemaDef !== null && !Array.isArray(schemaDef)) {
              // Check for missing required fields
              for (const [key, expectedType] of Object.entries(schemaDef)) {
                if (!(key in config)) {
                  issues.push({
                    severity: strictMode ? 'error' : 'warning',
                    file: configFile,
                    section: sectionName,
                    field: key,
                    issue: `Missing field "${key}".`,
                  });
                } else if (typeof expectedType !== 'object') {
                  const expected = typeof expectedType;
                  const actual = typeof config[key];
                  if (expected !== actual) {
                    issues.push({
                      severity: 'error',
                      file: configFile,
                      section: sectionName,
                      field: key,
                      issue: `Type mismatch: expected ${expected}, got ${actual}.`,
                    });
                  }
                }
              }

              // Check for extra fields not in schema
              for (const key of Object.keys(config)) {
                if (!(key in schemaDef)) {
                  issues.push({
                    severity: 'info',
                    file: configFile,
                    section: sectionName,
                    field: key,
                    issue: `Extra field not in schema.`,
                  });
                }
              }
            }
          } catch (e) {
            issues.push({
              severity: 'error',
              file: configFile,
              section: sectionName,
              issue: `Parse error: ${e.message}`,
            });
          }
        }

        const errorCount = issues.filter((i) => i.severity === 'error').length;
        const warningCount = issues.filter((i) => i.severity === 'warning').length;

        return {
          checked: true,
          schemaPath,
          configDir,
          fileCount: checked.length,
          files: checked,
          issueCount: issues.length,
          errorCount,
          warningCount,
          issues: issues.slice(0, 200),
          summary: `Validated ${checked.length} config(s): ${errorCount} error(s), ${warningCount} warning(s).`,
        };
      },
    },

    {
      name: 'audit_project_health',
      profile: 'core',
      category: 'diagnostics',
      description: 'Run a full project health check covering directory structure, asset inventory, scene graph stats, script compilation hints, and config consistency.',
      inputSchema: createSchema({
        checks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific checks to run: "structure", "assets", "scene", "scripts", "configs". Runs all by default.',
        },
        configSchemaPath: {
          type: 'string',
          description: 'Optional GDD schema path for config consistency check.',
        },
      }, []),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        const projectPath = runtimeContext.projectPath;
        if (!projectPath) {
          throw new Error('No Cocos project is currently open.');
        }

        const requested = Array.isArray(args.checks) && args.checks.length > 0
          ? args.checks.map((c) => c.toLowerCase())
          : ['structure', 'assets', 'scene', 'scripts', 'configs'];

        const report = { checks: [], warnings: [], errors: [] };

        // Structure check
        if (requested.includes('structure')) {
          const expectedDirs = ['assets', 'assets/scripts', 'assets/scenes'];
          const structureResult = { name: 'structure', passed: true, details: [] };
          for (const dir of expectedDirs) {
            const fullPath = path.join(projectPath, dir);
            const exists = fs.existsSync(fullPath);
            structureResult.details.push({ dir, exists });
            if (!exists) {
              structureResult.passed = false;
              report.warnings.push(`Missing directory: ${dir}`);
            }
          }
          report.checks.push(structureResult);
        }

        // Asset inventory check
        if (requested.includes('assets')) {
          const assetsDir = path.join(projectPath, 'assets');
          const assetResult = { name: 'assets', passed: true, counts: {}, total: 0 };
          if (fs.existsSync(assetsDir)) {
            const EXT_MAP = { '.png': 'images', '.jpg': 'images', '.ts': 'scripts', '.js': 'scripts', '.json': 'configs', '.prefab': 'prefabs', '.scene': 'scenes' };
            function countAssets(dir) {
              try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.isDirectory()) { countAssets(path.join(dir, entry.name)); continue; }
                  if (entry.name.endsWith('.meta')) continue;
                  const ext = path.extname(entry.name).toLowerCase();
                  const category = EXT_MAP[ext] || 'other';
                  assetResult.counts[category] = (assetResult.counts[category] || 0) + 1;
                  assetResult.total += 1;
                }
              } catch (e) { /* skip */ }
            }
            countAssets(assetsDir);
          } else {
            assetResult.passed = false;
            report.errors.push('assets/ directory does not exist.');
          }
          report.checks.push(assetResult);
        }

        // Scene graph check (via sceneBridge)
        if (requested.includes('scene')) {
          try {
            const sceneInfo = await sceneBridge.call('getSceneInfo', { maxDepth: 2, includeComponents: true });
            const perf = await sceneBridge.call('getPerformanceSnapshot', {});
            report.checks.push({
              name: 'scene',
              passed: true,
              sceneName: sceneInfo.sceneName,
              childCount: sceneInfo.childCount,
              stats: perf.stats || null,
              warnings: perf.warnings || [],
            });
            if (perf.warnings && perf.warnings.length > 0) {
              for (const w of perf.warnings) {
                report.warnings.push(`Scene: ${w.message}`);
              }
            }
          } catch (e) {
            report.checks.push({ name: 'scene', passed: false, error: e.message });
            report.warnings.push(`Scene check failed: ${e.message}`);
          }
        }

        // Script check (count .ts/.js files, check for syntax issues via basic scan)
        if (requested.includes('scripts')) {
          const scriptsDir = path.join(projectPath, 'assets/scripts');
          const scriptResult = { name: 'scripts', passed: true, count: 0, issues: [] };
          if (fs.existsSync(scriptsDir)) {
            function countScripts(dir) {
              try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.isDirectory()) { countScripts(path.join(dir, entry.name)); continue; }
                  const ext = path.extname(entry.name).toLowerCase();
                  if (ext === '.ts' || ext === '.js') {
                    scriptResult.count += 1;
                    // Basic syntax check: read file, look for common issues
                    try {
                      const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
                      if (content.includes('TODO') || content.includes('FIXME')) {
                        scriptResult.issues.push({ file: entry.name, issue: 'Contains TODO/FIXME markers.' });
                      }
                    } catch (e) { /* skip */ }
                  }
                }
              } catch (e) { /* skip */ }
            }
            countScripts(scriptsDir);
          } else {
            scriptResult.passed = false;
            scriptResult.issues.push({ file: 'assets/scripts', issue: 'Directory does not exist.' });
          }
          report.checks.push(scriptResult);
        }

        // Config consistency check
        if (requested.includes('configs') && args.configSchemaPath) {
          try {
            const schemaPath = ensureProjectPath(runtimeContext, args.configSchemaPath);
            if (fs.existsSync(schemaPath)) {
              const schema = readJsonFile(schemaPath);
              report.checks.push({ name: 'configs', passed: true, schemaLoaded: true, sections: Object.keys(schema) });
            } else {
              report.checks.push({ name: 'configs', passed: false, error: 'Schema file not found.' });
            }
          } catch (e) {
            report.checks.push({ name: 'configs', passed: false, error: e.message });
          }
        }

        const overallPassed = report.errors.length === 0 && report.checks.every((c) => c.passed);
        return {
          audited: true,
          projectPath,
          projectName: runtimeContext.projectName || path.basename(projectPath),
          passed: overallPassed,
          checkCount: report.checks.length,
          checks: report.checks,
          warningCount: report.warnings.length,
          warnings: report.warnings,
          errorCount: report.errors.length,
          errors: report.errors,
          summary: `Project health: ${overallPassed ? 'PASS' : 'FAIL'} (${report.checks.length} checks, ${report.warnings.length} warnings, ${report.errors.length} errors).`,
        };
      },
    },

    {
      name: 'inspect_scene_graph',
      profile: 'core',
      category: 'diagnostics',
      description: 'Analyze the current scene graph structure. Returns a hierarchical node tree with component info, depth statistics, and health warnings.',
      inputSchema: createSchema({
        maxDepth: {
          type: 'number',
          description: 'Maximum hierarchy depth to traverse. Default 5.',
        },
        includeComponents: {
          type: 'boolean',
          description: 'Include component names on each node. Default true.',
        },
        includeInactive: {
          type: 'boolean',
          description: 'Include inactive nodes. Default true.',
        },
        rootPath: {
          type: 'string',
          description: 'Optional root node path to scope the inspection.',
        },
        includeStats: {
          type: 'boolean',
          description: 'Include aggregate scene statistics. Default true.',
        },
      }, []),
      handler: async (args) => {
        const maxDepth = Number.isFinite(args.maxDepth) ? args.maxDepth : 5;
        const includeComponents = args.includeComponents !== false;
        const includeInactive = args.includeInactive !== false;

        // Get hierarchy
        const hierarchy = await sceneBridge.call('getHierarchy', {
          maxDepth,
          includeComponents,
          includeInactive,
          rootPath: args.rootPath || undefined,
        });

        // Get performance/stats snapshot
        let stats = null;
        let warnings = [];
        if (args.includeStats !== false) {
          try {
            const perf = await sceneBridge.call('getPerformanceSnapshot', {});
            stats = perf.stats || null;
            warnings = perf.warnings || [];
          } catch (e) {
            warnings.push({ severity: 'error', message: e.message });
          }
        }

        // Count nodes in hierarchy
        function countNodes(node) {
          let count = 1;
          if (Array.isArray(node.children)) {
            for (const child of node.children) {
              count += countNodes(child);
            }
          } else if (Number.isFinite(node.childCount)) {
            count += node.childCount;
          }
          return count;
        }

        let totalNodes = 0;
        if (Array.isArray(hierarchy.nodes)) {
          for (const node of hierarchy.nodes) {
            totalNodes += countNodes(node);
          }
        } else if (hierarchy.name) {
          totalNodes = countNodes(hierarchy);
        }

        return {
          inspected: true,
          sceneName: hierarchy.sceneName || hierarchy.name || 'unknown',
          totalNodes,
          maxDepth,
          hierarchy,
          stats,
          warningCount: warnings.length,
          warnings,
          summary: `Scene "${hierarchy.sceneName || hierarchy.name}": ${totalNodes} nodes, depth ${maxDepth}, ${warnings.length} warning(s).`,
        };
      },
    },

    // ========================================================================
    // EDITOR STATE TOOLS (Channel B)
    // ========================================================================

    {
      name: 'get_project_context',
      profile: 'core',
      category: 'editor-state',
      description: 'Get comprehensive project context including project info, editor state, current scene summary, tool profile, and available generators.',
      inputSchema: createSchema({
        includeSceneSummary: {
          type: 'boolean',
          description: 'Include a brief scene summary. Default true.',
        },
        includeFileSystem: {
          type: 'boolean',
          description: 'Include top-level project directory listing. Default true.',
        },
      }, []),
      handler: async (args) => {
        const runtimeContext = getRuntimeContext();
        const status = typeof getStatus === 'function' ? getStatus() : null;

        const context = {
          projectName: runtimeContext.projectName || null,
          projectPath: runtimeContext.projectPath || null,
          extensionName: runtimeContext.extensionName || null,
          version: runtimeContext.version || null,
          cocosVersion: runtimeContext.cocosVersion || null,
          toolProfile: runtimeContext.config ? runtimeContext.config.toolProfile : 'core',
          status,
        };

        // Generator availability
        const generators = runtimeContext.generators || {};
        context.generators = {
          available: Object.keys(generators).filter((k) => typeof generators[k] === 'function'),
        };

        // Scene summary
        if (args.includeSceneSummary !== false) {
          try {
            const sceneInfo = await sceneBridge.call('getSceneInfo', { maxDepth: 1, includeComponents: false });
            context.scene = {
              sceneName: sceneInfo.sceneName,
              uuid: sceneInfo.uuid,
              childCount: sceneInfo.childCount,
            };
          } catch (e) {
            context.scene = { error: e.message };
          }
        }

        // File system overview
        if (args.includeFileSystem !== false && runtimeContext.projectPath) {
          try {
            const entries = fs.readdirSync(runtimeContext.projectPath, { withFileTypes: true });
            context.fileSystem = entries.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? 'directory' : 'file',
            })).slice(0, 50);
          } catch (e) {
            context.fileSystem = { error: e.message };
          }
        }

        return {
          ...context,
          summary: `Project "${context.projectName}" (${context.version || 'unknown'}), scene: ${context.scene ? context.scene.sceneName || 'none' : 'N/A'}`,
        };
      },
    },

    {
      name: 'capture_scene_snapshot',
      profile: 'core',
      category: 'editor-state',
      description: 'Capture a fully serializable snapshot of the current scene state, including node hierarchy, component data, runtime state, and performance metrics.',
      inputSchema: createSchema({
        maxDepth: {
          type: 'number',
          description: 'Maximum hierarchy depth. Default 10.',
        },
        includeComponents: {
          type: 'boolean',
          description: 'Include detailed component data. Default true.',
        },
        includePerformance: {
          type: 'boolean',
          description: 'Include performance metrics. Default true.',
        },
        includeSerialized: {
          type: 'boolean',
          description: 'Include raw serialized scene content. Default false (can be very large).',
        },
      }, []),
      handler: async (args) => {
        const maxDepth = Number.isFinite(args.maxDepth) ? args.maxDepth : 10;
        const includeComponents = args.includeComponents !== false;

        // Scene info (hierarchy)
        const sceneInfo = await sceneBridge.call('getSceneInfo', {
          maxDepth,
          includeComponents,
        });

        // Runtime state
        let runtimeState = null;
        try {
          runtimeState = await sceneBridge.call('getRuntimeState', {});
        } catch (e) {
          runtimeState = { error: e.message };
        }

        // Performance snapshot
        let performance = null;
        if (args.includePerformance !== false) {
          try {
            performance = await sceneBridge.call('getPerformanceSnapshot', {});
          } catch (e) {
            performance = { error: e.message };
          }
        }

        // Serialized scene content
        let serializedContent = null;
        if (args.includeSerialized === true) {
          try {
            const serialized = await sceneBridge.call('serializeScene', { mode: 'current' });
            serializedContent = serialized.content || null;
          } catch (e) {
            serializedContent = { error: e.message };
          }
        }

        return {
          captured: true,
          timestamp: new Date().toISOString(),
          sceneName: sceneInfo.sceneName,
          sceneUuid: sceneInfo.uuid,
          childCount: sceneInfo.childCount,
          hierarchy: sceneInfo.nodes,
          runtime: runtimeState,
          performance,
          serializedScene: serializedContent ? '(included)' : '(omitted)',
          serializedContent,
          summary: `Snapshot of "${sceneInfo.sceneName}": ${sceneInfo.childCount} root children, ${runtimeState ? (runtimeState.paused ? 'paused' : 'running') : 'unknown'} runtime.`,
        };
      },
    },

    // ========================================================================
    // FALLBACK TOOL (Channel B)
    // ========================================================================

    {
      name: 'execute_script',
      profile: 'core',
      category: 'execution',
      description: 'Execute arbitrary JavaScript in the scene or editor context. Use as a fallback when no intent-level tool covers the needed operation. Includes safety checks for dangerous operations.',
      inputSchema: createSchema({
        context: {
          type: 'string',
          description: 'Execution context: "scene" (Cocos runtime) or "editor" (Electron/Node).',
        },
        code: {
          type: 'string',
          description: 'JavaScript code to execute. May return a value, define run(env), or export a function.',
        },
        args: {
          type: 'object',
          description: 'Optional JSON object passed into the script as args.',
        },
        safety_checks: {
          type: 'boolean',
          description: 'Override the project default JavaScript safety checks for this call.',
        },
      }, ['context', 'code']),
      handler: async (args) => {
        const context = String(args.context || '').toLowerCase();
        const runtimeContext = getRuntimeContext();

        // Safety validation
        assertToolJavascriptSafety(args, runtimeContext);

        if (context === 'scene') {
          return sceneBridge.call('executeCode', {
            code: args.code,
            args: args.args || {},
          });
        }

        if (context === 'editor') {
          if (typeof editorExecutor !== 'function') {
            throw new Error('Editor JavaScript execution is unavailable.');
          }
          return await editorExecutor({
            code: args.code,
            args: args.args || {},
          });
        }

        throw new Error(`Unknown execution context "${args.context}". Expected "scene" or "editor".`);
      },
    },
  ];

  // ==========================================================================
  // Registry object
  // ==========================================================================

  const registry = {
    listTools() {
      const { config } = getRuntimeContext();
      return tools
        .filter((tool) => isToolExposed(config || {}, tool))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema || createOutputSchema(tool.dataSchema),
          annotations: inferToolAnnotations(tool),
        }));
    },

    listToolCatalog() {
      const { config } = getRuntimeContext();
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        profile: tool.profile,
        category: toolCategory(tool),
        annotations: inferToolAnnotations(tool),
        outputSchema: tool.outputSchema || createOutputSchema(tool.dataSchema),
        enabled: isToolExposed(config || {}, tool),
      }));
    },

    async callToolDetailed(name, args) {
      const { config } = getRuntimeContext();
      const tool = tools.find((item) => item.name === name);
      if (!tool) {
        throw new Error(`Unknown tool '${name}'`);
      }
      if (!isToolExposed(config || {}, tool)) {
        throw new Error(`Tool '${name}' is not exposed by the current MCP tool profile '${config.toolProfile}'.`);
      }

      try {
        const result = await tool.handler(args || {});
        const envelope = createResultEnvelope(tool, args || {}, result);
        const output = typeof result === 'string' && result.startsWith(IMAGE_DATA_URI_PREFIX)
          ? result
          : toOutput(envelope);
        interactionLog.add(name, 'success', envelope.summary.slice(0, 500));
        return {
          value: envelope,
          text: output,
        };
      } catch (error) {
        interactionLog.add(name, 'error', error.message);
        error.toolEnvelope = createResultEnvelope(tool, args || {}, { message: error.message }, {
          ok: false,
          summary: error.message,
        });
        throw error;
      }
    },

    async callTool(name, args) {
      const result = await registry.callToolDetailed(name, args);
      return result.text;
    },
  };

  return registry;
}

module.exports = {
  createToolRegistry,
};
