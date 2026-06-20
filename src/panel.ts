import * as vscode from 'vscode';
import { MarketEngine, FileStock, Candle, MarketSummary } from './market-engine';

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
      'codeMarket',
      'Code Market',
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
  }

  refresh(): void {
    const stocks = this.engine.getStocks();
    this.panel.webview.postMessage({
      type: 'update',
      summary: this.engine.getMarketSummary(),
      tags: Object.fromEntries(stocks.map(s => [s.uri, this.engine.getTag(s)])),
      stocks,
      gainers: this.engine.getGainers(),
      losers: this.engine.getLosers(),
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

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code Market</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --up: #ff4d4f;
      --down: #52c41a;
      --neutral: var(--vscode-descriptionForeground, #8899a6);
    }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      background: var(--vscode-editor-background, #0b0e11);
      color: var(--vscode-foreground, #e0e0e0);
      padding: 16px;
      min-height: 100vh;
    }
    h1 { font-size: 22px; margin-bottom: 4px; color: var(--vscode-foreground, #fff); }
    .subtitle { font-size: 12px; color: var(--neutral); margin-bottom: 16px; }
    h2 { font-size: 14px; margin: 16px 0 8px; color: var(--neutral); text-transform: uppercase; letter-spacing: 0.5px; }
    .section { margin-bottom: 24px; }

    .market-banner {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .metric-card {
      background: var(--vscode-panel-background, #151a1f);
      border: 1px solid var(--vscode-panel-border, #1e2329);
      border-radius: 8px;
      padding: 12px;
    }
    .metric-label { font-size: 11px; color: var(--neutral); text-transform: uppercase; letter-spacing: 0.4px; }
    .metric-value { font-size: 18px; font-weight: 700; margin-top: 4px; font-family: monospace; }
    .metric-sub { font-size: 11px; margin-top: 2px; color: var(--neutral); }

    .up { color: var(--up); }
    .down { color: var(--down); }
    .neutral { color: var(--neutral); }

    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 12px; text-align: left; }
    th { color: var(--neutral); font-weight: 500; border-bottom: 1px solid var(--vscode-panel-border, #1e2329); }
    td { border-bottom: 1px solid var(--vscode-panel-border, #151a1f); }
    tr:hover td { background: var(--vscode-list-hoverBackground, #151a1f); }
    .right { text-align: right; }
    .stock-row { cursor: pointer; }
    .stock-row.active { background: var(--vscode-list-activeSelectionBackground, #1e2329); }
    .tag {
      display: inline-block;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--vscode-badge-background, #1e2329);
      color: var(--vscode-badge-foreground, #e0e0e0);
      margin-left: 6px;
      white-space: nowrap;
    }
    .delisted { opacity: 0.55; }

    #chartContainer { position: relative; width: 100%; height: 340px; background: var(--vscode-panel-background, #151a1f); border-radius: 8px; margin-top: 8px; border: 1px solid var(--vscode-panel-border, #1e2329); }
    canvas { display: block; width: 100%; height: 100%; }
    .no-data { color: var(--neutral); text-align: center; padding: 40px; }
    .leaders { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .leader-card { background: var(--vscode-panel-background, #151a1f); border-radius: 8px; padding: 12px; border: 1px solid var(--vscode-panel-border, #1e2329); }
    .leader-card h3 { font-size: 12px; color: var(--neutral); margin-bottom: 8px; }
    .leader-item { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
    .leader-name { color: var(--vscode-foreground, #e0e0e0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
    .leader-value { font-weight: 600; }

    .selected-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .selected-title { font-size: 16px; font-weight: 700; }
    .selected-meta { font-size: 12px; color: var(--neutral); }
  </style>
</head>
<body>
  <h1>📈 Code Market</h1>
  <div class="subtitle">Every file is a stock. Every edit is a trade.</div>

  <div class="market-banner" id="marketBanner">
    <div class="metric-card">
      <div class="metric-label">Vibe Index</div>
      <div class="metric-value" id="vibeScore">0</div>
      <div class="metric-sub" id="vibeStatus">Stable</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Total Market Cap</div>
      <div class="metric-value" id="totalLines">0</div>
      <div class="metric-sub">lines of code</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Market Volume</div>
      <div class="metric-value" id="totalVolume">0</div>
      <div class="metric-sub">line changes</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Adv / Dec / Unch</div>
      <div class="metric-value" id="marketBreadth">0 / 0 / 0</div>
      <div class="metric-sub" id="delistedCount">0 delisted</div>
    </div>
  </div>

  <div class="section leaders">
    <div class="leader-card">
      <h3>🚀 Top Gainers</h3>
      <div id="gainers"></div>
    </div>
    <div class="leader-card">
      <h3>🔻 Top Losers</h3>
      <div id="losers"></div>
    </div>
  </div>

  <div class="section">
    <h2>File Stocks</h2>
    <table>
      <thead>
        <tr>
          <th>Symbol</th>
          <th class="right">Price (Lines)</th>
          <th class="right">Change %</th>
          <th class="right">Volume</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody id="stockList"></tbody>
    </table>
  </div>

  <div class="section">
    <div class="selected-header">
      <div class="selected-title" id="selectedTitle">Select a stock</div>
      <div class="selected-meta" id="selectedMeta">Click a file to view its K-line chart</div>
    </div>
    <div id="chartContainer">
      <canvas id="klineCanvas"></canvas>
    </div>
  </div>

  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      let selectedUri = null;
      let allStocks = [];
      let tags = {};

      const canvas = document.getElementById('klineCanvas');
      const ctx = canvas.getContext('2d');
      let dpr = window.devicePixelRatio || 1;

      function resizeCanvas() {
        const container = document.getElementById('chartContainer');
        const rect = container.getBoundingClientRect();
        dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(rect.width * dpr));
        canvas.height = Math.max(1, Math.floor(rect.height * dpr));
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderChart();
      }

      window.addEventListener('resize', resizeCanvas);

      function renderSummary(summary) {
        document.getElementById('vibeScore').textContent = summary.vibeScore.toLocaleString();
        document.getElementById('vibeScore').className = 'metric-value ' + (summary.vibeScore > 0 ? 'up' : (summary.vibeScore < 0 ? 'down' : 'neutral'));
        document.getElementById('vibeStatus').textContent = summary.vibeStatus;
        document.getElementById('totalLines').textContent = summary.totalLines.toLocaleString();
        document.getElementById('totalVolume').textContent = summary.totalVolume.toLocaleString();
        document.getElementById('marketBreadth').innerHTML =
          '<span class="up">' + summary.gainers + '</span> / <span class="down">' + summary.losers + '</span> / <span class="neutral">' + summary.unchanged + '</span>';
        document.getElementById('delistedCount').textContent = summary.delisted + ' delisted';
      }

      function renderLeaders(gainers, losers) {
        const gEl = document.getElementById('gainers');
        const lEl = document.getElementById('losers');
        gEl.innerHTML = (gainers || []).map(s =>
          '<div class="leader-item"><span class="leader-name" title="' + escapeHtml(s.uri) + '">' + escapeHtml(s.name) + '</span><span class="leader-value up">+' + s.changePercent.toFixed(2) + '%</span></div>'
        ).join('') || '<div class="no-data">No gainers</div>';
        lEl.innerHTML = (losers || []).map(s =>
          '<div class="leader-item"><span class="leader-name" title="' + escapeHtml(s.uri) + '">' + escapeHtml(s.name) + '</span><span class="leader-value down">' + s.changePercent.toFixed(2) + '%</span></div>'
        ).join('') || '<div class="no-data">No losers</div>';
      }

      function renderStockList(stocks) {
        allStocks = stocks || [];
        const tbody = document.getElementById('stockList');
        if (allStocks.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" class="no-data">No files tracked yet. Start editing to see market data.</td></tr>';
          return;
        }
        tbody.innerHTML = allStocks.map(s => {
          const cls = s.changePercent > 0 ? 'up' : (s.changePercent < 0 ? 'down' : 'neutral');
          const sign = s.changePercent > 0 ? '+' : '';
          const totalVol = s.totalAdded + s.totalDeleted;
          const active = s.uri === selectedUri ? 'active' : '';
          const delisted = s.status === 'delisted' ? ' delisted' : '';
          const tag = escapeHtml(tags[s.uri] || 'Stable');
          return '<tr class="stock-row ' + active + delisted + '" data-uri="' + escapeHtml(s.uri) + '">' +
            '<td>' + escapeHtml(s.name) + '</td>' +
            '<td class="right">' + s.currentLines + '</td>' +
            '<td class="right ' + cls + '">' + sign + s.changePercent.toFixed(2) + '%</td>' +
            '<td class="right">' + totalVol + '</td>' +
            '<td><span class="tag">' + tag + '</span></td>' +
          '</tr>';
        }).join('');
      }

      document.getElementById('stockList').addEventListener('click', (e) => {
        const row = e.target.closest('.stock-row');
        if (!row) return;
        selectedUri = row.getAttribute('data-uri');
        renderStockList(allStocks);
        renderChart();
      });

      function renderChart() {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();

        const rect = canvas.getBoundingClientRect();
        const W = rect.width;
        const H = rect.height;

        const stock = allStocks.find(s => s.uri === selectedUri);
        const title = document.getElementById('selectedTitle');
        const meta = document.getElementById('selectedMeta');

        if (!stock) {
          title.textContent = 'Select a stock';
          meta.textContent = 'Click a file to view its K-line chart';
          ctx.fillStyle = 'var(--vscode-descriptionForeground, #8899a6)';
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('Select a file stock to view K-line chart', W / 2, H / 2);
          return;
        }

        title.textContent = escapeHtml(stock.name);
        const tag = escapeHtml(tags[stock.uri] || 'Stable');
        meta.innerHTML = escapeHtml(stock.uri) + ' · O: ' + stock.candles.length + ' candles · ' + tag;

        if (!stock.candles || stock.candles.length === 0) {
          ctx.fillStyle = 'var(--vscode-descriptionForeground, #8899a6)';
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('Waiting for the first candle to close...', W / 2, H / 2);
          return;
        }

        const candles = stock.candles;
        const padding = { top: 20, right: 60, bottom: 30, left: 10 };
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
        function yVol(vol) { return padding.top + chartH - (vol / maxVol) * (chartH * 0.2); }

        // Grid
        ctx.strokeStyle = 'var(--vscode-panel-border, #1e2329)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 5; i++) {
          const yy = padding.top + (i / 4) * chartH;
          ctx.beginPath();
          ctx.moveTo(padding.left, yy);
          ctx.lineTo(W - padding.right, yy);
          ctx.stroke();
        }

        // Price labels
        ctx.fillStyle = 'var(--vscode-descriptionForeground, #8899a6)';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < 5; i++) {
          const price = minPrice + (1 - i / 4) * priceRange;
          ctx.fillText(Math.round(price).toString(), W - padding.right + 4, padding.top + (i / 4) * chartH);
        }

        // Candles - 中国股市：红涨绿跌
        const candleWidth = Math.max(2, (chartW / candles.length) * 0.6);
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
          ctx.fillStyle = isUp ? 'rgba(255,77,79,0.25)' : 'rgba(82,196,26,0.25)';
          ctx.fillRect(xx - candleWidth / 2, volY, candleWidth, padding.top + chartH - volY);
        }

        // Time labels
        ctx.fillStyle = 'var(--vscode-descriptionForeground, #8899a6)';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const step = Math.max(1, Math.floor(candles.length / 6));
        for (let i = 0; i < candles.length; i += step) {
          const d = new Date(candles[i].timestamp);
          const label = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
          ctx.fillText(label, x(i), H - 22);
        }
      }

      function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
      }

      window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.type === 'update') {
          tags = msg.tags || {};
          renderSummary(msg.summary);
          renderLeaders(msg.gainers, msg.losers);
          renderStockList(msg.stocks);
          renderChart();
        }
      });

      resizeCanvas();
      renderSummary({ totalLines: 0, totalVolume: 0, gainers: 0, losers: 0, unchanged: 0, delisted: 0, vibeScore: 0, vibeStatus: '⚖️ Stable' });
      renderLeaders([], []);
      renderStockList([]);
    })();
  </script>
</body>
</html>`;
  }
}
