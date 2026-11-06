// The Linear-Delivery ids and signatures the bridge has accepted, so a delivery Linear
// sends again is acknowledged but not acted on twice (FR-203). Held in memory: a restart forgets
// them, which at worst lets one retry through.
import { inject, injectable } from "tsyringe";
import { CLOCK } from "./tokens.js";

// Linear can retry a delivery hours after the first attempt, long after the 60 s
// freshness window, so ids are kept for a day.
const KEEP_MS = 24 * 60 * 60 * 1000;
// Two keys per delivery, so 5,000 deliveries: far more than a day's for one bot. It
// only bounds memory.
const MAX_IDS = 10_000;

@injectable()
export class SeenDeliveries {
  // Insertion order is arrival order, so the oldest ids come first.
  readonly #seen = new Map<string, number>();

  constructor(@inject(CLOCK) private readonly now: () => number) {}

  // True the first time an id is offered, false after that. It checks and records in
  // one step, so two copies of a delivery arriving together can't both pass.
  firstTime(id: string): boolean {
    const now = this.now();
    for (const [oldest, at] of this.#seen) {
      if (now - at < KEEP_MS && this.#seen.size < MAX_IDS) break;
      this.#seen.delete(oldest);
    }
    if (this.#seen.has(id)) return false;
    this.#seen.set(id, now);
    return true;
  }
}
