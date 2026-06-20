import * as vscode from 'vscode';
import * as path from 'path';
import { Storage } from './storage';

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface FileStock {
  uri: string;
  name: string;
  currentLines: number;
  previousClose: number;
  change: number;
  changePercent: number;
  status: 'active' | 'delisted';
  ipoDate: number;
  delistedAt?: number;
  totalAdded: number;
  totalDeleted: number;
  candles: Candle[];
  lifecycle: FileLifecycle;
}

export interface FileLifecycle {
  highestLoc: number;
  lowestLoc: number;
  biggestPump: number;
  biggestDrop: number;
  listedDate: number;
}

export interface MarketSummary {
  totalLines: number;
  totalVolume: number;
  gainers: number;
  losers: number;
  unchanged: number;
  delisted: number;
  ipoCount: number;
  bullishCount: number;
  bearishCount: number;
  vibeScore: number;
  vibeStatus: string;
}

export interface EditEvent {
  timestamp: number;
  uri: string;
  name: string;
  added: number;
  removed: number;
}

export interface SectorInfo {
  directory: string;
  totalLines: number;
  totalChange: number;
  files: string[];
}

export type Timeframe = '10s' | '1m' | '5m' | 'day' | 'month' | 'quarter' | 'year';

interface FileState {
  lines: number;
  candleStartLines: number;
  windowHigh: number;
  windowLow: number;
  pendingAdded: number;
  pendingRemoved: number;
}

const CANDLE_WINDOW_MS = 10000;
const MAX_RECENT_EDITS = 100;

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '10s': 10000,
  '1m': 60000,
  '5m': 300000,
  'day': 86400000,
  'month': 2592000000,
  'quarter': 7776000000,
  'year': 31536000000,
};

const IGNORED_PATTERNS = [
  /(^|[\\/])node_modules($|[\\/])/,
  /(^|[\\/])\.git($|[\\/])/,
  /(^|[\\/])\.code-market($|[\\/])/,
  /(^|[\\/])dist($|[\\/])/,
  /(^|[\\/])build($|[\\/])/,
  /(^|[\\/])out($|[\\/])/,
  /\.(png|jpg|jpeg|gif|bmp|svg|ico|webp|mp3|mp4|wav|avi|mov|mkv|pdf|zip|tar|gz|rar|7z|exe|dll|so|dylib|bin|dat|ttf|otf|woff|woff2|eot|vsix)$/i
];

function shouldIgnore(filePath: string): boolean {
  return IGNORED_PATTERNS.some(pattern => pattern.test(filePath));
}

function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      count++;
    }
  }
  return count;
}

function getRelativePath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return path.basename(uri.fsPath);
  }
  return path.relative(folder.uri.fsPath, uri.fsPath);
}

function getDirectory(uri: vscode.Uri): string {
  const rel = getRelativePath(uri);
  const dir = path.dirname(rel);
  return dir === '.' ? '/' : dir;
}

function aggregateCandles(baseCandles: Candle[], timeframeMs: number): Candle[] {
  if (baseCandles.length === 0) {
    return [];
  }
  const result: Candle[] = [];
  let current: Candle | null = null;
  for (const c of baseCandles) {
    const bucketStart = Math.floor(c.timestamp / timeframeMs) * timeframeMs;
    if (!current || current.timestamp !== bucketStart) {
      if (current) {
        result.push(current);
      }
      current = {
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        timestamp: bucketStart,
      };
    } else {
      current.high = Math.max(current.high, c.high);
      current.low = Math.min(current.low, c.low);
      current.close = c.close;
      current.volume += c.volume;
    }
  }
  if (current) {
    result.push(current);
  }
  return result;
}

export class MarketEngine implements vscode.Disposable {
  private files = new Map<string, FileState>();
  private stocks = new Map<string, FileStock>();
  private listeners = new Set<() => void>();
  private interval: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private disposed = false;
  private storage = new Storage();
  private savePending = false;
  private recentEdits: EditEvent[] = [];

  constructor() {
    this.interval = setInterval(() => this.flushCandles(), CANDLE_WINDOW_MS);
  }

