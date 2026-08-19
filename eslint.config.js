const base = require("@aca/eslint-config/base.js");
const { moduleBoundaries } = require("@aca/eslint-config/module-boundaries");

module.exports = [...base, moduleBoundaries()];
