# 宏观数据面板插件扩展设计

## 目标

为 `obsidian-macro-data-panel` 插件新增 BLS 和 ISM 两个数据源，同时为 vault 中 5 类经济指标笔记补充 `data_panel` frontmatter 配置。

## 一、插件扩展

### 1.1 新增数据源 case

在 `main.js` 的 `fetchData()` 方法 switch 中新增：

```javascript
async fetchData(panel) {
  switch (panel.source) {
    case 'fred':  return this.fetchFRED(panel);
    case 'local': return this.fetchLocal(panel);
    case 'bls':   return this.fetchBLS(panel);   // 新增
    case 'ism':   return this.fetchISM(panel);   // 新增
    default: throw new Error(`未知数据源：${panel.source}`);
  }
}
```

### 1.2 fetchBLS(panel) 实现

- **API 端点**：`POST https://api.bls.gov/publicAPI/v2/timeseries/data/`
- **请求体**：`{ "seriesid": ["UNRATE", "CPIAUCSL", ...], "startyear": "2024", "endyear": "2026" }`
- **无需 Key**：免费限额 25 series/day；加 Key 可达 500/day
- **返回解析**：取每个 series 最新 2 条数据（最近月份 + 上月），映射到 `{ id, name, cur, prev, date, unit, error? }`
- **unit 字段**：BLS 数据本身不带单位，在 `fetchBLS()` 中根据 series ID 硬编码映射

```javascript
async fetchBLS(panel) {
  const key = this.plugin.settings.blsApiKey;
  const url = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
  const payload = {
    seriesid: panel.series.map(s => s.id),
    startyear: String(new Date().getFullYear() - 1),
    endyear:   String(new Date().getFullYear()),
    ...(key && { registrationkey: key })
  };
  const r = await obsidian.requestUrl({ url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (r.status !== 200) throw new Error(`BLS API ${r.status}`);
  const results = r.json?.Results?.series || [];
  // 解析最新2条，映射到 rows
  ...
}
```

### 1.3 fetchISM(panel) 实现

- **ISM 数据**：通过 CSV 下载页面获取，无需 Key
- **端点**：`https://api.ism.gov/indexes/{indexName}/data`（或直接从 ISM 官网手动下载 CSV）
- **数据特点**：单一 PMI 值，不是多 series 结构
- **策略**：`fetchISM()` 返回格式与 FRED 一致，单个 `{ id, name, cur, prev, date, unit }` 记录
- **series ID 映射**：`MANPMI` = 制造业 PMI，`SRVPMI` = 服务业 PMI

```javascript
async fetchISM(panel) {
  const idx = panel.series[0]?.id; // ism 只支持单指标
  const url = `https://api.ism.gov/indexes/${idx}/data?startYear=2024&endYear=2026`;
  const r = await obsidian.requestUrl({ url, method: 'GET' });
  const text = await r.text();
  // 解析 CSV，取最新2行
  ...
}
```

### 1.4 统一缓存格式

所有数据源统一写缓存：

```json
{
  "ts": "2026-04-01T00:00:00.000Z",
  "data": [
    { "id": "CPIAUCSL", "name": "CPI 总体", "unit": "指数", "cur": 315.3, "prev": 314.1, "date": "2026-02" }
  ]
}
```

## 二、frontmatter 补充

### 2.1 CPI.md

```yaml
data_panel:
  source: fred
  cache: Glossary/data/cpi-cache.json
  series:
    - { id: CPIAUCSL, name: CPI 总体, unit: 指数 }
    - { id: CPILFESL, name: 核心 CPI, unit: 指数 }
```

### 2.2 失业率 + 初请（新增专门笔记或扩展现有）

```yaml
data_panel:
  source: bls
  cache: Glossary/data/labor-cache.json
  series:
    - { id: LMUNRRTT01USM695S, name: 失业率, unit: "%" }
    - { id: ICSA, name: 初请失业金, unit: 千人 }
```

### 2.3 零售销售

```yaml
data_panel:
  source: fred
  cache: Glossary/data/retail-cache.json
  series:
    - { id: RSXFS, name: 零售销售, unit: 百万美元 }
```

### 2.4 GDP

```yaml
data_panel:
  source: fred
  cache: Glossary/data/gdp-cache.json
  series:
    - { id: GDPC1, name: 实际 GDP, unit: 十亿美元 }
```

### 2.5 工业产出 + 产能利用率

```yaml
data_panel:
  source: fred
  cache: Glossary/data/indpro-cache.json
  series:
    - { id: INDPRO, name: 工业产出, unit: 指数 }
    - { id: TCU, name: 产能利用率, unit: "%" }
```

## 三、实现顺序

1. `main.js` 加 `fetchBLS()`、`fetchISM()` 方法，更新 `fetchData()` switch
2. 创建对应的初始缓存 JSON 文件到 vault
3. 补充 5 类笔记的 `data_panel` frontmatter

## 四、设置页扩展

`MacroDataSettingTab` 新增 BLS API Key 输入框（可选，因为免费额度够用）：

```javascript
new obsidian.Setting(containerEl)
  .setName('BLS API Key（可选）')
  .setDesc('免费申请：https://data.bls.gov/registrationEngine/')
  .addText(t => t
    .setPlaceholder('可选')
    .setValue(this.plugin.settings.blsApiKey)
    .onChange(async v => {
      this.plugin.settings.blsApiKey = v.trim();
      await this.plugin.saveSettings();
    })
  );
```

`DEFAULT_SETTINGS` 更新为 `{ fredApiKey: '', blsApiKey: '' }`。
