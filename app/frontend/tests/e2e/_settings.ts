import { homedir } from "node:os";
import { join } from "node:path";

// Settings-file location shared by the config-touching specs
// (settings-dialog, board-list-reorder). Mirrors the backend's
// settings.Dir() resolution exactly, including the whitespace rule: a set
// but whitespace-only RK_CONFIG_DIR is treated as unset (falling back to
// the real ~/.config/hexokit), and a set value is used VERBATIM — so specs
// and backend always agree on the same file. Under `just test-e2e` the
// harness exports RK_CONFIG_DIR (per-run temp root); under interactive
// `just pw` it is unset and SETTINGS_PATH is the developer's real config,
// which the specs' snapshot/restore pattern protects.
const rawConfigDir = process.env.RK_CONFIG_DIR;
export const CONFIG_DIR =
  rawConfigDir && rawConfigDir.trim() !== ""
    ? rawConfigDir
    : join(homedir(), ".config", "hexokit");
export const SETTINGS_PATH = join(CONFIG_DIR, "config.yaml");
