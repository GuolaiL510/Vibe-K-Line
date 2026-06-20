import * as vscode from 'vscode';
import { MarketEngine } from './market-engine';
import { Panel } from './panel';

let engine: MarketEngine | undefined;

export function activate(context: vscode.ExtensionContext): void {
  engine = new MarketEngine();
  engine.start().catch(err => console.error('Vibe K-Line: failed to start engine', err));

  const openCommand = vscode.commands.registerCommand('codeMarket.open', () => {
    if (!engine) {
      return;
    }
    Panel.createOrShow(context.extensionUri, engine);
  });

  context.subscriptions.push(openCommand, {
    dispose: () => {
      engine?.dispose();
      engine = undefined;
    }
  });
}

export function deactivate(): void {
  engine?.dispose();
}
