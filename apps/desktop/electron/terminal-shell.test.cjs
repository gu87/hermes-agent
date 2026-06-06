const assert = require('node:assert/strict')
const test = require('node:test')

const { resolveShellCommand } = require('./terminal-shell.cjs')

// Stub existsSync — returns true only for paths in this set.
function stubExistsSync(present) {
  return p => present.has(p)
}

test('macOS: uses SHELL when absolute and exists', () => {
  const result = resolveShellCommand({
    platform: 'darwin',
    envSHELL: '/bin/zsh',
    existsSync: stubExistsSync(new Set(['/bin/zsh']))
  })
  assert.equal(result.command, '/bin/zsh')
  assert.deepEqual(result.args, ['-il'])
  assert.equal(result.name, 'zsh')
})

test('macOS: falls back to /bin/zsh when SHELL is unset', () => {
  const result = resolveShellCommand({
    platform: 'darwin',
    envSHELL: '',
    existsSync: stubExistsSync(new Set(['/bin/zsh']))
  })
  assert.equal(result.command, '/bin/zsh')
})

test('macOS: falls back to /bin/bash when SHELL is invalid and zsh missing', () => {
  const result = resolveShellCommand({
    platform: 'darwin',
    envSHELL: '/nonexistent/shell',
    existsSync: stubExistsSync(new Set(['/bin/bash']))
  })
  assert.equal(result.command, '/bin/bash')
})

test('macOS: falls back to /bin/sh when SHELL is relative', () => {
  const result = resolveShellCommand({
    platform: 'darwin',
    envSHELL: 'zsh',
    existsSync: stubExistsSync(new Set(['/bin/sh']))
  })
  assert.equal(result.command, '/bin/sh')
})

test('macOS: returns /bin/sh as last resort even if it does not exist', () => {
  const result = resolveShellCommand({
    platform: 'darwin',
    envSHELL: '',
    existsSync: stubExistsSync(new Set())
  })
  assert.equal(result.command, '/bin/sh')
})

test('macOS: returns interactive login args for zsh', () => {
  const result = resolveShellCommand({
    platform: 'darwin',
    envSHELL: '/bin/zsh',
    existsSync: stubExistsSync(new Set(['/bin/zsh']))
  })
  assert.deepEqual(result.args, ['-il'])
})

test('macOS: returns interactive login args for bash', () => {
  const result = resolveShellCommand({
    platform: 'darwin',
    envSHELL: '/bin/bash',
    existsSync: stubExistsSync(new Set(['/bin/bash']))
  })
  assert.deepEqual(result.args, ['-il'])
})

test('macOS: returns -i (not -il) for non-zsh/bash shells', () => {
  const result = resolveShellCommand({
    platform: 'darwin',
    envSHELL: '/bin/fish',
    existsSync: stubExistsSync(new Set(['/bin/fish']))
  })
  assert.deepEqual(result.args, ['-i'])
})

test('linux: same fallback chain as macOS', () => {
  const result = resolveShellCommand({
    platform: 'linux',
    envSHELL: '',
    existsSync: stubExistsSync(new Set(['/bin/bash']))
  })
  assert.equal(result.command, '/bin/bash')
  assert.deepEqual(result.args, ['-il'])
})

test('windows: uses COMSPEC when absolute and exists', () => {
  const result = resolveShellCommand({
    platform: 'win32',
    // A path that path.isAbsolute() returns true for on the host OS running
    // the test (typically Unix). On real Windows this would be C:\… instead.
    envComspec: '/opt/cmd.exe',
    existsSync: stubExistsSync(new Set(['/opt/cmd.exe']))
  })
  assert.equal(result.command, '/opt/cmd.exe')
  assert.deepEqual(result.args, [])
  assert.equal(result.name, 'cmd.exe')
})

test('windows: falls back to cmd.exe when COMSPEC is unset', () => {
  const result = resolveShellCommand({
    platform: 'win32',
    envComspec: '',
    existsSync: stubExistsSync(new Set())
  })
  assert.equal(result.command, 'cmd.exe')
  assert.deepEqual(result.args, [])
  assert.equal(result.name, 'cmd.exe')
})

test('windows: falls back to cmd.exe when COMSPEC is relative', () => {
  const result = resolveShellCommand({
    platform: 'win32',
    envComspec: 'cmd.exe',
    existsSync: stubExistsSync(new Set())
  })
  assert.equal(result.command, 'cmd.exe')
  assert.deepEqual(result.args, [])
})

test('returns absolute paths only', () => {
  // When SHELL is set to an existing absolute path, it stays absolute.
  const zsh = resolveShellCommand({
    platform: 'darwin',
    envSHELL: '/bin/zsh',
    existsSync: stubExistsSync(new Set(['/bin/zsh']))
  })
  assert.ok(zsh.command.startsWith('/'))

  // Fallback also returns absolute paths.
  const fallback = resolveShellCommand({
    platform: 'darwin',
    envSHELL: '',
    existsSync: stubExistsSync(new Set(['/bin/zsh']))
  })
  assert.ok(fallback.command.startsWith('/'))

  // Even the last resort is absolute.
  const last = resolveShellCommand({
    platform: 'darwin',
    envSHELL: '',
    existsSync: stubExistsSync(new Set())
  })
  assert.equal(last.command, '/bin/sh')
  assert.ok(last.command.startsWith('/'))
})
