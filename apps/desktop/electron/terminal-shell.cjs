/**
 * terminal-shell.cjs
 *
 * Resolve the interactive shell command, args, and display name for the
 * terminal PTY. Pure — no `require('electron')` — so it can be unit-tested
 * with `node --test` (same pattern as connection-config.cjs / bootstrap-platform.cjs).
 *
 * macOS / Linux resolution order:
 *   1. process.env.SHELL              (if absolute + exists)
 *   2. /bin/zsh → /bin/bash → /bin/sh (first one that exists)
 *   3. /bin/sh                        (last-resort fallback)
 *
 * Windows: process.env.COMSPEC or cmd.exe.
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * @param {object} opts
 * @param {string} opts.platform       — process.platform ('darwin' | 'linux' | 'win32')
 * @param {string} [opts.envSHELL]     — process.env.SHELL  (unix)
 * @param {string} [opts.envComspec]   — process.env.COMSPEC (windows)
 * @param {((p: string) => boolean)} [opts.existsSync]  — fs.existsSync, injectable for tests
 * @returns {{ command: string, args: string[], name: string }}
 */
function resolveShellCommand(opts = {}) {
  const { platform } = opts
  const existsSync = opts.existsSync || fs.existsSync

  if (platform === 'win32') {
    const comspec = opts.envComspec || ''
    const command =
      (path.isAbsolute(comspec) && existsSync(comspec) && comspec) || 'cmd.exe'
    return { args: [], command, name: path.basename(command) }
  }

  // macOS / Linux: prefer SHELL, then common fallbacks.
  const configuredShell = opts.envSHELL || ''
  const shellPath =
    (path.isAbsolute(configuredShell) && existsSync(configuredShell) && configuredShell) ||
    ['/bin/zsh', '/bin/bash', '/bin/sh'].find(candidate => existsSync(candidate)) ||
    '/bin/sh'

  const shellName = path.basename(shellPath)
  const interactiveArgs =
    shellName.includes('zsh') || shellName.includes('bash') ? ['-il'] : ['-i']

  return { args: interactiveArgs, command: shellPath, name: shellName }
}

module.exports = { resolveShellCommand }
