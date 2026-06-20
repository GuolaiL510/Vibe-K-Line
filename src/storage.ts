import * as vscode from 'vscode';
import { FileStock, Candle } from './market-engine';

interface PersistedCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

interface PersistedStock {
  uri: string;
  name: string;
  ipoDate: number;
  delistedAt?: number;
  status: 'active' | 'delisted';
  totalAdded: number;
  totalDeleted: number;
  candles: PersistedCandle[];
  lifecycle?: {
    highestLoc: number;
    lowestLoc: number;
    biggestPump: number;
    biggestDrop: number;
    listedDate: number;
  };
}

interface PersistedData {
  version: number;
  updatedAt: number;
  stocks: PersistedStock[];
}

const STORAGE_DIR = '.code-market';
const STORAGE_FILE = 'market-data.json';
const CURRENT_VERSION = 1;
const MAX_CANDLES_PER_STOCK = 500;

export class Storage {
  async loadAll(): Promise<Map<string, FileStock>> {
    const result = new Map<string, FileStock>();
    if (!vscode.workspace.workspaceFolders) {
      return result;
    }

    for (const folder of vscode.workspace.workspaceFolders) {
      const stocks = await this.loadFolder(folder);
      for (const stock of stocks) {
        result.set(stock.uri, stock);
      }
    }
    return result;
  }

  async saveAll(stocks: Map<string, FileStock>): Promise<void> {
    if (!vscode.workspace.workspaceFolders) {
      return;
    }

    for (const folder of vscode.workspace.workspaceFolders) {
      const folderStocks = this.collectStocksForFolder(folder, stocks);
      await this.saveFolder(folder, folderStocks);
    }
  }

  private async loadFolder(folder: vscode.WorkspaceFolder): Promise<FileStock[]> {
    const fileUri = this.getStorageUri(folder);
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const data: PersistedData = JSON.parse(new TextDecoder().decode(bytes));
      if (!data || data.version !== CURRENT_VERSION || !Array.isArray(data.stocks)) {
        return [];
      }
      return data.stocks.map(s => this.deserializeStock(s)).filter((s): s is FileStock => s !== null);
    } catch (err) {
      // File may not exist yet; that's fine.
      return [];
    }
  }

  private async saveFolder(folder: vscode.WorkspaceFolder, stocks: FileStock[]): Promise<void> {
    const dirUri = vscode.Uri.joinPath(folder.uri, STORAGE_DIR);
    await vscode.workspace.fs.createDirectory(dirUri);

    const persisted: PersistedData = {
      version: CURRENT_VERSION,
      updatedAt: Date.now(),
      stocks: stocks.map(s => this.serializeStock(s)),
    };

    const fileUri = vscode.Uri.joinPath(dirUri, STORAGE_FILE);
    const text = JSON.stringify(persisted, null, 2);
    await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(text));
  }

  private getStorageUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, STORAGE_DIR, STORAGE_FILE);
  }

  private collectStocksForFolder(folder: vscode.WorkspaceFolder, stocks: Map<string, FileStock>): FileStock[] {
    const result: FileStock[] = [];
    for (const stock of stocks.values()) {
      const stockFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(stock.uri));
      if (stockFolder && stockFolder.uri.toString() === folder.uri.toString()) {
        result.push(stock);
      }
    }
    return result;
  }

  private serializeStock(stock: FileStock): PersistedStock {
    return {
      uri: stock.uri,
      name: stock.name,
      ipoDate: stock.ipoDate,
      delistedAt: stock.delistedAt,
      status: stock.status,
      totalAdded: stock.totalAdded,
      totalDeleted: stock.totalDeleted,
      candles: stock.candles.slice(-MAX_CANDLES_PER_STOCK).map(c => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        timestamp: c.timestamp,
      })),
      lifecycle: stock.lifecycle,
    };
  }

  private deserializeStock(data: PersistedStock): FileStock | null {
    if (!data.uri || !data.name) {
      return null;
    }
    const candles: Candle[] = (data.candles || []).map(c => ({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      timestamp: c.timestamp,
    }));

    const lastClose = candles.length > 0 ? candles[candles.length - 1].close : data.totalAdded + data.totalDeleted;
    const currentLines = candles.length > 0 ? candles[candles.length - 1].close : 0;

    return {
      uri: data.uri,
      name: data.name,
      currentLines,
      previousClose: lastClose,
      change: currentLines - lastClose,
      changePercent: lastClose === 0 ? 0 : ((currentLines - lastClose) / lastClose) * 100,
      status: data.status === 'delisted' ? 'delisted' : 'active',
      ipoDate: data.ipoDate || Date.now(),
      delistedAt: data.delistedAt,
      totalAdded: data.totalAdded || 0,
      totalDeleted: data.totalDeleted || 0,
      candles,
      lifecycle: data.lifecycle || {
        highestLoc: currentLines,
        lowestLoc: currentLines,
        biggestPump: 0,
        biggestDrop: 0,
        listedDate: data.ipoDate || Date.now(),
      },
    };
  }
}
