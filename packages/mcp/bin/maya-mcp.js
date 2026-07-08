#!/usr/bin/env node
import("../dist/index.js").then((m) => m.main()).catch((e) => { console.error(e); process.exit(1); });
