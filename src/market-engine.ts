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
}

export interface MarketSummary {
  totalLines: number;
  totalVolume: number;
  gainers: number;
  losers: number;
  unchanged: number;
  delisted: number;
  vibeScore: number;
  vibeStatus: string;
}

interface FileState {
  lines: number;
  candleStartLines: number;
  windowHigh: number;
  windowLow: number;
  pendingAdded: number;
  pendingRemoved: number;
}

const CANDLE_WINDOW_MS = 10000;

const IGNORED_PATTERNS = [
  /(^|[\\/])node_modules($|[\\/])/,
  /(^|[\\/])\.git($|[\\/])/,
  /(^|[\\/])\.code-market($|[\\/])/,
  /(^|[\\/])dist($|[\\/])/,
  /(^|[\\/])build($|[\\/])/,
  /(^|[\\/])out($|[\\/])/,
  /\.(png|jpg|jpeg|gif|bmp|svg|ico|webp|mp3|mp4|wav|avi|mov|mkv|pdf|zip|tar|gz|rar|7z|exe|dll|so|dylib|bin|dat|ttf|otf|woff|woff2|eot)$/i
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

export class MarketEngine implements vscode.Disposable {
  private files = new Map<string, FileState>();
  private stocks = new Map<string, FileStock>();
  private listeners = new Set<() => void>();
  private interval: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private disposed = false;
  private storage = new Storage();
  private savePending = false;

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

  getMarketSummary(): MarketSummary {
    const stocks = this.getStocks();
    const active = stocks.filter(s => s.status === 'active');
    const delisted = stocks.filter(s => s.status === 'delisted');

    const totalLines = active.reduce((sum, s) => sum + s.currentLines, 0);
    const totalVolume = active.reduce((sum, s) => sum + s.totalAdded + s.totalDeleted, 0);
    const gainers = active.filter(s => s.changePercent > 0).length;
    const losers = active.filter(s => s.changePercent < 0).length;
    const unchanged = active.length - gainers - losers;
    const newFiles = active.filter(s => s.candles.length <= 1).length;

    const added = active.reduce((sum, s) => sum + s.totalAdded, 0);
    const deleted = active.reduce((sum, s) => sum + s.totalDeleted, 0);
    const editedFiles = active.filter(s => s.totalAdded + s.totalDeleted > 0).length;
    const vibeScore = Math.round(added * 1.0 + deleted * 0.6 + editedFiles * 3 + newFiles * 10 - delisted.length * 5);

    let vibeStatus = '⚖️ Stable';
    if (vibeScore > 500) { vibeStatus = '🔥 Extremely Bullish Vibe'; }
    else if (vibeScore > 200) { vibeStatus = '🚀 Bullish Vibe'; }
    else if (vibeScore > 50) { vibeStatus = '🌤 Warming Up'; }
    else if (vibeScore < -300) { vibeStatus = '💥 Market Crash'; }
    else if (vibeScore < -100) { vibeStatus = '📉 Bearish Vibe'; }

    return { totalLines, totalVolume, gainers, losers, unchanged, delisted: delisted.length, vibeScore, vibeStatus };
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
      console.error(`Code Market: failed to scan ${uri.fsPath}`, err);
    }
  }

  private async loadFile(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();

    if (this.files.has(key)) {
      // Existing stock from persistent storage: refresh current line count.
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
      } catch (err) {
        console.error(`Code Market: failed to reload ${uri.fsPath}`, err);
      }
      return;
    }

    try {
      const content = await vscode.workspace.fs.readFile(uri);
      const lines = countLines(new TextDecoder().decode(content));
      this.ipo(key, path.basename(uri.fsPath), lines);
    } catch (err) {
      console.error(`Code Market: failed to load ${uri.fsPath}`, err);
    }
  }

  private hydratePersisted(persisted: Map<string, FileStock>): void {
    for (const [uri, stock] of persisted.entries()) {
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
      ipoDate: Date.now(),
      totalAdded: 0,
      totalDeleted: 0,
      candles: [],
    });
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
    const key = uri.toString();
    if (this.files.has(key)) {
      // Already tracked by the live text-document listener; skip to avoid double counting.
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
        console.error('Code Market: failed to save market data', err);
      }
    }, 100);
  }
}
