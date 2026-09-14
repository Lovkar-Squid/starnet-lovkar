/* lovkar/scrub-fixture.js — make a stream-json dump safe to commit.

   Claude Code's system/init line carries real paths from the machine that produced it
   (memory_paths, powershell_path, the shell snapshot dir …). A raw dump therefore leaks the
   OS username into a public repo. Fixtures are worth checking in — they are the only honest
   test input for the translator — so scrub them instead of leaving them out.

   Replaces the user's home directory with a placeholder and nothing else, so the file stays
   byte-identical everywhere the tests actually look.

   Run:  node lovkar/scrub-fixture.js <in.jsonl> <out.jsonl>
         node lovkar/scrub-fixture.js --check <file.jsonl>   (report only, exit 1 if dirty)
*/
'use strict';
const fs = require('fs');

// JSON-escaped (\\) and raw (\) spellings of a Windows user dir, plus POSIX homes.
// The (?!USER) / (?!user\\b) guards make this IDEMPOTENT: a second pass matches nothing,
// so --check can reuse the same patterns instead of drifting out of sync with them.
const PATTERNS = [
  [/[A-Za-z]:\\\\Users\\\\(?!USER)[^\\"\/]+/g, 'C:\\\\Users\\\\USER'],
  [/[A-Za-z]:\\Users\\(?!USER)[^\\"\/]+/g,     'C:\\Users\\USER'],
  [/\/(?:home|Users)\/(?!user\\b)[A-Za-z0-9_.-]+/g, '/home/user']
];

const checkOnly = process.argv[2] === '--check';
const inPath = checkOnly ? process.argv[3] : process.argv[2];
const outPath = checkOnly ? null : process.argv[3];
if (!inPath || (!checkOnly && !outPath)) {
  console.error('usage: node lovkar/scrub-fixture.js <in.jsonl> <out.jsonl>\n       node lovkar/scrub-fixture.js --check <file.jsonl>');
  process.exit(2);
}

const src = fs.readFileSync(inPath, 'utf8');
let out = src;
let total = 0;
for (const [re, rep] of PATTERNS) {
  const hits = src.match(re);
  if (hits) total += hits.length;
  out = out.replace(re, rep);
}

if (checkOnly) {
  if (total) { console.error('✗ ' + inPath + ': ' + total + ' home-path occurrence(s) still present'); process.exit(1); }
  console.log('✓ ' + inPath + ': clean'); process.exit(0);
}

// the scrub must not change the line count or break any line's JSON
const a = src.split(/\r?\n/).filter(l => l.trim()).length;
const b = out.split(/\r?\n/).filter(l => l.trim()).length;
if (a !== b) { console.error('✗ line count changed ' + a + ' -> ' + b + ', refusing'); process.exit(1); }
let bad = 0;
for (const line of out.split(/\r?\n/)) { if (!line.trim()) continue; try { JSON.parse(line); } catch (e) { bad++; } }
if (bad) { console.error('✗ ' + bad + ' line(s) no longer parse as JSON, refusing'); process.exit(1); }

fs.writeFileSync(outPath, out);
console.log('✓ ' + outPath + ': ' + total + ' occurrence(s) scrubbed, ' + b + ' lines intact');
