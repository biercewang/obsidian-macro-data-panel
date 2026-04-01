'use strict';

var obsidian = require('obsidian');

const VIEW_TYPE = 'macro-data-panel';

// ── 侧边栏 View ───────────────────────────────────────────────────────
class MacroDataView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.currentFile = null;
  }

  getViewType()    { return VIEW_TYPE; }
  getDisplayText() { return '宏观数据'; }
  getIcon()        { return 'bar-chart-2'; }

  async onOpen() {
    this.containerEl.addClass('macro-data-panel');
    this.contentEl = this.containerEl.children[1]; // ItemView 的内容区
    this.showPlaceholder('打开含 data_panel 配置的笔记以加载数据');
    const file = this.app.workspace.getActiveFile();
    if (file) await this.refresh(file);
  }

  showPlaceholder(msg) {
    this.contentEl.empty();
    const wrap = this.contentEl.createDiv({ cls: 'mdp-placeholder' });
    wrap.createEl('span', { text: msg });
  }

  // 外部调用入口：文件切换时触发
  async refresh(file) {
    if (!file) { this.showPlaceholder('没有打开的文件'); return; }
    if (this.currentFile === file.path) return; // 同一文件不重复刷新
    this.currentFile = file.path;

    const meta  = this.app.metadataCache.getFileCache(file);
    const panel = meta?.frontmatter?.data_panel;

    if (!panel) {
      this.showPlaceholder('当前笔记没有 data_panel 配置');
      return;
    }

    this.contentEl.empty();
    this.contentEl.createDiv({ cls: 'mdp-title', text: file.basename });
    const body = this.contentEl.createDiv({ cls: 'mdp-body' });
    body.createDiv({ cls: 'mdp-loading', text: '⏳ 加载中...' });

    try {
      const { rows, label } = await this.fetchData(panel);
      this.renderTable(body, rows, label, panel);
      if (panel.cache && rows.some(r => !r.error && !isNaN(r.cur))) {
        this.saveCache(panel.cache, rows).catch(() => {});
      }
    } catch (err) {
      // 降级到本地缓存
      if (panel.cache) {
        try {
          const cached = await this.loadCache(panel.cache);
          this.renderTable(body, cached.data, `缓存 ${(cached.ts || '').slice(0, 10)}`, panel);
          return;
        } catch {}
      }
      body.empty();
      body.createDiv({ cls: 'mdp-error', text: `❌ ${err.message}` });
    }
  }

  // ── 数据路由 ───────────────────────────────────────────────────────
  async fetchData(panel) {
    switch (panel.source) {
      case 'fred':  return this.fetchFRED(panel);
      case 'bls':   return this.fetchBLS(panel);
      case 'ism':   return this.fetchISM(panel);
      case 'local': return this.fetchLocal(panel);
      default: throw new Error(`未知数据源：${panel.source}`);
    }
  }

  async fetchFRED(panel) {
    const key = this.plugin.settings.fredApiKey;
    if (!key) throw new Error('未配置 FRED API Key（设置 → 宏观数据面板）');

    const series = panel.series || [];
    const rows = await Promise.all(series.map(async s => {
      try {
        const url = 'https://api.stlouisfed.org/fred/series/observations'
          + `?series_id=${s.id}&api_key=${key}&sort_order=desc&limit=2&file_type=json`;
        const r = await obsidian.requestUrl({ url, method: 'GET' });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        const obs = r.json?.observations || [];
        return { ...s, cur: parseFloat(obs[0]?.value), prev: parseFloat(obs[1]?.value), date: obs[0]?.date };
      } catch (e) {
        return { ...s, cur: NaN, prev: NaN, date: null, error: e.message };
      }
    }));

    const errs = rows.filter(r => r.error);
    const label = 'FRED / BLS' + (errs.length ? `（${errs.map(r => r.id).join(', ')} 失败）` : '');
    return { rows, label };
  }

  async fetchLocal(panel) {
    if (!panel.file) throw new Error('local 源需要 file 路径');
    const f = this.app.vault.getAbstractFileByPath(panel.file);
    if (!f) throw new Error(`文件不存在：${panel.file}`);
    const raw = JSON.parse(await this.app.vault.read(f));
    return { rows: Array.isArray(raw) ? raw : raw.data, label: '本地数据库' };
  }

  async fetchBLS(panel) {
    const key = this.plugin.settings.blsApiKey;
    const url = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
    const blsUnitMap = {
      UNRATE:   '%',
      CPIAUCSL: '指数',
      ICSA:     '千人',
    };
    const currentYear = new Date().getFullYear();
    const payload = {
      seriesid: panel.series.map(s => s.id),
      startyear: String(currentYear - 1),
      endyear:   String(currentYear),
      ...(key && { registrationkey: key })
    };
    const r = await obsidian.requestUrl({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (r.status !== 200) throw new Error(`BLS API ${r.status}`);
    const results = r.json?.Results?.series || [];
    const rows = results.map(seriesItem => {
      const s = panel.series.find(x => x.id === seriesItem.ID) || {};
      const data = seriesItem.data || [];
      const sorted = data.sort((a, b) => {
        if (a.year !== b.year) return b.year - a.year;
        return (b.period || '').localeCompare(a.period || '');
      });
      const cur  = sorted[0];
      const prev = sorted[1];
      return {
        id:    s.id    || seriesItem.ID,
        name:  s.name  || seriesItem.ID,
        unit:  blsUnitMap[s.id] || s.unit || '',
        cur:   parseFloat(cur?.value),
        prev:  parseFloat(prev?.value),
        date:  cur ? `${cur.year}-${(cur.period || '').replace('M', '')}` : null
      };
    });
    return { rows, label: 'BLS / 美国劳工统计局' };
  }

  async fetchISM(panel) {
    const idx = panel.series[0];
    if (!idx) throw new Error('ISM 数据源需要 series 配置');
    // ISM CSV 端点（示例：制造业 PMI）
    const url = `https://api.ism.gov/indexes/${idx.id}/data?startYear=${new Date().getFullYear() - 1}&endYear=${new Date().getFullYear()}&format=csv`;
    const r = await obsidian.requestUrl({ url, method: 'GET' });
    if (r.status !== 200) throw new Error(`ISM API ${r.status}`);
    const text = r.text;
    // 解析 CSV：跳过 header 行，取最后2条数据
    const lines = text.trim().split('\n');
    const header = lines[0].split(',');
    const dateIdx = header.findIndex(h => h.includes('Date') || h.includes('Period'));
    const valueIdx = header.findIndex(h => h.includes('Index') || h.includes('Value'));
    if (dateIdx === -1 || valueIdx === -1) {
      throw new Error(`ISM CSV 格式异常：未找到 Date/Period 或 Index/Value 列。header: ${header.join(',')}`);
    }
    const dataLines = lines.slice(1);
    const curLine = dataLines[dataLines.length - 1]?.split(',');
    const prevLine = dataLines[dataLines.length - 2]?.split(',');
    return {
      rows: [{
        id:    idx.id,
        name:  idx.name || idx.id,
        unit:  idx.unit || '%',
        cur:   parseFloat(curLine?.[valueIdx]),
        prev:  parseFloat(prevLine?.[valueIdx]),
        date:  curLine?.[dateIdx]?.trim()
      }],
      label: 'ISM / 供应管理协会'
    };
  }

  // ── 渲染 ────────────────────────────────────────────────────────────
  renderTable(container, rows, label, panel) {
    container.empty();

    // V/U 比
    const jo = rows.find(r => r.id === 'JTSJOL');
    const un = rows.find(r => r.id === 'UNEMPLOY');
    const vu = panel.showVU && jo && un && !isNaN(jo.cur) && !isNaN(un.cur)
      ? (jo.cur / un.cur).toFixed(2) : null;

    const table = container.createEl('table', { cls: 'mdp-table' });
    const thead = table.createEl('thead');
    const hrow  = thead.createEl('tr');
    ['指标', '最新', '上期', '环比', '统计期'].forEach(h =>
      hrow.createEl('th', { text: h })
    );

    const tbody = table.createEl('tbody');

    rows.filter(r => !r.hidden).forEach(r => {
      const tr = tbody.createEl('tr');
      tr.createEl('td', { text: r.name, cls: 'mdp-name' });

      if (r.error) {
        const td = tr.createEl('td', { text: '获取失败', cls: 'mdp-err-cell' });
        td.setAttribute('colspan', '4');
        td.title = r.error;
        return;
      }

      const fmt = (v, u) => isNaN(v) ? '—'
        : u === '%' ? v.toFixed(2) + '%'
        : Math.round(v).toLocaleString('en-US') + ' 千';

      tr.createEl('td', { text: fmt(r.cur,  r.unit), cls: 'mdp-cur'  });
      tr.createEl('td', { text: fmt(r.prev, r.unit), cls: 'mdp-prev' });

      const diff = r.cur - r.prev;
      const fmtD = isNaN(diff) ? '—'
        : (diff > 0 ? '▲ ' : diff < 0 ? '▼ ' : '─ ')
          + (r.unit === '%'
            ? Math.abs(diff).toFixed(2) + '%'
            : Math.abs(Math.round(diff)).toLocaleString());
      tr.createEl('td', {
        text: fmtD,
        cls: 'mdp-diff ' + (diff > 0 ? 'mdp-up' : diff < 0 ? 'mdp-down' : 'mdp-flat')
      });
      tr.createEl('td', { text: r.date || '—', cls: 'mdp-date' });
    });

    // V/U 行
    if (vu) {
      const vuVal = parseFloat(vu);
      const tr = tbody.createEl('tr', { cls: 'mdp-vu-row' });
      tr.createEl('td', { text: 'V/U 比', cls: 'mdp-name mdp-vu-label' });
      const td = tr.createEl('td', {
        text: `${vu}  ${vuVal >= 1 ? '人选活' : '活选人'}`,
        cls: 'mdp-vu-val ' + (vuVal >= 1 ? 'mdp-up' : 'mdp-down')
      });
      td.setAttribute('colspan', '3');
      tr.createEl('td', { text: jo?.date || '—', cls: 'mdp-date' });
    }

    container.createDiv({
      cls:  'mdp-footer',
      text: `📡 ${label} · ${new Date().toLocaleString('zh-CN')}`
    });
  }

  // ── 缓存 ────────────────────────────────────────────────────────────
  async saveCache(path, data) {
    const json = JSON.stringify({ ts: new Date().toISOString(), data }, null, 2);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f) { await this.app.vault.modify(f, json); return; }
    const dir = path.split('/').slice(0, -1).join('/');
    try { await this.app.vault.createFolder(dir); } catch {}
    await this.app.vault.create(path, json);
  }

  async loadCache(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!f) throw new Error('no cache');
    return JSON.parse(await this.app.vault.read(f));
  }
}

