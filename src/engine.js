// Rostering engine (ADR 004). Pure functions, no DB.
// Times are hours from local midnight of day 1, so a shift Day 1 22:00 -> Day 2 06:00 is 22 -> 30.
// This file also runs as the worker thread (see bottom).
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const cfg = require('./config');

const SOLVED = 'SOLVED', FAIL = 'FAIL', TIMEOUT = 'TIMEOUT';
const hhmm = h => `${String(h % 24).padStart(2, '0')}:00`;
const when = h => `Day ${Math.floor(h / 24) + 1} ${hhmm(h)}`;
const overlaps = (a, b) => a.start < b.end && a.end > b.start;

// ===================== Building the problem =====================

// Unpopular points for a shift: night, weekend, holiday
function classify(shift, special) {
  let nightHours = 0;
  for (let h = shift.start; h < shift.end; h++) {
    const hod = h % 24;
    if (hod >= cfg.NIGHT.from || hod < cfg.NIGHT.to) nightHours++;
  }
  const touches = days => days.some(d => overlaps(shift, { start: (d - 1) * 24, end: d * 24 }));

  const tags = [];
  if (nightHours * 2 >= shift.end - shift.start) tags.push('N');
  if (touches(special.weekendDays)) tags.push('W');
  if (touches(special.holidayDays)) tags.push('H');
  return { tags: tags.join(''), points: tags.reduce((p, t) => p + cfg.POINTS[t], 0) };
}

// One slot = one position on one concrete shift
function buildSlots(p) {
  const slots = [];
  for (let day = 1; day <= p.days; day++) {
    for (const t of p.shiftTmpls) {
      const start = (day - 1) * 24 + t.start_hour;
      const shift = { id: `D${day}-${t.shift_cd}`, start, end: start + t.len_hours };
      Object.assign(shift, classify(shift, p.special));
      for (const pos of p.positions) slots.push({ id: `${shift.id}-${pos.cd}`, shift, pos });
    }
  }
  return slots;
}

// Cut the timeline at every shift start/end. A segment's staff = slots whose shift spans it.
function buildSegments(slots) {
  const shifts = [...new Set(slots.map(s => s.shift))];
  const points = [...new Set(shifts.flatMap(s => [s.start, s.end]))].sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const seg = { start: points[i], end: points[i + 1] };
    seg.slots = slots.filter(sl => sl.shift.start <= seg.start && sl.shift.end >= seg.end);
    if (seg.slots.length) segments.push(seg);
  }
  return segments;
}

// ===================== State =====================

function createState(emps, slots, ctx) {
  return {
    emps, slots, ...ctx,                         // ctx = { segments, covRules }
    worked: new Map(emps.map(e => [e.id, []])),  // empId -> shifts assigned
    assignment: new Map(),                        // slotId -> emp
    stats: { tries: 0, undos: 0 },
  };
}

function assign(state, emp, slot) {
  state.assignment.set(slot.id, emp);
  state.worked.get(emp.id).push(slot.shift);
}

function unassign(state, emp, slot) {
  state.assignment.delete(slot.id);
  const list = state.worked.get(emp.id);
  list.splice(list.lastIndexOf(slot.shift), 1);
}

const hoursOf = (state, emp) => state.worked.get(emp.id).reduce((h, s) => h + (s.end - s.start), 0);
const pointsOf = (state, emp) => state.worked.get(emp.id).reduce((p, s) => p + s.points, 0);

// ===================== Rules =====================

const onLeave = (emp, slot) => emp.leave.some(l => overlaps(slot.shift, l));
const hasQuals = (emp, slot) => slot.pos.quals.every(q => emp.quals.has(q));

function restOk(emp, slot, state) {
  return state.worked.get(emp.id).every(s => {
    const gap = slot.shift.start >= s.end ? slot.shift.start - s.end
              : s.start >= slot.shift.end ? s.start - slot.shift.end
              : -1; // overlapping shifts
    return gap >= cfg.MIN_REST_HOURS;
  });
}

const isEligible = (emp, slot, state) => !onLeave(emp, slot) && hasQuals(emp, slot) && restOk(emp, slot, state);
const candidatesFor = (slot, state) => state.emps.filter(e => isEligible(e, slot, state));

// ===================== Coverage across overlapping shifts =====================

const countQual = (seg, qual, state) =>
  seg.slots.filter(sl => state.assignment.get(sl.id)?.quals.has(qual)).length;

// Can every segment still reach its minimum? (already there + open slots someone with the qual could fill)
function coveragePossible(state) {
  for (const seg of state.segments) {
    for (const rule of state.covRules) {
      let possible = countQual(seg, rule.qual, state);
      for (const sl of seg.slots) {
        if (!state.assignment.has(sl.id) && candidatesFor(sl, state).some(e => e.quals.has(rule.qual))) possible++;
      }
      if (possible < rule.min) return false;
    }
  }
  return true;
}

// Would this person bring a qual that a segment of this slot's shift is still missing?
const suppliesMissing = (emp, slot, state) => state.segments.some(seg =>
  seg.slots.includes(slot) &&
  state.covRules.some(r => emp.quals.has(r.qual) && countQual(seg, r.qual, state) < r.min));

function coverageGaps(state) {
  const gaps = [];
  for (const seg of state.segments) {
    for (const r of state.covRules) {
      const have = countQual(seg, r.qual, state);
      if (have < r.min) gaps.push(`${when(seg.start)}-${hhmm(seg.end)}: needs ${r.min} ${r.qual}, has ${have}`);
    }
  }
  return gaps;
}

// ===================== Fairness =====================

