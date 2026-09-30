#!/usr/bin/env node
import { runCli } from '../src/index.js';
runCli(process.argv.slice(2)).then((code) => { process.exitCode = typeof code === 'number' ? code : 0; }).catch((error) => { console.error(error?.message || error); process.exitCode = 1; });
