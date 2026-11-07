import { prepareRune, PROJECT_ROOT } from './prepare-rune'
import { bundleEngine } from '../engine/build'

await prepareRune()
const commands = [
  ['bun', 'run', 'typecheck'],
  ['bun', 'run', 'lint'],
  ['bun', 'node_modules/typescript/bin/tsc', '--project', 'rune/engine/tsconfig.json', '--noEmit'],
  ['bun', 'node_modules/oxlint/bin/oxlint', 'rune/engine', 'rune/scripts'],
  ['cargo', 'check', '--manifest-path', 'rune/Cargo.toml', '--all-targets'],
]
for (const command of commands) {
  console.log(`Checking: ${command.join(' ')}`)
  const processHandle = Bun.spawn(command, { cwd: PROJECT_ROOT, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
  const code = await processHandle.exited
  if (code !== 0) process.exit(code)
}
await bundleEngine()
