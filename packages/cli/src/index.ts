#!/usr/bin/env node
import { nodeIo } from './io.ts'
import { runCli } from './run.ts'

process.exitCode = await runCli(process.argv.slice(2), nodeIo())
