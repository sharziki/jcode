# Jev and coordinator autonomy

## Initial observed state

Nova's authoritative runtime is on sxna-runtime-01 under proj-nova. Its
`decide status` reports no Jev provider/key, all nine slots off, and no decisions
in the last 24 hours. A local credential file exists with mode 600; its live
validity has not been checked. Installing the key alone can activate defaults,
so configure explicit slot modes and budget before providing the key.

## Roles

Jcode owns goals, focused workers, execution, acceptance checks, and continuation.
Jev is a narrow decision service, not an executor or authorization source.
Keep deterministic checks local; frontier models handle difficult reasoning.
Do not add a Jev request to every tool call or coordinator wake.

## First useful integration

Enable Nova's calibrated contradiction slot only after authorization. It compares
new fact pairs and creates proposals; it never overwrites facts automatically.
User approved activation with a $1/day decision cap on 2026-10-04, increasing
the proposed $0.25 cap. Leave every other slot explicitly off.
Nova's installed guide identifies triage and conflict as measured winners, but
reports higher total dream spending with triage. Do not enable triage merely to
save credits. Project-task routing is a separate integration and is not wired
by enabling Nova's memory slots.

## Consent and verification

Contradiction checking sends fact excerpts, potentially private, to TypeSafe.
Approval covers this data transfer and recurring API spend. User approved
activation with a $1/day cap; private fact egress is now allowed.
Keep the key out of command arguments, logs, Nova pages, and source control.
After approval: set the cap and explicit slot modes, install the credential for
the authoritative runtime, enable conflict with its reference calibration, and
probe using synthetic input. Record live API cost separately: key-only probes
use no brain engine and are not recorded as production decision receipts.
Check first-run watermarks and effective slot readiness; do not claim production
receipts or provider-failure behavior were tested without evidence. Expose only blockers or verified
results; retain rollback by disabling the slot.

Spend comparison must include downstream synthesis, not Jev's API price alone.

## Verified activation — 2026-10-04

- Installed TypeSafe credential in authority-owned `~/.gbrain/.env`, mode 600;
  retained a protected rollback copy. No credentials entered source control.
- Explicitly disabled all slots, then enabled only `conflict`, pinned to
  `typesafe:jev-1.13.0` with shipped reference calibration. Threshold 0.52.
- Decision daily cap is $1; remote share is 1 so no secondary $0.50 limit.
  Query, candidates, and conversation egress remain denied; facts allowed.
- Synthetic live probe resolved `jev-1.13.0` in 429 ms, cost $0.00001609.
  No brain content sent. Probe cost is outside engine-backed receipt accounting.
- Initial sweep ran effectively on for all six sources and initialized
  watermarks. Zero fact pairs examined and no fact writes or proposals.
  It checks new facts on subsequent extraction cycles, not historical backlog.
- Nova MCP/API/minions services remained active. Config loading reads optional
  operator `.env` on each call; no extra worker or service restart introduced.
- Production conflict receipts are currently empty. Real pair decisions,
  cumulative spend, and provider-failure fallback remain untested.

Rollback: `nova decide disable conflict`. Keep credential file private.
