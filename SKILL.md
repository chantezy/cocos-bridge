---
name: "cocos-bridge"
description: "何时使用:需要将 game-design MCP 产出的策划案落地到 Cocos Creator 3.8 项目中时——包括生成配置表/代码骨架、搭建场景/UI、导入资源、校验项目一致性。能力:17 个意图级工具 + 1 个 execute_script 兜底,覆盖生成器/场景搭建/资源管理/诊断校验四大工具组。边界:不替代 game-design MCP 的策划产出,只负责引擎侧落地。"
version: "0.1.0"
---

# Cocos Bridge:策划案到 Cocos Creator 的桥接层

## 概述

cocos-bridge 是连接 game-design MCP 策划案产出与 Cocos Creator 3.8 引擎实现的桥接层。解决的核心问题:game-design MCP 产出了系统规则、数值配置表、关卡敌人配置、战斗参数等策划案文档,这些文档需要变成 Cocos Creator 项目里可运行的配置文件、TypeScript 代码和场景节点。

**定位:** 不做通用引擎操作工具,只做"策划案意图 → 引擎实现"的翻译层。

---

## 架构

### 双通道设计

```
AI 客户端 (QoderWork / Cursor / VS Code)
    │
    ├── 通道 A:stdio(文件级操作,不需要编辑器运行)
    │   ├── generate_project_scaffold
    │   ├── generate_config_files
    │   ├── generate_component_scripts
    │   └── generate_state_machine
    │
    └── 通道 B:HTTP → 编辑器扩展(场景/资源操作,需要 Cocos Creator 运行)
        ├── 场景搭建工具组(build_*)
        ├── 资源管理工具组(import_*, validate_*, apply_*)
        ├── 诊断工具组(audit_*, check_*, inspect_*)
        └── 兜底工具(execute_script)
```

**通道 A** 通过 stdio 直接操作项目文件系统,不依赖编辑器运行。适合代码生成和配置文件生成。

**通道 B** 通过 HTTP 连接到嵌入 Cocos Creator 编辑器的 MCP Server,调用 `Editor.Message.request` 和 `cc.*` API 操作场景和资源。

### 包结构

```
@chantezy/mcp-cocos-bridge/
├── package.json              # npm 包,npm Trusted Publisher 发布
├── tsconfig.json
├── bin/
│   └── cocos-bridge.js       # stdio 入口(通道 A)
├── extension/                # Cocos Creator 编辑器扩展
│   ├── package.json          # Cocos 扩展 manifest
│   ├── src/
│   │   ├── main.ts           # 扩展入口,启动 HTTP MCP Server
│   │   ├── mcp-server.ts     # HTTP MCP Server(Streamable HTTP)
│   │   ├── scene.ts          # 场景脚本(运行在 cc 上下文)
│   │   └── tools/            # 通道 B 工具实现
│   └── dist/
├── src/                      # 共享代码
│   ├── index.ts              # stdio MCP Server 入口
│   ├── bridge.ts             # stdio → HTTP 桥接
│   ├── generators/           # 通道 A 生成器实现
│   │   ├── project-scaffold.ts
│   │   ├── config-generator.ts
│   │   ├── component-generator.ts
│   │   └── state-machine-generator.ts
│   └── schemas/              # 配置表 Schema 定义
│       ├── character-movement.ts
│       ├── combat-skill.ts
│       ├── level-enemy.ts
│       ├── economy-item.ts
│       └── element-matrix.ts
├── skills/
│   └── cocos-bridge/
│       ├── SKILL.md          # 本文件
│       └── references/
│           ├── tool-schemas.md       # 工具详细输入/输出 Schema
│           ├── cocos-api-map.md      # Editor.Message 消息映射表
│           └── integration-guide.md  # 与 game-design MCP 集成指南
└── dist/
```

### npm 发布

- 包名:`@chantezy/mcp-cocos-bridge`
- 发布方式:npm Trusted Publisher(OIDC),与 mcp-game-design 一致
- bin 入口:`cocos-bridge` → stdio 通道
- Cocos 扩展:用户需手动安装到 Cocos Creator 的 extensions 目录

---

## 工具总览(17 + 1)

### 工具组一览

