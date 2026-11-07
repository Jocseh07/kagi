import { expect, test } from 'bun:test'

test('pipeline concurrency and recovery scenarios run in an isolated process', async () => {
  const child = Bun.spawn([process.execPath, 'test', '--tsconfig-override', 'tsconfig.app.json', './scripts/adapt-pipeline.fixture.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // A real deadline kills a wedged subprocess; fake timers cannot control its event loop.
  const deadline = setTimeout(() => child.kill(), 15000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(code, stdout + stderr).toBe(0)
  } finally {
    clearTimeout(deadline)
    child.kill()
  }
}, 20000)
