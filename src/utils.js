// Creates standard error objects
const fail = (status, message) => Object.assign(new Error(message), { status });

// Date/Time validators
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isLocalTime = (s) =>
	typeof s === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(s);

// ID parser
const toId = (v) => {
	const n = Number(v);
	if (!Number.isInteger(n) || n < 1) throw fail(400, "invalid id");
	return n;
};

module.exports = {
	fail,
	isDate,
	isLocalTime,
	toId,
};