| 工具组 | 通道 | 工具数 | 核心工具 |
|-------|------|-------|---------|
| 生成器 | A(stdio) | 4 | generate_config_files, generate_component_scripts |
| 场景搭建 | B(HTTP) | 4 | build_scene_from_config, build_ui_layout |
| 资源管理 | B(HTTP) | 3 | import_and_organize_assets, validate_asset_references |
| 诊断校验 | B(HTTP) | 3 | check_config_consistency, audit_project_health |
| 编辑器状态 | B(HTTP) | 2 | get_project_context, capture_scene_snapshot |
| 兜底 | B(HTTP) | 1 | execute_script |

---

## 工具组一:生成器(通道 A,无需编辑器)

### 1. generate_project_scaffold

**用途:** 根据游戏类型和目标架构,生成 Cocos Creator 3.8 项目骨架。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| projectPath | string | 是 | 项目根目录路径 |
| gameType | enum | 是 | RPG / action / strategy / puzzle / simulation / platformer / card / roguelike |
| architecture | enum | 否 | MVC / ECS / component(默认 component) |
| features | string[] | 否 | 需要预置的功能模块:["combat","inventory","dialogue","save","audio","network","ui_framework","localization"] |

**产出:**

```
{projectPath}/
├── assets/
│   ├── Scripts/
│   │   ├── Core/              # EventBus, ObjectPool, StateMachine 基类
│   │   ├── Character/         # 按 features 选择性生成
│   │   ├── Level/
│   │   ├── UI/
│   │   ├── Data/              # ConfigLoader, SaveSystem
│   │   └── Network/           # 仅 features 包含 network 时
│   ├── Configs/               # JSON 配置表目录(空,等 generate_config_files 填充)
│   ├── Scenes/                # 预置 Main.scene 骨架
│   ├── Art/
│   └── Audio/
├── tsconfig.json
└── README.md                  # 项目结构说明
```

**衔接:** 读取 `game-tech-implementation` 的项目工程规范和按游戏类型的架构推荐。

---

### 2. generate_config_files

**用途:** 根据 GDD Schema 定义,在 Cocos 项目中生成 JSON 配置文件 + TypeScript 接口 + ConfigLoader。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| projectPath | string | 是 | 项目根目录 |
| schemaType | enum | 是 | character_movement / combat_skill / level_enemy / economy_item / element_matrix / character_defs / ui_screen / custom |
| schemaData | object | 是 | GDD 产出的 Schema JSON(来自 game-tech-implementation 的标准模板) |
| outputDir | string | 否 | 配置表输出目录,默认 assets/Configs/ |

**产出(每个 schemaType 生成 3 个文件):**

1. `assets/Configs/{schemaType}.json` — 配置数据文件
2. `assets/Scripts/Data/Configs/{SchemaTypePascal}Config.ts` — TypeScript 接口定义(schemaType 转 PascalCase,如 character_movement → CharacterMovement)
3. `assets/Scripts/Data/ConfigLoader.ts` — 更新或创建 ConfigLoader,增加对应的加载方法

**衔接:** 直接消费 `game-tech-implementation` 的配置表 Schema 模板和 `game-numerical-design` 产出的数值参数。

---

### 3. generate_component_scripts

**用途:** 根据系统设计或角色设计,生成 Cocos 组件脚本骨架。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| projectPath | string | 是 | 项目根目录 |
| components | object[] | 是 | 组件定义数组,每项含: |
| → name | string | 是 | 组件类名(如 CharacterMover) |
| → purpose | string | 是 | 组件职责描述 |
| → properties | object[] | 否 | @property 属性列表(name, type, default, tooltip) |
| → configRef | string | 否 | 关联的配置表类型(如 character_movement_params) |
| → stateMachine | string | 否 | 关联的状态机名称 |

**产出:** 每个组件生成一个 TypeScript 文件:

```typescript
// assets/Scripts/Character/CharacterMover.ts
import { _decorator, Component, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('CharacterMover')
export class CharacterMover extends Component {
    @property({ tooltip: '步行速度 m/s' })
    walkSpeed: number = 2.5;
    // ... 从 configRef 读取默认值
}
```

**衔接:** 消费 `game-system-design` 的系统规则和 `game-tech-implementation` 的代码生成示例。

---

### 4. generate_state_machine

