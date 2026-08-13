import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const buildDirectory = resolve(import.meta.dirname, '../build')
await rm(buildDirectory, { recursive: true, force: true })
