#!/usr/bin/env bun

import { main } from './src/cli';

process.on('SIGINT', () => process.exit(130));

process.exit(await main(process.argv.slice(2)));