**用途:** 根据状态机定义生成完整的状态枚举 + 转换表 + 状态机运行时代码。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| projectPath | string | 是 | 项目根目录 |
| name | string | 是 | 状态机名称(如 CharacterStateMachine) |
| states | object[] | 是 | 状态列表:[{name, onEnter?, onExit?}] |
| transitions | object[] | 是 | 转换列表:[{from, to, trigger, condition?, action?}] |
| initialState | string | 是 | 初始状态名 |

**产出:**

1. `assets/Scripts/Core/StateMachine/{name}.ts` — 状态枚举 + 状态机类
2. `assets/Scripts/Core/StateMachine/{name}Transitions.ts` — 转换条件实现

**衔接:** 直接消费 `game-tech-implementation` 的状态机模板(通用角色状态机、Boss 战斗状态机)。

---

## 工具组二:场景搭建(通道 B,需要编辑器)

### 5. build_scene_from_config

**用途:** 根据关卡配置 JSON,在 Cocos Creator 中自动搭建场景骨架。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| sceneName | string | 是 | 场景名称 |
| configPath | string | 是 | 关卡配置 JSON 文件路径(项目内相对路径) |
| options | object | 否 | 可选配置 |
| → createCameras | boolean | 否 | 是否自动创建相机,默认 true |
| → createLighting | boolean | 否 | 是否创建基础光照,默认 true |
| → templateScene | string | 否 | 模板场景路径(从模板复制而非空白创建) |

**产出:** 在 Cocos Creator 中创建/打开场景,包含:

- 根节点层级结构(从配置文件的 areas/zones 定义生成)
- Spawn 点节点(从配置的 spawn_points 生成)
- 检查点节点(从配置的 checkpoints 生成)
- 基础相机和光照(如 options.createCameras/createLighting 为 true)

**底层操作:** `scene:create-node`、`scene:set-property`、`scene:save-scene`

**衔接:** 消费 `game-level-design` 的关卡策划案参数。

---

### 6. build_ui_layout

**用途:** 根据 UI 配置,自动搭建 UI 节点层级。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| parentNode | string | 否 | 父节点 UUID,不指定则在当前场景创建新 Canvas |
| layout | object | 是 | UI 布局定义: |
| → type | enum | 是 | screen / panel / popup / toast / hud |
| → size | object | 否 | {width, height},默认 1280x720 |
| → children | object[] | 是 | 子节点递归定义,每项: |
| → → name | string | 是 | 节点名 |
| → → component | enum | 是 | Label / Sprite / Button / ScrollView / EditBox / RichText |
| → → rect | object | 否 | {x, y, width, height} 相对父节点 |
| → → anchor | object | 否 | {x, y} 锚点 |
| → → widget | object | 否 | Widget 对齐配置 {top, bottom, left, right} |
| → → properties | object | 否 | 组件属性(如 Label.fontSize, Label.string) |
| → → children | object[] | 否 | 递归子节点 |

**产出:** 在场景中创建完整的 UI 节点树,每个节点挂载对应组件并设置属性。

**底层操作:** `scene:create-node`、`scene:create-component`、`scene:set-property`

**衔接:** 消费 `game-system-design` 的 UI 线框图描述和 `game-art-production` 的 UI 设计规范。

---

### 7. build_combat_setup

**用途:** 根据战斗策划参数,搭建战斗场景基础元素。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| combatConfig | object | 是 | 战斗配置(来自 game-combat-design): |
| → arenaSize | object | 是 | {width, height, depth} 战斗场地尺寸 |
| → playerSpawn | object | 是 | {x, y, z} 玩家出生点 |
| → enemySpawns | object[] | 是 | [{x, y, z, enemyId}] 敌人出生点列表 |
| → cameraConfig | object | 否 | 相机配置 {type: follow_3d/top_down_2d/side_scroll, fov, ortho_height, follow_offset} |
| → hudElements | string[] | 否 | HUD 元素列表:["hp_bar","skill_bar","minimap"] |

**产出:**

- 战斗场地节点(含碰撞体边界)
- 玩家出生点标记节点
- 敌人出生点标记节点(每个挂载 spawn 配置)
- 战斗相机节点(按 cameraConfig 配置)
- HUD Canvas(按 hudElements 创建占位 UI)

