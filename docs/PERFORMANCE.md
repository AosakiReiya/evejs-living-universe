# Performance

The patch is designed to keep distant simulation off the physical 100 ms space
tick, but capacity still depends on CPU single-thread behavior, memory, storage,
market-service latency, world state, configuration, and where players gather.
Published limits are test inputs, not hardware-independent guarantees.

## Tick targets

The performance reference for a responsive target server is a **100 ms tick
interval**.

| Rolling tick interval | Interpretation | Operator response |
| ---: | --- | --- |
| About `100 ms` | Baseline | Normal target; report all deltas from this value. |
| Below `120 ms p95` | Healthy headroom | Normal bounded background work may continue. |
| `120-129.9 ms p95` | Warning/constrained | Stop scaling; defer planning and maintenance, then identify the cost. |
| `130 ms p95` or higher | Test ceiling exceeded | Admit due recovery or settlement work only; reduce load. |

The 130 ms value is a deliberately limited load-test ceiling. It is not the
desired everyday playing latency. Emergency boundaries near 500-600 ms exist to
protect state and identify an unplayable interval; they are not acceptable
operating targets.

## Measure the right quantities

Tick interval and tick work answer different questions:

- **Tick interval** is elapsed time between game ticks and is the player-facing
  latency reference. Compare average, p95, and maximum to 100 ms.
- **Tick work** is time actually spent executing one tick. Rising work predicts
  loss of timing headroom even before interval p95 crosses a boundary.
- **Scheduler work** measures Living Universe, economy, live-event, or X-Eve
  passes that run outside the main space tick.
- **Backlog** shows whether bounded work is merely cheap per pass but falling
  further behind.
- **CPU and memory** reveal host saturation, garbage collection pressure, or a
  leak that tick samples alone can miss.
- **`process.gc`** summarizes V8 garbage collections in a fixed 128-event
  window and lifetime totals, including count, duration, p95, maximum, and
  collection kind.
- **`capture.buildDurationMs`** reports how long the telemetry snapshot itself
  took to assemble, making measurement overhead visible.

A useful snapshot includes process uptime, RSS, heap used, CPU utilization over
the sample window, tick interval average/p95/max, tick work average/p95/max,
Living Universe scheduler average/p95/max, actors, flights, materialized ships,
materialized systems, active economy jobs, deliveries, losses, and queue depth.
With roaming conflict enabled, also record operation-group count, due
transitions, presence checks, camp count, expired or deferred contacts, scheduled
contacts, and roaming-kernel work-budget exhaustion.

The GC observer stores only a fixed ring of recent events and small aggregate
counters; it does not retain heap objects, write a profile, or walk the heap.
Interpret a long event-loop pause with low tick work and low roaming work
alongside `process.gc`, host CPU, and `capture.buildDurationMs`. If GC duration
is also low, external scheduling or storage contention is more likely than
ordinary in-game work.

Runtime performance telemetry is written beneath the target installation's
private `_local/runtime-performance` directory. Living-economy timeline samples
default to ten-minute intervals. Keep those outputs out of public source
control, especially when they contain local paths or operational details.

## Capacity-test sequence

The installed play profile starts with 5,000 persistent pilots, 64 materialized
ships per occupied system, and 180 materialized globally. That is the public
play target, not a guarantee for every host.

1. Let startup, cache loading, market seeding, and initial reconciliation
   settle.
2. Record a stable sample with no player in a heavily populated scene.
3. Record a second sample while observing traffic, mining, or combat.
4. If the server does not stabilize, use
   `evejs.config.x-eve.local.json` to reduce virtual population to 2,500, 1,000,
   or 400. At the 400-pilot step, use 48 materialized ships per occupied system
   and 120 globally.
5. Change physical caps only after the virtual population is stable.
6. Hold each stage long enough to see economy pulses, route planning, telemetry,
   garbage collection, and at least one busy observed scene.
