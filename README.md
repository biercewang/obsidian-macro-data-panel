# obsidian-macro-data-panel

Obsidian 侧边栏宏观经济数据面板插件。打开含有 `data_panel` 配置的笔记时，右侧边栏自动拉取并展示对应的实时数据。

## 功能

- 打开指标笔记 → 侧边栏自动刷新对应数据
- 支持 FRED（美联储圣路易斯分行）数据接口
- 支持本地 JSON 文件作为数据源（内部数据库）
- 断网时自动降级到本地缓存
- 数据源在笔记 frontmatter 中声明，笔记正文与数据展示完全解耦

## 安装

1. 将本仓库克隆或下载到 Obsidian vault 的插件目录：
   ```
   <vault>/.obsidian/plugins/macro-data-panel/
   ```
2. 确保目录中包含 `main.js`、`manifest.json`、`styles.css`
3. Obsidian → 设置 → 第三方插件 → 关闭安全模式 → 刷新列表 → 启用「宏观数据面板」

## 配置

### FRED API Key

Obsidian → 设置 → 宏观数据面板 → 填入 FRED API Key

免费申请地址：https://fred.stlouisfed.org/docs/api/api_key.html

### 在笔记中声明数据面板

在笔记的 frontmatter 中添加 `data_panel` 字段：

```yaml
---
data_panel:
  source: fred
  cache: Glossary/data/jolts-cache.json
  showVU: true
  series:
    - { id: JTSJOL,   name: 职位空缺,    unit: 千人 }
    - { id: JTSHIL,   name: 新增招聘,    unit: 千人 }
    - { id: JTSQUR,   name: 辞职率,      unit: "%" }
    - { id: JTSLDL,   name: 裁员/解雇,   unit: 千人 }
    - { id: UNEMPLOY, name: _unemployed, unit: 千人, hidden: true }
---
```

## data_panel 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `source` | ✓ | 数据源，见下方支持的数据源 |
| `series` | ✓ | 数据系列数组 |
| `cache` | | 本地缓存文件路径（相对于 vault 根目录） |
| `showVU` | | 是否显示职位空缺/失业比（JOLTS 专用） |

### series 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✓ | 数据系列 ID（各数据源格式不同，见下方） |
| `name` | ✓ | 显示名称 |
| `unit` | ✓ | 单位，`%` 显示两位小数，其他显示整数 + 千 |
| `hidden` | | `true` 则不在面板显示（但参与计算，如 V/U 比） |

## 支持的数据源

### `source: fred`

从 FRED（Federal Reserve Economic Data）拉取数据，需配置 API Key。

`series[].id` 为 FRED Series ID，常用 JOLTS 系列：

| Series ID | 含义 |
|-----------|------|
| `JTSJOL` | 职位空缺（千人） |
| `JTSHIL` | 新增招聘（千人） |
| `JTSQUR` | 辞职率（%） |
| `JTSLDL` | 裁员/解雇（千人） |
| `UNEMPLOY` | 失业人数（千人） |
| `CPIAUCSL` | CPI 总体（月度指数） |
| `CPILFESL` | 核心 CPI（剔除食品和能源） |
| `PCEPI` | PCE 价格指数 |
| `PPIFIS` | PPI 最终需求 |

完整 Series ID 可在 https://fred.stlouisfed.org 搜索。

### `source: local`

读取 vault 内的本地 JSON 文件，适合对接内部数据库。

需额外提供 `file` 字段：

```yaml
data_panel:
  source: local
  file: Glossary/data/my-data.json
  series:
    - { id: my_series, name: 自定义指标, unit: "%" }
```

JSON 文件格式（与缓存格式一致）：

```json
{
  "ts": "2026-04-01T00:00:00.000Z",
  "data": [
    { "id": "my_series", "name": "自定义指标", "unit": "%", "cur": 3.5, "prev": 3.2, "date": "2026-03" }
  ]
}
```

## 本地缓存机制

- 每次成功拉取后，数据自动保存到 `cache` 指定的路径
- 若 API 请求失败（断网、限流等），自动读取上次缓存并在来源处标注缓存日期
- 缓存文件为标准 JSON，可手动编辑或由外部脚本写入（本地数据库对接入口）

## 文件结构

```
macro-data-panel/
├── main.js          # 插件主逻辑
├── manifest.json    # 插件元信息
├── styles.css       # 侧边栏样式
└── README.md
```

## 扩展新数据源

在 `main.js` 的 `fetchData()` 方法中添加新的 `case`，并实现对应的 `fetchXxx()` 方法即可：

```javascript
async fetchData(panel) {
  switch (panel.source) {
    case 'fred':  return this.fetchFRED(panel);
    case 'local': return this.fetchLocal(panel);
    case 'bls':   return this.fetchBLS(panel);   // 新增
  }
}
```

每个 fetch 方法返回 `{ rows, label }`，`rows` 格式为：

```javascript
[{ id, name, unit, hidden, cur, prev, date, error? }]
```