**衔接:** 消费 `game-combat-design` 的战斗参数和 `game-character-design` 的角色清单。

---

### 8. populate_level_enemies

**用途:** 从关卡敌人配置表,批量在场景中生成敌人 spawn 节点和巡逻路径。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| configPath | string | 是 | level_enemy_spawns.json 的文件路径 |
| parentNode | string | 否 | 父节点 UUID,不指定则在当前场景根节点下创建 |
| prefabOverrides | object | 否 | {enemyId: prefabUUID} 指定特定敌人使用哪个预制体 |

**产出:** 在场景中批量创建:

- 敌人生成节点(位置、朝向、索敌范围)
- 巡逻路径节点(Bezier 或多点路径)
- 每个节点关联 enemyId 配置

**底层操作:** `scene:create-node`、`scene:set-property`、`asset-db:query-uuid`

**衔接:** 消费 `game-level-design` 的敌人配置表和 `game-numerical-design` 的数值参数。

---

## 工具组三:资源管理(通道 B)

### 9. import_and_organize_assets

**用途:** 批量导入外部资源到项目,并按命名规范组织。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| sourceDir | string | 是 | 外部资源目录路径 |
| targetDir | string | 是 | 项目内目标目录(如 assets/Art/Characters) |
| assetType | enum | 是 | sprite / model / audio / font / spine / texture |
| namingConvention | object | 否 | 命名规则: |
| → pattern | string | 否 | 正则表达式,如 `^char_\w+_stand\.png$` |
| → rename | boolean | 否 | 是否自动重命名不合规文件,默认 false |

**产出:**

- 导入资源到指定目录
- 命名规范检查报告(不合规文件列表 + 建议命名)
- 资源 meta 文件配置(压缩设置、导入参数)

**底层操作:** `asset-db:import-asset`、`asset-db:query-assets`、`asset-db:save-asset-meta`

**衔接:** 执行 `game-art-production` 的资源命名规范(char_{id}_stand.png 等)。

---

### 10. validate_asset_references

**用途:** 检查项目中的资源引用完整性,发现孤立资源和断裂引用。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| scope | enum | 否 | project(全项目)/ scene(当前场景)/ directory(指定目录),默认 project |
| directory | string | 否 | scope 为 directory 时指定路径 |

**产出:**

```json
{
  "totalAssets": 245,
  "orphanAssets": [...],     // 未被任何场景/预制体引用的资源
  "brokenReferences": [...], // 引用了不存在资源的节点/组件
  "duplicateAssets": [...],  // 内容相同但路径不同的资源
  "report": "..."            // 可读报告
}
```

**底层操作:** `asset-db:query-asset-dependencies`、`asset-db:query-assets`

---

### 11. apply_naming_convention

**用途:** 按命名规范批量重命名资源,对照 game-art-production 的规范表。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| directory | string | 是 | 要检查/重命名的目录 |
| convention | enum | 是 | character / scene / ui_icon / ui_button / vfx / item / skill / audio_bgm / audio_sfx(对应 game-art-production 的命名规范表 + 音频补充) |
| dryRun | boolean | 否 | true 时只报告不执行,默认 true |

**产出:**

- dryRun=true:变更预览报告(原路径 → 新路径)
- dryRun=false:实际重命名结果 + 更新引用

**底层操作:** `asset-db:move-asset`、`asset-db:query-assets`

**衔接:** 执行 `game-art-production` 的美术资源命名规范表。

---

## 工具组四:诊断校验(通道 B)

### 12. check_config_consistency

**用途:** 校验项目中的配置文件是否与 GDD Schema 定义一致。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| configDir | string | 否 | 配置文件目录,默认 assets/Configs/ |
| gddSchemas | object | 是 | GDD Schema 定义集合(来自 game-tech-implementation),key 为 schemaType |

**产出:**

```json
{
  "totalConfigs": 5,
  "totalSchemas": 5,
  "issues": [
    {
      "file": "combat_skill_defs.json",
      "type": "missing_field",
      "field": "damage.element",
      "schema": "combat_skill",
      "message": "技能 SK-003 缺少 damage.element 字段"
    },
    {
      "file": "economy_item_prices.json",
      "type": "type_mismatch",
      "field": "buy_price",
      "schema": "economy_item",
      "message": "IT-005 的 buy_price 应为 int,实际为 string"
    }
  ],
  "passRate": "80%"
}
```

