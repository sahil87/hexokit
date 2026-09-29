import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The state home dir names. Both the extension and the Go side
// (internal/codebridge/state.go) resolve the cb dir independently, so the
// names and the resolution rule may never drift apart.
export const HOME_DIR_NAME = 'hexokit';
export const LEGACY_HOME_DIR_NAME = 'run-kit';

// stateDir resolves <state home>/cb, where the state home is $XDG_STATE_HOME
// when set, else ~/.local/state. Dual-read rule (one release after the
// run-kit → hexokit rename): the new dir when it exists, else the legacy dir
// when it exists, else the new dir. The Go side keeps reading the legacy dir
// for one release, so an old VSIX pinned to run-kit by this rule's legacy
// branch stays reachable after the state home migrates. env and homedir are
// injectable for tests.
export function stateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const xdg = env.XDG_STATE_HOME;
  const base = typeof xdg === 'string' && xdg.length > 0 ? xdg : path.join(homedir(), '.local', 'state');
  const newHome = path.join(base, HOME_DIR_NAME);
  if (fs.existsSync(newHome)) {
    return path.join(newHome, 'cb');
  }
  const legacyHome = path.join(base, LEGACY_HOME_DIR_NAME);
  if (fs.existsSync(legacyHome)) {
    return path.join(legacyHome, 'cb');
  }
  return path.join(newHome, 'cb');
}