// ── 设置页 ────────────────────────────────────────────────────────────
class MacroDataSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: '宏观数据面板' });

    new obsidian.Setting(containerEl)
      .setName('FRED API Key')
      .setDesc('免费申请：https://fred.stlouisfed.org/docs/api/api_key.html')
      .addText(t => t
        .setPlaceholder('粘贴你的 API Key')
        .setValue(this.plugin.settings.fredApiKey)
        .onChange(async v => {
          this.plugin.settings.fredApiKey = v.trim();
          await this.plugin.saveSettings();
        })
      );
  }
}

// ── 插件主体 ──────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = { fredApiKey: '', blsApiKey: '' };

class MacroDataPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, leaf => new MacroDataView(leaf, this));

    this.addRibbonIcon('bar-chart-2', '宏观数据面板', () => this.activateView());

    this.addCommand({
      id:       'open-macro-data-panel',
      name:     '打开宏观数据面板',
      callback: () => this.activateView()
    });

    this.addSettingTab(new MacroDataSettingTab(this.app, this));

    // 文件切换时刷新
    this.registerEvent(
      this.app.workspace.on('file-open', file => {
        const view = this.getView();
        if (view && file) {
          view.currentFile = null; // 强制刷新
          view.refresh(file);
        }
      })
    );

    // 启动时打开侧边栏
    this.app.workspace.onLayoutReady(() => this.activateView());
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  getView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    return leaves.length ? leaves[0].view : null;
  }

  async activateView() {
    const { workspace } = this.app;
    if (workspace.getLeavesOfType(VIEW_TYPE).length) {
      workspace.revealLeaf(workspace.getLeavesOfType(VIEW_TYPE)[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = MacroDataPlugin;
