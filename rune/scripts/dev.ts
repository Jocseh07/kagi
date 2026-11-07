import { bundleEngine } from '../engine/build'
import { prepareRune, PROJECT_ROOT } from './prepare-rune'
import { prepareAssets } from './fonts'

await prepareRune()
const engine = await bundleEngine()
const assets = await prepareAssets()
const args = process.argv.slice(2).filter((value) => value !== '--')
const processHandle = Bun.spawn(['cargo', 'run', '--manifest-path', 'rune/Cargo.toml', '--', ...args], {
  cwd: PROJECT_ROOT,
  env: { ...process.env, KAGI_ENGINE: engine, KAGI_BUN: process.execPath, KAGI_ASSETS_DIR: assets },
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
})
const stop = () => processHandle.kill('SIGTERM')
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.exitCode = await processHandle.exited
process.off('SIGINT', stop)
process.off('SIGTERM', stop)
