const { generateJwtSecret } = require('../src/config/validateEnv');

console.log(generateJwtSecret());
