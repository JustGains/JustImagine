import { loadConfig, ensureDefaultConfig } from './config.js';
import { runJustImagine, runImagineCommand, runServiceCommand, imagineHelp, parseImagineArgs } from './justimagine.js';
import { createAuth } from './auth.js';

export { createAuth };
export { createImagineCli } from './justimagine.js';
export { createServer, listenOnFreePort } from './justimagine-server.js';

export async function runCli(argv = []) {
  ensureDefaultConfig();
  const args = [...argv];
  if (args[0] === 'imagine' || args[0] === 'justimagine') args.shift();
  const [cmd, ...rest] = args;
  const config = loadConfig();
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') { console.log(imagineHelp(config)); return 0; }
  if (cmd === 'service' || cmd === 'daemon') return runServiceCommand(rest);
  if (cmd === 'open') return runImagineCommand(['open', ...rest], { config });
  if (cmd === 'skill' || cmd === 'skills') return runImagineCommand([cmd, ...rest], { config });
  const flags = parseImagineArgs(args);
  return runJustImagine({ config, apiId: flags.api, root: flags.root, port: flags.port, open: flags.open !== false });
}
