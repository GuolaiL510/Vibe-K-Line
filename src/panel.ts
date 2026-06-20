import * as vscode from 'vscode';
import { MarketEngine, FileStock, Candle } from './market-engine';

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
    this.panel.webview.postMessage({
      type: 'update',
      stocks: this.engine.getStocks(),
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
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      background: var(--vscode-editor-background, #0b0e11);
      color: var(--vscode-foreground, #e0e0e0);
      padding: 16px;
      min-height: 100vh;
    }
    h1 { font-size: 20px; margin-bottom: 16px; color: var(--vscode-foreground, #fff); }
    h2 { font-size: 14px; margin: 16px 0 8px; color: var(--vscode-descriptionForeground, #8899a6); text-transform: uppercase; letter-spacing: 0.5px; }
    .section { margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 12px; text-align: left; }
    th { color: var(--vscode-descriptionForeground, #8899a6); font-weight: 500; border-bottom: 1px solid var(--vscode-panel-border, #1e2329); }
    td { border-bottom: 1px solid var(--vscode-panel-border, #151a1f); }
    tr:hover td { background: var(--vscode-list-hoverBackground, #151a1f); }
    .positive { color: var(--vscode-charts-green, #0ecb81); }
    .negative { color: var(--vscode-charts-red, #f6465d); }
    .neutral { color: var(--vscode-descriptionForeground, #8899a6); }
    .right { text-align: right; }
    .stock-row { cursor: pointer; }
    .stock-row.active { background: var(--vscode-list-activeSelectionBackground, #1e2329); }
    .delisted { opacity: 0.6; font-size: 11px; color: var(--vscode-descriptionForeground, #8899a6); }
    #chartContainer { position: relative; width: 100%; height: 320px; background: var(--vscode-panel-background, #151a1f); border-radius: 8px; margin-top: 8px; border: 1px solid var(--vscode-panel-border, #1e2329); }
    canvas { display: block; width: 100%; height: 100%; }
    .no-data { color: var(--vscode-descriptionForeground, #8899a6); text-align: center; padding: 40px; }
    .leaders { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .leader-card { background: var(--vscode-panel-background, #151a1f); border-radius: 8px; padding: 12px; border: 1px solid var(--vscode-panel-border, #1e2329); }
    .leader-card h3 { font-size: 12px; color: var(--vscode-descriptionForeground, #8899a6); margin-bottom: 8px; }
    .leader-item { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
    .leader-name { color: var(--vscode-foreground, #e0e0e0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
    .leader-value { font-weight: 600; }
  </style>
</head>
<body>
  <h1>📈 Code Market</h1>

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
        </tr>
      </thead>
      <tbody id="stockList"></tbody>
    </table>
  </div>

  <div class="section">
    <h2>K-Line Chart</h2>
    <div id="chartContainer">
      <canvas id="klineCanvas"></canvas>
    </div>
  </div>

  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      let selectedUri = null;
      let allStocks = [];

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

      function renderLeaders(gainers, losers) {
        const gEl = document.getElementById('gainers');
        const lEl = document.getElementById('losers');
        gEl.innerHTML = (gainers || []).map(s =>
          '<div class="leader-item"><span class="leader-name" title="' + escapeHtml(s.uri) + '">' + escapeHtml(s.name) + '</span><span class="leader-value positive">+' + s.changePercent.toFixed(2) + '%</span></div>'
        ).join('') || '<div class="no-data">No gainers</div>';
        lEl.innerHTML = (losers || []).map(s =>
          '<div class="leader-item"><span class="leader-name" title="' + escapeHtml(s.uri) + '">' + escapeHtml(s.name) + '</span><span class="leader-value negative">' + s.changePercent.toFixed(2) + '%</span></div>'
        ).join('') || '<div class="no-data">No losers</div>';
      }

      function renderStockList(stocks) {
        allStocks = stocks || [];
        const tbody = document.getElementById('stockList');
        if (allStocks.length === 0) {
          tbody.innerHTML = '<tr><td colspan="4" class="no-data">No files tracked yet. Start editing to see market data.</td></tr>';
          return;
        }
        tbody.innerHTML = allStocks.map(s => {
          const cls = s.changePercent > 0 ? 'positive' : (s.changePercent < 0 ? 'negative' : 'neutral');
          const sign = s.changePercent > 0 ? '+' : '';
          const totalVol = s.candles.reduce((sum, c) => sum + c.volume, 0);
          const active = s.uri === selectedUri ? 'active' : '';
          const statusLabel = s.status === 'delisted' ? ' <span class="delisted">(DELISTED)</span>' : '';
          return '<tr class="stock-row ' + active + '" data-uri="' + escapeHtml(s.uri) + '">' +
            '<td>' + escapeHtml(s.name) + statusLabel + '</td>' +
            '<td class="right">' + s.currentLines + '</td>' +
            '<td class="right ' + cls + '">' + sign + s.changePercent.toFixed(2) + '%</td>' +
            '<td class="right">' + totalVol + '</td>' +
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
        // Clear using physical pixels so high-DPI screens never show ghosting.
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.restore();

        const rect = canvas.getBoundingClientRect();
        const W = rect.width;
        const H = rect.height;

        const stock = allStocks.find(s => s.uri === selectedUri);
        if (!stock || !stock.candles || stock.candles.length === 0) {
          ctx.fillStyle = 'var(--vscode-descriptionForeground, #8899a6)';
          ctx.font = '14px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(selectedUri ? 'No candle data for this file yet' : 'Select a file to view K-line chart', W / 2, H / 2);
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
          if (candles.length === 1) {
            return padding.left + chartW / 2;
          }
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

        // Candles
        const candleWidth = Math.max(2, (chartW / candles.length) * 0.6);
        for (let i = 0; i < candles.length; i++) {
          const c = candles[i];
          const xx = x(i);
          const isUp = c.close >= c.open;
          const color = isUp ? 'var(--vscode-charts-green, #0ecb81)' : 'var(--vscode-charts-red, #f6465d)';

          // Wick
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(xx, y(c.high));
          ctx.lineTo(xx, y(c.low));
          ctx.stroke();

          // Body
          const bodyTop = y(Math.max(c.open, c.close));
          const bodyBottom = y(Math.min(c.open, c.close));
          const bodyH = Math.max(1, bodyBottom - bodyTop);
          ctx.fillStyle = color;
          ctx.fillRect(xx - candleWidth / 2, bodyTop, candleWidth, bodyH);

          // Volume bar
          const volY = yVol(c.volume);
          ctx.fillStyle = isUp ? 'rgba(14,203,129,0.3)' : 'rgba(246,70,93,0.3)';
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
          const label = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0');
          ctx.fillText(label, x(i), H - 22);
        }
      }

      function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
      }

      window.addEventListener('message', event => {
        const msg = event.data;
        if (msg.type === 'update') {
          renderLeaders(msg.gainers, msg.losers);
          renderStockList(msg.stocks);
          renderChart();
        }
      });

      resizeCanvas();
      renderLeaders([], []);
      renderStockList([]);
    })();
  </script>
</body>
</html>`;
  }
}
