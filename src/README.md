# Cocos Bridge MCP

Cocos Creator 3.8 扩展 + MCP Server，将游戏策划案（GDD）直接转化为 Cocos Creator 工程文件、场景和代码。

17 个意图级工具 + 1 个通用回退工具，聚焦「策划案 → 引擎实现」的桥接场景。每个工具封装了多个底层编辑器操作，AI 客户端一次调用即可完成原本需要多步编排的复杂任务。

## 定位

Cocos Bridge 是 [game-design MCP](https://github.com/chantezy/game-skills) 的下游执行层：

```
game-design MCP (策划案生成)
    ↓ 输出: 配置表 Schema / 状态机定义 / 关卡配置 / UI 布局
Cocos Bridge MCP (引擎实现)
    ↓ 输出: .ts 组件 / .json 配置 / 场景节点 / 状态机代码
Cocos Creator 3.8.8 工程
```

## 双通道架构

| 通道 | 传输 | 依赖 | 工具范围 |
|------|------|------|----------|
| **A: stdio** | 本地进程 | 无需编辑器 | 生成器 (4) + 诊断 (3) + 资源 (3) |
| **B: HTTP** | 编辑器扩展 | Cocos Creator 运行中 | 场景构建 (4) + 编辑器状态 (2) + 回退 (1) |

通道 A 可独立使用——AI 客户端通过 stdio 协议直接调用生成器，无需打开 Cocos Creator。通道 B 需要编辑器扩展运行，提供场景操作和实时检查能力。

## 工具清单

### 生成器 (Generators) — 通道 A

| 工具 | 输入 | 输出 |
|------|------|------|
| `generate_project_scaffold` | 游戏类型 + 架构 + 功能标志 | 完整项目目录结构 + tsconfig.json + 基础框架代码 |
| `generate_config_files` | GDD Schema 定义 | JSON 配置文件 + TypeScript 接口 + ConfigLoader.ts |
| `generate_component_scripts` | 组件定义 (属性列表) | @ccclass 组件 .ts 文件 + @property 装饰器 |
| `generate_state_machine` | 状态枚举 + 转移规则 | State enum + StateMachine class + Transitions 模块 |

### 场景构建 (Scene Builders) — 通道 B

| 工具 | 输入 | 输出 |
|------|------|------|
| `build_scene_from_config` | 关卡配置 JSON | 场景节点层级 (地形/灯光/相机/出生点) |
| `build_ui_layout` | UI 布局定义 | Canvas 下的 UI 节点树 + 组件绑定 |
| `build_combat_setup` | 战斗场景配置 | 角色节点 + 碰撞体 + 相机跟随 + UI 面板 |
| `populate_level_enemies` | 敌人刷新点列表 | 敌人 Prefab 实例 + 刷新逻辑脚本 |

### 资源管理 (Resources) — 通道 A

| 工具 | 输入 | 输出 |
|------|------|------|
| `import_and_organize_assets` | 源目录 + 命名规则 | 自动分类导入 (sprites/audio/prefabs...) |
| `validate_asset_references` | 项目目录 | 断裂引用 + 孤立资产报告 |
| `apply_naming_convention` | 目录 + 命名规范 | 批量重命名 + 规范校验报告 |

### 诊断 (Diagnostics) — 通道 A

| 工具 | 输入 | 输出 |
|------|------|------|
| `check_config_consistency` | 配置目录 | 字段类型/范围/引用一致性校验 |
| `audit_project_health` | 项目目录 | 结构/资产/场景/脚本/配置全面体检 |
| `inspect_scene_graph` | 场景文件路径 | 节点层级 + 组件 + 属性树 |

### 编辑器状态 (Editor State) — 通道 B

| 工具 | 输入 | 输出 |
|------|------|------|
| `get_project_context` | 无 | 项目路径/引擎版本/场景列表/脚本统计 |
| `capture_scene_snapshot` | 无 | 当前场景节点树 + 组件 + 变换信息 |

### 回退 (Fallback) — 通道 B

| 工具 | 输入 | 输出 |
|------|------|------|
| `execute_script` | JavaScript 代码 | 在场景或编辑器上下文执行任意 JS |

## 快速开始

### 方式一：stdio 独立使用（无需 Cocos Creator）

适合 AI 客户端直接调用生成器，在任意目录下产出 Cocos 项目文件：

```bash
# 全局安装
npm install -g @chantezy/cocos-bridge

# 或在 MCP 客户端配置中添加
```

MCP 客户端配置示例：

<details>
<summary>QoderWork / Claude Desktop</summary>

```json
{
  "mcpServers": {
    "cocos_bridge": {
      "command": "cocos-bridge",
      "args": ["--url", "http://127.0.0.1:8765/"]
    }
  }
}
```
</details>

<details>
<summary>Cursor / VS Code</summary>

```json
{
  "mcpServers": {
    "cocos_bridge": {
      "command": "cocos-bridge",
      "args": ["--url", "http://127.0.0.1:8765/"]
    }
  }
}
```
</details>

如果只需使用通道 A（生成器），可以直接指向本地目录，不需要 `--url`：

```json
{
  "mcpServers": {
    "cocos_bridge": {
      "command": "cocos-bridge"
    }
  }
}
```

### 方式二：Cocos Creator 扩展（完整双通道）

1. 将 `src/` 目录复制到 Cocos 项目的 `extensions/cocos-bridge/`：

```bash
cd /path/to/your-cocos-project
mkdir -p extensions
cp -r /path/to/cocos-bridge/src extensions/cocos-bridge
```

2. 重启 Cocos Creator，打开菜单 `Cocos Bridge > MCP Server`

3. 在 MCP 客户端中配置 HTTP 连接：

```json
{
  "mcpServers": {
    "cocos_bridge": {
      "url": "http://127.0.0.1:8765/"
    }
  }
}
```

### 验证连接

```bash
# HTTP 健康检查
curl http://127.0.0.1:8765/health

# 查看可用工具
curl http://127.0.0.1:8765/tools
```

## 与 game-design MCP 集成

Cocos Bridge 的每个工具都对应 game-design MCP 的特定技能输出：

| game-design 技能 | 输出格式 | cocos-bridge 工具 |
|------------------|----------|-------------------|
| game-system-design | 系统规则 + 数值参数 | `generate_config_files` |
| game-combat-design | 技能定义 + 伤害公式 | `generate_component_scripts`, `build_combat_setup` |
| game-level-design | 关卡配置 + 敌人刷新 | `build_scene_from_config`, `populate_level_enemies` |
| game-narrative-design | 对话系统 + 任务链 | `generate_state_machine` (对话状态机) |
| game-character-design | 角色属性 + 成长曲线 | `generate_component_scripts`, `generate_config_files` |
| game-numerical-design | 数值表 + 平衡参数 | `generate_config_files`, `check_config_consistency` |
| game-tech-implementation | Schema + 状态机 + 映射 | 全部生成器工具 |
| game-art-workflows | 美术规范 + 资源清单 | `import_and_organize_assets`, `apply_naming_convention` |
| game-qa-testing | 测试用例 + 检查清单 | `audit_project_health`, `validate_asset_references` |
| game-creative-discussion | 创意方向 + 核心循环 | `generate_project_scaffold` |
| game-ui-design | UI 布局 + 交互流程 | `build_ui_layout` |

## 配置

在 Cocos 项目根目录创建 `cocos-bridge.config.json`：

```json
{
  "host": "127.0.0.1",
  "port": 8765,
  "toolProfile": "core",
  "autostart": true,
  "executeJavascriptSafetyChecks": true,
  "enableSessions": false
}
```

环境变量：`COCOS_BRIDGE_HOST`、`COCOS_BRIDGE_PORT`、`COCOS_BRIDGE_PROFILE`、`COCOS_BRIDGE_URL`。

`toolProfile` 可选值：`core`（默认，全部 17+1 工具）、`full`、`custom`（配合 `enabledTools`/`disabledTools` 精细控制）。

## 项目结构

```
src/
├── browser.js          # Cocos 扩展入口 (Channel B)
├── scene.js            # 场景运行时桥接 (1596 行)
├── bin/
│   └── cocos-bridge.js # stdio CLI 入口 (Channel A)
├── lib/
│   ├── server.js       # HTTP MCP 服务器
│   ├── tool-registry.js # 18 个工具定义 + handler
│   ├── config.js       # 配置加载
│   ├── utils.js        # 工具函数
│   ├── javascript-safety.js  # JS 安全检查
│   ├── path-safety.js        # 路径安全检查
│   ├── interaction-log.js    # 交互日志
│   ├── runtime-log.js        # 运行日志
│   ├── tool-profiles.js      # 工具配置模板
│   └── generators/
│       ├── index.js
│       ├── project-scaffold.js    # 项目脚手架 (1317 行)
│       ├── config-generator.js    # 配置生成器
│       ├── component-generator.js # 组件生成器
│       └── state-machine-generator.js # 状态机生成器
├── package.json
├── README.md
└── LICENSE
```

## 开发

```bash
# 语法检查
npm run check

# 在项目中使用
cd your-cocos-project
npm link @chantezy/cocos-bridge
```

## 已知限制与后续计划

v0.1 聚焦核心桥接链路，以下功能计划在后续版本补充：

- `manage_prefabs` — Prefab 创建/实例化/变体管理
- `bind_animation_states` — 动画状态机与 FSM 状态绑定
- `hot_reload_configs` — 配置热重载（编辑器运行时重新加载 JSON）
- `generate_dialogue_system` — 对话系统完整实现（节点图 → Cocos 组件）
- `validate_state_machine` — 状态机可达性/死锁/终止态静态分析

## License

MIT. See [LICENSE](./LICENSE).
