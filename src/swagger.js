const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const swaggerUi = require("swagger-ui-express");

const spec = YAML.parse(
	fs.readFileSync(path.join(__dirname, "..", "openapi.yaml"), "utf8"),
);

module.exports = [swaggerUi.serve, swaggerUi.setup(spec)];
