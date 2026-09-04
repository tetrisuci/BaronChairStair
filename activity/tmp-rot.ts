/** Does a difficulty correction move a pinned day, or a pinned rush stack? */
import { Store } from "./server/db";
import { PuzzleArchive } from "./server/puzzles";
import { DaySchedule, pastDaysOf } from "./server/schedule";
import { dailyRushSeed, rushSequence } from "./shared/rush";

const DB = "/tmp/rot-check2.sqlite";
for (const f of [DB, DB + "-wal", DB + "-shm"]) await Bun.file(f).delete().catch(() => {});
const load = (o = []) => PuzzleArchive.load("./data/puzzles.json", { timeZone: "America/Los_Angeles" }, [], o);

const plain = load();
const store = new Store(DB, pastDaysOf(plain));
const before = new DaySchedule(plain, store);
const day = plain.currentDay() - 1;
const was = ["easy", "medium", "hard"].map((t) => before.forTier(day, t as never).id);
const wasStack = rushSequence(before.rushPoolFor(day), dailyRushSeed(day)).map((p) => p.id);

// A puzzle genuinely in this day's forty, moved to the other end of the scale.
const victim = plain.get(wasStack[20]!)!;
store.setOverride(victim.id, { difficulty: victim.difficulty > 5 ? 1 : 20 }, "zhiyuan");

const after = new DaySchedule(load(store.overridesFor() as never), store);
const now = ["easy", "medium", "hard"].map((t) => after.forTier(day, t as never).id);
const nowStack = rushSequence(after.rushPoolFor(day), dailyRushSeed(day)).map((p) => p.id);

const corrected = load(store.overridesFor() as never);
const pinnedIds = store.pinnedRushPool(day)!;
const unfrozen = rushSequence(pinnedIds.map((id) => corrected.get(id)!), dailyRushSeed(day)).map((p) => p.id);
const same = (a: number[], b: number[]) => a.filter((id, i) => id === b[i]).length;

console.log(`corrected puzzle ${victim.id}: d${victim.difficulty} -> d${victim.difficulty > 5 ? 1 : 20} (slot 20 of the stack)`);
console.log("pinned day unchanged:", JSON.stringify(was) === JSON.stringify(now));
console.log("WITH the freeze:   ", same(wasStack, nowStack) + "/40 slots survive");
console.log("WITHOUT the freeze:", same(wasStack, unfrozen) + "/40 slots survive  <- what the bug did");
