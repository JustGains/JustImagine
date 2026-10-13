import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendor = path.join(root, 'src', 'vendor', 'depth');
const modelDir = path.join(vendor, 'onnx-community', 'depth-anything-v2-small');
const revision = '4472b7362082ad9968fee890ca0f1e5aca36b93d';
const modelBase = `https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/${revision}`;
const modelHash = 'eca72971aea64216d767c70c534160de53b5435b588d362bac6dbd5a73f9bf1e';

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
async function download(url, target, expectedHash) {
  if (fs.existsSync(target) && (!expectedHash || sha256(target) === expectedHash)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  const temp = `${target}.part`;
  try {
    await pipeline(response.body, fs.createWriteStream(temp));
    if (expectedHash && sha256(temp) !== expectedHash) throw new Error(`SHA-256 mismatch for ${target}`);
    fs.renameSync(temp, target);
  } catch (error) { fs.rmSync(temp, { force: true }); throw error; }
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

await Promise.all([
  download(`${modelBase}/config.json`, path.join(modelDir, 'config.json')),
  download(`${modelBase}/preprocessor_config.json`, path.join(modelDir, 'preprocessor_config.json')),
  download(`${modelBase}/onnx/model_q4f16.onnx`, path.join(modelDir, 'onnx', 'model_q4f16.onnx'), modelHash)
]);
const wasmDir = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
const files = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
fs.mkdirSync(path.join(vendor, 'wasm'), { recursive: true });
for (const name of files) fs.copyFileSync(path.join(wasmDir, name), path.join(vendor, 'wasm', name));
await run('bun', ['build', 'scripts/depth-vendor-entry.js', '--target', 'browser', '--format', 'esm', '--outfile', 'src/vendor/depth/depth-transformers.js']);
console.log('Depth model and browser runtime updated.');
