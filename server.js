// roster.js
// ADR 004 demo: smart backtracking search with a greedy fallback.
// Run:  node roster.js            (normal roster)
//       node roster.js --crunch   (most litho techs on leave on day 2)
// Needs Node 16+.

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

// ============================================================
// 1. SAMPLE DATA: edit these to experiment
// ============================================================

const CONFIG = {
  days: 3,
  shiftLength: 8,           // hours
  minRestHours: 12,         // from the end of one shift to the start of the next
  maxHoursInPeriod: 24,     // per person, across the whole roster
  timeLimitMs: 5000,        // stop searching after this and use the fallback

  // 6 overlapping shifts per day, one starting every 4 hours.
  // At any moment, two shifts are on the floor.
  shiftTemplates: [
    { name: 'F', start: 2 },
    { name: 'A', start: 6 },
    { name: 'B', start: 10 },
    { name: 'C', start: 14 },
    { name: 'D', start: 18 },
    { name: 'E', start: 22 },
  ],

  // Positions every shift needs filled
  slotTemplates: [
    { role: 'TECH', quals: ['LITHO'] },
    { role: 'OPER', quals: [] },
  ],

  // Skills that must be on the floor at every moment (across overlapping shifts)
  coverageRules: [{ skill: 'SUP', min: 1 }],
};

// leaveDays: days this person can't start a shift (day 1 = first day)
const EMPLOYEES = [
  { id: 'Aisha',  quals: ['LITHO', 'SUP'], leaveDays: [] },
  { id: 'Ben',    quals: ['LITHO', 'SUP'], leaveDays: [2] },
  { id: 'Chen',   quals: ['LITHO', 'SUP'], leaveDays: [] },
  { id: 'Dina',   quals: ['LITHO'],        leaveDays: [] },
  { id: 'Eli',    quals: ['LITHO'],        leaveDays: [] },
  { id: 'Fatima', quals: ['LITHO'],        leaveDays: [3] },
  { id: 'Gopal',  quals: ['LITHO'],        leaveDays: [] },
  { id: 'Hana',   quals: ['LITHO'],        leaveDays: [] },
  { id: 'Ivan',   quals: ['SUP'],          leaveDays: [] },
  { id: 'Jamal',  quals: ['SUP'],          leaveDays: [] },
  { id: 'Kira',   quals: ['SUP'],          leaveDays: [1] },
  { id: 'Leo',    quals: [],               leaveDays: [] },
  { id: 'Maya',   quals: [],               leaveDays: [] },
  { id: 'Noor',   quals: [],               leaveDays: [] },
  { id: 'Omar',   quals: [],               leaveDays: [] },
  { id: 'Priya',  quals: [],               leaveDays: [] },
];

// --crunch: send most litho techs on leave on day 2, leaving only 2 for 6 TECH slots
const CRUNCH_OFF = ['Dina', 'Eli', 'Fatima', 'Gopal', 'Hana'];
function applyCrunch(list) {
  return list.map(e => (CRUNCH_OFF.includes(e.id) ? { ...e, leaveDays: [...e.leaveDays, 2] } : e));
}

// ============================================================
// 2. BUILDING THE PROBLEM
// ============================================================

// Times are absolute hours from the start of day 1 (so overnight shifts just work)
function buildShifts(cfg) {
  const shifts = [];
  for (let day = 1; day <= cfg.days; day++) {
    for (const t of cfg.shiftTemplates) {
      const start = (day - 1) * 24 + t.start;
      shifts.push({ id: `D${day}-${t.name}`, name: t.name, day, start, end: start + cfg.shiftLength, hours: cfg.shiftLength });
    }
  }
  return shifts;
}

// A slot = one position on one shift, e.g. "Day 1, shift A, TECH"
function buildSlots(shifts, cfg) {
  const slots = [];
  for (const shift of shifts) {
    cfg.slotTemplates.forEach((tpl, i) => {
      slots.push({ id: `${shift.id}-${tpl.role}${i}`, shift, role: tpl.role, quals: tpl.quals });
    });
  }
  return slots;
}

// Cut the timeline at every shift start/end. Each piece is a segment.
// A segment's staff = everyone on any shift that spans it.
function buildSegments(shifts, slots) {
  const points = [...new Set(shifts.flatMap(s => [s.start, s.end]))].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const seg = { start: points[i], end: points[i + 1] };
    const covering = shifts.filter(s => s.start <= seg.start && s.end >= seg.end);
    if (covering.length === 0) continue;
    seg.shifts = covering;
    seg.slots = slots.filter(sl => covering.includes(sl.shift));
    segments.push(seg);
  }
  return segments;
}