7. Compare p95 and backlog, not only a short average. Revert a stage that does
   not stabilize below the chosen ceiling.

For an overnight comparison, use matching windows and report deltas from 100 ms.
Host sleep, restart, process replacement, or missing samples divide the run into
separate observation windows and should be called out rather than interpolated.

## Roaming-conflict capacity

The roaming kernel uses a persistent deadline heap plus system and directional
gate-lane indexes. It does not perform an all-pairs pilot or flight scan.
Default admission limits are:

- 96 persistent operation groups;
- 16 due phase transitions per pass;
- 192 indexed presence checks per pass;
- six groups in a gate-camp phase at once;
- 1.5 ms of enforced synchronous roaming work per pass.

These are decision-work limits, not promises that six camps can all be
materialized beside players at once. Visible ships still consume the global and
per-system physical budgets. An already-visible camp joins an encounter in
place, avoiding a second acquire/remove/materialize cycle and its scene cost.

Healthy roaming telemetry has a stable or cycling deadline queue, bounded
deferred contacts, and no sustained work-budget exhaustion. If deadlines keep
aging or deferred contacts only grow, reduce group or camp count first. Increase
the transition or presence limits only after confirming that p95 tick interval,
tick work, and the broader Living Universe scheduler retain headroom.

In a recent 5000-pilot capacity run with the default 96 roaming groups, roaming
work remained below `0.5 ms p95`; the cumulative observed roaming-work maximum
was approximately `4.6 ms`. These are measurements from one workload, not a
universal capacity guarantee. They describe the bounded roaming subsystem only.
The current monolithic Living Universe and living-economy persistence paths can
still produce rare main-thread stalls above `600 ms`. Do not attribute an
overall tick maximum to roaming without comparing the roaming-work telemetry
with persistence, tick-work, garbage-collection, and host-scheduling data.

## Scaling priority

The cheapest capacity is virtual population. The most expensive capacity is
usually physical ships sharing an observed system, particularly during combat
or synchronized scene entry.

When latency rises, tune in this order:

1. Reduce per-system and global materialized-ship caps.
2. Reduce materializations per scheduler pass.
3. Reduce due flights, new economy jobs, production runs, reprices, and stock
   rows handled per pass.
4. Increase the interval for broad route planning or full stock reconciliation.
5. Reduce roaming operation groups or concurrent camps if conflict backlogs or
   observed-scene combat are the pressure source.
6. Reduce virtual population only if scheduler backlog or memory remains the
   limiting factor after physical work is controlled.

Do not raise the 120/130 ms admission thresholds simply to make telemetry look
healthy.

## The 10x test option

`livingUniverseOffGridTravelTimeMultiplier: 10` is a development convenience.
It applies only to eligible virtual travel in an unobserved system. A
materialized flight or one in a player-connected scene continues at normal
timing; entering observation rebases the remaining leg instead of moving the
ship instantly.

The multiplier saves wall-clock test time. It does not prove normal-time route
balance, production balance, delivery cadence, or sustainable economy
throughput. Return it to `1` for ordinary play and final measurements.

Likewise, `livingEconomyIndustryTimeScale: 0.1` makes NPC industry complete ten
times faster for tests. Do not combine accelerated travel and accelerated
industry results with normal-time economic claims.

## Reading a regression

- A higher p95 with flat tick work suggests host scheduling, blocking I/O, or
  another process rather than ordinary in-tick computation.
- A higher tick-work p95 after entering a system points toward materialization,
  physical AI, effects, combat, or scene fan-out.
- Stable tick latency with growing due queues means budgets are safe but too
  small for the configured workload.
- Periodic spikes aligned with stock or route maintenance suggest reducing the
  batch and spreading the work over more pulses.
- Rising RSS or heap across equivalent quiet windows requires a longer memory
  investigation before adding population.

Record the configuration with every benchmark, but redact paths, addresses,
credentials, and private deployment details before sharing it.
