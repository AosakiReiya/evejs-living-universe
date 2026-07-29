# Architecture

The Living Universe patch models a large population without keeping every NPC
ship in the expensive player-visible space simulation at all times. A pilot is
persistent; a physical ship is a temporary representation created when the
world needs observable fidelity.

## Design goals

- The universe continues to travel, mine, haul, manufacture, trade, fight, and
  lose ships without depending on a nearby player.
- Distant work consumes real modeled time and conserved resources without a
  per-ship 100 ms update loop.
- The same activity becomes physically visible when a player is present.
- Materialized NPCs use native hulls, fittings, movement, weapons, modules,
  effects, wrecks, and drops rather than decorative proxies.
- Background work is bounded, resumable, measurable, and deferrable under load.

## Simulation layers

### Persistent pilot and flight state

Pilots have stable identities, names, portraits, affiliations, roles, skills,
and doctrine assignments. Flights carry their current route, phase, deadline,
ship composition, task, cargo responsibility, and recovery identity. Restarting
the server does not intentionally collapse every pilot back into one station.

Roles are operational rather than permanent character classes. A suitable
pilot can move between mining, hauling, industry support, security, or combat as
demand and doctrine permit.

### Deadline-driven virtual space

Unobserved travel and work are represented by a next useful deadline. The
scheduler advances records that are due, within a time and item budget, and
leaves the rest queued. It does not run thousands of empty-space ships through
the normal 100 ms physical tick.

Travel time is derived from the route, hull, movement phases, and system
crossings. Virtual does not mean instant. The optional 10x multiplier changes
only eligible unobserved development-test legs.

### Player-proximity materialization

When a player can observe a flight, the runtime reserves from global and
per-system physical budgets and creates native ships in the appropriate scene.
They use authored arrival, gate, station-undock, belt, approach, align, warp,
weapon, module, and departure behavior. When observation ends and it is safe to
do so, durable virtual state resumes.

This is not a spawn bubble centered on the player. Actors already have routes,
origins, destinations, and work. Player presence changes representation and
fidelity, not the underlying reason for the activity.

### Living economy

The economy connects stock, demand, procurement, mining, freight, and industry:

1. Stations and regions expose stock, demand, and production opportunities.
2. Mining and procurement provide basic inputs.
3. Industry reserves inputs for timed manufacturing, research, or copying work.
4. Freight planning reserves cargo at a real source before a hauler departs.
5. The destination receives cargo only after the assigned trip completes.
6. Wallet, stock, job, and telemetry receipts make settlement replay-safe.
7. Loss or cancellation follows an explicit recovery or refund path rather than
   silently duplicating cargo or money.

Replacement demand is staged line by line while a ship returns only after its
complete package is assembled. Pirate hulls use faction shipyards plus a
bounded smuggler fallback instead of consuming the empire mineral basket.
When replacement pressure rises, a closed-loop mobilization controller
increases freight, industry, refinery, and pirate-supply capacity without
changing conflict pacing or flooding routine peacetime production.

NPC corporations can raise shortage-specific war-premium buy orders. A player
sale into one of those orders enters authoritative Living Economy stock and
reduces the shortage through the same idempotent settlement path; it is not a
decorative market payment. The player can therefore supply or compete with the
economy, but is not required to keep it alive.

### Conflict and replacement demand

Pirate, civilian, corporate, and security flights can enter campaign encounters.
The roaming kernel also forms a bounded set of persistent operation groups from
existing flights. Each group advances through staging, transit, patrol, camp,
and dispersal phases on a deadline queue. Directional gate-lane and system
indexes find overlapping hostile presence without scanning every group against
every other group.

A contact is an opportunity, not an automatic teleport into combat. Its system,
gate, time window, participating flights, and source operation are retained
explicitly. A contact whose overlap window has already expired is discarded
rather than scheduled as a late battle. Capacity-limited live contacts remain
bounded and retryable instead of causing an unbounded catch-up pass.

When observed, combat is represented with physical ships and native effects.
An already-visible gate camp is adopted into the encounter in place, preserving
its position and identity while only a missing opposing wing is materialized.
When sufficiently distant, bounded deterministic resolution can produce the
same durable categories of outcome. Loss handling is shared by campaign,
civilian-interdiction, and roaming paths so destroyed ships consume assets and
create replacement demand for industry and hauling.

Eligible unclaimed NPC wrecks can also become bounded salvage-recovery work.
Recovery crews use the existing salvager reward rules, spend modeled outbound,
recovery, and return time, and credit recovered materials only after delivery.
The salvage state is persisted with the rest of the Living Economy; it is not
an instant or free stock injection.

Security and distress behavior can surface activity to players without making
every encounter wait indefinitely for a witness.

Living factions admit player targets per character. Recent aggression creates
a temporary wall-clock hostility window, while sufficiently poor standing
creates persistent shoot-on-sight behavior. Short-lived kill-credit records
connect physical player final blows to loss and standing processing without
treating simulated NPC pilots as player attackers.

### Optional estate and live-event systems

The family estate is a gated shared-corporation scenario built on existing
wormhole, structure, economy, wallet, and Living Universe services. Restoration
materials are commissioned from regional stock and delivered by outside NPC
haulers; they are not credited at order time.

Live events use their own deadline queue and bounded scheduler. The event
framework and individual content remain independently gated so unfinished
content does not activate merely because the patch is installed.

### X-Eve economic circuit

X-Eve is an experimental, disabled-by-default layer for durable economic events,
balanced ledger entries, replay-safe effects, and adaptive admission. It runs
outside the 100 ms space tick. At higher rolling latency it defers planning,
then limits work to due continuations, and finally sheds background work while
preserving queues for later recovery.

## Persistence and recovery

Long-lived tasks use durable identities and monotonic counters. External effects
such as stock movement, wallet escrow, delivery, refund, and loss settlement are
recorded so replay after interruption does not perform the same effect twice.

Recovery favors a visible terminal or quarantined state over silent guessing.
Resets are refused while unresolved deliveries or economic work would make a
reset unsafe. Runtime databases and journals are operational state and are not
part of this public patch repository.

## Performance boundary

The physical game simulation remains the source of truth for player-observed
movement and combat. Virtual state is the scalable representation for distant
activity. Small bounded schedulers bridge the two; global and per-system caps
prevent a busy Local list from automatically becoming an equally large physical
scene.

Roaming operations add a second boundary beneath those physical caps: at most
96 operation groups, 16 due phase transitions, 192 indexed presence checks, six
camping groups, and 1.5 ms of synchronous roaming work per pass at the default
configuration. These limits bound decision work; they do not reserve or bypass
physical-ship capacity.

The practical target remains near the 100 ms tick baseline. See
[Performance](PERFORMANCE.md) for thresholds and capacity-test procedure.

## Distribution boundary

This architecture is delivered as changes against a separately obtained
compatible v0.12.3.1 base. The repository contains no complete patched server
tree, EVE client, CCP assets, runtime databases, certificates, portrait cache,
or private deployment data.
