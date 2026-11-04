# Cron Schedule Kinds — Four Ways a Clock Can Wake an Agent

> [← Back to the README](https://github.com/sahil87/hexokit/blob/main/README.md)

An interactive explainer for `rk cron`: the three schedule kinds (`every`, `cron`, `backoff`) and the `wake_on` edge trigger, each as an animated timeline you can play, restart, and change the rules of — plus the `deliver` policy that decides what happens when the agent is busy at fire time. Companion to the [cron spec](https://github.com/sahil87/hexokit/blob/main/docs/specs/cron.md).

<div class="rk-cron-clocks not-content"><div class="wrap">
  <header>
    <div class="eyebrow">HexoKit · rk cron</div>
    <div class="title" role="heading" aria-level="2">Four ways a clock can wake an agent</div>
    <p>An <code>rk cron</code> entry is a small intent file: <em>what</em> text to deliver, <em>which</em> pane to deliver it to, and <em>when</em>. The “when” comes in three schedule kinds plus one optional edge trigger, and a <code>deliver</code> policy on the entry says what to do if the agent is busy at that moment — send anyway, hold until idle, or skip the fire. A ticker polls every 30 seconds and asks a pure function, “given the entries, the delivery log and the panes’ agent states on disk right now, what is due?” Nothing is remembered in memory, so a restart never loses the clock.</p>
    <div class="legend">
      <span><i class="dot" style="background:var(--sched)"></i> schedule fire</span>
      <span><i class="dot" style="background:var(--wake)"></i> wake fire</span>
      <span><i class="dot" style="background:transparent;border:2px solid var(--miss)"></i> missed occurrence</span>
      <span><i class="dot" style="background:transparent;border:2px solid var(--wake)"></i> held</span>
      <span><i class="dot" style="background:transparent;border:2px solid var(--sched)"></i> skipped (busy)</span>
      <span><i class="sw" style="background:var(--act)"></i> agent active</span>
      <span><i class="sw" style="background:var(--wait)"></i> agent waiting</span>
      <span><i class="sw" style="background:var(--line)"></i> agent idle</span>
      <span><i class="sw" style="background:var(--outage);border:1px dashed var(--ink-3)"></i> daemon down</span>
    </div>
    <p style="font-size:14px;color:var(--ink-3)">Every panel loads finished. Press <b>Play</b> to watch it happen; toggles change the rules and replay.</p>
  </header>
  <!-- ===================== EVERY ===================== -->
  <section class="panel" id="p-every">
    <div class="panel-head">
      <h2>every <small>fixed interval</small></h2>
      <div class="add">rk cron add "check PRs" --every 5m</div>
    </div>
    <div class="panel-body">
      <div class="stage">
        <canvas id="c-every" height="150" aria-label="Timeline of fixed-interval fires"></canvas>
        <div class="controls">
          <button class="primary" data-act="play">Play</button>
          <button data-act="restart">Restart</button>
          <button data-toggle="outage" aria-pressed="false">Daemon down 20–33 min</button>
          <div class="readout" data-readout></div>
        </div>
      </div>
      <div class="rule">
        <p>A metronome. It fires whenever <strong>now − last delivery ≥ interval</strong>. The anchor is the newest line for this entry in the delivery log, or the moment the entry was created before its first fire.</p>
        <h3>What to notice</h3>
        <ul>
          <li>Nothing is “scheduled ahead”. Each poll just re-checks the gap since the last delivery.</li>
          <li>If the daemon was down, the first poll after restart sees a gap larger than the interval and fires immediately, then the rhythm continues from there. Nothing piles up.</li>
        </ul>
      </div>
    </div>
  </section>
  <!-- ===================== CRON ===================== -->
  <section class="panel" id="p-cron">
    <div class="panel-head">
      <h2>cron <small>wall clock</small></h2>
      <div class="add">rk cron add "morning digest" --cron "0 9 * * *" [--catch-up once]</div>
    </div>
    <div class="panel-body">
      <div class="stage">
        <canvas id="c-cron" height="150" aria-label="Timeline of daily 09:00 fires over three days"></canvas>
        <div class="controls">
          <button class="primary" data-act="play">Play</button>
          <button data-act="restart">Restart</button>
          <button data-toggle="catchup" aria-pressed="false">catch_up: once</button>
          <div class="readout" data-readout></div>
        </div>
      </div>
      <div class="rule">
        <p>The classic five-field expression, in the daemon’s local time. The evaluator finds the latest occurrence since the last delivery and fires if it is still inside a <strong>2-minute grace window</strong> (covering the 30 s poll and short restarts).</p>
        <h3>What to notice</h3>
        <ul>
          <li>An occurrence that fell while the daemon was down is <strong>skipped</strong> by default and logged as <code>missed</code>. Firing a 09:00 digest at 14:00 is usually wrong.</li>
          <li><code>catch_up: once</code> opts in to exactly one late fire per gap, the moment the daemon is back.</li>
        </ul>
      </div>
    </div>
  </section>
  <!-- ===================== BACKOFF ===================== -->
  <section class="panel" id="p-backoff">
    <div class="panel-head">
      <h2>backoff <small>doubling ladder from the last real activity</small></h2>
      <div class="add">rk cron add "operator tick" --backoff --min 1m --max 30m</div>
    </div>
    <div class="panel-body">
      <div class="stage">
        <canvas id="c-backoff" height="190" aria-label="Timeline of backoff fires with the operator's activity strip"></canvas>
        <div class="controls">
          <button class="primary" data-act="play">Play</button>
          <button data-act="restart">Restart</button>
          <button data-act="poke">You type to the operator</button>
          <button data-toggle="flat" aria-pressed="false">flat: min = max (idle reminder)</button>
          <div class="readout" data-readout></div>
        </div>
      </div>
      <div class="rule">
        <p>Gaps of <strong>1, 2, 4, 8, 16 min, then 30 min</strong> forever, counted from an <em>anchor</em>. The anchor is not the last fire. It is the last time the target pane went idle <strong>for a reason other than the clock</strong>, read from its <code>@rk_pane_agent_state</code> option.</p>
        <h3>The signal</h3>
        <ul>
          <li>Every delivery makes the agent busy for a few seconds, then idle again. That flip lands within <strong>120 s</strong> of the entry’s own delivery, so the clock says “I caused that” and the ladder <em>keeps climbing</em>.</li>
          <li>An idle flip <em>not</em> explained by a recent delivery is genuine activity: someone typed, or the agent did real work. The ladder <strong>resets</strong> to a 1-minute gap from that moment.</li>
          <li>So: quiet agent, ticks thin out. Busy agent, ticks stay frequent. The agent never has to tell the clock anything.</li>
          <li>Set <code>min = max</code> and the ladder is flat — “ping every 3 min of quiet”. Same anchor rules: the clock’s own pings don’t restart the count, real activity does. <code>rk cron add "wake up" --idle-every 3m</code> writes exactly this entry — no new kind, no schema field.</li>
        </ul>
      </div>
    </div>
  </section>
  <!-- ===================== WAKE ===================== -->
  <section class="panel" id="p-wake">
    <div class="panel-head">
      <h2>wake_on <small>edge trigger, OR’d onto any schedule</small></h2>
      <div class="add">wake_on: { event: agent-state-change, scope: server, debounce: 60s }</div>
    </div>
    <div class="panel-body">
      <div class="stage">
        <canvas id="c-wake" height="230" aria-label="Agent state strips with wake fires on actionable transitions"></canvas>
        <div class="controls">
          <button class="primary" data-act="play">Play</button>
          <button data-act="restart">Restart</button>
          <div class="readout" data-readout></div>
        </div>
      </div>
      <div class="rule">
        <p>Not a schedule at all. Each poll fingerprints the state of <strong>every other pane on the server</strong> and fires when the fingerprint changed by an <em>actionable</em> transition.</p>
        <h3>Three rules keep it from feeding on itself</h3>
        <ul>
          <li><strong>Actionable</strong> = a pane became <span style="color:var(--wait)">waiting</span> (a question), became idle (finished), or disappeared. Becoming <span style="color:var(--act)">active</span> is ignored: an agent starting work needs no attention.</li>
          <li><strong>Self-exclusion</strong>: the target’s own pane is left out of the fingerprint. A delivery makes the target busy, and that must never count as the next edge.</li>
          <li><strong>Debounce</strong>: an edge within 60 s of the entry’s last delivery is held, not dropped, and fires on a later poll. A burst coalesces into one delivery.</li>
        </ul>
      </div>
    </div>
  </section>
  <!-- ===================== DELIVER ===================== -->
  <section class="panel" id="p-deliver">
    <div class="panel-head">
      <h2>deliver <small>what happens when the agent is busy at fire time</small></h2>
      <div class="add">rk cron add "check PRs" --every 5m --deliver skip-if-busy</div>
    </div>
    <div class="panel-body">
      <div class="stage">
        <canvas id="c-deliver" height="240" aria-label="Three delivery policies across one busy stretch of an every-5m entry"></canvas>
        <div class="controls">
          <button class="primary" data-act="play">Play</button>
          <button data-act="restart">Restart</button>
          <button data-toggle="busy" aria-pressed="true">agent busy 7–18 min</button>
          <div class="readout" data-readout></div>
        </div>
      </div>
      <div class="rule">
        <p>The schedule decides <em>when</em> a fire comes due; <code>deliver</code> decides what happens if the target agent is busy at that moment. One <code>every 5m</code> entry below, three policies, one busy stretch (the green block on the state strip).</p>
        <h3>Hold, drop, or neither</h3>
        <ul>
          <li><strong>immediate</strong> ignores the agent state: every boundary fires, busy or not — the payload lands in a working pane.</li>
          <li><strong>when-idle</strong> <em>holds</em> a busy-pane fire and delivers the moment the agent goes idle; the rhythm re-anchors on that delivery. A hold is bounded: 2 hours past the due time it expires with a logged <code>held-expired</code> rather than landing hours late.</li>
          <li><strong>skip-if-busy</strong> <em>drops</em> a busy-pane fire: the skip is logged (<code>skipped-busy</code>), so the next attempt is one full interval later, not the next 30 s poll — and the grid itself never moves.</li>
        </ul>
      </div>
    </div>
  </section>
  <!-- ===================== TOGETHER ===================== -->
  <section class="panel summary" id="p-together">
    <h2>Put together: the operator’s clock</h2>
    <div>
      <p>The operator tick seeded on every tmux server — rk defines the clock; the operator consumer (fab) plants and tunes the entry, and <code>rk operator</code> only launches the operator the entry respawns — is one entry using two of these mechanisms at once. <strong>wake_on</strong> is the reactive channel: an agent asks a question, the operator is pinged within a poll. <strong>backoff</strong> is the fallback poll: it thins out to every 24 minutes when nothing is happening and snaps back to 3 minutes the moment someone touches the operator.</p>
      <p>Either channel’s fire is a “delivery” of the same entry, appended to a per-server log as <code>{ts, entry, target, reason, outcome}</code>. That log, plus the panes’ state options, is the entire memory of the clock. The only way to silence an entry is to tell it: <code>rk cron mute &lt;id&gt; --for 30m</code>.</p>
      <pre><code>id: uqdy
name: operator tick
schedule: { kind: backoff, min: 3m, max: 24m }
wake_on:  { event: agent-state-change, scope: server, debounce: 1m }
target:   { kind: role, role: operator }
payload:  operator tick
deliver:  skip-if-busy
if_absent: respawn   # dead operator? relaunch `rk operator`, then deliver
pinned:   true</code></pre>
    </div>
    <div class="tablewrap">
      <table>
        <thead><tr><th>Kind</th><th>Fires when…</th><th>Good for</th></tr></thead>
        <tbody>
          <tr><td>every</td><td>the gap since the last delivery reaches the interval</td><td>plain heartbeats, polling a queue</td></tr>
          <tr><td>cron</td><td>a wall-clock occurrence arrives (missed ones skipped unless <code>catch_up: once</code>)</td><td>“09:00 every day”, weekly reports</td></tr>
          <tr><td>backoff</td><td>the doubling ladder from the last <em>genuine</em> idle moment comes due</td><td>attention that should fade while quiet</td></tr>
          <tr><td>backoff, min = max<br>(<code>--idle-every</code>)</td><td>X after the last genuine idle moment, then every X while it stays quiet</td><td>reminders that wait for quiet</td></tr>
          <tr><td>wake_on</td><td>another pane finished, asked something, or vanished</td><td>reacting within seconds instead of a poll</td></tr>
        </tbody>
      </table>
      <p style="margin-top:14px;font-size:14px;color:var(--ink-3)">The flat ladder’s fixed-grid cousin is <code>--every X --deliver skip-if-busy</code>: it fires only at grid points where the agent happens to be idle, skipping busy boundaries instead of waiting out a fresh X of quiet — the deliver panel above shows the difference.</p>
      <p style="margin-top:14px;font-size:14px;color:var(--ink-3)">All four are evaluated by the same 30-second poll, so any fire lands up to 30 s after it came due. Every payload must tolerate being delivered twice; a restart may re-fire one due tick.</p>
    </div>
  </section>
</div>
</div>

<style>
  .rk-cron-clocks {
    --bg: #EDF0F2;
    --bg-panel: #F7F8F9;
    --bg-inset: #E2E6EA;
    --ink: #17222B;
    --ink-2: #4A5966;
    --ink-3: #7B8894;
    --line: #C9D1D8;
    --line-2: #DCE2E7;
    --sched: #2F6FDB;      /* schedule fires */
    --sched-soft: #2F6FDB33;
    --wake: #D9821B;       /* wake (edge) fires */
    --wake-soft: #D9821B33;
    --act: #199C5A;        /* agent active */
    --act-soft: #199C5A2E;
    --wait: #C23B5E;       /* agent waiting */
    --miss: #8A96A1;
    --outage: #17222B14;
    --focus: #2F6FDB;
    --mono: var(--sl-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    --sans: var(--sl-font, system-ui, -apple-system, 'Segoe UI', sans-serif);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .rk-cron-clocks {
      --bg: #0F1519; --bg-panel: #161D23; --bg-inset: #0B1014;
      --ink: #E3E9EE; --ink-2: #A9B5BF; --ink-3: #6F7D89;
      --line: #2A343D; --line-2: #1F282F;
      --sched: #6FA0FF; --sched-soft: #6FA0FF33;
      --wake: #F0A24A; --wake-soft: #F0A24A33;
      --act: #3DDC84; --act-soft: #3DDC842E;
      --wait: #FF6B8E; --miss: #6F7D89; --outage: #E3E9EE12; --focus: #6FA0FF;
    }
  }
  :root[data-theme="dark"] .rk-cron-clocks {
    --bg: #0F1519; --bg-panel: #161D23; --bg-inset: #0B1014;
    --ink: #E3E9EE; --ink-2: #A9B5BF; --ink-3: #6F7D89;
    --line: #2A343D; --line-2: #1F282F;
    --sched: #6FA0FF; --sched-soft: #6FA0FF33;
    --wake: #F0A24A; --wake-soft: #F0A24A33;
    --act: #3DDC84; --act-soft: #3DDC842E;
    --wait: #FF6B8E; --miss: #6F7D89; --outage: #E3E9EE12; --focus: #6FA0FF;
    color-scheme: dark;
  }
  .rk-cron-clocks * { box-sizing: border-box; }
  .rk-cron-clocks {
    color: var(--ink); font-family: var(--sans); font-size: 16px; line-height: 1.55;
    padding-block: 8px 40px;
  }
  .rk-cron-clocks { container-type: inline-size; }
  .rk-cron-clocks .wrap { max-width: 1040px; margin: 0 auto; display: grid; gap: 56px; }
  .rk-cron-clocks header { display: grid; gap: 14px; max-width: 720px; }
  .rk-cron-clocks .eyebrow { font-family: var(--mono); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-3); }
  .rk-cron-clocks .title { font-family: var(--mono); font-weight: 600; font-size: clamp(30px, 5vw, 46px); line-height: 1.1; margin: 0; letter-spacing: -.02em; text-wrap: balance; }
  .rk-cron-clocks header p { margin: 0; color: var(--ink-2); font-size: 17px; max-width: 62ch; }
  .rk-cron-clocks code, .rk-cron-clocks pre { font-family: var(--mono); font-size: .92em; }
  .rk-cron-clocks code { background: var(--bg-inset); padding: .1em .4em; border-radius: 4px; }
  .rk-cron-clocks pre { background: var(--bg-inset); padding: 14px 16px; border-radius: 6px; overflow-x: auto; margin: 0; line-height: 1.5; font-size: 13px; }
  .rk-cron-clocks pre code { background: none; padding: 0; }
  .rk-cron-clocks .legend { display: flex; flex-wrap: wrap; gap: 8px 22px; font-family: var(--mono); font-size: 12px; color: var(--ink-2); }
  .rk-cron-clocks .legend span { display: inline-flex; align-items: center; gap: 7px; }
  .rk-cron-clocks .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .rk-cron-clocks .sw { width: 18px; height: 8px; border-radius: 2px; display: inline-block; }
  .rk-cron-clocks .panel {
    background: var(--bg-panel); border: 1px solid var(--line-2); border-radius: 10px;
    padding: 24px 24px 20px; display: grid; gap: 18px;
  }
  .rk-cron-clocks .panel-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px 24px; align-items: start; }
  .rk-cron-clocks .panel-head h2 { margin: 0; font-family: var(--mono); font-weight: 600; font-size: 22px; letter-spacing: -.01em; }
  .rk-cron-clocks .panel-head h2 small { font-weight: 400; color: var(--ink-3); font-size: 14px; margin-left: 10px; }
  .rk-cron-clocks .panel-head .add { font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); background: var(--bg-inset); padding: 6px 10px; border-radius: 5px; white-space: nowrap; overflow-x: auto; max-width: 100%; }
  .rk-cron-clocks .panel-body { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 20px 28px; align-items: start; }
  .rk-cron-clocks .panel-body p { margin: 0 0 10px; color: var(--ink-2); font-size: 15px; }
  .rk-cron-clocks .panel-body p strong { color: var(--ink); font-weight: 600; }
  .rk-cron-clocks .stage { display: grid; gap: 10px; min-width: 0; }
  .rk-cron-clocks canvas { width: 100%; max-width: 100%; min-width: 0; display: block; border-radius: 6px; background: var(--bg-inset); }
  .rk-cron-clocks .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .rk-cron-clocks button {
    font-family: var(--mono); font-size: 12.5px; font-weight: 500; color: var(--ink);
    background: var(--bg-panel); border: 1px solid var(--line); border-radius: 5px; padding: 6px 12px; cursor: pointer;
  }
  .rk-cron-clocks button:hover { border-color: var(--ink-3); }
  .rk-cron-clocks button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .rk-cron-clocks button[aria-pressed="true"] { background: var(--ink); color: var(--bg-panel); border-color: var(--ink); }
  .rk-cron-clocks button.primary { border-color: var(--ink); }
  .rk-cron-clocks .readout { margin-left: auto; font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); font-variant-numeric: tabular-nums; text-align: right; }
  .rk-cron-clocks .readout b { color: var(--ink); font-weight: 600; }
  .rk-cron-clocks .rule { display: grid; gap: 8px; }
  .rk-cron-clocks .rule h3 { margin: 0; font-family: var(--mono); font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); font-weight: 500; }
  .rk-cron-clocks .rule ul { margin: 0; padding-left: 18px; color: var(--ink-2); font-size: 14.5px; display: grid; gap: 6px; }
  .rk-cron-clocks .summary { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 24px 32px; align-items: start; }
  .rk-cron-clocks .summary h2 { grid-column: 1 / -1; margin: 0; font-family: var(--mono); font-weight: 600; font-size: 22px; }
  .rk-cron-clocks .summary p { margin: 0 0 10px; color: var(--ink-2); font-size: 15px; }
  .rk-cron-clocks table { border-collapse: collapse; width: 100%; font-size: 14px; }
  .rk-cron-clocks th, .rk-cron-clocks td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line-2); vertical-align: top; }
  .rk-cron-clocks th { font-family: var(--mono); font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); font-weight: 500; }
  .rk-cron-clocks td:first-child { font-family: var(--mono); font-size: 13px; white-space: nowrap; }
  .rk-cron-clocks .tablewrap { overflow-x: auto; }
  @container (max-width: 760px) {
    .rk-cron-clocks .panel-body, .rk-cron-clocks .summary { grid-template-columns: 1fr; }
    .rk-cron-clocks .panel-head { grid-template-columns: 1fr; }
    .rk-cron-clocks .panel { padding: 18px 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .rk-cron-clocks .pulse { display: none; }
  }
</style>

<script>
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.querySelector('.rk-cron-clocks');
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const fmtMin = (m) => { const h = Math.floor(m / 60), mm = Math.round(m % 60); return h ? `${h}h ${String(mm).padStart(2,'0')}m` : `${mm}m`; };
  /* ---------- shared engine ---------- */
  class Sim {
    constructor(sectionId, canvasId, cfg) {
      this.section = document.getElementById(sectionId);
      this.canvas = document.getElementById(canvasId);
      this.ctx = this.canvas.getContext('2d');
      this.duration = cfg.duration;         // sim units (minutes or hours)
      this.speed = cfg.speed;               // sim units per real second
      this.compute = cfg.compute;           // (state) -> model
      this.draw = cfg.draw;                 // (ctx, w, h, t, model, self) -> void
      this.readout = cfg.readout || (() => '');
      this.state = cfg.initial ? cfg.initial() : {};
      this.t = this.duration;               // page at rest: show the finished timeline
      this.playing = false;
      this.last = null;
      this.model = this.compute(this.state, this);
      this.readoutEl = this.section.querySelector('[data-readout]');
      this.playBtn = this.section.querySelector('[data-act="play"]');
      this.section.querySelectorAll('button').forEach(b => {
        const act = b.dataset.act, tog = b.dataset.toggle;
        if (act === 'play') b.addEventListener('click', () => this.toggle());
        else if (act === 'restart') b.addEventListener('click', () => this.restart(true));
        else if (act && cfg.actions && cfg.actions[act]) b.addEventListener('click', () => { const run = cfg.actions[act]; run(this); this.model = this.compute(this.state, this); this.render(); });
        else if (tog) b.addEventListener('click', () => {
          this.state[tog] = !this.state[tog];
          b.setAttribute('aria-pressed', String(this.state[tog]));
          if (cfg.onToggle) cfg.onToggle(this, tog);
          this.model = this.compute(this.state, this);
          this.restart(true);
        });
      });
      this.stage = this.canvas.parentElement;
      this.cssH = parseInt(this.canvas.getAttribute('height'), 10);
      this.canvas.style.height = this.cssH + 'px';
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.stage);
      this.resize();
    }
    resize() {
      // Measure the container, never the canvas: a canvas's own min-content width is
      // its bitmap width, so measuring itself under a DPR scale feeds back and grows unbounded.
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(200, Math.floor(this.stage.clientWidth)), h = this.cssH;
      if (w === this.w && this.canvas.width === Math.round(w * dpr)) return;
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w; this.h = h;
      this.render();
    }
    toggle() { this.playing ? this.pause() : this.play(); }
    play() {
      if (this.t >= this.duration) { this.t = 0; if (this.resetFn) this.resetFn(this); this.model = this.compute(this.state, this); }
      this.playing = true; this.playBtn.textContent = 'Pause'; this.last = null;
      requestAnimationFrame(ts => this.frame(ts));
    }
    pause() { this.playing = false; this.playBtn.textContent = 'Play'; }
    restart(autoplay) {
      this.t = 0; if (this.resetFn) this.resetFn(this); this.model = this.compute(this.state, this);
      if (autoplay && !reduced) this.play(); else { this.pause(); this.t = reduced ? this.duration : 0; this.render(); }
    }
    frame(ts) {
      if (!this.playing) return;
      if (this.last == null) this.last = ts;
      const dt = (ts - this.last) / 1000; this.last = ts;
      this.t = Math.min(this.duration, this.t + dt * this.speed);
      this.render();
      if (this.t >= this.duration) { this.pause(); return; }
      requestAnimationFrame(ts2 => this.frame(ts2));
    }
    render() {
      const { ctx, w, h } = this; if (!w) return;
      ctx.clearRect(0, 0, w, h);
      this.draw(ctx, w, h, this.t, this.model, this);
      if (this.readoutEl) this.readoutEl.innerHTML = this.readout(this.t, this.model, this);
      if (!this.playing && !reduced && this.hasPulse(this.t)) requestAnimationFrame(() => this.render());
    }
    hasPulse(t) { return (this.model.fires || []).some(f => t - f.t >= 0 && t - f.t < this.pulseSpan); }
  }
  /* ---------- drawing helpers ---------- */
  const PAD = { l: 18, r: 18 };
  const xOf = (t, dur, w) => PAD.l + (t / dur) * (w - PAD.l - PAD.r);
  function axis(ctx, w, y, dur, step, labelFn, opts = {}) {
    ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD.l, y + .5); ctx.lineTo(w - PAD.r, y + .5); ctx.stroke();
    ctx.fillStyle = css('--ink-3'); ctx.font = `11px ${css('--mono')}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let t = 0; t <= dur + 1e-9; t += step) {
      const x = xOf(t, dur, w);
      ctx.beginPath(); ctx.moveTo(x + .5, y - 4); ctx.lineTo(x + .5, y + 4); ctx.stroke();
      if (!opts.every || Math.round(t / step) % opts.every === 0) ctx.fillText(labelFn(t), x, y + 8);
    }
  }
  function region(ctx, w, dur, a, b, y0, y1, label) {
    const x0 = xOf(a, dur, w), x1 = xOf(b, dur, w);
    ctx.fillStyle = css('--outage'); ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = css('--ink-3'); ctx.lineWidth = 1;
    ctx.strokeRect(x0 + .5, y0 + .5, x1 - x0 - 1, y1 - y0 - 1); ctx.setLineDash([]);
    if (label) { ctx.fillStyle = css('--ink-3'); ctx.font = `11px ${css('--mono')}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(label, (x0 + x1) / 2, y0 + 6); }
  }
  function playhead(ctx, w, h, t, dur, y0, y1) {
    const x = xOf(t, dur, w);
    ctx.strokeStyle = css('--ink'); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    ctx.fillStyle = css('--ink'); ctx.beginPath(); ctx.moveTo(x - 5, y0); ctx.lineTo(x + 5, y0); ctx.lineTo(x, y0 + 6); ctx.closePath(); ctx.fill();
  }
  // a fire: filled dot + expanding ring for pulseSpan sim units after it lands
  function fire(ctx, x, y, color, age, span, label, labelColor, hollow) {
    if (hollow) {
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill();
      if (!reduced && age >= 0 && age < span) {
        const k = age / span;
        ctx.strokeStyle = color; ctx.globalAlpha = 1 - k; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 6 + k * 16, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    if (label) { ctx.fillStyle = labelColor || color; ctx.font = `11px ${css('--mono')}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(label, x, y - 10); }
  }
  function stem(ctx, x, y0, y1, color) { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + .5, y0); ctx.lineTo(x + .5, y1); ctx.stroke(); }
  function strip(ctx, w, dur, y, hgt, segs, t, name) {
    // segs: [{a,b,state}] ; states: idle|active|waiting ; draw up to t
    ctx.fillStyle = css('--line-2'); ctx.fillRect(PAD.l, y, xOf(Math.min(t, dur), dur, w) - PAD.l, hgt);
    for (const s of segs) {
      if (s.a >= t) continue;
      const x0 = xOf(s.a, dur, w), x1 = xOf(Math.min(s.b, t), dur, w);
      ctx.fillStyle = s.state === 'active' ? css('--act') : s.state === 'waiting' ? css('--wait') : css('--line-2');
      ctx.fillRect(x0, y, Math.max(1.5, x1 - x0), hgt);
    }
    if (name) { ctx.fillStyle = css('--ink-2'); ctx.font = `11px ${css('--mono')}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(name, PAD.l, y - 3); }
  }
  /* ================= EVERY ================= */
  new Sim('p-every', 'c-every', {
    duration: 60, speed: 6, // 60 sim minutes in 10 s
    initial: () => ({ outage: false }),
    compute: (st) => {
      const interval = 5, fires = [], out = st.outage ? [20, 33] : null;
      let last = 0;
      while (true) {
        let due = last + interval;
        if (out && due >= out[0] && due < out[1]) due = out[1]; // first poll after restart
        if (due > 60) break;
        fires.push({ t: due, late: out && due === out[1] });
        last = due;
      }
      return { fires, out, interval };
    },
    readout: (t, m) => {
      const done = m.fires.filter(f => f.t <= t);
      const last = done.length ? done[done.length - 1].t : 0;
      return `t = <b>${fmtMin(t)}</b> · since last delivery <b>${fmtMin(Math.max(0, t - last))}</b> · fires <b>${done.length}</b>`;
    },
    draw(ctx, w, h, t, m, self) {
      self.pulseSpan = 2;
      const yAxis = 100;
      if (m.out) region(ctx, w, 60, m.out[0], m.out[1], 34, yAxis + 2, 'daemon down');
      axis(ctx, w, yAxis, 60, 5, v => `${v}m`);
      for (const f of m.fires) {
        if (f.t > t) break;
        const x = xOf(f.t, 60, w);
        stem(ctx, x, 58, yAxis, css('--sched-soft'));
        fire(ctx, x, 58, css('--sched'), t - f.t, self.pulseSpan, f.late ? 'restart → fire' : (f.t === 5 ? '+5m' : ''), css('--ink-2'));
      }
      playhead(ctx, w, h, t, 60, 24, yAxis + 6);
    },
  });
  /* ================= CRON ================= */
  // timeline in hours, 3 days (0..72). Day boundaries at 0, 24, 48. 09:00 = 9, 33, 57. Outage day 2: 31..38 (07:00–14:00).
  new Sim('p-cron', 'c-cron', {
    duration: 72, speed: 7.2, // 10 s
    initial: () => ({ catchup: false }),
    compute: (st) => {
      const out = [31, 38];
      const fires = [{ t: 9 }, { t: 57 }];
      const missed = [];
      if (st.catchup) fires.push({ t: 38, late: true, label: 'catch-up (once)' }); else missed.push({ t: 33 });
      fires.sort((a, b) => a.t - b.t);
      return { fires, missed, out };
    },
    readout: (t, m) => {
      const day = Math.floor(t / 24) + 1, hh = Math.floor(t % 24), mm = Math.floor((t % 1) * 60);
      const done = m.fires.filter(f => f.t <= t).length, miss = m.missed.filter(f => f.t <= t).length;
      return `day <b>${day}</b> <b>${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}</b> · fired <b>${done}</b> · missed <b>${miss}</b>`;
    },
    draw(ctx, w, h, t, m, self) {
      self.pulseSpan = 2.5;
      const yAxis = 100, dur = 72;
      region(ctx, w, dur, m.out[0], m.out[1], 34, yAxis + 2, 'daemon down');
      axis(ctx, w, yAxis, dur, 6, v => { const hh = v % 24; return hh === 0 ? `day ${v / 24 + 1}` : `${String(hh).padStart(2,'0')}:00`; });
      // the 09:00 marks as faint targets
      for (const o of [9, 33, 57]) { const x = xOf(o, dur, w); ctx.strokeStyle = css('--line'); ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(x + .5, 44); ctx.lineTo(x + .5, yAxis); ctx.stroke(); ctx.setLineDash([]); }
      for (const f of m.missed) { if (f.t > t) continue; const x = xOf(f.t, dur, w); fire(ctx, x, 58, css('--miss'), 0, 0, 'missed · skipped', css('--ink-3'), true); }
      for (const f of m.fires) {
        if (f.t > t) continue; const x = xOf(f.t, dur, w);
        stem(ctx, x, 58, yAxis, css('--sched-soft'));
        fire(ctx, x, 58, css('--sched'), t - f.t, self.pulseSpan, f.label || '09:00', css('--ink-2'));
      }
      playhead(ctx, w, h, t, dur, 24, yAxis + 6);
    },
  });
  /* ================= BACKOFF ================= */
  const MINB = 1, MAXB = 30, ATTR = 2, TICKBUSY = 0.35, WORK = 1.5;
  function gapAfter(r) { let g = MINB; for (let i = 0; i < r; i++) { if (g >= MAXB || g > MAXB - g) return MAXB; g *= 2; } return g; }
  new Sim('p-backoff', 'c-backoff', {
    duration: 100, speed: 8, // 100 sim minutes in 12.5 s
    initial: () => ({ pokes: [], flat: false }),
    actions: {
      poke: (self) => { if (!self.playing) { self.restart(true); } self.state.pokes.push(self.t); }
    },
    onToggle: (self, tog) => {
      if (tog !== 'flat') return;
      self.section.querySelector('.add').textContent = self.state.flat
        ? 'rk cron add "wake up" --idle-every 3m'
        : 'rk cron add "operator tick" --backoff --min 1m --max 30m';
    },
    compute: (st) => {
      // Operator idle at t=0 (anchor 0). Fires climb the ladder. Each fire → active for TICKBUSY (attributed: no reset).
      // A poke at p → operator active [p, p+WORK], idle epoch p+WORK, not attributed → ladder resets, anchor = p+WORK.
      // st.flat: min = max — every gap is a constant 3 sim-minutes; the anchor rules are unchanged.
      const gap = st.flat ? () => 3 : gapAfter;
      const pokes = [...st.pokes].sort((a, b) => a - b);
      const fires = [], segs = [], resets = [];
      let anchor = 0, rung = 0, t = 0, pi = 0;
      let guard = 0;
      while (guard++ < 500) {
        const next = anchor + (() => { let s = 0; for (let n = 0; n <= rung; n++) s += gap(n); return s; })();
        const poke = pi < pokes.length ? pokes[pi] : Infinity;
        if (poke < next) {
          segs.push({ a: poke, b: poke + WORK, state: 'active' });
          resets.push({ t: poke, idleAt: poke + WORK });
          anchor = poke + WORK; rung = 0; pi++;
          if (anchor > 100) break;
          continue;
        }
        if (next > 100) break;
        fires.push({ t: next, rung: rung + 1, gap: gap(rung) });
        segs.push({ a: next, b: next + TICKBUSY, state: 'active' });
        rung++;
      }
      return { fires, segs, resets, anchor };
    },
    resetFn: (self) => { self.state.pokes = []; },
    readout: (t, m) => {
      const done = m.fires.filter(f => f.t <= t);
      const next = m.fires.find(f => f.t > t);
      const rung = done.length && (!m.resets.some(r => r.t > done[done.length - 1].t && r.t <= t)) ? done[done.length - 1].rung : 0;
      return `t = <b>${fmtMin(t)}</b> · rung <b>${rung}</b> · next fire ${next ? `in <b>${fmtMin(next.t - t)}</b>` : '<b>—</b>'}`;
    },
    draw(ctx, w, h, t, m, self) {
      self.pulseSpan = 3;
      const dur = 100, yAxis = 110, yStrip = 140;
      axis(ctx, w, yAxis, dur, 10, v => `${v}m`);
      // resets
      for (const r of m.resets) {
        if (r.t > t) continue;
        const x = xOf(r.t, dur, w);
        ctx.fillStyle = css('--act'); ctx.font = `11px ${css('--mono')}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText('you typed → ladder resets', x, 40);
        stem(ctx, x, 42, yAxis, css('--act-soft'));
        if (r.idleAt <= t) { const xi = xOf(r.idleAt, dur, w); ctx.fillStyle = css('--ink-3'); ctx.textBaseline = 'top'; ctx.fillText('new anchor', xi, yStrip + 16); }
      }
      // fires + gap labels
      let prev = null;
      for (const f of m.fires) {
        if (f.t > t) break;
        const x = xOf(f.t, dur, w);
        stem(ctx, x, 72, yAxis, css('--sched-soft'));
        fire(ctx, x, 72, css('--sched'), t - f.t, self.pulseSpan, `+${f.gap}m`, css('--ink-2'));
        // rung number under the dot
        ctx.fillStyle = css('--ink-3'); ctx.font = `10px ${css('--mono')}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(`r${f.rung}`, x, 80);
        prev = f;
      }
      // attribution windows on the strip (light) for fires
      strip(ctx, w, dur, yStrip, 10, m.segs, t, 'operator pane  @rk_pane_agent_state');
      for (const f of m.fires) {
        if (f.t > t) break;
        const x0 = xOf(f.t, dur, w), x1 = xOf(Math.min(f.t + ATTR, t), dur, w);
        ctx.strokeStyle = css('--sched-soft'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x0, yStrip + 14.5); ctx.lineTo(x1, yStrip + 14.5); ctx.stroke();
      }
      ctx.fillStyle = css('--ink-3'); ctx.font = `10px ${css('--mono')}`; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.fillText('thin blue = 120 s attribution window: a flip inside it was “caused by the clock”', w - PAD.r, yStrip + 16);
      playhead(ctx, w, h, t, dur, 24, yStrip + 12);
    },
  });
  /* ================= WAKE ================= */
  // 30 sim minutes. Agents A, B, C; operator (self) excluded. Debounce 1 min after own delivery.
  new Sim('p-wake', 'c-wake', {
    duration: 30, speed: 3, // 10 s
    initial: () => ({}),
    compute: () => {
      const A = [{ a: 0, b: 6, state: 'active' }, { a: 6, b: 9, state: 'waiting' }, { a: 9, b: 14, state: 'active' }, { a: 14, b: 30, state: 'idle' }];
      const B = [{ a: 0, b: 3, state: 'idle' }, { a: 3, b: 12, state: 'active' }, { a: 12, b: 30, state: 'idle' }];
      const C = [{ a: 0, b: 14.4, state: 'active' }, { a: 14.4, b: 30, state: 'idle' }];
      // transitions
      const trans = [
        { t: 3, who: 'B', to: 'active' }, { t: 6, who: 'A', to: 'waiting' }, { t: 9, who: 'A', to: 'active' },
        { t: 12, who: 'B', to: 'idle' }, { t: 14, who: 'A', to: 'idle' }, { t: 14.4, who: 'C', to: 'idle' },
      ];
      const fires = [], ignored = [], held = [];
      let lastDelivery = -Infinity, pending = null;
      const poll = 0.5;
      for (let p = 0; p <= 30 + 1e-9; p += poll) {
        const edges = trans.filter(x => x.t > p - poll && x.t <= p);
        for (const e of edges) { if (e.to === 'active') ignored.push(e); else pending = pending || e; }
        if (pending && p - lastDelivery >= 1) { fires.push({ t: p, cause: pending }); lastDelivery = p; pending = null; }
        else if (pending && !held.some(h => h.cause === pending)) held.push({ t: p, cause: pending });
      }
      const opSegs = fires.map(f => ({ a: f.t, b: f.t + 0.3, state: 'active' }));
      return { rows: [['agent A', A], ['agent B', B], ['agent C', C]], opSegs, fires, ignored, held, trans };
    },
    readout: (t, m) => {
      const done = m.fires.filter(f => f.t <= t).length, ign = m.ignored.filter(x => x.t <= t).length;
      return `t = <b>${fmtMin(t)}</b> · wake fires <b>${done}</b> · ignored (→ active) <b>${ign}</b>`;
    },
    draw(ctx, w, h, t, m, self) {
      self.pulseSpan = 1.5;
      const dur = 30, yAxis = 92, rowY = [118, 146, 174], opY = 206;
      axis(ctx, w, yAxis, dur, 5, v => `${v}m`);
      // transitions: stems from strip up to axis, labelled
      for (const e of m.trans) {
        if (e.t > t) continue;
        const x = xOf(e.t, dur, w);
        const y = rowY[['A', 'B', 'C'].indexOf(e.who)];
        const ignored = e.to === 'active';
        stem(ctx, x, yAxis, y, ignored ? css('--line') : (e.to === 'waiting' ? css('--wait') : css('--ink-3')));
        if (ignored) { ctx.fillStyle = css('--ink-3'); ctx.font = `10px ${css('--mono')}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('→ active · ignored', x, yAxis - 6); }
      }
      // held edge marker
      for (const hd of m.held) {
        if (hd.t > t) continue; const x = xOf(hd.cause.t, dur, w);
        ctx.fillStyle = css('--wake'); ctx.font = `10px ${css('--mono')}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('held (debounce)', x, yAxis - 24);
      }
      for (const f of m.fires) {
        if (f.t > t) break; const x = xOf(f.t, dur, w);
        stem(ctx, x, 58, yAxis, css('--wake-soft'));
        const lab = f.cause.to === 'waiting' ? `${f.cause.who} asks → wake` : `${f.cause.who} done → wake`;
        fire(ctx, x, 58, css('--wake'), t - f.t, self.pulseSpan, lab, css('--ink-2'));
      }
      m.rows.forEach(([name, segs], i) => strip(ctx, w, dur, rowY[i], 10, segs, t, name));
      // operator row, greyed: excluded from its own fingerprint
      ctx.globalAlpha = .45; strip(ctx, w, dur, opY, 10, m.opSegs, t, 'operator (target) · excluded from the fingerprint'); ctx.globalAlpha = 1;
      playhead(ctx, w, h, t, dur, 24, opY + 12);
    },
  });
  /* ================= DELIVER ================= */
  // 30 sim minutes of one every-5m entry; the agent is busy (active) 7–18 min when st.busy.
  new Sim('p-deliver', 'c-deliver', {
    duration: 30, speed: 3, // 10 s
    initial: () => ({ busy: true }),
    compute: (st) => {
      const dur = 30, step = 5, busy = st.busy ? [7, 18] : null;
      const isBusy = (x) => !!(busy && x >= busy[0] && x < busy[1]);
      const immediate = [], whenIdle = [], skipIfBusy = [];
      for (let g = step; g <= dur + 1e-9; g += step) immediate.push({ t: g, busy: isBusy(g) });
      let next = step;
      while (next <= dur + 1e-9) {
        if (isBusy(next)) { whenIdle.push({ t: busy[1], heldFrom: next }); next = busy[1] + step; }
        else { whenIdle.push({ t: next }); next += step; }
      }
      for (let g = step; g <= dur + 1e-9; g += step) skipIfBusy.push({ t: g, skipped: isBusy(g) });
      // exposed for the pulse sweep; skipped fires are not pulses
      const fires = immediate.concat(whenIdle, skipIfBusy.filter(f => !f.skipped));
      return { immediate, whenIdle, skipIfBusy, busy, fires };
    },
    readout: (t, m) => {
      const im = m.immediate.filter(f => f.t <= t).length;
      const wi = m.whenIdle.filter(f => f.t <= t);
      const held = m.whenIdle.filter(f => f.heldFrom != null && f.heldFrom <= t).length;
      const sk = m.skipIfBusy.filter(f => f.t <= t);
      return `t = <b>${fmtMin(t)}</b> · immediate <b>${im}</b> · when-idle <b>${wi.length}</b> (held <b>${held}</b>) · skip-if-busy <b>${sk.filter(f => !f.skipped).length}</b> (skipped <b>${sk.filter(f => f.skipped).length}</b>)`;
    },
    draw(ctx, w, h, t, m, self) {
      self.pulseSpan = 1.5;
      const dur = 30, yAxis = 54, yStrip = 88;
      const lanes = [
        { name: 'immediate', y: 134, rows: m.immediate },
        { name: 'when-idle', y: 174, rows: m.whenIdle },
        { name: 'skip-if-busy', y: 214, rows: m.skipIfBusy },
      ];
      axis(ctx, w, yAxis, dur, 5, v => `${v}m`);
      const segs = m.busy ? [{ a: m.busy[0], b: m.busy[1], state: 'active' }] : [];
      strip(ctx, w, dur, yStrip, 10, segs, t, 'agent pane  @rk_pane_agent_state');
      let busyLabels = 0;
      for (const lane of lanes) {
        ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD.l, lane.y + .5); ctx.lineTo(w - PAD.r, lane.y + .5); ctx.stroke();
        ctx.fillStyle = css('--ink-2'); ctx.font = `11px ${css('--mono')}`; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText(lane.name, PAD.l, lane.y - 24);
        for (const f of lane.rows) {
          const visible = f.t <= t || (f.heldFrom != null && f.heldFrom <= t);
          if (!visible) continue;
          const x = xOf(f.t, dur, w);
          if (lane.name === 'immediate') {
            if (f.t <= t) {
              fire(ctx, x, lane.y, css('--sched'), t - f.t, self.pulseSpan, '', css('--ink-2'));
              if (f.busy) {
                // stagger the two adjacent busy labels so they never collide
                ctx.fillStyle = css('--ink-2'); ctx.font = `11px ${css('--mono')}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
                ctx.fillText('into a busy pane', x, lane.y - (busyLabels++ % 2 === 0 ? 10 : 26));
              }
            }
          } else if (lane.name === 'when-idle') {
            if (f.heldFrom != null) {
              const xh = xOf(f.heldFrom, dur, w);
              fire(ctx, xh, lane.y, css('--wake'), 0, 0, 'held', css('--ink-2'), true);
              if (f.t <= t) {
                ctx.strokeStyle = css('--wake'); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(xh, lane.y - 16); ctx.lineTo(x, lane.y - 16); ctx.stroke(); ctx.setLineDash([]);
                fire(ctx, x, lane.y, css('--sched'), t - f.t, self.pulseSpan, 'delivered when idle', css('--ink-2'));
              }
            } else if (f.t <= t) fire(ctx, x, lane.y, css('--sched'), t - f.t, self.pulseSpan, '', css('--ink-2'));
          } else if (f.t <= t) {
            fire(ctx, x, lane.y, css('--sched'), t - f.t, self.pulseSpan, f.skipped ? 'skipped · busy' : '', css('--ink-2'), f.skipped);
          }
        }
      }
      playhead(ctx, w, h, t, dur, 24, 226);
    },
  });
})();
</script>
