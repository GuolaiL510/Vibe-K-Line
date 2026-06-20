import * as vscode from 'vscode';
import * as path from 'path';

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
  candles: Candle[];
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

  constructor() {
    this.interval = setInterval(() => this.flushCandles(), CANDLE_WINDOW_MS);
  }

  async start(): Promise<void> {
    await this.scanWorkspace();
    this.setupWatchers();
    this.setupDocumentListener();
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
  }

  private onFileDelete(uri: vscode.Uri): void {
    const key = uri.toString();
    const stock = this.stocks.get(key);
    if (stock) {
      stock.status = 'delisted';
      stock.delistedAt = Date.now();
    }
    this.emit();
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
    this.recalcChange(stock);
    this.emit();
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
  }
}
