import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export type ViewerAssets = {
  tokensCss: string;
  runtimeJs: string;
};

const TOKENS_URL = new URL('../../design/project/tokens.css', import.meta.url);
const RUNTIME_URL = new URL('./runtime.js', import.meta.url);

let cached: Promise<ViewerAssets> | null = null;

export function loadViewerAssets(): Promise<ViewerAssets> {
  if (!cached) cached = read();
  return cached;
}

async function read(): Promise<ViewerAssets> {
  const [tokensCss, runtimeJs] = await Promise.all([
    readFile(TOKENS_URL, 'utf8').catch((error) => {
      throw new Error(`Viewer asset missing: ${fileURLToPath(TOKENS_URL)} (${(error as Error).message})`);
    }),
    readFile(RUNTIME_URL, 'utf8').catch((error) => {
      throw new Error(`Viewer asset missing: ${fileURLToPath(RUNTIME_URL)} (${(error as Error).message})`);
    }),
  ]);
  return { tokensCss, runtimeJs };
}

export function _resetAssetsCacheForTests(): void {
  cached = null;
}