**衔接:** 对照 `game-tech-implementation` 的 Schema 模板和 `game-full-workflow` 的配置表字段一致性校验。

---

### 13. audit_project_health

**用途:** 全面的项目健康度检查。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| checks | string[] | 否 | 要执行的检查项,默认全部:["scene","assets","configs","naming","performance","scripts"] |

**产出:**

```json
{
  "score": 85,
  "checks": {
    "scene": { "pass": true, "issues": [] },
    "assets": { "pass": false, "issues": ["3 个孤立资源", "1 个断裂引用"] },
    "configs": { "pass": true, "issues": [] },
    "naming": { "pass": false, "issues": ["2 个不符合命名规范的文件"] },
    "performance": { "pass": true, "issues": [] }
  }
}
```

**底层操作:** `scene:query-dirty`、`scene:query-performance`、`asset-db:query-asset-dependencies`

---

### 14. inspect_scene_graph

**用途:** 分析当前场景结构,输出结构化摘要供 AI 理解场景状态。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| depth | number | 否 | 最大分析深度,默认 5 |
| includeComponents | boolean | 否 | 是否列出每个节点的组件,默认 true |
| includeProperties | boolean | 否 | 是否列出关键属性值,默认 false |

**产出:** 场景节点树的 JSON 结构化摘要,包含每个节点的名称、UUID、组件列表、子节点数量。

**底层操作:** `scene:query-node-tree`、`scene:query-node`、`scene:query-components`

---

## 工具组五:编辑器状态(通道 B)

### 15. get_project_context

**用途:** 获取当前项目的基本信息、编辑器状态、活跃场景等上下文。

**输入:** 无

**产出:**

```json
{
  "project": { "name": "MyGame", "path": "/path/to/project", "uuid": "xxx" },
  "editor": { "version": "3.8.8", "platform": "darwin" },
  "scene": { "name": "Main", "uuid": "xxx", "dirty": false, "nodeCount": 42 },
  "selection": { "nodes": ["uuid1", "uuid2"], "assets": [] }
}
```

**底层操作:** `Editor.Project`、`Editor.App`、`Editor.Selection`、`scene:query-current-scene`

---

### 16. capture_scene_snapshot

**用途:** 捕获当前场景的可序列化快照,用于 AI 理解场景状态或做变更前记录基线。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| format | enum | 否 | tree(节点树)/ full(含属性)/ diff(与上次快照的差异),默认 tree |

**产出:** 场景状态的 JSON 快照。

**底层操作:** `scene:snapshot`、`scene:query-node-tree`

---

## 兜底工具(通道 B)

### 17. execute_script

**用途:** 在场景上下文或编辑器上下文中执行任意 JavaScript/TypeScript 代码。意图级工具覆盖不到的操作使用此工具。

**输入:**

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| code | string | 是 | 要执行的代码 |
| context | enum | 是 | scene(引擎 cc.* 上下文)/ editor(编辑器 Node.js 上下文) |

**安全规则:**

- 禁止:文件系统删除操作、child_process、原始 writable stream、路径穿越
- scene 上下文可用:`cc.Node`、`cc.Component`、`cc.Vec3`、`cc.director`、`cc.instantiate` 等
- editor 上下文可用:`Editor.Message`、`Editor.Project`、`Editor.Selection`、`fs`(只读)、`path`

**产出:** 代码执行的返回值(JSON 序列化)。

---

## 与 game-design MCP 的集成点

### 集成矩阵

| game-design 技能 | cocos-bridge 工具 | 衔接方式 |
|-----------------|------------------|---------|
| game-tech-implementation | generate_config_files, generate_component_scripts, generate_state_machine, generate_project_scaffold | Schema → 配置文件 + 代码 |
| game-combat-design | build_combat_setup, generate_state_machine | 战斗参数 → 场景元素 + 状态机 |
| game-level-design | build_scene_from_config, populate_level_enemies | 关卡配置 → 场景节点 |
| game-system-design | build_ui_layout, generate_component_scripts | 系统规则 → UI 节点 + 组件 |
| game-character-design | generate_component_scripts, build_combat_setup | 角色设定 → 组件脚本 |
| game-numerical-design | generate_config_files | 数值参数 → 配置表 JSON |
| game-art-production | import_and_organize_assets, apply_naming_convention | 命名规范 → 资源整理 |
| game-full-workflow | check_config_consistency, audit_project_health | 一致性校验 → 项目诊断 |
| game-qa-testing | audit_project_health, check_config_consistency | 测试依据 → 自动检查 |

