import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ipToInt, parseRangeSpec, parseRanges, tagsForIp } from '../src/ipranges.js';

test('ipToInt parses valid IPv4 and rejects junk', () => {
  assert.equal(ipToInt('0.0.0.0'), 0);
  assert.equal(ipToInt('255.255.255.255'), 4294967295);
  assert.equal(ipToInt('134.76.10.5'), ((134 * 256 + 76) * 256 + 10) * 256 + 5);
  assert.equal(ipToInt('134.76.10'), null); // too few octets
  assert.equal(ipToInt('256.0.0.1'), null); // octet out of range
  assert.equal(ipToInt('a.b.c.d'), null);
});

test('parseRangeSpec accepts CIDR and octet prefixes', () => {
  // "134.76" is a /16 prefix => base 134.76.0.0
  assert.deepEqual(parseRangeSpec('134.76'), parseRangeSpec('134.76.0.0/16'));
  // "10" is a /8
  assert.deepEqual(parseRangeSpec('10'), parseRangeSpec('10.0.0.0/8'));
  // "192.168.1" is a /24
  assert.deepEqual(parseRangeSpec('192.168.1'), parseRangeSpec('192.168.1.0/24'));
  // base is normalised to the network address
  assert.deepEqual(parseRangeSpec('134.76.5.9/16'), parseRangeSpec('134.76.0.0/16'));
  assert.equal(parseRangeSpec('not-an-ip'), null);
  assert.equal(parseRangeSpec('10.0.0.0/33'), null);
  assert.equal(parseRangeSpec(''), null);
});

test('parseRanges ignores comments/blanks and reads "range: tag"', () => {
  const text = [
    '# a comment',
    '',
    '134.76: GWDG',
    '10.0.0.0/8: intern   # trailing comment',
    'garbage line without colon',
    'bad/99: nope',
    '192.168.0.0/16:LAN',
  ].join('\n');
  const ranges = parseRanges(text);
  assert.equal(ranges.length, 3);
  assert.deepEqual(
    ranges.map((r) => r.label),
    ['GWDG', 'intern', 'LAN']
  );
});

test('tagsForIp matches the GWDG /16 and nothing outside it', () => {
  const ranges = parseRanges('134.76: GWDG');
  assert.deepEqual(tagsForIp('134.76.10.5', ranges), ['GWDG']);
  assert.deepEqual(tagsForIp('134.76.255.255', ranges), ['GWDG']);
  assert.deepEqual(tagsForIp('134.77.0.1', ranges), []); // just outside /16
  assert.deepEqual(tagsForIp('8.8.8.8', ranges), []);
  assert.deepEqual(tagsForIp('not-an-ip', ranges), []);
});

test('tagsForIp returns multiple distinct tags for overlapping ranges', () => {
  const ranges = parseRanges(['134.76: GWDG', '134.76.10.0/24: Goettingen', '134.76: GWDG'].join('\n'));
  assert.deepEqual(tagsForIp('134.76.10.7', ranges), ['GWDG', 'Goettingen']);
  assert.deepEqual(tagsForIp('134.76.11.7', ranges), ['GWDG']); // outside the /24
});
