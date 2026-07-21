'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var PROPERTY_TYPES = Object.freeze([
  'number', 'string', 'boolean', 'Vec2', 'Vec3', 'Color', 'Size',
  'SpriteFrame', 'AnimationClip', 'AudioClip', 'Node', 'Prefab', 'enum',
]);

var LIFECYCLE_METHODS = Object.freeze([
  'onLoad', 'start', 'update', 'lateUpdate', 'onEnable', 'onDisable',
  'onDestroy', 'onEnable', 'resetInEditor', 'onRestore',
]);

// ---------------------------------------------------------------------------
// Type mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map a property type string to the Cocos Creator import needed.
 */
function typeToImport(type) {
  var map = {
    Vec2: 'Vec2',
    Vec3: 'Vec3',
    Color: 'Color',
    Size: 'Size',
    SpriteFrame: 'SpriteFrame',
    AnimationClip: 'AnimationClip',
    AudioClip: 'AudioClip',
    Node: 'Node',
    Prefab: 'Prefab',
  };
  return map[type] || null;
}

/**
 * Map a property type to the @property decorator type expression.
 */
function typeToPropertyDecorator(type, prop) {
  if (type === 'number') return '';
  if (type === 'string') return '';
  if (type === 'boolean') return '';
  if (type === 'enum' && prop && prop.enumValues && prop.enumValues.length > 0) {
    return 'type: ' + pascalCase(prop.name) + 'Enum';
  }
  // Cocos class types
  var cocosType = typeToImport(type);
  if (cocosType) {
    return 'type: ' + cocosType;
  }
  return '';
}

/**
 * Map a property type to its default value literal for the class field.
 */
function typeToDefaultValue(type, prop) {
  if (prop && prop.default !== undefined) {
    if (typeof prop.default === 'string') return "'" + prop.default + "'";
    return String(prop.default);
  }
  if (type === 'number') return '0';
  if (type === 'string') return "''";
  if (type === 'boolean') return 'false';
  if (type === 'Vec2') return 'new Vec2(0, 0)';
  if (type === 'Vec3') return 'new Vec3(0, 0, 0)';
  if (type === 'Color') return 'new Color(255, 255, 255, 255)';
  if (type === 'Size') return 'new Size(0, 0)';
  if (type === 'SpriteFrame') return 'null';
  if (type === 'AnimationClip') return 'null';
  if (type === 'AudioClip') return 'null';
  if (type === 'Node') return 'null';
  if (type === 'Prefab') return 'null';
  if (type === 'enum' && prop && prop.enumValues && prop.enumValues.length > 0) {
    return pascalCase(prop.name) + 'Enum.' + prop.enumValues[0];
  }
  return 'null';
}

