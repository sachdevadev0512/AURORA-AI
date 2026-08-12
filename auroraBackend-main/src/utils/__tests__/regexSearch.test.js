const {
  escapeRegexLiteral,
  buildCaseInsensitiveRegex,
  buildExactCaseInsensitiveRegex,
  buildMongoRegexFilter,
  normalizeSearchInput,
} = require('../regexSearch');

test('escapeRegexLiteral treats user input as a literal substring', () => {
  expect(escapeRegexLiteral('(a+)+$')).toBe('\\(a\\+\\)\\+\\$');
  expect('hello (a+)+ world'.match(new RegExp(escapeRegexLiteral('(a+)+'), 'i'))).toBeTruthy();
});

test('buildCaseInsensitiveRegex does not allow broad wildcard injection', () => {
  const regex = buildCaseInsensitiveRegex('.*');
  expect('anything').not.toMatch(regex);
  expect('.*').toMatch(regex);
});

test('buildExactCaseInsensitiveRegex anchors the full value', () => {
  const regex = buildExactCaseInsensitiveRegex('A1B2C3');
  expect('A1B2C3').toMatch(regex);
  expect('prefix-A1B2C3').not.toMatch(regex);
});

test('normalizeSearchInput trims and caps length', () => {
  expect(normalizeSearchInput('  abc  ')).toBe('abc');
  expect(normalizeSearchInput('x'.repeat(250))).toHaveLength(200);
});

test('buildMongoRegexFilter escapes special characters', () => {
  expect(buildMongoRegexFilter('(test)')).toEqual({
    $regex: '\\(test\\)',
    $options: 'i',
  });
});
