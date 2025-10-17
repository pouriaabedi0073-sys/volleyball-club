const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'sync-hybrid.js');
const src = fs.readFileSync(file, 'utf8');

function isIdentifierChar(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

const results = [];

// find occurrences of 'try' where it's a keyword (not part of identifier)
for (let i = 0; i < src.length; i++) {
  if (src.slice(i, i+3) === 'try') {
    const before = src[i-1] || '';
    const after = src[i+3] || '';
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) {
      // found try keyword
      // skip whitespace and comments to find following '{'
      let j = i+3;
      while (j < src.length) {
        const ch = src[j];
        if (/\s/.test(ch)) { j++; continue; }
        // handle single-line comments
        if (src.slice(j, j+2) === '//') { j = src.indexOf('\n', j+2); if (j === -1) j = src.length; continue; }
        // handle block comments
        if (src.slice(j, j+2) === '/*') { j = src.indexOf('*/', j+2); if (j === -1) { j = src.length; break; } j += 2; continue; }
        break;
      }
      const nextCh = src[j];
      if (nextCh !== '{') {
        // it's a try without block? record
        results.push({pos:i, reason: 'no { after try', index: i});
        continue;
      }
      // find matching closing brace for this try's block
      let k = j;
      let stack = [];
      for (; k < src.length; k++) {
        const ch = src[k];
        // naive: ignore strings and regex and template literals and comments
        if (src.slice(k, k+2) === '//') { k = src.indexOf('\n', k+2); if (k === -1) { k = src.length; break; } continue; }
        if (src.slice(k, k+2) === '/*') { k = src.indexOf('*/', k+2); if (k === -1) { k = src.length; break; } k += 2; continue; }
        if (ch === '"' || ch === "'") {
          const quote = ch;
          k++;
          while (k < src.length) {
            if (src[k] === '\\') { k += 2; continue; }
            if (src[k] === quote) { break; }
            k++;
          }
          continue;
        }
        if (ch === '`') {
          k++;
          while (k < src.length) {
            if (src[k] === '\\') { k += 2; continue; }
            if (src[k] === '`') { break; }
            k++;
          }
          continue;
        }
        if (ch === '{') { stack.push('{'); continue; }
        if (ch === '}') { stack.pop(); if (stack.length === 0) break; continue; }
      }
      if (k >= src.length) {
        results.push({pos:i, reason: 'could not find matching }', index: i});
        continue;
      }
      // now k is index of matching '}' for the try block
      // find next non-whitespace/comment token after k
      let m = k+1;
      while (m < src.length) {
        const ch = src[m];
        if (/\s/.test(ch)) { m++; continue; }
        if (src.slice(m, m+2) === '//') { m = src.indexOf('\n', m+2); if (m === -1) m = src.length; continue; }
        if (src.slice(m, m+2) === '/*') { m = src.indexOf('*/', m+2); if (m === -1) { m = src.length; break; } m += 2; continue; }
        break;
      }
      const nextWordMatch = src.slice(m, m+10).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      const nextWord = nextWordMatch ? nextWordMatch[1] : null;
      if (nextWord !== 'catch' && nextWord !== 'finally') {
        // record line/col info
        const before = src.slice(0, i);
        const line = before.split('\n').length;
        const col = i - before.lastIndexOf('\n') - 1;
        results.push({pos:i, line, col, reason: 'missing catch/finally after try (block ends at '+k+')', blockEnd:k, nextWord});
      }
    }
  }
}

if (results.length === 0) {
  console.log('No problematic try blocks found');
  process.exit(0);
}
console.log('Found possible issues:');
results.forEach(r => {
  console.log(`- at pos ${r.pos} (line ${r.line}, col ${r.col}): ${r.reason}` + (r.nextWord ? (', next token: '+r.nextWord) : ''));
});
process.exit(0);