function createState(employees, slots, segments, cfg) {
  return {
    cfg, slots, segments,
    employees: employees.map(e => ({ ...e, quals: new Set(e.quals), shifts: [], hours: 0 })),
    assignment: new Map(), // slot.id -> employee
    stats: { tries: 0, backtracks: 0 },
  };
}

// ============================================================
// 3. RULES
// ============================================================

function isEligible(emp, slot, state) {
  const { shift } = slot;
  if (emp.leaveDays.includes(shift.day)) return false;
  if (!slot.quals.every(q => emp.quals.has(q))) return false;
  if (emp.hours + shift.hours > state.cfg.maxHoursInPeriod) return false;

  // Rest time against every shift they already have (also blocks overlaps)
  for (const other of emp.shifts) {
    const gap = shift.start >= other.end ? shift.start - other.end
              : other.start >= shift.end ? other.start - shift.end
              : -1; // the shifts overlap
    if (gap < state.cfg.minRestHours) return false;
  }
  return true;
}

function candidatesFor(slot, state) {
  return state.employees.filter(e => isEligible(e, slot, state));
}

function countSkill(seg, skill, state) {
  return seg.slots.filter(sl => state.assignment.get(sl.id)?.quals.has(skill)).length;
}

// Can every segment still reach its required skills?
// Counts people already on the floor + open slots that someone with the skill could still fill.
function coverageStillPossible(state) {
  for (const seg of state.segments) {
    for (const rule of state.cfg.coverageRules) {
      let possible = countSkill(seg, rule.skill, state);
      for (const slot of seg.slots) {
        if (state.assignment.has(slot.id)) continue;
        if (candidatesFor(slot, state).some(e => e.quals.has(rule.skill))) possible++;
      }
      if (possible < rule.min) return false;
    }
  }
  return true;
}

// Would this person bring a skill that's missing somewhere during this shift?
function suppliesMissingSkill(emp, slot, state) {
  return state.segments.some(seg =>
    seg.shifts.includes(slot.shift) &&
    state.cfg.coverageRules.some(rule =>
      emp.quals.has(rule.skill) && countSkill(seg, rule.skill, state) < rule.min));
}

// Order to try people in: fills a missing skill first, then fewest hours, then name
function rankCandidates(cands, slot, state) {
  return cands
    .map(emp => ({ emp, helps: suppliesMissingSkill(emp, slot, state) ? 0 : 1 }))
    .sort((a, b) => a.helps - b.helps || a.emp.hours - b.emp.hours || a.emp.id.localeCompare(b.emp.id))
    .map(x => x.emp);
}

function assign(state, emp, slot) {
  state.assignment.set(slot.id, emp);
  emp.shifts.push(slot.shift);
  emp.hours += slot.shift.hours;
}

function unassign(state, emp, slot) {
  state.assignment.delete(slot.id);
  emp.shifts.splice(emp.shifts.lastIndexOf(slot.shift), 1);
  emp.hours -= slot.shift.hours;
}

// ============================================================
// 4. THE SEARCH (ADR 003, fixed)
// ============================================================

const SOLVED = 'SOLVED', FAIL = 'FAIL', TIMEOUT = 'TIMEOUT';

function search(state, deadline) {
  if (Date.now() > deadline) return TIMEOUT;

  const open = state.slots.filter(s => !state.assignment.has(s.id));
  if (open.length === 0) return coverageStillPossible(state) ? SOLVED : FAIL;

  // Fix 1 + 2: find the hardest open slot, and stop immediately if any slot is now impossible
  let hardest = null, hardestCands = null;
  for (const slot of open) {
    const cands = candidatesFor(slot, state);
    if (cands.length === 0) return FAIL;
    if (!hardest || cands.length < hardestCands.length) { hardest = slot; hardestCands = cands; }
  }
  if (!coverageStillPossible(state)) return FAIL;

  for (const emp of rankCandidates(hardestCands, hardest, state)) {
    state.stats.tries++;
    assign(state, emp, hardest);
    const result = search(state, deadline);
    if (result !== FAIL) return result; // SOLVED or TIMEOUT: stop either way
    unassign(state, emp, hardest);
    state.stats.backtracks++;
  }
  return FAIL;
}

// ============================================================
// 5. GREEDY FALLBACK: never undoes, reports gaps
// ============================================================

