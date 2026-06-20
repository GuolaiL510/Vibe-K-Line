import * as vscode from 'vscode';
import { MarketEngine, FileStock, Candle, MarketSummary, Timeframe, EditEvent, SectorInfo } from './market-engine';

export class Panel implements vscode.Disposable {
  public static currentPanel: Panel | undefined;

  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private updateDisposable: vscode.Disposable;

  public static createOrShow(extensionUri: vscode.Uri, engine: MarketEngine): Panel {
    if (Panel.currentPanel) {
      Panel.currentPanel.panel.reveal();
      return Panel.currentPanel;
    }
    Panel.currentPanel = new Panel(extensionUri, engine);
    return Panel.currentPanel;
  }

  private constructor(
    private extensionUri: vscode.Uri,
    private engine: MarketEngine
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'vibeKLine',
      'Vibe K-Line',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.updateDisposable = engine.onUpdate(() => this.refresh());
    this.panel.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'requestCandles') {
        this.sendCandles(msg.uri || null, msg.timeframe as Timeframe, msg.view as 'market' | 'file');
      }
      if (msg.type === 'requestFileDetail') {
        this.sendFileDetail(msg.uri);
      }
    }, null, this.disposables);
  }

  refresh(): void {
    const stocks = this.engine.getStocks();
    const active = this.engine.getActiveStocks();
    const summary = this.engine.getMarketSummary();
    const tags = Object.fromEntries(stocks.map(s => [s.uri, this.engine.getTag(s)]));
    const recentEdits = this.engine.getRecentEdits();
    const sectors = this.engine.getSectors();

    this.panel.webview.postMessage({
      type: 'update',
      summary,
      tags,
      stocks: active,
      delisted: this.engine.getDelistedStocks(),
      gainers: this.engine.getGainers(),
      losers: this.engine.getLosers(),
      recentEdits,
      sectors,
      workspaceName: vscode.workspace.name || 'Workspace',
    });
  }

  dispose(): void {
    Panel.currentPanel = undefined;
    this.updateDisposable.dispose();
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private sendCandles(uri: string | null, timeframe: Timeframe, view: 'market' | 'file'): void {
    if (view === 'market') {
      const candles = this.engine.getMarketCandles(timeframe);
      this.panel.webview.postMessage({ type: 'candles', view: 'market', candles });
    } else if (uri) {
      const stock = this.engine.getStock(uri);
      if (stock) {
        const candles = this.engine.getCandlesForTimeframe(stock, timeframe);
        this.panel.webview.postMessage({ type: 'candles', view: 'file', candles, stock });
      }
    }
  }

  private sendFileDetail(uri: string): void {
    const stock = this.engine.getStock(uri);
    if (!stock) return;
    const candles = this.engine.getCandlesForTimeframe(stock, '10s');
    this.panel.webview.postMessage({ type: 'fileDetail', stock, candles });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Vibe K-Line</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --up: #ff4d4f;
      --down: #52c41a;
      --neutral: var(--vscode-descriptionForeground, #8899a6);
      --bg: var(--vscode-editor-background, #0b0e11);
      --fg: var(--vscode-foreground, #e0e0e0);
      --panel-bg: var(--vscode-panel-background, #151a1f);
      --panel-border: var(--vscode-panel-border, #1e2329);
      --hover-bg: var(--vscode-list-hoverBackground, #1e2329);
      --active-bg: var(--vscode-list-activeSelectionBackground, #2a3038);
      --badge-bg: var(--vscode-badge-background, #2a3038);
      --badge-fg: var(--vscode-badge-foreground, #e0e0e0);
      --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    }
    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--fg);
      min-height: 100vh;
      overflow-x: hidden;
    }
    .hidden { display: none !important; }

    /* Toolbar */
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--panel-border);
      background: var(--panel-bg);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .toolbar-left { display: flex; align-items: center; gap: 12px; }
    .toolbar-title { font-size: 15px; font-weight: 700; }
    .mode-badge {
      font-size: 10px; padding: 2px 8px; border-radius: 4px;
      background: var(--badge-bg); color: var(--badge-fg); text-transform: uppercase; letter-spacing: 0.5px;
    }
    .toolbar-right { display: flex; align-items: center; gap: 4px; }
    .tf-btn {
      font-size: 11px; padding: 4px 10px; border: 1px solid var(--panel-border);
      background: transparent; color: var(--neutral); border-radius: 4px; cursor: pointer;
      font-family: var(--font);
    }
    .tf-btn:hover { background: var(--hover-bg); color: var(--fg); }
    .tf-btn.active { background: var(--active-bg); color: var(--fg); border-color: var(--neutral); }

    /* Summary Cards */
    .summary-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px;
      padding: 12px 16px;
    }
    .card {
      background: var(--panel-bg);
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      padding: 10px;
    }
    .card-label { font-size: 10px; color: var(--neutral); text-transform: uppercase; letter-spacing: 0.4px; }
    .card-value { font-size: 16px; font-weight: 700; margin-top: 4px; font-family: monospace; }
    .card-sub { font-size: 10px; color: var(--neutral); margin-top: 2px; }
    .up { color: var(--up); }
    .down { color: var(--down); }
    .neutral { color: var(--neutral); }

    /* Main Layout */
    .main-layout {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 12px;
      padding: 0 16px 12px;
      min-height: 0;
    }
    @media (max-width: 900px) {
      .main-layout { grid-template-columns: 1fr; }
    }

    /* Stock List */
    .stock-list-container {
      background: var(--panel-bg);
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      max-height: 480px;
    }
    .stock-list-header {
      display: grid;
      grid-template-columns: 1fr 60px 70px 50px 80px;
      gap: 4px;
      padding: 8px 10px;
      font-size: 10px;
      color: var(--neutral);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      border-bottom: 1px solid var(--panel-border);
      background: var(--bg);
    }
    .stock-list-body { overflow-y: auto; flex: 1; }
    .stock-row {
      display: grid;
      grid-template-columns: 1fr 60px 70px 50px 80px;
      gap: 4px;
      padding: 6px 10px;
      font-size: 12px;
      align-items: center;
      cursor: pointer;
      border-bottom: 1px solid var(--panel-border);
    }
    .stock-row:hover { background: var(--hover-bg); }
    .stock-row.active { background: var(--active-bg); }
    .stock-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stock-right { text-align: right; font-family: monospace; }
    .tag {
      display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 3px;
      background: var(--badge-bg); color: var(--badge-fg); white-space: nowrap;
    }

    /* Chart Area */
    .chart-area { display: flex; flex-direction: column; gap: 10px; }
    .chart-box {
      background: var(--panel-bg);
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      position: relative;
      height: 280px;
    }
    .chart-box canvas { display: block; width: 100%; height: 100%; border-radius: 6px; }
    .chart-title {
      position: absolute; top: 8px; left: 10px; font-size: 11px; color: var(--neutral); z-index: 2;
      pointer-events: none;
    }

    /* Heatmap */
    .heatmap-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 6px;
    }
    .heatmap-cell {
      background: var(--panel-bg);
      border: 1px solid var(--panel-border);
      border-radius: 4px;
      padding: 8px;
      font-size: 11px;
    }
    .heatmap-dir { color: var(--neutral); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .heatmap-lines { font-weight: 700; font-family: monospace; margin-top: 2px; }
    .heatmap-change { font-size: 10px; font-family: monospace; }

    /* Bottom Sections */
    .bottom-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      padding: 0 16px 12px;
    }
    @media (max-width: 1100px) {
      .bottom-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 600px) {
      .bottom-grid { grid-template-columns: 1fr; }
    }
    .bottom-card {
      background: var(--panel-bg);
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      padding: 10px;
    }
    .bottom-card h3 { font-size: 11px; color: var(--neutral); text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 8px; }
    .bottom-item {
      display: flex; justify-content: space-between; align-items: center;
      padding: 3px 0; font-size: 12px;
    }
    .bottom-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
    .bottom-value { font-family: monospace; font-weight: 600; }
    .no-data { color: var(--neutral); font-size: 12px; text-align: center; padding: 8px 0; }

    /* Edit Tape */
    .tape-scroll {
      max-height: 120px; overflow-y: auto; font-size: 11px; font-family: monospace;
    }
    .tape-item { display: flex; gap: 6px; padding: 2px 0; border-bottom: 1px solid var(--panel-border); }
    .tape-time { color: var(--neutral); min-width: 42px; }
    .tape-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tape-net { min-width: 50px; text-align: right; }

    /* File Detail Page */
    .detail-header {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--panel-border);
      background: var(--panel-bg);
    }
    .back-btn {
      font-size: 18px; cursor: pointer; padding: 4px 8px; border-radius: 4px;
      background: transparent; border: none; color: var(--fg); line-height: 1;
    }
    .back-btn:hover { background: var(--hover-bg); }
    .detail-title { font-size: 15px; font-weight: 700; }
    .detail-path { font-size: 11px; color: var(--neutral); }
    .detail-meta { display: flex; align-items: center; gap: 10px; margin-left: auto; }
    .detail-loc { font-size: 14px; font-family: monospace; font-weight: 700; }
    .detail-change { font-size: 13px; font-family: monospace; }

    .detail-layout {
      display: grid;
      grid-template-columns: 1fr 240px;
      gap: 12px;
      padding: 12px 16px;
    }
    @media (max-width: 900px) {
      .detail-layout { grid-template-columns: 1fr; }
    }
    .detail-chart-box { height: 360px; }
    .detail-vol-box { height: 120px; }
    .info-card {
      background: var(--panel-bg);
      border: 1px solid var(--panel-border);
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 10px;
    }
    .info-card h4 { font-size: 11px; color: var(--neutral); text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 8px; }
    .info-row { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; }
    .info-label { color: var(--neutral); }
    .info-value { font-family: monospace; font-weight: 600; }
    .detail-edits { padding: 0 16px 12px; }
    .detail-edits h3 { font-size: 11px; color: var(--neutral); text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 8px; }
    .edit-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .edit-table th, .edit-table td { padding: 5px 8px; text-align: left; border-bottom: 1px solid var(--panel-border); }
    .edit-table th { color: var(--neutral); font-weight: 500; }
    .edit-table td { font-family: monospace; }
    .edit-table .right { text-align: right; }
  </style>
</head>
<body>
  <div id="page-overview">
    <div class="toolbar">
      <div class="toolbar-left">
        <div class="toolbar-title">Vibe K-Line</div>
        <div class="mode-badge">Realtime</div>
        <div class="toolbar-title" style="font-size:12px;color:var(--neutral);font-weight:400;" id="workspaceName"></div>
      </div>
      <div class="toolbar-right" id="overviewTf">
        <button class="tf-btn active" data-tf="10s">10s</button>
        <button class="tf-btn" data-tf="1m">1m</button>
        <button class="tf-btn" data-tf="5m">5m</button>
        <button class="tf-btn" data-tf="day">Day</button>
        <button class="tf-btn" data-tf="month">Month</button>
        <button class="tf-btn" data-tf="quarter">Quarter</button>
        <button class="tf-btn" data-tf="year">Year</button>
      </div>
    </div>

    <div class="summary-row" id="summaryCards">
      <div class="card"><div class="card-label">Vibe Index</div><div class="card-value" id="vibeScore">0</div><div class="card-sub" id="vibeStatus">Stable</div></div>
      <div class="card"><div class="card-label">Market Index</div><div class="card-value" id="totalLines">0</div><div class="card-sub">total LOC</div></div>
      <div class="card"><div class="card-label">Volume</div><div class="card-value" id="totalVolume">0</div><div class="card-sub">line changes</div></div>
      <div class="card"><div class="card-label">IPO</div><div class="card-value" id="ipoCount">0</div><div class="card-sub">new files</div></div>
      <div class="card"><div class="card-label">Delisted</div><div class="card-value down" id="delistedCount">0</div><div class="card-sub">removed</div></div>
      <div class="card"><div class="card-label">Bullish</div><div class="card-value up" id="bullishCount">0</div><div class="card-sub">gaining</div></div>
      <div class="card"><div class="card-label">Bearish</div><div class="card-value down" id="bearishCount">0</div><div class="card-sub">losing</div></div>
    </div>

    <div class="main-layout">
      <div class="stock-list-container">
        <div class="stock-list-header">
          <div>Symbol</div><div class="stock-right">LOC</div><div class="stock-right">Chg%</div><div class="stock-right">Vol</div><div>Status</div>
        </div>
        <div class="stock-list-body" id="stockList"></div>
      </div>
      <div class="chart-area">
        <div class="chart-box">
          <div class="chart-title">Market Candle Chart</div>
          <canvas id="marketChart"></canvas>
        </div>
        <div class="heatmap-grid" id="sectorHeatmap"></div>
      </div>
    </div>

    <div class="bottom-grid">
      <div class="bottom-card"><h3>Top Gainers</h3><div id="gainers"></div></div>
      <div class="bottom-card"><h3>Top Losers</h3><div id="losers"></div></div>
      <div class="bottom-card"><h3>IPO</h3><div id="ipoList"></div></div>
      <div class="bottom-card"><h3>Delisted</h3><div id="delistedList"></div></div>
    </div>

    <div style="padding: 0 16px 12px;">
      <div class="bottom-card"><h3>Recent Edits Tape</h3><div class="tape-scroll" id="editTape"></div></div>
    </div>
  </div>

  <div id="page-file-detail" class="hidden">
    <div class="detail-header">
      <button class="back-btn" id="backBtn">&#8592;</button>
      <div>
        <div class="detail-title" id="detailName">File</div>
        <div class="detail-path" id="detailPath"></div>
      </div>
      <div class="detail-meta">
        <span class="tag" id="detailTag">Stable</span>
        <span class="detail-loc" id="detailLoc">0</span>
        <span class="detail-change" id="detailChange">0%</span>
      </div>
    </div>
    <div class="toolbar" style="position:static;border-top:1px solid var(--panel-border);">
      <div class="toolbar-left"><div class="toolbar-title" style="font-size:13px;">Timeframe</div></div>
      <div class="toolbar-right" id="detailTf">
        <button class="tf-btn active" data-tf="10s">10s</button>
        <button class="tf-btn" data-tf="1m">1m</button>
        <button class="tf-btn" data-tf="5m">5m</button>
        <button class="tf-btn" data-tf="day">Day</button>
        <button class="tf-btn" data-tf="month">Month</button>
        <button class="tf-btn" data-tf="quarter">Quarter</button>
        <button class="tf-btn" data-tf="year">Year</button>
      </div>
    </div>
    <div class="detail-layout">
      <div class="chart-area">
        <div class="chart-box detail-chart-box">
          <div class="chart-title">Candle Chart</div>
          <canvas id="detailCandleChart"></canvas>
        </div>
        <div class="chart-box detail-vol-box">
          <div class="chart-title">Volume</div>
          <canvas id="detailVolChart"></canvas>
        </div>
      </div>
      <div>
        <div class="info-card">
          <h4>OHLC</h4>
          <div class="info-row"><span class="info-label">Open</span><span class="info-value" id="ohlcOpen">-</span></div>
          <div class="info-row"><span class="info-label">High</span><span class="info-value" id="ohlcHigh">-</span></div>
          <div class="info-row"><span class="info-label">Low</span><span class="info-value" id="ohlcLow">-</span></div>
          <div class="info-row"><span class="info-label">Close</span><span class="info-value" id="ohlcClose">-</span></div>
          <div class="info-row"><span class="info-label">Volume</span><span class="info-value" id="ohlcVol">-</span></div>
        </div>
        <div class="info-card">
          <h4>Lifecycle</h4>
          <div class="info-row"><span class="info-label">Listed</span><span class="info-value" id="lifeListed">-</span></div>
          <div class="info-row"><span class="info-label">Highest LOC</span><span class="info-value" id="lifeHigh">-</span></div>
          <div class="info-row"><span class="info-label">Lowest LOC</span><span class="info-value" id="lifeLow">-</span></div>
          <div class="info-row"><span class="info-label">Biggest Pump</span><span class="info-value up" id="lifePump">-</span></div>
          <div class="info-row"><span class="info-label">Biggest Drop</span><span class="info-value down" id="lifeDrop">-</span></div>
        </div>
      </div>
    </div>
    <div class="detail-edits">
      <h3>Recent Edits</h3>
      <table class="edit-table"><thead><tr><th>Time</th><th>Added</th><th>Removed</th><th class="right">Net</th></tr></thead><tbody id="detailEditTable"></tbody></table>
    </div>
  </div>

  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      let currentView = 'overview';
      let selectedUri = null;
      let allStocks = [];
      let delistedStocks = [];
      let tags = {};
      let recentEdits = [];
      let sectors = [];
      let overviewTf = '10s';
      let detailTf = '10s';
      let marketCandles = [];
      let fileCandles = [];

      const pageOverview = document.getElementById('page-overview');
      const pageDetail = document.getElementById('page-file-detail');
      const backBtn = document.getElementById('backBtn');

      const marketCanvas = document.getElementById('marketChart');
      const marketCtx = marketCanvas.getContext('2d');
      const detailCandleCanvas = document.getElementById('detailCandleChart');
      const detailCandleCtx = detailCandleCanvas.getContext('2d');
      const detailVolCanvas = document.getElementById('detailVolChart');
      const detailVolCtx = detailVolCanvas.getContext('2d');
      let dpr = window.devicePixelRatio || 1;

      function setView(view) {
        currentView = view;
        if (view === 'overview') {
          pageOverview.classList.remove('hidden');
          pageDetail.classList.add('hidden');
        } else {
          pageOverview.classList.add('hidden');
          pageDetail.classList.remove('hidden');
        }
        requestAnimationFrame(() => {
          resizeAll();
          renderAll();
        });
      }

      backBtn.addEventListener('click', () => setView('overview'));

      function setupTfButtons(containerId, currentVar, renderFn) {
        const container = document.getElementById(containerId);
        container.addEventListener('click', (e) => {
          const btn = e.target.closest('.tf-btn');
          if (!btn) return;
          container.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          if (containerId === 'overviewTf') {
            overviewTf = btn.dataset.tf;
          } else {
            detailTf = btn.dataset.tf;
          }
          vscode.postMessage({ type: 'requestCandles', uri: selectedUri, timeframe: btn.dataset.tf, view: containerId === 'overviewTf' ? 'market' : 'file' });
        });
      }
      setupTfButtons('overviewTf');
      setupTfButtons('detailTf');

      document.getElementById('stockList').addEventListener('click', (e) => {
        const row = e.target.closest('.stock-row');
        if (!row) return;
        selectedUri = row.dataset.uri;
        detailTf = '10s';
        document.getElementById('detailTf').querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
        document.getElementById('detailTf').querySelector('[data-tf="10s"]').classList.add('active');
        vscode.postMessage({ type: 'requestFileDetail', uri: selectedUri });
        setView('file-detail');
      });

      function resizeCanvas(canvas, ctx) {
        const container = canvas.parentElement;
        const rect = container.getBoundingClientRect();
        dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(rect.width * dpr));
        canvas.height = Math.max(1, Math.floor(rect.height * dpr));
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      function resizeAll() {
        resizeCanvas(marketCanvas, marketCtx);
        resizeCanvas(detailCandleCanvas, detailCandleCtx);
        resizeCanvas(detailVolCanvas, detailVolCtx);
      }
      const resizeHandler = () => { resizeAll(); renderAll(); };
      window.addEventListener('resize', resizeHandler);
      window.addEventListener('unload', () => {
        window.removeEventListener('resize', resizeHandler);
      });

      function renderAll() {
        renderMarketChart();
        renderDetailCharts();
      }

      function renderMarketChart() {
        const canvas = marketCanvas;
        const ctx = marketCtx;
        const rect = canvas.getBoundingClientRect();
        const W = rect.width;
        const H = rect.height;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();

        const candles = marketCandles;
        if (!candles || candles.length === 0) {
          ctx.fillStyle = 'var(--neutral)';
          ctx.font = '13px var(--font)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('Waiting for market data...', W / 2, H / 2);
          return;
        }
        drawCandles(ctx, W, H, candles, true);
      }

      function renderDetailCharts() {
        if (currentView !== 'file-detail' || !selectedUri) return;
        const rectC = detailCandleCanvas.getBoundingClientRect();
        const rectV = detailVolCanvas.getBoundingClientRect();

        detailCandleCtx.save();
        detailCandleCtx.setTransform(1, 0, 0, 1, 0, 0);
        detailCandleCtx.clearRect(0, 0, detailCandleCanvas.width, detailCandleCanvas.height);
        detailCandleCtx.restore();

        detailVolCtx.save();
        detailVolCtx.setTransform(1, 0, 0, 1, 0, 0);
        detailVolCtx.clearRect(0, 0, detailVolCanvas.width, detailVolCanvas.height);
        detailVolCtx.restore();

        const candles = fileCandles;
        if (!candles || candles.length === 0) {
          detailCandleCtx.fillStyle = 'var(--neutral)';
          detailCandleCtx.font = '13px var(--font)';
          detailCandleCtx.textAlign = 'center';
          detailCandleCtx.textBaseline = 'middle';
          detailCandleCtx.fillText('No candle data yet', rectC.width / 2, rectC.height / 2);
          return;
        }
        drawCandles(detailCandleCtx, rectC.width, rectC.height, candles, false);
        drawVolume(detailVolCtx, rectV.width, rectV.height, candles);
      }

      function drawCandles(ctx, W, H, candles, showLabels) {
        const padding = { top: 24, right: showLabels ? 60 : 10, bottom: 24, left: 10 };
        const chartW = W - padding.left - padding.right;
        const chartH = H - padding.top - padding.bottom;

        const maxPrice = Math.max(...candles.map(c => c.high));
        const minPrice = Math.min(...candles.map(c => c.low));
        const priceRange = maxPrice - minPrice || 1;
        const maxVol = Math.max(...candles.map(c => c.volume)) || 1;

        function x(i) {
          if (candles.length === 1) return padding.left + chartW / 2;
          return padding.left + (i / (candles.length - 1)) * chartW;
        }
        function y(price) { return padding.top + (1 - (price - minPrice) / priceRange) * chartH; }
        function yVol(vol) { return padding.top + chartH - (vol / maxVol) * (chartH * 0.25); }

        ctx.strokeStyle = 'var(--panel-border)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 5; i++) {
          const yy = padding.top + (i / 4) * chartH;
          ctx.beginPath();
          ctx.moveTo(padding.left, yy);
          ctx.lineTo(W - padding.right, yy);
          ctx.stroke();
        }

        if (showLabels) {
          ctx.fillStyle = 'var(--neutral)';
          ctx.font = '11px var(--font)';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          for (let i = 0; i < 5; i++) {
            const price = minPrice + (1 - i / 4) * priceRange;
            ctx.fillText(Math.round(price).toLocaleString(), W - padding.right + 4, padding.top + (i / 4) * chartH);
          }
        }

        const candleWidth = Math.max(2, (chartW / candles.length) * 0.55);
        for (let i = 0; i < candles.length; i++) {
          const c = candles[i];
          const xx = x(i);
          const isUp = c.close >= c.open;
          const color = isUp ? 'var(--up)' : 'var(--down)';

          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(xx, y(c.high));
          ctx.lineTo(xx, y(c.low));
          ctx.stroke();

          const bodyTop = y(Math.max(c.open, c.close));
          const bodyBottom = y(Math.min(c.open, c.close));
          const bodyH = Math.max(1, bodyBottom - bodyTop);
          ctx.fillStyle = color;
          ctx.fillRect(xx - candleWidth / 2, bodyTop, candleWidth, bodyH);

          const volY = yVol(c.volume);
          ctx.fillStyle = isUp ? 'rgba(255,77,79,0.2)' : 'rgba(82,196,26,0.2)';
          ctx.fillRect(xx - candleWidth / 2, volY, candleWidth, padding.top + chartH - volY);
        }

        ctx.fillStyle = 'var(--neutral)';
        ctx.font = '10px var(--font)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const step = Math.max(1, Math.floor(candles.length / 6));
        for (let i = 0; i < candles.length; i += step) {
          const d = new Date(candles[i].timestamp);
          const label = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
          ctx.fillText(label, x(i), H - 20);
        }
      }

      function drawVolume(ctx, W, H, candles) {
        const padding = { top: 20, right: 10, bottom: 20, left: 10 };
        const chartW = W - padding.left - padding.right;
        const chartH = H - padding.top - padding.bottom;
        const maxVol = Math.max(...candles.map(c => c.volume)) || 1;

        function x(i) {
          if (candles.length === 1) return padding.left + chartW / 2;
          return padding.left + (i / (candles.length - 1)) * chartW;
        }
        function yVol(vol) { return padding.top + chartH - (vol / maxVol) * chartH; }

        const barWidth = Math.max(2, (chartW / candles.length) * 0.6);
        for (let i = 0; i < candles.length; i++) {
          const c = candles[i];
          const xx = x(i);
          const isUp = c.close >= c.open;
          const volY = yVol(c.volume);
          ctx.fillStyle = isUp ? 'rgba(255,77,79,0.35)' : 'rgba(82,196,26,0.35)';
          ctx.fillRect(xx - barWidth / 2, volY, barWidth, padding.top + chartH - volY);
        }
      }

      function renderSummary(summary) {
        document.getElementById('vibeScore').textContent = summary.vibeScore.toLocaleString();
        document.getElementById('vibeScore').className = 'card-value ' + (summary.vibeScore > 0 ? 'up' : (summary.vibeScore < 0 ? 'down' : 'neutral'));
        document.getElementById('vibeStatus').textContent = summary.vibeStatus;
        document.getElementById('totalLines').textContent = summary.totalLines.toLocaleString();
        document.getElementById('totalVolume').textContent = summary.totalVolume.toLocaleString();
        document.getElementById('ipoCount').textContent = summary.ipoCount.toLocaleString();
        document.getElementById('delistedCount').textContent = summary.delisted.toLocaleString();
        document.getElementById('bullishCount').textContent = summary.bullishCount.toLocaleString();
        document.getElementById('bearishCount').textContent = summary.bearishCount.toLocaleString();
      }

      function renderStockList(stocks) {
        allStocks = stocks || [];
        const tbody = document.getElementById('stockList');
        if (allStocks.length === 0) {
          tbody.innerHTML = '<div class="no-data">No files tracked yet. Start editing to see market data.</div>';
          return;
        }
        tbody.innerHTML = allStocks.map(s => {
          const cls = s.changePercent > 0 ? 'up' : (s.changePercent < 0 ? 'down' : 'neutral');
          const sign = s.changePercent > 0 ? '+' : '';
          const totalVol = s.totalAdded + s.totalDeleted;
          const active = s.uri === selectedUri ? 'active' : '';
          const tag = escapeHtml(tags[s.uri] || 'Stable');
          return '<div class="stock-row ' + active + '" data-uri="' + escapeHtml(s.uri) + '">' +
            '<div class="stock-name" title="' + escapeHtml(s.uri) + '">' + escapeHtml(s.name) + '</div>' +
            '<div class="stock-right">' + s.currentLines + '</div>' +
            '<div class="stock-right ' + cls + '">' + sign + s.changePercent.toFixed(2) + '%</div>' +
            '<div class="stock-right">' + totalVol + '</div>' +
            '<div><span class="tag">' + tag + '</span></div>' +
          '</div>';
        }).join('');
      }

      function renderLeaders(gainers, losers) {
        const gEl = document.getElementById('gainers');
        const lEl = document.getElementById('losers');
        gEl.innerHTML = (gainers || []).map(s =>
          '<div class="bottom-item"><span class="bottom-name" title="' + escapeHtml(s.uri) + '">' + escapeHtml(s.name) + '</span><span class="bottom-value up">+' + s.changePercent.toFixed(2) + '%</span></div>'
        ).join('') || '<div class="no-data">No gainers</div>';
        lEl.innerHTML = (losers || []).map(s =>
          '<div class="bottom-item"><span class="bottom-name" title="' + escapeHtml(s.uri) + '">' + escapeHtml(s.name) + '</span><span class="bottom-value down">' + s.changePercent.toFixed(2) + '%</span></div>'
        ).join('') || '<div class="no-data">No losers</div>';
      }

      function renderIpoList(stocks) {
        const ipo = (stocks || []).filter(s => s.candles.length <= 1).slice(0, 10);
        const el = document.getElementById('ipoList');
        el.innerHTML = ipo.length ? ipo.map(s =>
          '<div class="bottom-item"><span class="bottom-name">' + escapeHtml(s.name) + '</span><span class="bottom-value">' + s.currentLines + ' LOC</span></div>'
        ).join('') : '<div class="no-data">No new files</div>';
      }

      function renderDelistedList(stocks) {
        const el = document.getElementById('delistedList');
        el.innerHTML = (stocks || []).length ? stocks.slice(0, 10).map(s =>
          '<div class="bottom-item"><span class="bottom-name">' + escapeHtml(s.name) + '</span><span class="bottom-value down">Delisted</span></div>'
        ).join('') : '<div class="no-data">No delisted files</div>';
      }

      function renderHeatmap(sectors) {
        const el = document.getElementById('sectorHeatmap');
        if (!sectors || sectors.length === 0) {
          el.innerHTML = '<div class="no-data">No sector data</div>';
          return;
        }
        el.innerHTML = sectors.map(s => {
          const cls = s.totalChange > 0 ? 'up' : (s.totalChange < 0 ? 'down' : 'neutral');
          const sign = s.totalChange > 0 ? '+' : '';
          return '<div class="heatmap-cell">' +
            '<div class="heatmap-dir">' + escapeHtml(s.directory) + '</div>' +
            '<div class="heatmap-lines">' + s.totalLines.toLocaleString() + ' LOC</div>' +
            '<div class="heatmap-change ' + cls + '">' + sign + s.totalChange + ' (' + s.files.length + ' files)</div>' +
          '</div>';
        }).join('');
      }

      function renderEditTape(edits) {
        const el = document.getElementById('editTape');
        if (!edits || edits.length === 0) {
          el.innerHTML = '<div class="no-data">No recent edits</div>';
          return;
        }
        el.innerHTML = edits.slice().reverse().map(e => {
          const d = new Date(e.timestamp);
          const time = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0');
          const net = e.added - e.removed;
          const cls = net > 0 ? 'up' : (net < 0 ? 'down' : 'neutral');
          const sign = net > 0 ? '+' : '';
          return '<div class="tape-item">' +
            '<span class="tape-time">' + time + '</span>' +
            '<span class="tape-name">' + escapeHtml(e.name) + '</span>' +
            '<span class="tape-net ' + cls + '">' + sign + net + '</span>' +
          '</div>';
        }).join('');
      }

      function renderDetail(stock, candles) {
        if (!stock) return;
        document.getElementById('detailName').textContent = escapeHtml(stock.name);
        document.getElementById('detailPath').textContent = escapeHtml(stock.uri);
        document.getElementById('detailTag').textContent = escapeHtml(tags[stock.uri] || 'Stable');
        document.getElementById('detailLoc').textContent = stock.currentLines.toLocaleString();
        const chgCls = stock.changePercent > 0 ? 'up' : (stock.changePercent < 0 ? 'down' : 'neutral');
        const chgSign = stock.changePercent > 0 ? '+' : '';
        document.getElementById('detailChange').textContent = chgSign + stock.changePercent.toFixed(2) + '%';
        document.getElementById('detailChange').className = 'detail-change ' + chgCls;

        const last = candles && candles.length > 0 ? candles[candles.length - 1] : null;
        document.getElementById('ohlcOpen').textContent = last ? last.open.toLocaleString() : '-';
        document.getElementById('ohlcHigh').textContent = last ? last.high.toLocaleString() : '-';
        document.getElementById('ohlcLow').textContent = last ? last.low.toLocaleString() : '-';
        document.getElementById('ohlcClose').textContent = last ? last.close.toLocaleString() : '-';
        document.getElementById('ohlcVol').textContent = last ? last.volume.toLocaleString() : '-';

        const lc = stock.lifecycle || {};
        document.getElementById('lifeListed').textContent = lc.listedDate ? new Date(lc.listedDate).toLocaleString() : '-';
        document.getElementById('lifeHigh').textContent = (lc.highestLoc || 0).toLocaleString();
        document.getElementById('lifeLow').textContent = (lc.lowestLoc || 0).toLocaleString();
        document.getElementById('lifePump').textContent = (lc.biggestPump || 0).toLocaleString();
        document.getElementById('lifeDrop').textContent = (lc.biggestDrop || 0).toLocaleString();

        const fileEdits = recentEdits.filter(e => e.uri === stock.uri).slice().reverse();
        const tbody = document.getElementById('detailEditTable');
        tbody.innerHTML = fileEdits.length ? fileEdits.map(e => {
          const d = new Date(e.timestamp);
          const time = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0');
          const net = e.added - e.removed;
          const netCls = net > 0 ? 'up' : (net < 0 ? 'down' : 'neutral');
          const netSign = net > 0 ? '+' : '';
          return '<tr><td>' + time + '</td><td class="up">+' + e.added + '</td><td class="down">-' + e.removed + '</td><td class="right ' + netCls + '">' + netSign + net + '</td></tr>';
        }).join('') : '<tr><td colspan="4" class="no-data">No recent edits</td></tr>';
      }

      function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
      }

      window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.type === 'update') {
          tags = msg.tags || {};
          allStocks = msg.stocks || [];
          delistedStocks = msg.delisted || [];
          recentEdits = msg.recentEdits || [];
          sectors = msg.sectors || [];
          document.getElementById('workspaceName').textContent = msg.workspaceName || '';
          renderSummary(msg.summary);
          renderStockList(allStocks);
          renderLeaders(msg.gainers, msg.losers);
          renderIpoList(allStocks);
          renderDelistedList(delistedStocks);
          renderHeatmap(sectors);
          renderEditTape(recentEdits);
          if (currentView === 'file-detail' && selectedUri) {
            const stock = allStocks.find(s => s.uri === selectedUri);
            if (stock) {
              renderDetail(stock, fileCandles);
            }
          }
          renderAll();
        }
        if (msg.type === 'candles') {
          if (msg.view === 'market') {
            marketCandles = msg.candles || [];
          } else if (msg.view === 'file') {
            fileCandles = msg.candles || [];
            if (msg.stock) {
              renderDetail(msg.stock, fileCandles);
            }
          }
          renderAll();
        }
        if (msg.type === 'fileDetail') {
          fileCandles = msg.candles || [];
          if (msg.stock) {
            renderDetail(msg.stock, fileCandles);
          }
          renderAll();
        }
      });

      vscode.postMessage({ type: 'requestCandles', uri: null, timeframe: '10s', view: 'market' });
      resizeAll();
      renderSummary({ totalLines: 0, totalVolume: 0, gainers: 0, losers: 0, unchanged: 0, delisted: 0, ipoCount: 0, bullishCount: 0, bearishCount: 0, vibeScore: 0, vibeStatus: '⚖️ Stable' });
      renderStockList([]);
      renderLeaders([], []);
      renderIpoList([]);
      renderDelistedList([]);
      renderHeatmap([]);
      renderEditTape([]);
    })();
  </script>
</body>
</html>`;
  }
}
