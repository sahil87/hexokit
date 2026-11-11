# Plan: Daemon Autostart Spike (S1)

**Change**: 261111-q5yn-daemon-autostart-spike
**Intake**: `intake.md`

## Requirements

### Spike: Isolation

#### R1: Experiments run only in a throwaway environment
All systemd experiments SHALL run inside a disposable systemd-as-PID-1 container started through `sudo docker`, with a throwaway in-container user. The experiments MUST NOT register, enable, start or stop any unit on the host's systemd, MUST NOT enable lingering on the host, and MUST NOT reboot the host. The container and its image MUST be removed when the spike ends.

- **GIVEN** the host user manager is live and `Linger=no` for the host user
- **WHEN** the spike has finished
- **THEN** `systemctl --user list-unit-files` on the host shows no new unit, `loginctl show-user` still reports `Linger=no`, the host `tmux -L rk-daemon` server is untouched, and `sudo docker ps -a` / `images` show no spike leftovers

### Spike: Linux candidates

#### R2: Candidate unit shapes are compared against the four hazards
Each Linux candidate (L1 `Type=oneshot` + `RemainAfterExit=yes`, L2 `Type=forking`, L3 either plus `KillMode=process`) SHALL use `ExecStart=<login shell> -lc '<abs rk path> daemon start'` with no `Restart=`, and SHALL be exercised against: (1) tmux server survival after the start process exits, and after `systemctl --user stop` and `disable`; (2) environment provenance versus a manual start; (3) boot with lingering on and off, including `HOME`/`XDG_*`/`TMUX_TMPDIR`/socket path; (4) `daemon-reload` and a second start not producing a second daemon, with a success result when the daemon is already running.

- **GIVEN** a candidate unit installed in the throwaway user's `~/.config/systemd/user/`
- **WHEN** the unit is started, stopped, disabled, reloaded and (container-)restarted
- **THEN** each hazard has a recorded pass/fail with the commands run and the relevant output

#### R3: Environment provenance is diffed
The findings SHALL contain the diff of `tmux -L rk-daemon show-environment -g` between a manual `rk daemon start` from an interactive shell and a unit-started daemon, covering `PATH`, `SSH_AUTH_SOCK`, locale and a provider-credential-style variable, and SHALL name what a non-interactive login shell misses (variables set only in the interactive rc file).

- **GIVEN** a profile file and an rc file in the throwaway user's home each exporting a marker variable
- **WHEN** the daemon is started by the unit and manually
- **THEN** the findings state which marker variables reach the tmux server in each case

#### R4: Cron-after-reboot is recorded
The findings SHALL record what happens after a reboot to an rk cron entry whose target tmux server no longer exists, as an observation only.

