module.exports = {
  PORT: Number(process.env.PORT) || 3000,
  SITE_TZ: process.env.SITE_TZ || 'Asia/Dubai',
  MAX_DAYS: 31,

  MIN_REST_HOURS: 12,
  TIME_LIMIT_MS: 5000,          // main search
  APPROVAL_LIMIT_MS: 1000,      // each flexi check
  FLEXI_PER_YEAR: 2,

  WEEKEND_ISO_DAYS: [6, 7],     // Saturday, Sunday
  NIGHT: { from: 22, to: 6 },
  POINTS: { N: 1, W: 1, H: 2 }, // night, weekend, holiday
  HOURS_PER_POINT: 4,           // each unpopular point counts like 4 extra hours
};
