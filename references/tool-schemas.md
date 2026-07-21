# 工具 Schema 详细定义

本文件包含 cocos-bridge 每个工具的完整 Zod Schema 定义,可直接用于 MCP Server 的 tool() 注册。

---

## 生成器工具组

### generate_project_scaffold

```typescript
const GenerateProjectScaffoldSchema = {
  projectPath: z.string().describe("项目根目录的绝对路径"),
  gameType: z.enum([
    "RPG", "action", "strategy", "puzzle",
    "simulation", "platformer", "card", "roguelike"
  ]).describe("游戏类型,决定预置的模块和架构模式"),
  architecture: z.enum(["MVC", "ECS", "component"])
    .default("component")
    .describe("代码架构模式。动作/战斗密集推荐 ECS,RPG/剧情推荐 MVC,通用推荐 component"),
  features: z.array(z.enum([
    "combat", "inventory", "dialogue", "save",
    "audio", "network", "ui_framework", "localization"
  ])).optional()
    .describe("需要预置的功能模块,不指定则只生成核心框架"),
};

// 输出
const GenerateProjectScaffoldOutput = {
  success: z.boolean(),
  projectPath: z.string(),
  createdFiles: z.array(z.string()).describe("创建的文件路径列表"),
  architecture: z.string(),
  nextSteps: z.array(z.string()).describe("推荐的下一步操作"),
};
```

### generate_config_files

```typescript
const GenerateConfigFilesSchema = {
  projectPath: z.string().describe("项目根目录绝对路径"),
  schemaType: z.enum([
    "character_movement",
    "combat_skill",
    "level_enemy",
    "economy_item",
    "element_matrix",
    "character_defs",
    "ui_screen",
    "custom"
  ]).describe("配置表 Schema 类型,对应 game-tech-implementation 的标准模板"),
  schemaData: z.record(z.any())
    .describe("Schema 数据 JSON。结构需符合 game-tech-implementation 对应 Schema 的字段定义"),
  outputDir: z.string().optional()
    .describe("配置表输出目录,默认 {projectPath}/assets/Configs/"),
  generateInterface: z.boolean().default(true)
    .describe("是否生成 TypeScript 接口文件"),
  generateLoader: z.boolean().default(true)
    .describe("是否生成/更新 ConfigLoader"),
};

const GenerateConfigFilesOutput = {
  success: z.boolean(),
  files: z.array(z.object({
    path: z.string(),
    type: z.enum(["config", "interface", "loader"]),
    description: z.string(),
  })),
  validationErrors: z.array(z.object({
    field: z.string(),
    message: z.string(),
  })).describe("Schema 校验发现的问题"),
};
```

### generate_component_scripts

```typescript
const ComponentDefinitionSchema = z.object({
  name: z.string().describe("组件类名,PascalCase,如 CharacterMover"),
  purpose: z.string().describe("组件职责的一句话描述"),
  directory: z.string().optional()
    .describe("输出子目录,如 Character/、Level/、UI/。不指定则放 Scripts/ 根目录"),
  properties: z.array(z.object({
    name: z.string(),
    type: z.enum([
      "number", "string", "boolean",
      "Vec2", "Vec3", "Color", "Size",
      "SpriteFrame", "AnimationClip", "AudioClip",
      "Node", "Prefab", "enum"
    ]),
    default: z.any().optional(),
    tooltip: z.string().optional(),
    range: z.tuple([z.number(), z.number()]).optional()
      .describe("number 类型的最小/最大值"),
    enumValues: z.array(z.string()).optional()
      .describe("type 为 enum 时的可选值列表"),
  })).optional(),
  configRef: z.string().optional()
    .describe("关联的配置表 Schema 类型,组件会自动从 ConfigLoader 读取对应配置"),
  stateMachine: z.string().optional()
    .describe("关联的状态机名称,组件会集成状态机实例"),
  lifecycle: z.array(z.enum([
    "onLoad", "start", "update", "lateUpdate",
    "onEnable", "onDisable", "onDestroy"
  ])).optional()
    .describe("需要生成的生命周期方法"),
});

const GenerateComponentScriptsSchema = {
  projectPath: z.string(),
  components: z.array(ComponentDefinitionSchema)
    .min(1).describe("要生成的组件定义列表"),
};

const GenerateComponentScriptsOutput = {
  success: z.boolean(),
  files: z.array(z.object({
    path: z.string(),
    className: z.string(),
    propertiesCount: z.number(),
    hasConfigRef: z.boolean(),
    hasStateMachine: z.boolean(),
  })),
};
```

