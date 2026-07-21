# Cocos Creator 3.8 Editor.Message 消息映射表

本文件记录 cocos-bridge 各工具底层调用的 Editor.Message 消息,供开发时查阅。

---

## 消息通道分类

### scene:* (场景操作)

| 消息 | 参数 | 返回 | 被哪些工具使用 |
|------|------|------|--------------|
| `scene:create-node` | `{parent, name, components?, assetUuid?}` | `{uuid}` | build_*, populate_* |
| `scene:remove-node` | `{uuid}` | `{}` | — |
| `scene:set-property` | `{uuid, path, value}` | `{}` | build_*, populate_* |
| `scene:set-parent` | `{uuid, parent}` | `{}` | build_scene_from_config |
| `scene:duplicate-node` | `{uuid}` | `{uuid}` | — |
| `scene:query-node-tree` | `{sceneUuid?}` | 节点树 JSON | inspect_scene_graph, capture_scene_snapshot |
| `scene:query-node` | `{uuid}` | 节点数据 | inspect_scene_graph |
| `scene:query-current-scene` | 无 | `{uuid, name}` | get_project_context |
| `scene:query-components` | `{uuid}` | 组件列表 | inspect_scene_graph |
| `scene:query-dirty` | 无 | `{dirty: boolean}` | audit_project_health |
| `scene:query-performance` | 无 | 性能数据 | audit_project_health |
| `scene:create-component` | `{uuid, component}` | `{}` | build_ui_layout, build_combat_setup |
| `scene:delete-component` | `{uuid, component}` | `{}` | — |
| `scene:open-scene` | `{uuid}` | `{}` | build_scene_from_config |
| `scene:save-scene` | `{uuid?}` | `{}` | build_scene_from_config |
| `scene:snapshot` | `{uuid?}` | 场景快照 | capture_scene_snapshot |
| `scene:execute-scene-script` | `{name, method, args}` | 脚本返回值 | execute_script, 所有通道B工具 |
| `scene:create-prefab` | `{nodeUuid, url}` | `{uuid}` | — |
| `scene:connect-prefab-instance` | `{nodeUuid, prefabUuid}` | `{}` | — |
| `scene:apply-prefab` | `{nodeUuid}` | `{}` | — |
| `scene:unlink-prefab` | `{nodeUuid}` | `{}` | — |
| `scene:begin-recording` | `{uuids?}` | `{id}` | 需要 undo 支持的操作 |
| `scene:end-recording` | `{id}` | `{}` | 配合 begin-recording |
| `scene:cancel-recording` | `{id}` | `{}` | 操作失败时取消 |

### asset-db:* (资源数据库)

| 消息 | 参数 | 返回 | 被哪些工具使用 |
|------|------|------|--------------|
| `asset-db:query-assets` | `{pattern?, type?}` | 资源列表 | validate_*, apply_*, get_project_context |
| `asset-db:query-uuid` | `{url}` | `{uuid}` | populate_level_enemies |
| `asset-db:query-asset-info` | `{uuid}` | 资源信息 | import_and_organize_assets |
| `asset-db:query-asset-meta` | `{uuid}` | 资源 meta | import_and_organize_assets |
| `asset-db:query-asset-dependencies` | `{uuid}` | 依赖列表 | validate_asset_references |
| `asset-db:query-url` | `{uuid}` | `{url}` | — |
| `asset-db:query-path` | `{uuid}` | `{path}` | apply_naming_convention |
| `asset-db:create-asset` | `{url, content?}` | `{uuid}` | generate_config_files(通道B模式) |
| `asset-db:save-asset` | `{uuid, content}` | `{}` | — |
| `asset-db:save-asset-meta` | `{uuid, meta}` | `{}` | import_and_organize_assets |
| `asset-db:delete-asset` | `{uuid}` | `{}` | — |
| `asset-db:copy-asset` | `{src, dest}` | `{uuid}` | — |
| `asset-db:move-asset` | `{src, dest}` | `{}` | apply_naming_convention |
| `asset-db:import-asset` | `{src, dest, options?}` | `{uuid}` | import_and_organize_assets |
| `asset-db:refresh-asset` | `{uuid}` | `{}` | import_and_organize_assets |

### builder:* / project:* / preferences:*

