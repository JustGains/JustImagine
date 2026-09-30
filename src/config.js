import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripHash } from './strip.js';

export const APP_HOME = process.env.JUSTIMAGINE_HOME || path.join(os.homedir(), '.justimagine');
export const BRO_DIR = APP_HOME;
export const CONFIG_PATH = process.env.JUSTIMAGINE_CONFIG_PATH || path.join(APP_HOME, 'config.json');
export const configPath = () => process.env.JUSTIMAGINE_CONFIG_PATH || CONFIG_PATH;

const DEFAULT_CONFIG = {
  '#': 'JustImagine config. Keys are provider ids; imageApis may add custom APIs.',
  keys: {},
  imageApis: []
};

export function loadRawConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return null; }
}
export function loadConfig() { return stripHash(loadRawConfig() ?? DEFAULT_CONFIG); }
export function ensureDefaultConfig() {
  if (fs.existsSync(configPath())) return false;
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(DEFAULT_CONFIG, null, 2));
  return true;
}
export function setKey(providerId, key) {
  const raw = loadRawConfig() ?? structuredClone(DEFAULT_CONFIG);
  raw.keys = raw.keys || {};
  if (key) raw.keys[providerId] = key; else delete raw.keys[providerId];
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(raw, null, 2));
}
