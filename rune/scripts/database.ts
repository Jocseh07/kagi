import { bundleEngine } from '../engine/build'
import { PROJECT_ROOT } from './prepare-rune'

const operation = process.argv[2]
if (operation !== 'status' && operation !== 'initialize') throw new Error('Choose status or initialize.')
const rest = process.argv.slice(3).filter((value) => value !== '--')
if (!rest.includes('--data-dir')) throw new Error('Name the target database directory with --data-dir.')
const entry = await bundleEngine()
const processHandle = Bun.spawn([process.execPath, entry, operation === 'status' ? '--status' : '--initialize', ...rest], { cwd: PROJECT_ROOT, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
process.exitCode = await processHandle.exited