function pascalCase(str) {
  return str
    .replace(/(^|[_\s-])(\w)/g, function (_, __, ch) { return ch.toUpperCase(); })
    .replace(/[^a-zA-Z0-9]/g, '');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeFileSafe(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Component code generation
// ---------------------------------------------------------------------------

function buildImports(component) {
  var lines = [];
  var cocosImports = ['_decorator', 'Component'];
  var typeImports = {};

  // Scan properties for Cocos types
  var props = component.properties || [];
  for (var i = 0; i < props.length; i++) {
    var imp = typeToImport(props[i].type);
    if (imp) typeImports[imp] = true;
  }

  // Add discovered type imports
  var additionalImports = Object.keys(typeImports);
  if (additionalImports.length > 0) {
    cocosImports = cocosImports.concat(additionalImports);
  }

  lines.push("import { " + cocosImports.join(', ') + " } from 'cc';");
  lines.push("const { ccclass, property } = _decorator;");

  // ConfigLoader import
  if (component.configRef) {
    lines.push("import { ConfigLoader } from '../Data/ConfigLoader';");
  }

  // StateMachine import
  if (component.stateMachine) {
    var smName = pascalCase(component.stateMachine.name || component.stateMachine);
    var smDir = component.stateMachine.directory || '../Core';
    lines.push("import { " + smName + " } from '" + smDir + "/" + smName + "';");
  }

  return lines;
}

function buildEnumDeclarations(component) {
  var lines = [];
  var props = component.properties || [];
  for (var i = 0; i < props.length; i++) {
    var prop = props[i];
    if (prop.type === 'enum' && prop.enumValues && prop.enumValues.length > 0) {
      var enumName = prop.name.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase() + '_ENUM';
      // Use a Cocos-compatible enum pattern
      lines.push('');
      lines.push('export enum ' + pascalCase(prop.name) + 'Enum {');
      for (var j = 0; j < prop.enumValues.length; j++) {
        var val = prop.enumValues[j];
        lines.push('  ' + val + ' = ' + j + ',');
      }
      lines.push('}');
    }
  }
  return lines;
}

function buildProperties(props) {
  var lines = [];
  for (var i = 0; i < props.length; i++) {
    var prop = props[i];
    var decorators = [];

    // Build @property decorator options
    var opts = [];
    var typeDec = typeToPropertyDecorator(prop.type, prop);
    if (typeDec) opts.push(typeDec);
    if (prop.tooltip) opts.push("tooltip: '" + prop.tooltip.replace(/'/g, "\\'") + "'");
    if (prop.range && Array.isArray(prop.range) && prop.range.length === 2) {
      opts.push('range: [' + prop.range[0] + ', ' + prop.range[1] + ']');
    }

    if (opts.length > 0) {
      lines.push('  @property({ ' + opts.join(', ') + ' })');
    } else {
      lines.push('  @property');
    }

    var defaultVal = typeToDefaultValue(prop.type, prop);
    var tsType = prop.type;
    if (tsType === 'number' || tsType === 'float' || tsType === 'int') tsType = 'number';
    else if (tsType === 'string') tsType = 'string';
    else if (tsType === 'boolean' || tsType === 'bool') tsType = 'boolean';
    else if (tsType === 'enum') tsType = pascalCase(prop.name) + 'Enum';
    // else keep as-is (Vec2, Vec3, etc.)

    var nullable = (defaultVal === 'null') ? ' | null' : '';
    lines.push('  public ' + prop.name + ': ' + tsType + nullable + ' = ' + defaultVal + ';');
    lines.push('');
  }
  return lines;
}

function buildLifecycleMethod(method) {
  var lines = [];
  if (method === 'update' || method === 'lateUpdate') {
    lines.push('  ' + method + '(dt: number): void {');
  } else {
    lines.push('  ' + method + '(): void {');
  }

  // State machine forwarding for update
  if (method === 'update') {
    lines.push('    if (this._stateMachine) {');
    lines.push('      this._stateMachine.update(dt);');
    lines.push('    }');
  }

  lines.push('  }');
  return lines;
}

function buildConfigLoaderIntegration(configRef) {
  var lines = [];
  var configName = pascalCase(configRef);

  lines.push('');
  lines.push('  private _config: any = null;');
  lines.push('');
  lines.push('  /** Load the ' + configRef + ' config data. */');
  lines.push('  private async loadConfig(): Promise<void> {');
  lines.push('    try {');
  lines.push("      this._config = await ConfigLoader.load('Configs/" + configRef + "');");
  lines.push('    } catch (e) {');
  lines.push("      console.error('Failed to load config " + configRef + ":', e);");
  lines.push('    }');
  lines.push('  }');
  return lines;
}

function buildStateMachineIntegration(stateMachine) {
  var lines = [];
  var smName = pascalCase(stateMachine.name || stateMachine);

  lines.push('');
  lines.push('  private _stateMachine: ' + smName + ' | null = null;');
  lines.push('');
  lines.push('  /** Initialize the ' + smName + ' state machine. */');
  lines.push('  private initStateMachine(): void {');
  lines.push('    this._stateMachine = new ' + smName + '();');

  if (stateMachine.states && Array.isArray(stateMachine.states)) {
    lines.push('    // Register states');
    for (var i = 0; i < stateMachine.states.length; i++) {
      var state = stateMachine.states[i];
      lines.push("    this._stateMachine.registerState('" + state.name + "', {");
      if (state.onEnter) {
        lines.push('      onEnter: (prev) => this.onEnter' + pascalCase(state.name) + '(prev),');
      }
      if (state.onExit) {
        lines.push('      onExit: (next) => this.onExit' + pascalCase(state.name) + '(next),');
      }
      lines.push('    });');
    }
  }

  if (stateMachine.initialState) {
    lines.push("    this._stateMachine.start('" + stateMachine.initialState + "');");
  }

  lines.push('  }');
  return lines;
}

function generateComponentFile(component) {
  var name = pascalCase(component.name);
  var lines = [];

  // Header
  lines.push('/**');
  lines.push(' * ' + name + ' — ' + (component.purpose || 'component'));
  lines.push(' * Generated by cocos-bridge component-generator.');
  lines.push(' * Target: Cocos Creator 3.8.x');
  lines.push(' */');
  lines.push('');

  // Imports
  var imports = buildImports(component);
  lines = lines.concat(imports);
  lines.push('');

  // Enum declarations
  var enums = buildEnumDeclarations(component);
  if (enums.length > 0) {
    lines = lines.concat(enums);
    lines.push('');
  }

  // Class declaration
  lines.push("@ccclass('" + name + "')");
  lines.push('export class ' + name + ' extends Component {');

  // Properties
  if (component.properties && component.properties.length > 0) {
    var props = buildProperties(component.properties);
    lines = lines.concat(props);
  }

  // ConfigLoader integration
  if (component.configRef) {
    var configLines = buildConfigLoaderIntegration(component.configRef);
    lines = lines.concat(configLines);
  }

  // StateMachine integration
  if (component.stateMachine) {
    var smLines = buildStateMachineIntegration(component.stateMachine);
    lines = lines.concat(smLines);
  }

  // Lifecycle methods
  var lifecycle = component.lifecycle || [];
  if (lifecycle.length > 0) {
    // Auto-add config loading to onLoad if configRef is set
    var hasOnLoad = lifecycle.indexOf('onLoad') >= 0;

    for (var i = 0; i < lifecycle.length; i++) {
      lines.push('');
      var methodLines = buildLifecycleMethod(lifecycle[i]);

      // Inject config/state machine initialization into onLoad
      if (lifecycle[i] === 'onLoad') {
        var injectLines = [];
        if (component.configRef) {
          injectLines.push('    this.loadConfig();');
        }
        if (component.stateMachine) {
          injectLines.push('    this.initStateMachine();');
        }
        if (injectLines.length > 0) {
          // Insert after the opening brace line
          methodLines.splice(1, 0, injectLines.join('\n'));
        }
      }

      lines = lines.concat(methodLines);
    }
  } else {
    // Default: add onLoad if configRef or stateMachine is set
    if (component.configRef || component.stateMachine) {
      lines.push('');
      lines.push('  onLoad(): void {');
      if (component.configRef) {
        lines.push('    this.loadConfig();');
      }
      if (component.stateMachine) {
        lines.push('    this.initStateMachine();');
      }
      lines.push('  }');
    }
  }

  // State callback stubs if state machine with states
  if (component.stateMachine && component.stateMachine.states) {
    var states = component.stateMachine.states;
    for (var s = 0; s < states.length; s++) {
      var st = states[s];
      if (st.onEnter) {
        lines.push('');
        lines.push('  private onEnter' + pascalCase(st.name) + '(prevState: string): void {');
        lines.push('    // TODO: implement ' + st.name + ' enter logic');
        lines.push('  }');
      }
      if (st.onExit) {
        lines.push('');
        lines.push('  private onExit' + pascalCase(st.name) + '(nextState: string): void {');
        lines.push('    // TODO: implement ' + st.name + ' exit logic');
        lines.push('  }');
      }
    }
  }

  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateComponent(comp) {
  var errors = [];
  if (!comp.name || typeof comp.name !== 'string') {
    errors.push('Component name is required.');
  }
  if (comp.properties && Array.isArray(comp.properties)) {
    for (var i = 0; i < comp.properties.length; i++) {
      var prop = comp.properties[i];
      if (!prop.name) {
        errors.push('Property at index ' + i + ' is missing a name.');
      }
      if (prop.type && PROPERTY_TYPES.indexOf(prop.type) === -1) {
        errors.push("Property '" + (prop.name || 'unnamed') + "' has unknown type '" + prop.type + "'. Valid types: " + PROPERTY_TYPES.join(', ') + '.');
      }
    }
  }
  if (comp.lifecycle && Array.isArray(comp.lifecycle)) {
    for (var j = 0; j < comp.lifecycle.length; j++) {
      if (LIFECYCLE_METHODS.indexOf(comp.lifecycle[j]) === -1) {
        errors.push("Unknown lifecycle method '" + comp.lifecycle[j] + "'. Valid: " + LIFECYCLE_METHODS.join(', ') + '.');
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate Cocos Creator component script scaffolds.
 *
 * @param {object} args
 * @param {string} args.projectPath - Absolute path to the Cocos project root.
 * @param {Array}  args.components - Array of component definitions.
 * @returns {Promise<{success: boolean, files: string[], error?: string}>}
 */
async function generateComponentScripts(args) {
  var projectPath = args ? args.projectPath : undefined;
  var components = args ? args.components : undefined;

  // --- Validation -----------------------------------------------------------
  if (!projectPath || typeof projectPath !== 'string') {
    return { success: false, files: [], error: 'projectPath is required and must be a string.' };
  }
  if (!Array.isArray(components) || components.length === 0) {
    return { success: false, files: [], error: 'components array is required and must not be empty.' };
  }

  // Validate all components first
  var allErrors = [];
  for (var i = 0; i < components.length; i++) {
    var compErrors = validateComponent(components[i]);
    if (compErrors.length > 0) {
      allErrors.push('Component ' + i + ' (' + (components[i].name || 'unnamed') + '): ' + compErrors.join('; '));
    }
  }
  if (allErrors.length > 0) {
    return { success: false, files: [], error: allErrors.join('\n') };
  }

  try {
    var files = [];
    var scriptsBase = path.join(projectPath, 'assets/Scripts');

    for (var c = 0; c < components.length; c++) {
      var comp = components[c];
      var dir = comp.directory || '';
      var fileName = pascalCase(comp.name) + '.ts';
      var filePath = path.join(scriptsBase, dir, fileName);
      var content = generateComponentFile(comp);

      writeFileSafe(filePath, content);
      files.push(path.relative(projectPath, filePath));
    }

    return { success: true, files: files };
  } catch (err) {
    return { success: false, files: [], error: err.message };
  }
}

module.exports = {
  generateComponentScripts,
  PROPERTY_TYPES,
  LIFECYCLE_METHODS,
};