### generate_state_machine

```typescript
const StateDefinition = z.object({
  name: z.string().describe("状态名,PascalCase,如 Idle、Walking、Attacking"),
  onEnter: z.string().optional().describe("进入状态时执行的逻辑描述(生成注释)"),
  onExit: z.string().optional().describe("退出状态时执行的逻辑描述"),
  isFinal: z.boolean().optional().describe("是否为终态(如 Dead)"),
});

const TransitionDefinition = z.object({
  from: z.string().describe("源状态名,可用 'Any' 表示任意状态"),
  to: z.string().describe("目标状态名"),
  trigger: z.string().describe("触发条件描述,如 '移动输入'、'HP <= 0'"),
  condition: z.string().optional()
    .describe("TypeScript 条件表达式,如 'input.moveMagnitude > 0'"),
  action: z.string().optional()
    .describe("转换时执行的动作描述,如 '播放步行动画'"),
  priority: z.number().optional()
    .describe("优先级,数字越大越先匹配。高优先级状态(死亡/受击)应设更高值"),
});

const GenerateStateMachineSchema = {
  projectPath: z.string(),
  name: z.string().describe("状态机名称,如 CharacterStateMachine、BossStateMachine"),
  states: z.array(StateDefinition).min(2),
  transitions: z.array(TransitionDefinition).min(1),
  initialState: z.string().describe("初始状态名"),
  directory: z.string().optional()
    .describe("输出子目录,默认 Scripts/Core/StateMachine/"),
};

const GenerateStateMachineOutput = {
  success: z.boolean(),
  files: z.array(z.object({
    path: z.string(),
    type: z.enum(["state_enum", "state_machine", "transitions"]),
  })),
  stateCount: z.number(),
  transitionCount: z.number(),
  validationWarnings: z.array(z.string())
    .describe("如存在不可达状态或死锁风险,在此列出"),
};
```

---

## 场景搭建工具组

### build_scene_from_config

```typescript
const BuildSceneFromConfigSchema = {
  sceneName: z.string().describe("场景名称"),
  configPath: z.string().describe("关卡配置 JSON 文件的相对路径(相对于项目根目录)"),
  options: z.object({
    createCameras: z.boolean().default(true),
    createLighting: z.boolean().default(true),
    createGroundPlane: z.boolean().default(true)
      .describe("是否创建地面平面(3D 场景)"),
    templateScene: z.string().optional()
      .describe("模板场景 UUID 或路径,从此模板复制而非空白创建"),
  }).optional(),
};

// 关卡配置 JSON 格式(输入文件需符合此结构)
const LevelConfigFormat = {
  level_id: "string,如 LV-001",
  name: "string,关卡显示名",
  bounds: "{ width: number, height: number, depth?: number }",
  areas: [
    {
      id: "string",
      name: "string",
      position: "{ x, y, z }",
      size: "{ width, height, depth? }",
      type: "enum: combat | safe | puzzle | boss | corridor",
    }
  ],
  spawn_points: [
    { id: "string", position: "{ x, y, z }", type: "enum: player | enemy | npc" }
  ],
  checkpoints: [
    { id: "string", position: "{ x, y, z }" }
  ],
  camera: {
    type: "enum: follow_3d | top_down_2d | side_scroll | fixed",
    fov: "number,可选",
    ortho_height: "number,可选",
  },
};
```

### build_ui_layout

