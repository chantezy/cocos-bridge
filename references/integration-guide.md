# 与 game-design MCP 集成指南

本文件描述 cocos-bridge 如何与 `@chantezy/mcp-game-design` 的 11 个技能衔接。

---

## 集成架构

```
game-design MCP                          cocos-bridge MCP
(策划案产出)                              (引擎落地)

game-creative-discussion ──→ 游戏创意框架
    │
game-tech-implementation ──→ 配置表Schema/状态机/代码规范
    │                            │
    │                            ├──→ generate_project_scaffold
    │                            ├──→ generate_config_files
    │                            ├──→ generate_component_scripts
    │                            └──→ generate_state_machine
    │
game-system-design ──→ 系统规则/UI线框图
    │                       │
    │                       ├──→ build_ui_layout
    │                       └──→ generate_component_scripts
    │
game-combat-design ──→ 战斗参数/Boss模式
    │                       │
    │                       ├──→ build_combat_setup
    │                       └──→ generate_state_machine
    │
game-level-design ──→ 关卡配置/敌人分布
    │                       │
    │                       ├──→ build_scene_from_config
    │                       └──→ populate_level_enemies
    │
game-numerical-design ──→ 数值参数/经济表
    │                           │
    │                           └──→ generate_config_files
    │
game-character-design ──→ 角色设定/属性
    │                           │
    │                           └──→ generate_component_scripts
    │
game-art-production ──→ 美术资源/命名规范
    │                         │
    │                         ├──→ import_and_organize_assets
    │                         └──→ apply_naming_convention
    │
game-full-workflow ──→ GDD一致性校验
    │                        │
    │                        └──→ check_config_consistency
    │
game-qa-testing ──→ 测试用例
    │                     │
    │                     └──→ audit_project_health
```

---

## 逐技能集成细节

### game-tech-implementation → cocos-bridge

这是最核心的集成点。game-tech-implementation 产出 5 种标准 Schema 模板,cocos-bridge 的 `generate_config_files` 直接消费:

| Schema 模板 | generate_config_files 的 schemaType 参数 | 生成文件 |
|------------|-----------------------------------------|---------|
| 角色移动参数 | `character_movement` | character_movement_params.json + CharacterMovementConfig.ts |
| 技能定义 | `combat_skill` | combat_skill_defs.json + SkillConfig.ts |
| 关卡敌人配置 | `level_enemy` | level_enemy_spawns.json + EnemySpawnConfig.ts |
| 经济系统物品定价 | `economy_item` | economy_item_prices.json + ItemPriceConfig.ts |
| 属性克制矩阵 | `element_matrix` | element_matrix.json + ElementMatrix.ts |

**数据流:** AI 先调用 `get_skill("game-tech-implementation")` 获取 Schema 模板 → 根据策划案填入实际参数 → 调用 `generate_config_files` 生成文件。

**状态机集成:** game-tech-implementation 定义了通用角色状态机和 Boss 战斗状态机的状态枚举 + 转换表 → 直接作为 `generate_state_machine` 的输入。

### game-combat-design → cocos-bridge

game-combat-design 产出:
- 攻击手感参数(前摇/后摇/命中停顿/击退) → 写入 `combat_skill_defs.json` 的 timing 和 effects 字段
- 闪避设计参数(无敌帧/冷却/消耗) → 写入 `character_movement_params.json` 的 dodge 字段
- Boss 战阶段配置(阶段阈值/招式池/输出窗口) → `generate_state_machine` 生成 Boss 状态机
- 伤害公式 → 写入 `combat_skill_defs.json` 的 damage 字段

**场景搭建:** combatConfig.arenaSize 和 enemySpawns 来自 game-combat-design 的关卡战斗设计 → `build_combat_setup` 在场景中创建。

### game-level-design → cocos-bridge

game-level-design 产出:
- 关卡流程(区域划分/节奏控制) → 转为 level_config.json 的 areas 数组
- 敌人配置表 → 直接作为 `populate_level_enemies` 的 configPath 输入
- 检查点设置 → 写入 level_config.json 的 checkpoints

**场景搭建:** `build_scene_from_config` 读取 level_config.json,自动创建区域节点、spawn 点、检查点。

### game-system-design → cocos-bridge

game-system-design 产出:
- UI 线框图描述 → 转为 `build_ui_layout` 的 layout JSON
- 系统规则(背包/技能/经济) → `generate_component_scripts` 生成对应组件

**UI 搭建流程:** AI 解析 game-system-design 的 UI 线框图 → 转换为 UINodeDefinition 数组 → 调用 `build_ui_layout` 创建 UI 节点树。

### game-numerical-design → cocos-bridge

game-numerical-design 产出:
- 战斗数值表 → 填充 `combat_skill_defs.json` 的 damage/timing 字段
- 经济系统数值(日产/日消比、时间价格) → 填充 `economy_item_prices.json`
- 成长曲线参数 → 可生成独立的 progression_exp_curve.json

### game-character-design → cocos-bridge

game-character-design 产出:
- 角色属性档位(HP/ATK/DEF/SPD) → 写入 `character_movement_params.json` 或独立的 character_defs.json
- 角色定位(坦克/DPS/辅助) → 影响 `generate_component_scripts` 的组件生成策略

### game-art-production → cocos-bridge

game-art-production 定义了美术资源的命名规范表:
- 角色立绘:`char_{id}_stand.png`
- 场景背景:`scene_{场景名}_bg.png`
- UI 图标:`icon_{功能名}.png`
- 特效序列帧:`vfx_{特效名}_{帧号}.png`

这些规范直接编码到 `apply_naming_convention` 的 convention 枚举和校验规则中。

### game-full-workflow → cocos-bridge

game-full-workflow 的六维度校验中的"配置表字段一致性校验"→ 由 `check_config_consistency` 执行:
- 输入:gddSchemas 来自 game-tech-implementation 的 Schema 模板
- 校验:项目实际配置文件 vs Schema 定义
- 输出:不一致项列表

### game-qa-testing → cocos-bridge

game-qa-testing 的"配置校验"和"可玩性保障"→ 由 `audit_project_health` 执行:
- 配置正确性:`configs` 检查项
- 资源完整性:`assets` 检查项
- 命名规范:`naming` 检查项

---

## 检测与自动衔接(未来增强)

当 cocos-bridge MCP 和 game-design MCP 同时连接时,可以实现自动检测:

```
AI 调用 get_skill("game-tech-implementation") 产出策划案
    │
    ├── 检测到 cocos-bridge 已连接
    │   → 自动提示:"是否需要我将这些配置表生成到 Cocos 项目中?"
    │   → 用户确认 → 调用 generate_config_files
    │
    └── 检测到 cocos-bridge 未连接
        → 输出策划案文档 + 配置表 JSON(纯文本)
        → 提示:"如需直接在 Cocos 项目中生成,请安装 cocos-bridge MCP"
```

此检测逻辑可嵌入 game-tech-implementation 的 SKILL.md 中,作为"执行层"的可选步骤。