| 消息 | 参数 | 返回 | 用途 |
|------|------|------|------|
| `builder:open` | 无 | `{}` | 打开构建面板 |
| `project:query-config` | `{key}` | 配置值 | get_project_context |
| `preferences:query-config` | `{key}` | 配置值 | — |
| `preferences:set-config` | `{key, value}` | `{}` | — |

---

## cc.* 引擎 API(场景脚本可用)

场景脚本通过 `require('cc')` 导入,运行在与项目脚本相同的上下文中。

### 核心类

| 类/模块 | 常用 API | 使用场景 |
|---------|---------|---------|
| `Node` | `.name`, `.uuid`, `.active`, `.position`, `.rotation`, `.scale`, `.parent`, `.children`, `.addComponent()`, `.getComponent()`, `.removeFromParent()`, `.destroy()`, `.addChild()` | 所有场景操作 |
| `Component` | `.node`, `.enabled`, `.getComponent()` | 组件查询 |
| `Vec3` | `new Vec3(x,y,z)`, `.set()`, `.clone()` | 位置/缩放设置 |
| `Quat` | `new Quat()`, `.setFromEuler()` | 旋转设置 |
| `Color` | `new Color(r,g,b,a)`, `Color.WHITE` | UI/精灵颜色 |
| `director` | `.getScene()`, `.runSceneImmediate()`, `.isPaused()`, `.pause()`, `.resume()` | 场景切换/运行时控制 |
| `instantiate` | `instantiate(prefab)` | 预制体实例化 |
| `assetManager` | `.loadAny()`, `.resources.load()` | 资源加载 |
| `js` | `.getClassByName(name)` | 按名称查找组件类 |

### UI 组件

| 组件 | 常用属性/方法 |
|------|-------------|
| `Canvas` | `.designResolution` |
| `UITransform` | `.setContentSize(w,h)`, `.setAnchorPoint(x,y)`, `.contentSize` |
| `Label` | `.string`, `.fontSize`, `.lineHeight`, `.color`, `.overflow` |
| `Sprite` | `.spriteFrame`, `.color`, `.type`, `.sizeMode` |
| `Button` | `.target`, `.clickEvents`, `Button.EventType.CLICK` |
| `Widget` | `.top`, `.bottom`, `.left`, `.right`, `.isAlignTop/Bottom/Left/Right` |
| `Layout` | `.type`, `.resizeMode`, `.spacingX/Y` |

### 3D 组件

| 组件 | 常用属性/方法 |
|------|-------------|
| `Camera` | `.fov`, `.orthoHeight`, `.projection`, `.near`, `.far`, `.priority`, `.visibility` |
| `Animation` | `.play()`, `.stop()`, `.clips`, `.defaultClip` |
| `MeshRenderer` | `.mesh`, `.material` |

---

## Editor.* API 模块

| 模块 | 方法 | 使用场景 |
|------|------|---------|
| `Editor.Message` | `.request(channel, action, ...args)`, `.send()`, `.broadcast()` | 所有编辑器操作 |
| `Editor.Project` | `.name`, `.path`, `.uuid` | get_project_context |
| `Editor.App` | `.path`, `.version` | get_project_context |
| `Editor.Selection` | `.select(uuid)`, `.clear()`, `.getSelected()` | — |
| `Editor.Panel` | `.open(panelName)`, `.close(panelName)` | — |
| `Editor.Profile` | `.getConfig(pkg, key)`, `.setConfig(pkg, key, value)` | — |

---

## 场景脚本通信约束

通过 `Editor.Message.request('scene', 'execute-scene-script', options)` 执行场景脚本时:

1. **options 格式:**
```javascript
{
  name: 'my-extension',     // 扩展名
  method: 'myMethod',        // scene.ts 中 exports.methods 的方法名
  args: [纯JSON参数]         // 参数必须是纯 JSON,不可含 cc 对象引用
}
```

2. **数据传输限制:** 参数和返回值必须是可序列化的纯 JSON 对象。Node、Vec3 等原生对象必须在 scene script 内处理,返回时转为普通对象 `{x, y, z}`。

3. **错误处理:** scene script 抛出的错误会被 IPC 层捕获并返回为 rejected Promise。建议在 scene script 内 try-catch 并返回结构化错误:
```javascript
{ ok: false, error: '具体错误信息', stack: err.stack }
```