- **GIVEN** a cron entry whose target server is gone after a restart
- **WHEN** `rk cron tick` (or the daemon's tick) runs
- **THEN** the observed behaviour is written down; no fix is attempted

### Spike: macOS

#### R5: macOS is a documented, untested candidate
The findings SHALL include a candidate LaunchAgent plist (`RunAtLoad`, no `KeepAlive`, `ProgramArguments` through the login shell, with and without `AbandonProcessGroup`) explicitly labelled untested, plus the checklist A2 must verify.

- **GIVEN** no macOS host is reachable
- **WHEN** the findings file is written
- **THEN** the macOS section states "untested" and lists the hazards for A2 to verify

### Spike: Deliverable

#### R6: One findings file, no code
The only repository change SHALL be one markdown file at `fab/plans/sahil/26-11-11-rk-daemon-autostart-s1-findings.md` containing the winning Linux unit verbatim, the results matrix, the env diff, the cron note, the macOS candidate, and input for A1/A2's open decisions. Nothing under `app/`, `docs/memory/` or `docs/specs/` SHALL change.

- **GIVEN** the spike is complete
- **WHEN** `git diff --stat main...HEAD` is read
- **THEN** only `fab/changes/261111-q5yn-daemon-autostart-spike/*` and the findings file appear

### Non-Goals

- Fixing the cron-after-reboot behaviour — recorded only.
- Any `rk daemon autostart` implementation — that is A1/A2.

## Tasks

### Phase 1: Setup

- [x] T001 Build the throwaway systemd container via `sudo docker` (image with systemd, tmux, the host's `rk` binary, a test user with `~/.profile` and `~/.bashrc` markers, linger configurable), working dir in the scratchpad <!-- R1 -->

### Phase 2: Experiments

- [x] T002 Run candidates L1–L3 against hazards 1, 2 and 4 in the container; capture commands and output <!-- R2, R3 -->
- [x] T003 Run hazard 3 (lingering on/off, `HOME`/`XDG_*`/`TMUX_TMPDIR`/socket path via container restart) and the cron-after-restart observation <!-- R2, R4 -->

### Phase 3: Deliverable

- [x] T004 Write `fab/plans/sahil/26-11-11-rk-daemon-autostart-s1-findings.md` (winning unit verbatim, matrix, env diff, cron note, untested macOS plist and checklist, A1/A2 inputs) <!-- R3, R4, R5, R6 -->
- [x] T005 Remove the container and image; verify the host systemd, linger state and `rk-daemon` tmux server are untouched <!-- R1 -->

## Acceptance

### Functional Completeness

- [ ] A-001 R1: Container and image are gone; host `systemctl --user` has no new unit, host `Linger=no`, host `rk-daemon` tmux server unaffected
- [ ] A-002 R2: Each of L1–L3 has a recorded result for all four hazards
- [ ] A-003 R3: The findings contain the environment diff and name what a non-interactive login shell misses
- [ ] A-004 R4: The cron-after-restart observation is recorded
- [ ] A-005 R5: The macOS plist is present and labelled untested, with a verification checklist
- [ ] A-006 R6: The findings file holds the winning unit verbatim and the A1/A2 open-decision inputs

### Behavioral Correctness

- [ ] A-007 R6: `git diff --name-only` against the base lists only the change folder and the findings file

### Scenario Coverage

- [ ] A-008 R2: The unit stop/disable scenario shows whether the tmux server survived, with evidence

### Edge Cases & Error Handling

- [ ] A-009 R2: The "daemon already running" start is recorded with its exit code and the unit's resulting state

### Code Quality

- [ ] A-010 Pattern consistency: The findings file matches the layout and tone of its sibling plan files
- [ ] A-011 No unnecessary duplication: The findings point to the plan instead of restating its decisions

### Security

- [ ] A-012 R1: The privileged container is not left running and no host files outside the scratchpad and the findings file are modified

## Notes

- Check items as you review: `- [x]`
- All acceptance items must pass before `/fab-continue` (hydrate)
- If an item is not applicable, mark checked and prefix with **N/A**: `- [x] A-NNN **N/A**: {reason}`

## Assumptions

| # | Grade | Decision | Rationale | Scores |
|---|-------|----------|-----------|--------|
| 1 | Certain | Throwaway environment is a `sudo docker` systemd container | User chose "sudo docker, privileged" when asked | S:95 R:70 A:90 D:90 |
| 2 | Certain | macOS is recorded as an untested candidate | User chose "candidate plist, untested" | S:95 R:85 A:90 D:90 |
| 3 | Confident | A container restart approximates a reboot; a true boot with lingering is not proven | No VM/KVM available on the host; the findings must say so | S:70 R:80 A:70 D:65 |
| 4 | Confident | The host `rk` binary is copied into the container for the tests | Needed to exercise `rk daemon start`; the same version as the live one | S:65 R:90 A:75 D:70 |
| 5 | Confident | Any in-container test user and files are disposable and never mapped to host paths | Isolation requirement R1 | S:70 R:85 A:80 D:75 |

5 assumptions (2 certain, 3 confident, 0 tentative).