function greedy(state) {
  const gaps = [];
  const startCount = new Map(state.slots.map(s => [s.id, candidatesFor(s, state).length]));
  const order = [...state.slots].sort((a, b) => startCount.get(a.id) - startCount.get(b.id));

  for (const slot of order) {
    const cands = candidatesFor(slot, state);
    if (cands.length === 0) { gaps.push(`${slot.id}: nobody eligible`); continue; }
    assign(state, rankCandidates(cands, slot, state)[0], slot);
  }
  return gaps;
}

function coverageGaps(state) {
  const gaps = [];
  for (const seg of state.segments) {
    for (const rule of state.cfg.coverageRules) {
      const have = countSkill(seg, rule.skill, state);
      if (have < rule.min) gaps.push(`${when(seg.start)} to ${when(seg.end)}: needs ${rule.min} ${rule.skill}, has ${have}`);
    }
  }
  return gaps;
}

// ============================================================
// 6. RUN + OUTPUT
// ============================================================

const hhmm = h => `${String(h % 24).padStart(2, '0')}:00`;
const when = h => `Day ${Math.floor(h / 24) + 1} ${hhmm(h)}`;

function run(employees, cfg) {
  const shifts = buildShifts(cfg);
  const slots = buildSlots(shifts, cfg);
  const segments = buildSegments(shifts, slots);

  const t0 = Date.now();
  let state = createState(employees, slots, segments, cfg);
  const status = search(state, t0 + cfg.timeLimitMs);
  const stats = state.stats;

  let slotGaps = [];
  if (status !== SOLVED) {
    state = createState(employees, slots, segments, cfg);
    slotGaps = greedy(state);
  }

  return {
    status, stats, ms: Date.now() - t0,
    usedFallback: status !== SOLVED,
    roster: shifts.map(shift => ({
      day: shift.day,
      label: `${shift.name}  ${hhmm(shift.start)}-${hhmm(shift.end)}`,
      staff: slots.filter(s => s.shift === shift).map(s => {
        const emp = state.assignment.get(s.id);
        return {
          role: s.role,
          name: emp ? emp.id : '--GAP--',
          flagged: !!emp && cfg.coverageRules.some(r => emp.quals.has(r.skill)),
        };
      }),
    })),
    hours: state.employees.map(e => ({ id: e.id, hours: e.hours, shifts: e.shifts.length })),
    gaps: [...slotGaps, ...coverageGaps(state)],
  };
}

function printResult(r, ticks) {
  const headline = {
    SOLVED: '[OK] Found a valid roster',
    FAIL: '[IMPOSSIBLE] Proved no valid roster exists with these rules',
    TIMEOUT: '[TIMEOUT] Search hit the time limit',
  }[r.status];

  console.log(`\n${headline}  (${r.ms} ms, ${r.stats.tries} tries, ${r.stats.backtracks} undos)`);
  if (r.usedFallback) console.log('Showing the greedy fallback roster instead. See gaps below.');

  let day = 0;
  for (const row of r.roster) {
    if (row.day !== day) { day = row.day; console.log(`\nDay ${day}`); }
    const staff = row.staff.map(s => `${s.role}: ${(s.name + (s.flagged ? '*' : '')).padEnd(9)}`).join('  ');
    console.log(`  ${row.label}   ${staff}`);
  }
  console.log('\n* = supervisor-qualified');

  console.log('\nHours worked:');
  for (const h of r.hours) console.log(`  ${h.id.padEnd(8)} ${String(h.hours).padStart(2)}h  (${h.shifts} shifts)`);

  console.log(r.gaps.length ? `\nGaps:\n  ${r.gaps.join('\n  ')}` : '\nNo gaps.');
  console.log(`\nMain thread stayed responsive: heartbeat ticked ${ticks} times while the worker solved.\n`);
}

// ============================================================
// 7. MAIN THREAD vs WORKER (same file, two roles)
// ============================================================

if (isMainThread) {
  const employees = process.argv.includes('--crunch') ? applyCrunch(EMPLOYEES) : EMPLOYEES;

  let ticks = 0;
  const heartbeat = setInterval(() => ticks++, 10); // proves the main thread isn't blocked

  const worker = new Worker(__filename, { workerData: { employees, cfg: CONFIG } });
  const killSwitch = setTimeout(() => worker.terminate(), CONFIG.timeLimitMs + 2000); // safety net

  let done = false;
  worker.once('message', result => { done = true; printResult(result, ticks); });
  worker.once('error', err => console.error('Worker error:', err));
  worker.once('exit', () => {
    clearInterval(heartbeat);
    clearTimeout(killSwitch);
    if (!done) console.error('Worker stopped without returning a result.');
  });
} else {
  parentPort.postMessage(run(workerData.employees, workerData.cfg));
}