### 典型工作流

```
1. game-creative-discussion → 游戏创意框架
2. game-system-design → 系统策划案(含 UI 线框图)
3. game-tech-implementation → 配置表 Schema + 状态机模板 + 代码生成指导
   │
   ├──→ [cocos-bridge] generate_project_scaffold    # 生成项目骨架
   ├──→ [cocos-bridge] generate_config_files        # 生成配置文件
   ├──→ [cocos-bridge] generate_component_scripts   # 生成组件脚本
   ├──→ [cocos-bridge] generate_state_machine       # 生成状态机代码
   │
4. game-level-design → 关卡策划案
   │
   ├──→ [cocos-bridge] build_scene_from_config      # 搭建关卡场景
   ├──→ [cocos-bridge] populate_level_enemies       # 放置敌人
   │
5. game-art-production → 美术资源
   │
   ├──→ [cocos-bridge] import_and_organize_assets   # 导入资源
   │
6. 整合阶段
   │
   ├──→ [cocos-bridge] build_ui_layout              # 搭建 UI
   ├──→ [cocos-bridge] build_combat_setup           # 搭建战斗场景
   ├──→ [cocos-bridge] check_config_consistency     # 校验一致性
   └──→ [cocos-bridge] audit_project_health         # 项目体检
```

---

## 已知缺口与未来工具(v0.2+)

以下能力在当前版本中缺失,计划在后续版本中补充:

| 缺失能力 | 当前替代方案 | 计划工具 |
|---------|-----------|---------|
| 预制体创建/管理 | 通过 `execute_script` 手动操作 | `manage_prefabs`(创建/实例化/解除关联/应用修改) |
| 动画状态绑定 | 通过 `execute_script` 手动绑定 | `bind_animation_states`(将状态机状态关联到 AnimationClip) |
| 配置热更新验证 | 手动刷新 | `reload_configs`(触发编辑器重新加载配置表) |
| 对话系统代码生成 | `generate_component_scripts` 手动配置 | `generate_dialogue_system`(对话树/分支/触发器) |
| 状态机一致性校验 | `check_config_consistency` 只校验配置 | `validate_state_machines`(校验状态机定义与 game-tech-implementation 模板的一致性) |

**已知冗余:**
- `validate_asset_references` 与 `audit_project_health(checks:["assets"])` 功能重叠。独立工具适合精细控制,audit 适合快速体检。
- `capture_scene_snapshot` 与 `inspect_scene_graph` 概念相近。snapshot 侧重可序列化状态和 diff,inspect 侧重过滤和组件详情。

---

## 实现要点

### Cocos Creator 3.8.8 兼容性

- Editor.Message API 使用 3.8 版本的消息协议
- 场景序列化格式对齐 3.8 的 JSON 结构
- 不使用 4.0 新增的 API(Marionette 动画系统等)

### 数据传递约束

场景脚本通过 Electron IPC 通信,**传输数据必须是纯 JSON 对象**,不可包含原生对象引用。所有 cc.* 对象(如 Node、Vec3)需在 scene script 内处理,只返回序列化后的数据。

### 协议版本

- MCP 协议版本:`2024-11-05`(与 game-design MCP 对齐)
- HTTP 传输:Streamable HTTP(通道 B)
- stdio 传输:标准 stdio(通道 A)

---

## 参考资料索引

| 文件 | 内容 | 何时读取 |
|------|------|---------|
| references/tool-schemas.md | 每个工具的完整 Zod Schema 定义 | 实现工具时 |
| references/cocos-api-map.md | Editor.Message 消息映射表(80+ 消息) | 开发通道 B 工具时 |
| references/integration-guide.md | 与 game-design MCP 的集成详细指南 | 设计集成逻辑时 |
