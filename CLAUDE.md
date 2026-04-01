# CLAUDE.md — 宏观数据面板插件

## 项目背景

这是一个 Obsidian 本地插件，用于在侧边栏展示宏观经济指标数据。
所属 vault：`/Volumes/Disk/MyInfo2026`（用户的个人知识库，Obsidian 管理）。

**核心设计原则**：笔记正文只写知识内容，数据展示配置声明在 frontmatter，由插件统一渲染到侧边栏，两者完全解耦。

## 文件说明

| 文件 | 说明 |
|------|------|
| `main.js` | 插件全部逻辑，单文件 CommonJS，无需编译 |
| `manifest.json` | Obsidian 插件元信息 |
| `styles.css` | 侧边栏面板样式，使用 Obsidian CSS 变量适配深浅色主题 |

## 架构概览

```
MacroDataPlugin (Plugin)
├── onload()          — 注册 View、Ribbon、Command、file-open 事件监听
├── activateView()    — 打开/聚焦侧边栏面板
└── settings          — { fredApiKey }，通过 Obsidian 标准设置页管理

MacroDataView (ItemView)
├── refresh(file)     — 读取当前文件 frontmatter.data_panel，路由到对应 fetch
├── fetchData(panel)  — 数据源路由（switch on panel.source）
├── fetchFRED(panel)  — FRED API，使用 obsidian.requestUrl 绕过 CSP
├── fetchLocal(panel) — 读取 vault 内 JSON 文件
├── renderTable()     — 统一渲染，与数据源无关
├── saveCache()       — 异步写本地缓存 JSON
└── loadCache()       — 降级读缓存

MacroDataSettingTab (PluginSettingTab)
└── FRED API Key 输入框
```

## 关键设计决策

- **不用 fetch()，用 requestUrl()**：Obsidian 的 CSP 会拦截 fetch() 的外部请求，requestUrl 走 Electron 主进程，无此限制
- **单文件 CommonJS，不编译**：插件逻辑简单，无需 TypeScript 构建链，直接写 main.js 降低维护成本
- **配置在 frontmatter**：笔记文件只改 YAML，不嵌入代码块；Obsidian metadataCache 可同步读取，无需 await
- **缓存 JSON 格式**：与 local 数据源读取格式一致，方便外部脚本直接写入（内部数据库对接）

## 关联的 vault 文件

| 路径 | 说明 |
|------|------|
| `Glossary/JOLTS（Job Openings and Labor Turnover Survey）.md` | 第一个接入数据面板的指标文件，frontmatter 中有完整 data_panel 示例 |
| `Glossary/data/jolts-cache.json` | JOLTS 数据本地缓存，插件自动维护 |
| `Glossary/scripts/fred-panel.js` | 早期 DataviewJS 方案遗留，已被本插件取代，可删除 |
| `Glossary/scripts/data-panel.js` | 同上，已被本插件取代，可删除 |
| `Glossary/data/config.md` | 早期 DataviewJS 方案的 API Key 存储，已被本插件设置页取代，可删除 |

## 扩展方向

### 新增数据源
在 `fetchData()` 的 switch 中加新 case，实现 `fetchXxx(panel)` 方法，返回 `{ rows, label }`。
rows 每项格式：`{ id, name, unit, hidden?, cur, prev, date, error? }`

### 新增面板字段
在 frontmatter `data_panel` 下加新字段，`refresh()` 方法读取后透传给 `renderTable()`。

### 内部数据库对接
外部脚本按以下格式写入 JSON 文件，笔记配置 `source: local` + `file: 路径` 即可：
```json
{ "ts": "ISO8601时间", "data": [{ "id": "...", "cur": 0, "prev": 0, "date": "YYYY-MM" }] }
```

## 开发注意事项

- Obsidian 插件为 CommonJS：`var obsidian = require('obsidian')`，`module.exports = MyPlugin`
- 修改 main.js 后需在 Obsidian 中「重新载入插件」（设置 → 第三方插件 → 禁用再启用，或用 Hot Reload 插件）
- CSS 变量（`var(--text-muted)` 等）自动适配深浅色主题，不要硬编码颜色
- `app.metadataCache.getFileCache(file)` 是同步的，frontmatter 读取无需 await
