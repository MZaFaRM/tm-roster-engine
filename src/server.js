const express = require("express");
const cfg = require("./config");
const db = require("./db");
const { solveInWorker } = require("./engine");
const { fail, isDate, isLocalTime, toId } = require("./utils");
const { route, errorHandler } = require("./middleware");
const swaggerDocs = require("./swagger");

const app = express();
app.use(express.json());
app.use("/docs", ...swaggerDocs);

app.get("/health", (req, res) => res.json({ ok: true }));

// Employees
app.get(
	"/employees",
	route(async (req, res) => res.json(await db.listEmployees())),
);
app.post(
	"/employees",
	route(async (req, res) => {
		const { name, quals = [] } = req.body ?? {};
		if (!name) throw fail(400, "name is required");
		if (!Array.isArray(quals)) throw fail(400, "quals must be an array");
		res.status(201).json(await db.createEmployee(name, quals));
	}),
);

// Leave (site-local "YYYY-MM-DD HH:MM")
app.get(
	"/leave",
	route(async (req, res) =>
		res.json(
			await db.listLeave(req.query.empId ? toId(req.query.empId) : null),
		),
	),
);
app.post(
	"/leave",
	route(async (req, res) => {
		const { empId, startAt, endAt } = req.body ?? {};
		if (!isLocalTime(startAt) || !isLocalTime(endAt)) {
			throw fail(
				400,
				'startAt and endAt must be "YYYY-MM-DD HH:MM" in site time',
			);
		}
		res.status(201).json(await db.createLeave(toId(empId), startAt, endAt));
	}),
);

// Flexi requests
app.get(
	"/flexi-requests",
	route(async (req, res) =>
		res.json(await db.listFlexiReqs(req.query.status ?? null)),
	),
);
app.post(
	"/flexi-requests",
	route(async (req, res) => {
		const { empId, date } = req.body ?? {};
		if (!isDate(date)) throw fail(400, "date must be YYYY-MM-DD");
		res.status(201).json(await db.createFlexiReq(toId(empId), date));
	}),
);

// Rosters
app.get(
	"/rosters",
	route(async (req, res) => res.json(await db.listRuns())),
);
app.post(
	"/rosters",
	route(async (req, res) => {
		const { startDate, days = 7, replace = false } = req.body ?? {};
		if (!isDate(startDate)) throw fail(400, "startDate must be YYYY-MM-DD");
		if (!Number.isInteger(days) || days < 1 || days > cfg.MAX_DAYS) {
			throw fail(
				400,
				`days must be an integer from 1 to ${cfg.MAX_DAYS}`,
			);
		}
		if (typeof replace !== "boolean")
			throw fail(400, "replace must be a boolean");

		// one roster per period. Same period can be replaced; a different overlapping period cannot.
		const clashes = await db.findOverlappingRuns(startDate, days);
		if (clashes.length) {
			const samePeriod = clashes.every(
				(r) => r.period_start === startDate && r.days === days,
			);
			if (!samePeriod) {
				const c = clashes.find(
					(r) => r.period_start !== startDate || r.days !== days,
				);
				throw fail(
					409,
					`period overlaps roster run ${c.run_id} (${c.period_start}, ${c.days} days)`,
				);
			}
			if (!replace) {
				throw fail(
					409,
					`a roster already exists for this period (run ${clashes[0].run_id}); send replace: true to regenerate`,
				);
			}
		}

		const problem = await db.loadProblem(startDate, days);
		const result = await solveInWorker(problem);
		const runId = await db.saveRun(
			problem,
			result,
			clashes.map((r) => r.run_id),
		);
		const run = await db.getRun(runId);

		res.status(201).json({
			...run,
			replaced_run_ids: clashes.map((r) => r.run_id),
			stats: result.stats,
			flexi_decisions: result.decisions,
			people: result.people,
		});
	}),
);

app.get(
	"/rosters/:id",
	route(async (req, res) => {
		const run = await db.getRun(toId(req.params.id));
		if (!run) throw fail(404, "roster not found");
		res.json(run);
	}),
);

// Errors & Boot
app.use(errorHandler);

app.listen(cfg.PORT, () =>
	console.log(`Roster API on http://localhost:${cfg.PORT}`),
);
