import * as os from 'node:os';
import * as path from 'node:path';

// The state home dir name. Both the extension and the Go side
// (internal/codebridge/state.go) resolve the cb dir independently, so the
// name and the resolution rule may never drift apart.
export const HOME_DIR_NAME = 'hexokit';

// stateDir resolves <state home>/cb, where the state home is $XDG_STATE_HOME
// when set, else ~/.local/state. env and homedir are injectable for tests.
export function stateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const xdg = env.XDG_STATE_HOME;
  const base = typeof xdg === 'string' && xdg.length > 0 ? xdg : path.join(homedir(), '.local', 'state');
  return path.join(base, HOME_DIR_NAME, 'cb');
}