```typescript
const UINodeDefinition = z.object({
  name: z.string(),
  component: z.enum([
    "Label", "Sprite", "Button", "ScrollView",
    "EditBox", "RichText", "ProgressBar", "Slider",
    "Toggle", "Layout", "Mask", "Empty"
  ]),
  rect: z.object({
    x: z.number(), y: z.number(),
    width: z.number(), height: z.number(),
  }).optional(),
  anchor: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }).optional(),
  widget: z.object({
    top: z.number().optional(),
    bottom: z.number().optional(),
    left: z.number().optional(),
    right: z.number().optional(),
    horizontal: z.enum(["left", "center", "right", "stretch"]).optional(),
    vertical: z.enum(["top", "middle", "bottom", "stretch"]).optional(),
  }).optional(),
  properties: z.record(z.any()).optional()
    .describe("组件属性,如 { fontSize: 24, string: '标题' }"),
  children: z.lazy(() => z.array(UINodeDefinition)).optional(),
});

const BuildUILayoutSchema = {
  parentNode: z.string().optional()
    .describe("父节点 UUID。不指定则在当前场景创建新 Canvas"),
  layout: z.object({
    type: z.enum(["screen", "panel", "popup", "toast", "hud"]),
    size: z.object({
      width: z.number().default(1280),
      height: z.number().default(720),
    }).optional(),
    designResolution: z.enum(["1280x720", "1920x1080", "750x1334", "custom"]).optional(),
    children: z.array(UINodeDefinition),
  }),
};
```

### build_combat_setup

```typescript
const BuildCombatSetupSchema = {
  combatConfig: z.object({
    arenaSize: z.object({
      width: z.number(),
      height: z.number(),
      depth: z.number().optional(),
    }).describe("战斗场地尺寸(米)"),
    playerSpawn: z.object({
      x: z.number(), y: z.number(), z: z.number().default(0),
    }),
    enemySpawns: z.array(z.object({
      id: z.string(),
      enemyId: z.string().describe("关联 enemy_defs 配置表中的敌人ID"),
      position: z.object({ x: z.number(), y: z.number(), z: z.number().default(0) }),
      patrolPath: z.array(z.object({
        x: z.number(), y: z.number(), z: z.number().default(0)
      })).optional(),
      detectionRange: z.number().optional(),
    })).min(1),
    cameraConfig: z.object({
      type: z.enum(["follow_3d", "top_down_2d", "side_scroll"]).default("follow_3d"),
      fov: z.number().optional(),
      ortho_height: z.number().optional(),
      follow_offset: z.object({
        x: z.number().optional(), y: z.number().optional(), z: z.number().optional()
      }).optional(),
    }).optional(),
    hudElements: z.array(z.enum([
      "hp_bar", "mp_bar", "skill_bar", "minimap",
      "boss_hp_bar", "timer", "combo_counter"
    ])).optional(),
  }),
};
```

### populate_level_enemies

```typescript
const PopulateLevelEnemiesSchema = {
  configPath: z.string()
    .describe("level_enemy_spawns.json 的文件路径(相对项目根目录)"),
  parentNode: z.string().optional()
    .describe("父节点 UUID。不指定则在当前场景根节点下创建 Enemies 容器节点"),
  prefabOverrides: z.record(z.string()).optional()
    .describe("{ enemyId: prefabUUID } 指定特定敌人类型使用哪个预制体"),
  createPatrolPaths: z.boolean().default(true)
    .describe("是否为有巡逻配置的敌人创建巡逻路径节点"),
};
```

---

## 资源管理工具组

### import_and_organize_assets

```typescript
const ImportAndOrganizeAssetsSchema = {
  sourceDir: z.string().describe("外部资源目录的绝对路径"),
  targetDir: z.string().describe("项目内目标目录(相对项目根,如 assets/Art/Characters)"),
  assetType: z.enum([
    "sprite", "model", "audio", "font",
    "spine", "texture", "prefab", "animation"
  ]),
  namingConvention: z.object({
    pattern: z.string().optional()
      .describe("命名正则,如 '^char_\\w+_stand\\.png$'"),
    prefix: z.string().optional()
      .describe("文件名前缀,如 'char_'"),
    rename: z.boolean().default(false)
      .describe("是否自动重命名不合规文件"),
  }).optional(),
  importSettings: z.object({
    textureCompression: z.enum(["none", "etc2", "astc", "pvrtc"]).optional(),
    mipmaps: z.boolean().optional(),
    filterMode: z.enum(["point", "bilinear", "trilinear"]).optional(),
  }).optional()
    .describe("资源导入设置,覆盖 Cocos 默认值"),
};
```

### validate_asset_references

```typescript
const ValidateAssetReferencesSchema = {
  scope: z.enum(["project", "scene", "directory"]).default("project"),
  directory: z.string().optional()
    .describe("scope 为 directory 时指定路径"),
  excludePatterns: z.array(z.string()).optional()
    .describe("排除的路径模式,如 ['**/node_modules/**']"),
};
```

