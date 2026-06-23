// Persistence layer: a single JSON config file kept in DATA_DIR (a mounted
// volume in production). No external dependencies — just fs.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const EMPTY = { endpoints: [] };

export function getConfigPath() {
  return CONFIG_PATH;
}

export async function loadConfig() {
  try {
    const text = await fs.readFile(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.endpoints)) {
      return structuredClone(EMPTY);
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return structuredClone(EMPTY);
    }
    throw err;
  }
}

// Atomic write: write to a temp file in the same dir, then rename.
export async function saveConfig(config) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = CONFIG_PATH + '.' + process.pid + '.tmp';
  const text = JSON.stringify(config, null, 2);
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, CONFIG_PATH);
}

// Ensure the file exists so the volume has a config.json from the start.
export async function ensureConfig() {
  const config = await loadConfig();
  await saveConfig(config);
  return config;
}
