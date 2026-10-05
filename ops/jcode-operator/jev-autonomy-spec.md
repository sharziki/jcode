# Jev and coordinator autonomy

## Observed state

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
Use a proposed $0.25 daily decision cap. Leave every other slot explicitly off.
Nova's installed guide identifies triage and conflict as measured winners, but
reports higher total dream spending with triage. Do not enable triage merely to
save credits. Project-task routing is a separate integration and is not wired
by enabling Nova's memory slots.

## Consent and verification

Contradiction checking sends fact excerpts, potentially private, to TypeSafe.
Approval must cover this data transfer and recurring API spend. Current policy
denies private egress, so do not change it or copy credentials before approval.
Keep the key out of command arguments, logs, Nova pages, and source control.
After approval: set the cap and explicit slot modes, install the credential for
the authoritative runtime, enable conflict with its reference calibration, and
probe using synthetic facts. Verify a receipt, budget accounting, fallback on
provider failure, and unchanged fact writes. Expose only blockers or verified
results; retain rollback by disabling the slot.

Spend comparison must include downstream synthesis, not Jev's API price alone.