const fairness = (state, emp) => hoursOf(state, emp) + pointsOf(state, emp) * cfg.HOURS_PER_POINT;

// Try first: supplies a missing supervisor, then lowest fairness score, then lowest id
function rank(cands, slot, state) {
  return cands
    .map(emp => ({ emp, helps: suppliesMissing(emp, slot, state) ? 0 : 1, fair: fairness(state, emp) }))
    .sort((a, b) => a.helps - b.helps || a.fair - b.fair || a.emp.id - b.emp.id)
    .map(x => x.emp);
}

// ===================== Search =====================

// Hardest open slot first; fail as soon as any slot has nobody left
function search(state, deadline) {
  if (Date.now() > deadline) return TIMEOUT;
  const open = state.slots.filter(s => !state.assignment.has(s.id));
  if (open.length === 0) return coveragePossible(state) ? SOLVED : FAIL;

  let hardest = null, hardestCands = null;
  for (const slot of open) {
    const cands = candidatesFor(slot, state);
    if (cands.length === 0) return FAIL;
    if (!hardest || cands.length < hardestCands.length) { hardest = slot; hardestCands = cands; }
  }
  if (!coveragePossible(state)) return FAIL;

  for (const emp of rank(hardestCands, hardest, state)) {
    state.stats.tries++;
    assign(state, emp, hardest);
    const result = search(state, deadline);
    if (result !== FAIL) return result;
    unassign(state, emp, hardest);
    state.stats.undos++;
  }
  return FAIL;
}

// Fallback: hardest-first, never undo, report gaps
function greedy(state) {
  const gaps = [];
  const initial = new Map(state.slots.map(s => [s.id, candidatesFor(s, state).length]));
  const order = [...state.slots].sort((a, b) => initial.get(a.id) - initial.get(b.id));

  for (const slot of order) {
    const cands = candidatesFor(slot, state);
    if (cands.length === 0) { gaps.push(`${when(slot.shift.start)} ${slot.pos.cd}: nobody eligible`); continue; }
    assign(state, rank(cands, slot, state)[0], slot);
  }
  return gaps;
}

// ===================== Flexi days =====================

const wholeDay = day => ({ start: (day - 1) * 24, end: day * 24 });
const trySolve = (emps, slots, ctx) => search(createState(emps, slots, ctx), Date.now() + cfg.APPROVAL_LIMIT_MS);

// First come, first served. Approved days become leave in the returned employee list.
function processFlexi(emps, reqs, slots, ctx) {
  let current = emps;
  const used = new Map(reqs.map(r => [r.emp_id, r.used]));
  const decisions = [];
  const baseline = trySolve(current, slots, ctx);

  for (const req of reqs) {
    const emp = current.find(e => e.id === req.emp_id);
    const decide = (status, reason = '') => decisions.push({
      req_id: req.req_id, emp_id: req.emp_id, emp_name: emp?.name ?? null,
      req_date: req.req_date, status, reason,
    });

    if (!emp) { decide('DENIED', 'inactive employee'); continue; }
    if (used.get(emp.id) >= cfg.FLEXI_PER_YEAR) { decide('DENIED', 'no flexi days left this year'); continue; }
    if (baseline !== SOLVED) { decide('DEFERRED', 'roster has gaps even without this request'); continue; }

    const trial = current.map(e => (e.id === emp.id ? { ...e, leave: [...e.leave, wholeDay(req.day)] } : e));
    const status = trySolve(trial, slots, ctx);

    if (status === SOLVED) {
      current = trial;
      used.set(emp.id, used.get(emp.id) + 1);
      decide('APPROVED');
    } else if (status === FAIL) decide('DENIED', 'shifts could not be covered');
    else decide('REVIEW', 'check timed out');
  }
  return { emps: current, decisions };
}

// ===================== Entry points =====================

function solve(p) {
  const emps = p.emps.map(e => ({ ...e, quals: new Set(e.quals) }));
  const slots = buildSlots(p);
  const ctx = { segments: buildSegments(slots), covRules: p.covRules };

  const flexi = processFlexi(emps, p.reqs, slots, ctx);

  const t0 = Date.now();
  let state = createState(flexi.emps, slots, ctx);
  const status = search(state, t0 + cfg.TIME_LIMIT_MS);
  const stats = state.stats;

  let gaps = [];
  if (status !== SOLVED) {
    state = createState(flexi.emps, slots, ctx);
    gaps = greedy(state);
  }
  gaps.push(...coverageGaps(state));

  return {
    status, stats, ms: Date.now() - t0, usedFallback: status !== SOLVED,
    decisions: flexi.decisions,
    gaps,
    roster: slots.map(s => {
      const emp = state.assignment.get(s.id);
      return { posId: s.pos.id, start: s.shift.start, end: s.shift.end, tags: s.shift.tags, empId: emp?.id ?? null };
    }),
    people: state.emps.map(e => ({
      emp_id: e.id, emp_name: e.name, hours: hoursOf(state, e), points: pointsOf(state, e),
    })),
  };
}

// Run solve() in a worker so the API stays responsive
function solveInWorker(problem) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: problem });
    const maxMs = cfg.TIME_LIMIT_MS + cfg.APPROVAL_LIMIT_MS * (problem.reqs.length + 1) + 2000;
    const kill = setTimeout(() => worker.terminate(), maxMs); // safety net
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => {
      clearTimeout(kill);
      reject(new Error(`solver exited (${code}) without a result`)); // no-op if already resolved
    });
  });
}

// When loaded as a worker: solve and send the result back
if (!isMainThread) parentPort.postMessage(solve(workerData));

module.exports = { solve, solveInWorker };
