// All database access. Times go into the engine as hours from local midnight of day 1.
const { Pool } = require("pg");
const cfg = require("./config");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const rows = (sql, params) => pool.query(sql, params).then((r) => r.rows);

async function tx(fn) {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const out = await fn(client);
		await client.query("COMMIT");
		return out;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

// - Employees -

const EMP_SQL = `
  SELECT e.emp_id, e.emp_name, e.active,
         COALESCE(array_agg(q.qual_cd ORDER BY q.qual_cd)
                  FILTER (WHERE q.qual_cd IS NOT NULL), '{}') AS quals
    FROM md_emp e LEFT JOIN md_emp_qual q USING (emp_id)`;

const listEmployees = () =>
	rows(`${EMP_SQL} GROUP BY e.emp_id ORDER BY e.emp_id`);

const createEmployee = (name, quals) =>
	tx(async (c) => {
		const {
			rows: [emp],
		} = await c.query(
			`INSERT INTO md_emp (emp_name) VALUES ($1) RETURNING emp_id`,
			[name],
		);
		if (quals.length) {
			await c.query(
				`INSERT INTO md_emp_qual (emp_id, qual_cd) SELECT $1, unnest($2::text[])`,
				[emp.emp_id, quals],
			);
		}
		const {
			rows: [full],
		} = await c.query(`${EMP_SQL} WHERE e.emp_id = $1 GROUP BY e.emp_id`, [
			emp.emp_id,
		]);
		return full;
	});

// - Leave (input/output in site-local time) -

const listLeave = (empId) =>
	rows(
		`
  SELECT leave_id, emp_id, leave_type,
         to_char(start_at AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS start_local,
         to_char(end_at   AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS end_local
    FROM td_leave
   WHERE $2::int IS NULL OR emp_id = $2
   ORDER BY start_at`,
		[cfg.SITE_TZ, empId],
	);

const createLeave = (empId, startLocal, endLocal) =>
	rows(
		`
  INSERT INTO td_leave (emp_id, start_at, end_at)
  VALUES ($1, $2::timestamp AT TIME ZONE $4, $3::timestamp AT TIME ZONE $4)
  RETURNING leave_id`,
		[empId, startLocal, endLocal, cfg.SITE_TZ],
	).then((r) => r[0]);

// - Flexi requests -

const listFlexiReqs = (status) =>
	rows(
		`
  SELECT r.req_id, r.emp_id, e.emp_name, r.req_date::text AS req_date,
         r.status, r.reason, r.submitted_at
    FROM td_flexi_req r JOIN md_emp e USING (emp_id)
   WHERE $1::text IS NULL OR r.status = $1
   ORDER BY r.submitted_at, r.req_id`,
		[status],
	);

const createFlexiReq = (empId, date) =>
	rows(
		`
  INSERT INTO td_flexi_req (emp_id, req_date) VALUES ($1, $2)
  RETURNING req_id, status`,
		[empId, date],
	).then((r) => r[0]);

// - Engine input -

async function loadProblem(startDate, days) {
	const p = [startDate, days];
	const [
		emps,
		shiftTmpls,
		positions,
		covRules,
		leave,
		special,
		reqs,
		neighbours,
	] = await Promise.all([
		rows(`${EMP_SQL} WHERE e.active GROUP BY e.emp_id ORDER BY e.emp_id`),

		rows(
			`SELECT shift_cd, start_hour, len_hours FROM md_shift_tmpl ORDER BY start_hour`,
		),

		rows(`SELECT p.pos_id, p.pos_cd,
                 COALESCE(array_agg(q.qual_cd) FILTER (WHERE q.qual_cd IS NOT NULL), '{}') AS quals
            FROM md_pos p LEFT JOIN md_pos_qual q USING (pos_id)
           GROUP BY p.pos_id ORDER BY p.pos_id`),

		rows(`SELECT qual_cd, min_cnt FROM md_cov_rule`),

		// Leave overlapping the period, as hours from period start
		rows(
			`WITH t AS (SELECT ($1::date)::timestamp AT TIME ZONE $3 AS t0)
          SELECT l.emp_id,
                 EXTRACT(EPOCH FROM (l.start_at - t.t0)) / 3600 AS start_h,
                 EXTRACT(EPOCH FROM (l.end_at   - t.t0)) / 3600 AS end_h
            FROM td_leave l, t
           WHERE l.start_at < t.t0 + make_interval(days => $2::int) AND l.end_at > t.t0`,
			[...p, cfg.SITE_TZ],
		),

		// Which day numbers (1 = first day) are weekends / holidays
		rows(
			`SELECT d AS day,
                 EXTRACT(ISODOW FROM $1::date + d - 1) = ANY($3::int[]) AS is_weekend,
                 EXISTS (SELECT 1 FROM md_holiday h WHERE h.hol_date = $1::date + d - 1) AS is_holiday
            FROM generate_series(1, $2::int) d`,
			[...p, cfg.WEEKEND_ISO_DAYS],
		),

		// Undecided flexi requests in the period, first come first served.
		// DEFERRED / REVIEW are retried on every run until they get a real decision.
		rows(
			`SELECT r.req_id, r.emp_id, r.req_date::text AS req_date,
                 (r.req_date - $1::date) + 1 AS day,
                 (SELECT count(*)::int FROM td_flexi_req a
                   WHERE a.emp_id = r.emp_id AND a.status = 'APPROVED'
                     AND date_part('year', a.req_date) = date_part('year', r.req_date)) AS used
            FROM td_flexi_req r
           WHERE r.status IN ('PENDING', 'DEFERRED', 'REVIEW')
             AND r.req_date >= $1::date AND r.req_date < $1::date + $2::int
           ORDER BY r.submitted_at, r.req_id`,
			p,
		),

		rows(
			`WITH t AS (SELECT ($1::date)::timestamp AT TIME ZONE $3 AS t0),
              near AS (
                (SELECT run_id FROM td_roster_run
                  WHERE period_start <= $1::date - 1 AND period_start + days > $1::date - 1
                  ORDER BY run_id DESC LIMIT 1)
                UNION
                (SELECT run_id FROM td_roster_run
                  WHERE period_start <= $1::date + $2::int AND period_start + days > $1::date + $2::int
                  ORDER BY run_id DESC LIMIT 1))
          SELECT a.emp_id,
                 EXTRACT(EPOCH FROM (a.start_at - t.t0)) / 3600 AS start_h,
                 EXTRACT(EPOCH FROM (a.end_at   - t.t0)) / 3600 AS end_h
            FROM td_assign a, t
           WHERE a.run_id IN (SELECT run_id FROM near)
             AND a.end_at   > t.t0 - make_interval(hours => $4::int)
             AND a.start_at < t.t0 + make_interval(days => $2::int, hours => $4::int)`,
			[...p, cfg.SITE_TZ, cfg.MIN_REST_HOURS],
		),
	]);

	const byId = new Map(
		emps.map((e) => [
			e.emp_id,
			{
				id: e.emp_id,
				name: e.emp_name,
				quals: e.quals,
				leave: [],
				neighbours: [],
			},
		]),
	);
	for (const l of leave)
		byId.get(l.emp_id)?.leave.push({
			start: Number(l.start_h),
			end: Number(l.end_h),
		});

	for (const a of neighbours)
		byId.get(a.emp_id)?.neighbours.push({
			start: Number(a.start_h),
			end: Number(a.end_h),
		});

	return {
		startDate,
		days,
		emps: [...byId.values()],
		shiftTmpls,
		positions: positions.map((r) => ({
			id: r.pos_id,
			cd: r.pos_cd,
			quals: r.quals,
		})),
		covRules: covRules.map((r) => ({ qual: r.qual_cd, min: r.min_cnt })),
		special: {
			weekendDays: special.filter((r) => r.is_weekend).map((r) => r.day),
			holidayDays: special.filter((r) => r.is_holiday).map((r) => r.day),
		},
		reqs,
	};
}

// - Engine output -

const saveRun = (problem, result, replaceIds = []) =>
	tx(async (c) => {
		if (replaceIds.length) {
			// CASCADE removes their td_assign and td_gap rows
			await c.query(
				`DELETE FROM td_roster_run WHERE run_id = ANY($1::int[])`,
				[replaceIds],
			);
		}

		for (const d of result.decisions) {
			await c.query(
				`UPDATE td_flexi_req SET status = $2, reason = NULLIF($3, ''), decided_at = now() WHERE req_id = $1`,
				[d.req_id, d.status, d.reason],
			);
			if (d.status === "APPROVED") {
				await c.query(
					`INSERT INTO td_leave (emp_id, start_at, end_at, leave_type)
         VALUES ($1, $2::date::timestamp AT TIME ZONE $3, ($2::date + 1)::timestamp AT TIME ZONE $3, 'FLEXI')`,
					[d.emp_id, d.req_date, cfg.SITE_TZ],
				);
			}
		}

		const {
			rows: [run],
		} = await c.query(
			`INSERT INTO td_roster_run (period_start, days, status, used_fallback, duration_ms)
     VALUES ($1, $2, $3, $4, $5) RETURNING run_id`,
			[
				problem.startDate,
				problem.days,
				result.status,
				result.usedFallback,
				result.ms,
			],
		);

		const filled = result.roster.filter((r) => r.empId);
		await c.query(
			`INSERT INTO td_assign (run_id, emp_id, pos_id, start_at, end_at)
     SELECT $1, u.e, u.p, t.t0 + make_interval(hours => u.s), t.t0 + make_interval(hours => u.f)
       FROM unnest($2::int[], $3::int[], $4::int[], $5::int[]) AS u(e, p, s, f),
            (SELECT ($6::date)::timestamp AT TIME ZONE $7 AS t0) AS t`,
			[
				run.run_id,
				filled.map((r) => r.empId),
				filled.map((r) => r.posId),
				filled.map((r) => r.start),
				filled.map((r) => r.end),
				problem.startDate,
				cfg.SITE_TZ,
			],
		);

		if (result.gaps.length) {
			await c.query(
				`INSERT INTO td_gap (run_id, descr) SELECT $1, unnest($2::text[])`,
				[run.run_id, result.gaps],
			);
		}
		return run.run_id;
	});

const findOverlappingRuns = (startDate, days) =>
	rows(
		`SELECT run_id, period_start::text AS period_start, days
       FROM td_roster_run
      WHERE period_start < $1::date + $2::int
        AND period_start + days > $1::date
      ORDER BY run_id`,
		[startDate, days],
	);

const listRuns = () =>
	rows(`
  SELECT run_id, period_start::text AS period_start, days, status, used_fallback, duration_ms, created_at
    FROM td_roster_run ORDER BY run_id DESC`);

async function getRun(runId) {
	const [run] = await rows(
		`
    SELECT run_id, period_start::text AS period_start, days, status, used_fallback, duration_ms, created_at
      FROM td_roster_run WHERE run_id = $1`,
		[runId],
	);
	if (!run) return null;

	const [assignments, gaps] = await Promise.all([
		rows(
			`SELECT to_char(a.start_at AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS start_local,
                 to_char(a.end_at   AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS end_local,
                 p.pos_cd, a.emp_id, e.emp_name
            FROM td_assign a
            JOIN md_emp e ON e.emp_id = a.emp_id
            JOIN md_pos p ON p.pos_id = a.pos_id
           WHERE a.run_id = $1
           ORDER BY a.start_at, p.pos_id`,
			[runId, cfg.SITE_TZ],
		),
		rows(`SELECT descr FROM td_gap WHERE run_id = $1 ORDER BY gap_id`, [
			runId,
		]),
	]);
	return {
		...run,
		time_zone: cfg.SITE_TZ,
		assignments,
		gaps: gaps.map((g) => g.descr),
	};
}

module.exports = {
	pool,
	listEmployees,
	createEmployee,
	listLeave,
	createLeave,
	listFlexiReqs,
	createFlexiReq,
	loadProblem,
	saveRun,
	findOverlappingRuns,
	listRuns,
	getRun,
};
