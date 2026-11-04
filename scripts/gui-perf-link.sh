#!/usr/bin/env bash
# Port-scoped link emulation for the GUI perf spec (tests/e2e/gui-perf.spec.ts).
#
# Adds a Tailscale-shaped round trip to ONE loopback port so a Playwright
# viewer on this host sees the latency a remote laptop or phone would, while
# every other loopback consumer (the live rk daemon on :6123, tmux control
# sockets, code-server) is untouched. Both directions of a loopback flow
# traverse `lo`, so delaying packets whose source OR destination port matches
# yields the full RTT. Delay the Go BACKEND port (E2E_PORT+1): the browser
# talks to Vite, which proxies /ws/gui/host and /api to the backend, so the
# RFB stream and the API pay the round trip while Vite's hundreds of dev
# module requests stay fast (delaying the Vite port stalls page load instead).
#
#   scripts/gui-perf-link.sh on <port> [rtt_ms=260] [mbit=40]   # mbit=0 ⇒ no rate cap
#   scripts/gui-perf-link.sh off
#   scripts/gui-perf-link.sh status
#
# Requires passwordless sudo for `tc` (refuses otherwise). The script owns
# exactly one root qdisc on lo (prio, handle 1:); `on` refuses when lo already
# carries a root qdisc that is neither the kernel default nor ours, and `off`
# removes only ours — a foreign traffic-control setup is never destroyed.
set -euo pipefail

usage() {
  echo "usage: $0 on <port> [rtt_ms=260] [mbit=40] | off | status" >&2
  exit 2
}

need_sudo() {
  sudo -n true 2>/dev/null || {
    echo "error: passwordless sudo is required for tc on lo" >&2
    exit 1
  }
}

# The root qdisc this script installs — identified by handle so on/off never
# touch a qdisc some other service or experiment put on lo.
OUR_HANDLE="1:"

# The root line is not always listed first — select it by its ` root ` marker.
root_qdisc() { tc qdisc show dev lo | grep -m1 ' root '; }
root_is_default() { root_qdisc | grep -q '^qdisc noqueue 0: root'; }
root_is_ours() { root_qdisc | grep -q "^qdisc prio ${OUR_HANDLE} root"; }
require_owned_or_default_root() {
  if ! root_is_default && ! root_is_ours; then
    echo "error: lo already carries a root qdisc this script does not own — refusing to replace it:" >&2
    root_qdisc >&2
    exit 1
  fi
}

cmd="${1:-}"
case "$cmd" in
  on)
    port="${2:-}"
    [[ "$port" =~ ^[0-9]+$ ]] || usage
    rtt="${3:-260}"
    mbit="${4:-40}"
    [[ "$rtt" =~ ^[0-9]+$ && "$mbit" =~ ^[0-9]+$ ]] || usage
    need_sudo
    half=$(( rtt / 2 ))
    require_owned_or_default_root
    # Idempotent: replace a previous emulation of ours before installing this one.
    sudo tc qdisc del dev lo root 2>/dev/null || true
    # prio with 3 bands (priomap values are 0-based band indices): every
    # priority maps to band 0 (1:1), so unmatched traffic is never delayed;
    # only the filters below steer the port's TCP flows to band 2 (1:3),
    # where netem lives.
    sudo tc qdisc add dev lo root handle "$OUR_HANDLE" prio bands 3 priomap 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0
    if [ "$mbit" -gt 0 ]; then
      sudo tc qdisc add dev lo parent 1:3 handle 30: netem delay "${half}ms" rate "${mbit}mbit"
    else
      sudo tc qdisc add dev lo parent 1:3 handle 30: netem delay "${half}ms"
    fi
    sudo tc filter add dev lo parent 1:0 protocol ip prio 1 u32 match ip protocol 6 0xff match ip dport "$port" 0xffff flowid 1:3
    sudo tc filter add dev lo parent 1:0 protocol ip prio 1 u32 match ip protocol 6 0xff match ip sport "$port" 0xffff flowid 1:3
    if [ "$mbit" -gt 0 ]; then
      echo "link emulation on: port $port, ${rtt}ms RTT (${half}ms each way), ${mbit} Mbit/s"
    else
      echo "link emulation on: port $port, ${rtt}ms RTT (${half}ms each way), no rate cap"
    fi
    ;;
  off)
    need_sudo
    require_owned_or_default_root
    if root_is_ours; then
      sudo tc qdisc del dev lo root
      echo "link emulation off (lo back to default qdisc)"
    else
      echo "link emulation is not on (lo has its default qdisc); nothing to remove"
    fi
    ;;
  status)
    tc -s qdisc show dev lo
    tc filter show dev lo 2>/dev/null || true
    ;;
  *)
    usage
    ;;
esac
