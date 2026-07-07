#!/usr/bin/env node
// Dev/standalone launcher. In the product, the Phase 5 supervisor boots the
// bus via startBusServer(); this bin exists for development and tests.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { startBusServer } from '../dist/index.js';

const home = process.env.MAYA_HOME || path.join(os.homedir(), '.maya');
fs.mkdirSync(home, { recursive: true });
const dbPath = process.env.MAYA_BUS_DB || path.join(home, 'bus.db');
const port = Number(process.env.MAYA_BUS_PORT || 4300);

const running = await startBusServer({ port, dbPath });
console.log(`maya-bus listening on ws://127.0.0.1:${running.port}/ws/bus/<channelId>  (db: ${dbPath})`);
if (running.bootstrapAdminToken) {
  console.log('\nFirst run — admin token (shown ONCE, store it safely):');
  console.log(`  ${running.bootstrapAdminToken.token}`);
}

const stop = async () => {
  await running.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
