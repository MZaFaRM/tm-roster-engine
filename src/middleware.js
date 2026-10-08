// Async wrapper to pass errors to Express's next()
const route = (fn) => (req, res, next) =>
	Promise.resolve(fn(req, res)).catch(next);

// Global error handler
const errorHandler = (err, req, res, next) => {
	// 22xxx / 23xxx = Postgres bad data / constraint violation
	const status = err.status ?? (/^(22|23)/.test(err.code ?? "") ? 400 : 500);
	if (status === 500) console.error(err);
	res.status(status).json({ error: err.message });
};

module.exports = {
	route,
	errorHandler,
};
