import { CronList } from "@/components/cron-list";
import { CronLog } from "@/components/cron-log";

// The detail sheet of an `inline` table anchors to its nearest positioned
// ancestor. The tables' own roots are `relative` there, which would confine a
// sheet opened from the capped registry region to that region — demote them so
// the console root is the anchor and every sheet covers the whole segment body.
const SHEET_ANCHOR_TO_CONSOLE =
  "[&>[data-testid=cron-list]]:static [&>[data-testid=cron-log]]:static";

/**
 * The Cron segment body: the `CronList` registry stacked over the `CronLog`
 * deliveries. Each table is rendered unchanged — own toolbar (`+ New entry`,
 * `show loop`, default off), own scroll, own detail sheet. The registry is a
 * short list, so its region is content-sized and capped near 40% of the body;
 * the deliveries are the long list and take the rest. `server` and `inline`
 * pass straight through (the desktop drawer mounts inline, the operator route
 * not).
 */
export function CronConsole({ server, inline = false }: { server: string; inline?: boolean }) {
  return (
    <div className="relative flex-1 min-w-0 min-h-0 flex flex-col" data-testid="cron-console">
      <div
        className={`shrink-0 max-h-[40%] min-h-0 flex flex-col ${SHEET_ANCHOR_TO_CONSOLE}`}
        data-testid="cron-console-registry"
      >
        <CronList server={server} inline={inline} />
      </div>
      <div
        className={`flex-1 min-h-0 flex flex-col border-t border-border ${SHEET_ANCHOR_TO_CONSOLE}`}
        data-testid="cron-console-deliveries"
      >
        <CronLog server={server} inline={inline} />
      </div>
    </div>
  );
}