  async start(): Promise<void> {
    const persisted = await this.storage.loadAll();
    this.hydratePersisted(persisted);
    await this.scanWorkspace();
    this.setupWatchers();
    this.setupDocumentListener();
    this.scheduleSave();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.interval);
    this.disposables.forEach(d => d.dispose());
    this.files.clear();
    this.stocks.clear();
    this.listeners.clear();
  }

  onUpdate(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  getStocks(): FileStock[] {
    return Array.from(this.stocks.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  getActiveStocks(): FileStock[] {
    return this.getStocks().filter(s => s.status === 'active');
  }

  getDelistedStocks(): FileStock[] {
    return this.getStocks().filter(s => s.status === 'delisted');
  }

  getGainers(): FileStock[] {
    return this.getActiveStocks()
      .filter(s => s.changePercent > 0)
      .sort((a, b) => b.changePercent - a.changePercent)
      .slice(0, 10);
  }

  getLosers(): FileStock[] {
    return this.getActiveStocks()
      .filter(s => s.changePercent < 0)
      .sort((a, b) => a.changePercent - b.changePercent)
      .slice(0, 10);
  }

  getRecentEdits(): EditEvent[] {
    return this.recentEdits.slice();
  }

  getRecentEditsForFile(uri: string): EditEvent[] {
    return this.recentEdits.filter(e => e.uri === uri);
  }

  getSectors(): SectorInfo[] {
    const map = new Map<string, SectorInfo>();
    for (const stock of this.getActiveStocks()) {
      const dir = getDirectory(vscode.Uri.parse(stock.uri));
      let sector = map.get(dir);
      if (!sector) {
        sector = { directory: dir, totalLines: 0, totalChange: 0, files: [] };
        map.set(dir, sector);
      }
      sector.totalLines += stock.currentLines;
      sector.totalChange += stock.change;
      sector.files.push(stock.name);
    }
    return Array.from(map.values()).sort((a, b) => b.totalLines - a.totalLines);
  }

  getStock(uri: string): FileStock | undefined {
    return this.stocks.get(uri);
  }

  getCandlesForTimeframe(stock: FileStock, timeframe: Timeframe): Candle[] {
    if (timeframe === '10s') {
      return stock.candles.slice();
    }
    return aggregateCandles(stock.candles, TIMEFRAME_MS[timeframe]);
  }

  getMarketCandles(timeframe: Timeframe): Candle[] {
    const active = this.getActiveStocks();
    if (active.length === 0) {
      return [];
    }
    const allTimestamps = new Set<number>();
    const stockCandles = new Map<string, Candle[]>();
    for (const stock of active) {
      const candles = this.getCandlesForTimeframe(stock, timeframe);
      stockCandles.set(stock.uri, candles);
      for (const c of candles) {
        allTimestamps.add(c.timestamp);
      }
    }
    const timestamps = Array.from(allTimestamps).sort((a, b) => a - b);
    if (timestamps.length === 0) {
      return [];
    }
    const result: Candle[] = [];
    for (const ts of timestamps) {
      let open = 0;
      let high = 0;
      let low = 0;
      let close = 0;
      let volume = 0;
      let count = 0;
      for (const stock of active) {
        const candles = stockCandles.get(stock.uri)!;
        const c = candles.find(x => x.timestamp === ts);
        if (c) {
          open += c.open;
          high += c.high;
          low += c.low;
          close += c.close;
          volume += c.volume;
          count++;
        }
      }
      if (count > 0) {
        result.push({ open, high, low, close, volume, timestamp: ts });
      }
    }
    return result;
  }

  getMarketSummary(): MarketSummary {
    const stocks = this.getStocks();
    const active = stocks.filter(s => s.status === 'active');
    const delisted = stocks.filter(s => s.status === 'delisted');

    const totalLines = active.reduce((sum, s) => sum + s.currentLines, 0);
    const totalVolume = active.reduce((sum, s) => sum + s.totalAdded + s.totalDeleted, 0);
    const gainers = active.filter(s => s.changePercent > 0).length;
    const losers = active.filter(s => s.changePercent < 0).length;
    const unchanged = active.length - gainers - losers;
    const ipoCount = active.filter(s => s.candles.length <= 1).length;
    const bullishCount = active.filter(s => this.getTag(s) === '🔴 Bullish' || this.getTag(s) === '🚀 Mooning').length;
    const bearishCount = active.filter(s => this.getTag(s) === '🟢 Bearish' || this.getTag(s) === '🔻 Rugged').length;

    const added = active.reduce((sum, s) => sum + s.totalAdded, 0);
    const deleted = active.reduce((sum, s) => sum + s.totalDeleted, 0);
    const editedFiles = active.filter(s => s.totalAdded + s.totalDeleted > 0).length;
    const vibeScore = Math.round(added * 1.0 + deleted * 0.6 + editedFiles * 3 + ipoCount * 10 - delisted.length * 5);

    let vibeStatus = '⚖️ Stable';
    if (vibeScore > 500) { vibeStatus = '🔥 Extremely Bullish Vibe'; }
    else if (vibeScore > 200) { vibeStatus = '🚀 Bullish Vibe'; }
    else if (vibeScore > 50) { vibeStatus = '🌤 Warming Up'; }
    else if (vibeScore < -300) { vibeStatus = '💥 Market Crash'; }
    else if (vibeScore < -100) { vibeStatus = '📉 Bearish Vibe'; }

    return { totalLines, totalVolume, gainers, losers, unchanged, delisted: delisted.length, ipoCount, bullishCount, bearishCount, vibeScore, vibeStatus };
  }

  getTag(stock: FileStock): string {
    if (stock.status === 'delisted') { return '⛔ Delisted'; }
    if (stock.candles.length === 0) { return '🆕 IPO'; }

    const last = stock.candles[stock.candles.length - 1];
    const range = last.high - last.low;
    const center = (last.open + last.close) / 2 || 1;
    const volatility = center > 0 ? range / center : 0;

    if (volatility > 0.5) { return '🎢 Volatile'; }
    if (last.close > last.open * 1.25) { return '🚀 Mooning'; }
    if (last.close < last.open * 0.75) { return '🔻 Rugged'; }
    if (last.close > last.open) { return '🔴 Bullish'; }
    if (last.close < last.open) { return '🟢 Bearish'; }
    if (stock.candles.length > 5 && last.volume === 0) { return '💤 Dormant'; }
    return '⚖️ Stable';
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // ignore listener errors
      }
    }
  }

  private async scanWorkspace(): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      return;
    }
    for (const folder of vscode.workspace.workspaceFolders) {
      await this.scanUri(folder.uri);
    }
  }

  private async scanUri(uri: vscode.Uri): Promise<void> {
    if (shouldIgnore(getRelativePath(uri))) {
      return;
    }

    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      for (const [name, type] of entries) {
        const child = vscode.Uri.joinPath(uri, name);
        if (shouldIgnore(getRelativePath(child))) {
          continue;
        }
        if (type === vscode.FileType.Directory) {
          await this.scanUri(child);
        } else if (type === vscode.FileType.File) {
          await this.loadFile(child);
        }
      }
    } catch (err) {
      console.error(`Vibe K-Line: failed to scan ${uri.fsPath}`, err);
    }
  }

  private async loadFile(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();

    if (this.files.has(key)) {
      try {
        const content = await vscode.workspace.fs.readFile(uri);
        const lines = countLines(new TextDecoder().decode(content));
        const state = this.files.get(key)!;
        const stock = this.stocks.get(key)!;
        state.lines = lines;
        state.candleStartLines = lines;
        state.windowHigh = lines;
        state.windowLow = lines;
        stock.currentLines = lines;
        stock.previousClose = lines;
        stock.change = 0;
        stock.changePercent = 0;
        stock.status = 'active';
        stock.delistedAt = undefined;
        this.recalcChange(stock);
        this.updateLifecycle(stock);
      } catch (err) {
        console.error(`Vibe K-Line: failed to reload ${uri.fsPath}`, err);
      }
      return;
    }

    try {
      const content = await vscode.workspace.fs.readFile(uri);
      const lines = countLines(new TextDecoder().decode(content));
      this.ipo(key, path.basename(uri.fsPath), lines);
    } catch (err) {
      console.error(`Vibe K-Line: failed to load ${uri.fsPath}`, err);
    }
  }

  private hydratePersisted(persisted: Map<string, FileStock>): void {
    for (const [uri, stock] of persisted.entries()) {
      if (!stock.lifecycle) {
        stock.lifecycle = {
          highestLoc: stock.currentLines,
          lowestLoc: stock.currentLines,
          biggestPump: 0,
          biggestDrop: 0,
          listedDate: stock.ipoDate,
        };
      }
      this.stocks.set(uri, stock);
      const lastClose = stock.candles.length > 0 ? stock.candles[stock.candles.length - 1].close : stock.currentLines;
      this.files.set(uri, {
        lines: stock.currentLines,
        candleStartLines: lastClose,
        windowHigh: stock.currentLines,
        windowLow: stock.currentLines,
        pendingAdded: 0,
        pendingRemoved: 0,
      });
    }
  }

  private ipo(uri: string, name: string, lines: number): void {
    const now = Date.now();
    this.files.set(uri, {
      lines,
      candleStartLines: lines,
      windowHigh: lines,
      windowLow: lines,
      pendingAdded: 0,
      pendingRemoved: 0,
    });

    this.stocks.set(uri, {
      uri,
      name,
      currentLines: lines,
      previousClose: lines,
      change: 0,
      changePercent: 0,
      status: 'active',
      ipoDate: now,
      totalAdded: 0,
      totalDeleted: 0,
      candles: [],
      lifecycle: {
        highestLoc: lines,
        lowestLoc: lines,
        biggestPump: 0,
        biggestDrop: 0,
        listedDate: now,
      },
    });
  }

  private updateLifecycle(stock: FileStock): void {
    const lc = stock.lifecycle;
    lc.highestLoc = Math.max(lc.highestLoc, stock.currentLines);
    lc.lowestLoc = Math.min(lc.lowestLoc, stock.currentLines);
    if (stock.candles.length > 0) {
      const last = stock.candles[stock.candles.length - 1];
      const change = last.close - last.open;
      if (change > 0) {
        lc.biggestPump = Math.max(lc.biggestPump, change);
      } else if (change < 0) {
        lc.biggestDrop = Math.max(lc.biggestDrop, -change);
      }
    }
  }

  private setupWatchers(): void {
    if (!vscode.workspace.workspaceFolders) {
      return;
    }
    for (const folder of vscode.workspace.workspaceFolders) {
      const pattern = new vscode.RelativePattern(folder, '**/*');
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(uri => this.onFileCreate(uri));
      watcher.onDidChange(uri => this.onFileChange(uri));
      watcher.onDidDelete(uri => this.onFileDelete(uri));
      this.disposables.push(watcher);
    }
  }

  private setupDocumentListener(): void {
    const disposable = vscode.workspace.onDidChangeTextDocument(event => this.onTextDocumentChange(event));
    this.disposables.push(disposable);
  }

  private async onFileCreate(uri: vscode.Uri): Promise<void> {
    if (shouldIgnore(getRelativePath(uri))) {
      return;
    }
    await this.loadFile(uri);
    this.emit();
    this.scheduleSave();
  }

  private async onFileChange(uri: vscode.Uri): Promise<void> {
    if (shouldIgnore(getRelativePath(uri))) {
      return;
    }
    await this.loadFile(uri);
    this.emit();
    this.scheduleSave();
  }

  private onFileDelete(uri: vscode.Uri): void {
    const key = uri.toString();
    const stock = this.stocks.get(key);
    if (stock) {
      stock.status = 'delisted';
      stock.delistedAt = Date.now();
    }
    this.files.delete(key);
    this.emit();
    this.scheduleSave();
  }

  private onTextDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const doc = event.document;
    const uri = doc.uri;
    if (shouldIgnore(getRelativePath(uri))) {
      return;
    }

    const key = uri.toString();
    let state = this.files.get(key);
    if (!state) {
      this.ipo(key, path.basename(uri.fsPath), doc.lineCount);
      state = this.files.get(key)!;
    }

    let added = 0;
    let removed = 0;
    for (const change of event.contentChanges) {
      const newLines = Math.max(0, change.text.split('\n').length - 1);
      if (change.range.isEmpty) {
        added += newLines;
      } else {
        removed += change.range.end.line - change.range.start.line;
        added += newLines;
      }
    }

    state.pendingAdded += added;
    state.pendingRemoved += removed;
    state.lines = doc.lineCount;
    state.windowHigh = Math.max(state.windowHigh, state.lines);
    state.windowLow = Math.min(state.windowLow, state.lines);

    const stock = this.stocks.get(key)!;
    stock.currentLines = state.lines;
    stock.totalAdded += added;
    stock.totalDeleted += removed;
    this.recalcChange(stock);
    this.updateLifecycle(stock);

    this.recentEdits.push({
      timestamp: Date.now(),
      uri: key,
      name: stock.name,
      added,
      removed,
    });
    if (this.recentEdits.length > MAX_RECENT_EDITS) {
      this.recentEdits.shift();
    }

    this.emit();
    this.scheduleSave();
  }

  private recalcChange(stock: FileStock): void {
    stock.change = stock.currentLines - stock.previousClose;
    stock.changePercent = stock.previousClose === 0 ? 0 : (stock.change / stock.previousClose) * 100;
  }

  private flushCandles(): void {
    const now = Date.now();
    for (const [uri, state] of this.files.entries()) {
      const stock = this.stocks.get(uri);
      if (!stock || stock.status === 'delisted') {
        continue;
      }

      const candle: Candle = {
        open: state.candleStartLines,
        high: state.windowHigh,
        low: state.windowLow,
        close: state.lines,
        volume: state.pendingAdded + state.pendingRemoved,
        timestamp: now,
      };

      stock.candles.push(candle);
      if (stock.candles.length > 100) {
        stock.candles.shift();
      }

      this.updateLifecycle(stock);

      stock.previousClose = state.lines;
      this.recalcChange(stock);

      state.candleStartLines = state.lines;
      state.windowHigh = state.lines;
      state.windowLow = state.lines;
      state.pendingAdded = 0;
      state.pendingRemoved = 0;
    }
    this.emit();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.savePending) {
      return;
    }
    this.savePending = true;
    setTimeout(async () => {
      this.savePending = false;
      if (this.disposed) {
        return;
      }
      try {
        await this.storage.saveAll(this.stocks);
      } catch (err) {
        console.error('Vibe K-Line: failed to save market data', err);
      }
    }, 100);
  }
}
