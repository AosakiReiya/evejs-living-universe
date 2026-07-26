# Shared C2 Family Estate

The family-estate slice creates one shared corporation home rather than one private system per character. The optional veteran prologue below grants its ships and skills only when a player explicitly starts it; merely enabling the estate never grants rewards or transfers corporation ownership.

## Authored layout

The default profile uses the existing effect-free class-2 system **J164417** (`31000355`). It has normal C2 combat and exploration content and does not modify a Gnosis fit with a wormhole weather effect.

The managed topology is exactly four source connections:

| Slot | Default destination | Lifetime | Cumulative mass | Individual ship mass |
|---|---|---:|---:|---:|
| High-security conduit | Uitra (`30030141`), four stargate jumps from Jita | Permanent | Unlimited | Unrestricted |
| Low-security conduit | Oinasiken (`30045347`) in Black Rise | Permanent | Unlimited | Unrestricted |
| Random aperture 1 | Reseeded destination | Normal | Normal | Normal wormhole type |
| Random aperture 2 | Reseeded destination | Normal | Normal | Normal wormhole type |

The permanent conduits retain ordinary per-character polarization, but have no individual ship-size limit. Frigates, freighters, carriers, dreadnoughts, supercarriers, and titans can all use them. They do not expire and jumps do not consume cumulative connection mass. Both endpoints remain visible and scannable. The two random apertures use the existing discovery, hidden K162, lifetime, individual ship-size limits, mass depletion, collapse, and replacement behavior.

While the estate profile is enabled, authored native statics and unmanaged wandering connections are not sourced from or randomly targeted at the home system. This prevents the managed four-connection layout from silently growing extra entrances. A collapsed random slot is replaced after `familyEstateRandomRespawnDelaySeconds`; permanent slots repair themselves during startup or reconciliation.

## Athanor

Startup idempotently seeds one Athanor named **The Family Holding** at **J164417 II - Moon 1** (`40369145`). It starts in a deliberately damaged but dockable condition:

- hull damage: 18%;
- armor damage: 45%;
- shield charge: 20%;
- docking, fitting, offices, repair, and insurance available;
- reprocessing, moon extraction, reactions, and other module-backed services offline;
- public docking and tethering until a capsuleer corporation claims it.

The structure carries a persistent `familyEstate` marker. Re-running the bootstrap will not duplicate it, rename it, move it, transfer it, or resurrect it after destruction. Its initial owner is the configured holding corporation; the claim flow below transfers that same structure rather than replacing it.

## Corporation claim and residents

The estate has a separate persistent claim record so ownership and mission progression survive restarts without overloading the structure record. A claim requires the corporation CEO or a director to be docked in **The Family Holding** and to belong to a capsuleer-created corporation. Claiming:

- transfers the existing Athanor to that corporation;
- changes docking and tethering from public to corporation access;
- records the claimant as the permanent estate founder;
- makes every current and future corporation member an estate resident;
- starts the estate at the `claimed` progression stage without automatically repairing advanced services.

The founder, corporation CEO/directors, and delegated stewards can manage estate progression. The founder role cannot be removed. Steward status is an estate permission only and does not grant unrelated corporation wallet or hangar roles. Friends join through the server's ordinary corporation application/invitation system; leaving the corporation immediately removes their resident access without requiring a second membership list.

Progress capabilities are persisted in dependency order: shelter systems, reprocessing, market, clone services, manufacturing/research, reactions, and moon extraction. Only shelter systems begin unlocked. Mission code can call `unlockFamilyEstateCapability()` after completing the appropriate repair objective; unlocking the state does not silently online a structure service before its matching mission implementation exists.

## Enabling and checking it

Set this in the private `evejs.config.local.json` used by the server:

```json
"familyEstateEnabled": true
```

The remaining `familyEstate...` settings document the selected system, known-space endpoints, owner, moon, random-slot count, and respawn delay. Keep private deployment addresses and credentials out of this configuration and out of the repository.

After a server start, a GM can inspect or reconcile the estate in chat:

```text
/estate status
/estate connections
/estate claim
/estate members
/estate role <characterID> <steward|resident>
/estate services
/estate projects
/estate contribute <project>
/estate start <project>
/estate ledger
/estate ensure
/estateprologue start
/estateprologue status
/estateprologue recover
```

`/estate ensure` is safe to repeat and is restricted to GM/content/programmer accounts. It recreates missing managed wormholes and creates the Athanor only if no marked estate structure has ever existed. `/estate unlock <capability>` is an operator-only mission-development aid. The verification commands are:

```powershell
cd server
npm run verify:family-estate
npm run verify:family-estate-claim
npm run verify:family-estate-prologue
npm run verify:family-estate-projects
npm run verify:family-estate-logistics
```

## Restoration projects and estate economy

The estate uses persistent, corporation-scale restoration projects rather than direct GM unlocks. A resident can still contribute missing materials from their personal item hangar while docked in **The Family Holding**. A founder, steward, CEO, or director can also use `/estate start <project>` before the bill of materials is complete. That single command commissions procurement, authorizes outside freight, and enables automatic project start when the last shipment arrives.

Commissioned materials come from real Living Economy stock at ordinary regional stations. Independent secure-hauler flights reserve the source stock, depart from that station, follow their normal stargate route, cross the permanent high-security estate conduit, approach The Family Holding, deliver, and return empty. They are not spawned beside the player and the cargo is not credited merely because a timer elapsed. If a player is in the relevant system the flight materializes and remains visible under normal flight physics; its pilot continues to appear in Local. A destroyed or orphaned hauler reopens the unmet demand instead of completing the project.