### apply_naming_convention

```typescript
const ApplyNamingConventionSchema = {
  directory: z.string().describe("要检查/重命名的目录路径"),
  convention: z.enum([
    "character",    // char_{id}_{pose}.png
    "scene",        // scene_{name}_bg.png
    "ui_icon",      // icon_{function}.png
    "ui_button",    // btn_{name}.png
    "vfx",          // vfx_{name}_{frame}.png
    "item",         // item_{id}.png
    "skill",        // skill_{id}.png
    "audio_bgm",    // bgm_{name}.mp3
    "audio_sfx",    // sfx_{name}.wav
  ]).describe("命名规范类型,对应 game-art-production 的命名规范表"),
  dryRun: z.boolean().default(true)
    .describe("true 时只报告不执行"),
};
```

---

## 诊断校验工具组

### check_config_consistency

```typescript
const CheckConfigConsistencySchema = {
  configDir: z.string().optional()
    .describe("配置文件目录,默认 assets/Configs/"),
  gddSchemas: z.record(z.object({
    fields: z.record(z.object({
      type: z.enum(["int", "float", "string", "bool", "enum", "array", "object"]),
      required: z.boolean().optional(),
      range: z.tuple([z.any(), z.any()]).optional(),
      default: z.any().optional(),
    })),
  })).describe("GDD Schema 定义集合,key 为配置类型名"),
  strict: z.boolean().default(false)
    .describe("严格模式:配置文件中不允许 Schema 未定义的额外字段"),
};
```

### audit_project_health

```typescript
const AuditProjectHealthSchema = {
  checks: z.array(z.enum([
    "scene",       // 场景完整性(脏状态、空节点、重复节点名)
    "assets",      // 资源引用完整性
    "configs",     // 配置文件格式和命名
    "naming",      // 资源命名规范
    "performance", // 场景性能指标(节点数、Draw Call 预估)
    "scripts",     // 脚本编译错误检查
  ])).optional()
    .describe("要执行的检查项,默认全部"),
  severity: z.enum(["all", "error", "warning", "info"]).default("all")
    .describe("最低报告级别"),
};
```

### inspect_scene_graph

```typescript
const InspectSceneGraphSchema = {
  rootNode: z.string().optional()
    .describe("根节点 UUID,不指定则从场景根节点开始"),
  depth: z.number().min(1).max(20).default(5)
    .describe("最大分析深度"),
  includeComponents: z.boolean().default(true)
    .describe("是否列出每个节点挂载的组件"),
  includeProperties: z.boolean().default(false)
    .describe("是否列出组件的关键属性值(会增加输出量)"),
  filter: z.object({
    componentTypes: z.array(z.string()).optional()
      .describe("只显示包含指定组件的节点"),
    activeOnly: z.boolean().default(false)
      .describe("只显示 active 节点"),
  }).optional(),
};
```

---

## 编辑器状态工具组

### get_project_context

无输入参数。

### capture_scene_snapshot

```typescript
const CaptureSceneSnapshotSchema = {
  format: z.enum(["tree", "full", "diff"]).default("tree")
    .describe("tree: 节点树结构; full: 含组件属性; diff: 与上次快照的差异"),
  rootNode: z.string().optional()
    .describe("限定快照范围的根节点 UUID"),
};
```

---

## 兜底工具

### execute_script

```typescript
const ExecuteScriptSchema = {
  code: z.string().describe("要执行的 JavaScript 代码"),
  context: z.enum(["scene", "editor"]).default("scene")
    .describe("scene: 在 Cocos 引擎上下文中执行,可使用 cc.* API; editor: 在编辑器 Node.js 上下文中执行"),
  timeout: z.number().default(30000)
    .describe("执行超时时间(毫秒),默认 30s"),
};

// 安全检查规则(内置,不暴露给用户)
const BLOCKED_PATTERNS = [
  /rm\s+-rf/,
  /rmdir/,
  /fs\.unlink/,
  /child_process/,
  /require\s*\(\s*['"]child_process['"]\s*\)/,
  /process\.exit/,
  /\.createWriteStream/,
  /eval\s*\(/,
];
```
