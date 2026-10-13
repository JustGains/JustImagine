// Background removal through JustTools' justrmbg (BRIA RMBG-2.0), run on this
// machine. The app exists only where the command does. One engine serves the
// whole server: `justrmbg --serve` keeps the model loaded between images and
// across batches, and closes after a quiet spell to give its memory back.
// Releases without serve mode get one batch run per request instead.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const PROBE_TTL = 60_000;
// The first start downloads the pinned runtime and model (about a gigabyte).
const START_TIMEOUT = 20 * 60_000;

export function inContainer(env = process.env) {
  if (env.JUSTIMAGINE_CONTAINER) return !/^(0|false|off|no)$/i.test(env.JUSTIMAGINE_CONTAINER);
  if (process.platform !== 'linux') return false;
  if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) return true;
  try { return /docker|kubepods|containerd|libpod/.test(fs.readFileSync('/proc/1/cgroup', 'utf8')); } catch { return false; }
}

// "0-3,6,8-9" -> [0, 1, 2, 3, 6, 8, 9]
export function parseCpuList(text) {
  const out = [];
  for (const part of String(text || '').trim().split(',')) {
    const [a, b = a] = part.split('-').map((n) => Number.parseInt(n, 10));
    if (Number.isInteger(a) && Number.isInteger(b) && b >= a && b - a < 4096) for (let n = a; n <= b; n++) out.push(n);
  }
  return out;
}

