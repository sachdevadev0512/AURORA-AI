const fs = require('fs');
const path = require('path');
const vm = require('vm');

function getJsFiles(dir) {
  let results = [];
  fs.readdirSync(dir).forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      if (!file.includes('node_modules')) results = results.concat(getJsFiles(filePath));
    } else if (file.endsWith('.js')) {
      results.push(filePath);
    }
  });
  return results;
}

const files = getJsFiles(path.join(__dirname, '../src'));
let errors = 0;
files.forEach(f => {
  try {
    const code = fs.readFileSync(f, 'utf8');
    new vm.Script(code, { filename: f });
  } catch (err) {
    console.error(`Syntax error in ${f}:`, err.message);
    errors++;
  }
});

if (errors > 0) {
  process.exit(1);
} else {
  console.log(`Syntax check passed for ${files.length} files.`);
}