Every freight contract debits the owning corporation's real master wallet into durable escrow before departure. Its invoice contains the actual source-stock value plus a 5% carrier fee, with a 50,000 ISK minimum fee per shipment. Arrival converts the escrow to paid delivery accounting without charging the wallet a second time. Loss or cancellation returns the escrow exactly once. The project labor budget is kept in reserve while contracts are admitted, so procurement cannot accidentally consume the ISK needed to start the work. `/estate projects` shows active shipments, escrow, delivered goods and freight spend, outstanding estimates, and any funding error.

When all materials are delivered, the project labor cost is debited exactly once and the project starts automatically. Project work then advances in real elapsed time, including while players are offline. Restart reconciliation, source-stock reservations, wallet effects, delivery settlement, and refunds all use stable operation identities so replay does not duplicate items or ISK. `/estate complete <project>` remains an operator-only testing aid.

The first two playable projects are:

1. `stabilization` — consumes one Structure Construction Parts unit, bulk minerals, Nanite Repair Paste, 5 million ISK, and two hours. Completion repairs the Athanor's actual shield, armor, and hull state.
2. `reprocessing` — requires stabilization, a Standup Reprocessing Facility I, further structure materials, 10 million ISK, and four hours. Completion fits the supplied service module offline and unlocks the reprocessing capability. Players must still stock the fuel bay and online the module using the normal Upwell service mechanics.

The estate treasury is the owning corporation's real master wallet, not a second invented currency. Once claimed, an hourly commercial settlement credits low-volume tenant leases and berth/service income based on resident count, active conduits, structure condition, and restored facilities, then subtracts operating expenses. At most 24 hours are caught up after an outage. Each settlement has a deterministic identity and is checked against the corporation wallet journal before crediting, preventing restart duplication. Reprocessing taxes generated by real player activity already credit the structure owner's corporation wallet through the native reprocessing runtime and appear in the corporation wallet journal; they are not duplicated by the estate settlement.

`/estate projects` shows treasury balance, lifetime commercial gross/expenses/net, project requirements, contributions, contracts, escrow, and timers. `/estate ledger` shows recent restoration, freight, and commercial entries. The scheduler reconciles once per minute and is unreferenced, so it adds no high-frequency simulation work and cannot hold the process open during shutdown.

### Faster isolated testing

Travel acceleration is deliberately limited to unobserved virtual space. Set `livingUniverseOffGridTravelTimeMultiplier` above `1` to shorten flight legs only while the ship is neither materialized nor in a system containing a player. If a player enters during an accelerated leg, the remaining journey is rebased to normal time without teleporting the ship. The local X-Eve test profile uses `10`, while player-observed flight, station clearance, alignment, warp, wormhole traversal, and final approach remain at normal speed.

The local profile also uses `livingEconomyIndustryTimeScale: 0.1` so NPC industry completes ten times faster during this isolated accelerated test. This changes production duration, not project repair duration: stabilization still takes two hours and reprocessing still takes four hours after their supplies arrive. Keep both multipliers at production values when measuring final balance or pacing.

## Veteran prologue

The prologue is deliberately short and assumes the player already understands Eve. It uses persistent per-character objective state and real game events rather than asking the player to advance it with chat commands:

1. **A Letter From Home** — while docked anywhere, `/estateprologue start` applies a bounded generalist skill floor and issues and boards a fitted Sunesis. The player travels normally to Uitra.
2. **Squatters at the Gate** — entering the permanent Uitra conduit advances the objective and creates three Guristas frigates and one Guristas destroyer around The Family Holding. They use native NPC flight, targeting, weapons, effects, wrecks, bounty, and loot. Destroying all four advances the chain.
3. **The Family Holding** — the player docks in the Athanor. The CEO or a director uses `/estate claim`; if the player's corporation already owns it, docking is sufficient. Completion issues and boards a fitted Gnosis with a flexible drone/hybrid baseline plus missile, probing, archaeology, hacking, salvaging, and tractor alternatives in its cargo.

The skill floor raises only skills below the configured level and never lowers an existing skill. It covers the supplied hulls, shield tank, drones, hybrid guns, heavy missiles, scanning, hacking, archaeology, and salvaging. Rewards store their item IDs in the objective ledger, so `start`, `status`, and `recover` are safe to repeat without becoming a ship faucet. The recovery command only replaces a genuinely missing Sunesis or respawns a lost transient encounter after a restart; it does not skip objectives. A Gnosis is issued only after the estate is secured, docked, and owned by the player's corporation.

This is a shared-corporation opening. The first eligible leader transfers the Athanor. Later friends in that same corporation can run their own prologues, clear their own encounter, and finish by docking because their corporation already holds the estate.

## Next mission integration points

The next estate progression slice has stable infrastructure to target:

1. Repair the reprocessing plant and unlock the persisted `reprocessing` capability.
2. Recover the market/procurement ledger and begin corporation buy orders.
3. Restore manufacturing and research services.
4. Restore reactions and moon extraction.
5. Tie the two rotating apertures to later exploration and expansion missions.

Commissioned restoration freight is the deliberately narrow first use of NPC economic routing through the estate conduit. The damaged Athanor is not treated as a general market hub: it accepts only an authorized restoration bill of materials. Ordinary trade, manufacturing supply, and open-ended regional routing remain later capability unlocks.