// The CPUs this process may run on, and how many of them its cgroup quota pays
// for. A container capped at 2 CPUs on a 32-core host still sees 32 cores, and
// ONNX Runtime would start a thread per core and be throttled all the time.
export function cpuBudget({ read = (file) => fs.readFileSync(file, 'utf8'), cores = os.cpus().length } = {}) {
  const tryRead = (file) => { try { return read(file).trim(); } catch { return ''; } };
  let allowed = parseCpuList(tryRead('/sys/fs/cgroup/cpuset.cpus.effective') || tryRead('/sys/fs/cgroup/cpuset/cpuset.effective_cpus'));
  if (!allowed.length) allowed = Array.from({ length: Math.max(1, cores) }, (_, i) => i);
  let quota = allowed.length;
  const v2 = tryRead('/sys/fs/cgroup/cpu.max').split(/\s+/);
  const v1 = [tryRead('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), tryRead('/sys/fs/cgroup/cpu/cpu.cfs_period_us')];
  const [max, period] = v2[0] && v2[0] !== 'max' ? v2.map(Number) : v1.map(Number);
  if (max > 0 && period > 0) quota = Math.max(1, Math.min(allowed.length, Math.floor(max / period)));
  return { cpus: allowed.slice(0, quota), total: allowed.length };
}

function probe(command, args) {
  const result = spawnSync(command, [...args, '--help'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0 || !/rmbg/i.test(text)) return null;
  return { serve: /--serve\b/.test(text) };
}

// The kernel's out-of-memory killer leaves no message of its own.
const exitReason = (code, signal) => signal === 'SIGKILL' ? 'The background remover ran out of memory. On the CPU it needs about 8 GB.' : `justrmbg stopped (exit ${code ?? signal}).`;
const tail = (text) => String(text || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').replace(/^justrmbg:\s*/i, '');

// `command`/`args` name the program; by default JUSTIMAGINE_RMBG, then
// `justrmbg` or `rmbg` on PATH. JUSTIMAGINE_RMBG=off hides the app.
export function createRmbgEngine({ command, args = [], env = process.env, container = inContainer(env), idleMs, window } = {}) {
  const configured = command || env.JUSTIMAGINE_RMBG || '';
  const disabled = /^(0|false|off|no)$/i.test(configured);
  const idle = idleMs ?? (Number(env.JUSTIMAGINE_RMBG_IDLE_SECONDS) > 0 ? Number(env.JUSTIMAGINE_RMBG_IDLE_SECONDS) * 1000 : container ? 3 * 60_000 : 10 * 60_000);
  let found = null;
  let foundAt = 0;
  let session = null;
  let seq = 0;

  function resolveCommand() {
    if (disabled) return null;
    if (Date.now() - foundAt < PROBE_TTL) return found;
    found = null;
    for (const candidate of configured ? [configured] : ['justrmbg', 'rmbg']) {
      const info = probe(candidate, args);
      if (info) { found = { command: candidate, ...info }; break; }
    }
    foundAt = Date.now();
    return found;
  }

  // A container has no GPU unless one was handed in with a CUDA runtime, so
  // skip the accelerator probe and go straight to CPU. JUSTIMAGINE_RMBG_PROVIDER
  // (auto, cpu, directml, cuda, coreml) overrides either way.
  function providerArgs() {
    const wanted = String(env.JUSTIMAGINE_RMBG_PROVIDER || '').toLowerCase();
    if (/^(auto|cpu|directml|cuda|coreml)$/.test(wanted)) return ['--provider', wanted];
    if (container && !(env.ORT_DYLIB_PATH && env.NVIDIA_VISIBLE_DEVICES && env.NVIDIA_VISIBLE_DEVICES !== 'void')) return ['--cpu'];
    return [];
  }

  function childEnv() {
    const out = { ...env };
    // Keep the downloaded runtime and model on a volume that outlives the
    // container, so a rebuild does not fetch a gigabyte again.
    if (env.JUSTIMAGINE_RMBG_CACHE && process.platform !== 'win32') out.XDG_CACHE_HOME = env.JUSTIMAGINE_RMBG_CACHE;
    return out;
  }

  function launch(extra) {
    const found = resolveCommand();
    if (!found) throw new Error('Background removal needs JustTools’ justrmbg on this server.');
    let cmd = found.command;
    let argv = [...args, ...extra, '--download', ...providerArgs()];
    if (container && process.platform === 'linux') {
      // Hold inference to the CPUs the quota pays for; spare cores only mean
      // throttling. The web server keeps priority over a long batch.
      const { cpus, total } = cpuBudget();
      if (cpus.length < total && spawnSync('taskset', ['-V'], { stdio: 'ignore', timeout: 2000 }).status === 0) {
        argv = ['-c', cpus.join(','), cmd, ...argv];
        cmd = 'taskset';
      }
    }
    const child = spawn(cmd, argv, { env: childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (container) child.once('spawn', () => { try { os.setPriority(child.pid, 10); } catch { /* not permitted */ } });
    return { child, found };
  }

  function startSession() {
    const { child, found } = launch(['--serve']);
    const s = { child, waiting: [], stderr: '', ending: false, closed: false, provider: '' };
    let ready, fail;
    s.ready = new Promise((resolve, reject) => { ready = resolve; fail = reject; });
    s.ready.catch(() => {});
    const timer = setTimeout(() => stop(new Error('The background remover took too long to start.')), START_TIMEOUT);
    timer.unref?.();
    const stop = (error) => {
      clearTimeout(timer);
      error.fatal = true;
      if (s.closed) return;
      s.closed = true;
      if (session === s) session = null;
      fail(error);
      for (const w of s.waiting.splice(0)) w.reject(error);
      try { child.kill(); } catch { /* gone */ }
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (part) => { s.stderr = (s.stderr + part).slice(-4000); });
    child.stdin.on('error', () => {});
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) { clearTimeout(timer); s.provider = String(msg.provider || ''); ready(); return; }
      const at = s.waiting.findIndex((w) => w.id === String(msg.id));
      const [w] = s.waiting.splice(at < 0 ? 0 : at, 1);
      if (!w) return;
      if (msg.ok) w.resolve({ seconds: Number(msg.seconds) || 0, provider: s.provider });
      else w.reject(new Error(msg.error || 'The background remover could not read that image.'));
      if (!s.waiting.length) scheduleIdle(s);
    });
    child.on('error', (error) => stop(error));
    child.on('close', (code, signal) => stop(new Error(s.ending ? 'The background remover stopped.' : signal === 'SIGKILL' ? exitReason(code, signal) : tail(s.stderr) || exitReason(code, signal))));
    s.found = found;
    return s;
  }

  function scheduleIdle(s) {
    clearTimeout(s.idle);
    s.idle = setTimeout(() => {
      if (s.waiting.length || s.closed) return;
      s.ending = true;
      if (session === s) session = null;
      s.child.stdin.end();
    }, idle);
    s.idle.unref?.();
  }

  async function serveOne(input, output) {
    if (!session || session.ending || session.closed) session = startSession();
    const s = session;
    clearTimeout(s.idle);
    await s.ready;
    if (s.closed) throw new Error(tail(s.stderr) || 'The background remover stopped.');
    return new Promise((resolve, reject) => {
      const id = String(++seq);
      s.waiting.push({ id, resolve, reject });
      s.child.stdin.write(`${JSON.stringify({ id, input, output })}\n`);
    });
  }

  // Serve mode: keep a few requests in flight so the next image decodes and
  // the last one saves while the model works, but few enough that Stop takes
  // effect within an image or two. A CPU in a container gains nothing from more.
  async function runServe(tasks, { signal, onResult }) {
    const width = window || (container ? 2 : 4);
    let next = 0;
    let fatal = null;
    const worker = async () => {
      while (next < tasks.length && !signal?.aborted) {
        const task = tasks[next++];
        const started = Date.now();
        // A remover that will not start fails the rest at once, not one relaunch per image.
        if (fatal) { await onResult(task, fatal); continue; }
        try { const done = await serveOne(task.input, task.output); await onResult(task, null, { ...done, ms: Date.now() - started }); }
        catch (error) { if (error.fatal) fatal = error; await onResult(task, error); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, tasks.length) }, worker));
  }

  // Older releases: one run over a folder of staged copies. justrmbg picks
  // inputs by extension and names each result after its stem.
  async function runBatch(tasks, { signal, onResult }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justimagine-rmbg-'));
    const inDir = path.join(dir, 'in');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(inDir); fs.mkdirSync(outDir);
    const stems = tasks.map((_, i) => String(i).padStart(5, '0'));
    const staged = tasks.map((task, i) => {
      const file = path.join(inDir, `${stems[i]}.${task.ext || 'png'}`);
      try { fs.linkSync(task.input, file); } catch { fs.copyFileSync(task.input, file); }
      return file;
    });
    const settled = new Set();
    const started = Date.now();
    const sweep = async () => {
      for (let i = 0; i < tasks.length; i++) {
        if (settled.has(i)) continue;
        // v2.8 keeps the stem in folder mode; later releases add -nobg.
        const made = [`${stems[i]}-nobg.png`, `${stems[i]}.png`].map((name) => path.join(outDir, name)).find((file) => fs.existsSync(file));
        if (!made) continue;
        settled.add(i);
        fs.rmSync(staged[i], { force: true });
        try { fs.renameSync(made, tasks[i].output); } catch { fs.copyFileSync(made, tasks[i].output); fs.rmSync(made, { force: true }); }
        await onResult(tasks[i], null, { ms: Date.now() - started });
      }
    };
    try {
      // On the CPU, v2.8's memory grows with each image until the kernel
      // kills it. A run that finished images before dying is restarted on
      // the rest; only a run that makes no progress ends the batch.
      while (!signal?.aborted && settled.size < tasks.length) {
        const before = settled.size;
        const { child } = launch([inDir, '--output', outDir]);
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (part) => { stderr = (stderr + part).slice(-4000); });
        child.stdout.resume();
        child.stdin.end();
        const kill = () => { try { child.kill(); } catch { /* gone */ } };
        signal?.addEventListener('abort', kill, { once: true });
        let polling = Promise.resolve();
        const poll = setInterval(() => { polling = polling.then(sweep); }, 500);
        const [code, killedBy] = await new Promise((resolve) => { child.on('error', () => resolve([-1])); child.on('close', (...exit) => resolve(exit)); });
        clearInterval(poll);
        signal?.removeEventListener('abort', kill);
        await polling; await sweep();
        if (signal?.aborted || settled.size === tasks.length) break;
        if (killedBy === 'SIGKILL' && settled.size > before) continue;
        const error = new Error(killedBy === 'SIGKILL' ? exitReason(code, killedBy) : tail(stderr) || exitReason(code, killedBy));
        for (let i = 0; i < tasks.length; i++) if (!settled.has(i)) await onResult(tasks[i], error);
        break;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  return {
    // Whether the command is here, how it will run, and whether it is warm.
    status() {
      const found = resolveCommand();
      return {
        available: !!found,
        resident: !!found?.serve,
        warm: !!session && !session.closed && !session.ending,
        container,
        provider: session?.provider || (providerArgs().includes('--cpu') ? 'CPU' : '')
      };
    },
    // tasks: [{ input, output, ext }]. onResult(task, error, { ms }) once per task.
    async removeAll(tasks, { signal, onResult = () => {} } = {}) {
      const found = resolveCommand();
      if (!found) throw new Error('Background removal needs JustTools’ justrmbg on this server.');
      return found.serve ? runServe(tasks, { signal, onResult }) : runBatch(tasks, { signal, onResult });
    },
    close() {
      const s = session;
      session = null;
      if (s && !s.closed) { s.ending = true; s.child.stdin.end(); }
    }
  };
}
