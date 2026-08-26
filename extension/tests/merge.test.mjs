// Teste mergePagedArray en l'extrayant de extractor.js — pas en la recopiant.
// Une version antérieure d'un test voisin réimplémentait la logique qu'elle
// vérifiait et passait donc avec le bug remis en place ; on ne refait pas ça.
//
// Usage :  node extension/tests/merge.test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, '..', 'extractor.js'), 'utf8');

// ---------- extraire la fonction de la source ----------
const start = SRC.indexOf('function mergePagedArray(');
if (start < 0) { console.error('  ÉCHEC — mergePagedArray introuvable dans extractor.js'); process.exit(1); }
let depth = 0, end = -1;
for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
  if (SRC[i] === '{') depth++;
  else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const mergePagedArray = new Function(SRC.slice(start, end) + '; return mergePagedArray;')();

// ---------- fixtures ----------
const tx = (id, date, bytesPad = 0) => ({
  id: String(id),
  createdAt: date,
  type: 'deposit',
  fromType: 'fireblocks-deposit',
  pad: 'x'.repeat(bytesPad),
});

const BIG = 10_000_000;
let pass = 0; const fails = [];
const check = (c, l) => c ? pass++ : fails.push(l);

// 1. Deux pages disjointes doivent s'additionner — c'est tout l'objet.
{
  const p1 = [tx(3, '2026-03-03'), tx(2, '2026-02-02'), tx(1, '2026-01-01')];
  const p2 = [tx(6, '2026-06-06'), tx(5, '2026-05-05'), tx(4, '2026-04-04')];
  const r = mergePagedArray(p1, p2, (x) => x.id, BIG);
  check(r.merged.length === 6, `2 pages disjointes → 6 (obtenu ${r.merged.length})`);
  check(r.added === 3, `3 nouvelles annoncées (obtenu ${r.added})`);
}

// 2. Une page rechargée ne doit rien dupliquer.
{
  const p1 = [tx(1, '2026-01-01'), tx(2, '2026-02-02')];
  const r = mergePagedArray(p1, p1.slice(), (x) => x.id, BIG);
  check(r.merged.length === 2, `page identique rechargée → 2 (obtenu ${r.merged.length})`);
  check(r.added === 0, `0 nouvelle annoncée (obtenu ${r.added})`);
}

// 3. Le résultat doit être trié par date croissante, quel que soit l'ordre reçu.
{
  const r = mergePagedArray(
    [tx(9, '2026-09-09'), tx(1, '2026-01-01')],
    [tx(5, '2026-05-05')],
    (x) => x.id, BIG);
  const dates = r.merged.map((x) => x.createdAt);
  check(String(dates) === String([...dates].sort()), `trié croissant (obtenu ${dates})`);
}

// 4. Les items sans clé doivent être ignorés, pas faire tomber la fusion.
{
  const r = mergePagedArray([tx(1, '2026-01-01')], [{ createdAt: '2026-02-02' }, tx(2, '2026-02-03')], (x) => x.id, BIG);
  check(r.merged.length === 2, `item sans id ignoré → 2 (obtenu ${r.merged.length})`);
}

// 5. Le budget doit borner, en gardant les PLUS RÉCENTS.
{
  const pad = 2000;
  const older = Array.from({ length: 10 }, (_, i) => tx(100 + i, `2026-01-${String(i + 1).padStart(2, '0')}`, pad));
  const newer = Array.from({ length: 10 }, (_, i) => tx(200 + i, `2026-08-${String(i + 1).padStart(2, '0')}`, pad));
  const budget = 6 * (pad + 200);
  const r = mergePagedArray(older, newer, (x) => x.id, budget);
  check(r.merged.length > 0 && r.merged.length < 20, `budget respecté → borné (obtenu ${r.merged.length}/20)`);
  check(r.merged.every((x) => x.createdAt.startsWith('2026-08')),
        'les jours gardés doivent être les plus récents');
  check(r.dropped === 20 - r.merged.length, `dropped cohérent (${r.dropped})`);
}

// 6. Un item plus gros que le budget entier doit quand même être gardé s'il est
//    seul — sinon on se retrouve avec un tableau vide et plus rien à synchroniser.
{
  const huge = tx(1, '2026-08-01', 50_000);
  const r = mergePagedArray([], [huge], (x) => x.id, 100);
  check(r.merged.length === 1, `item surdimensionné seul → gardé (obtenu ${r.merged.length})`);
}

// 7. Tableau précédent vide ou absent : ne doit pas jeter.
{
  const r1 = mergePagedArray([], [tx(1, '2026-01-01')], (x) => x.id, BIG);
  const r2 = mergePagedArray(null, [tx(1, '2026-01-01')], (x) => x.id, BIG);
  check(r1.merged.length === 1 && r2.merged.length === 1, 'précédent vide/null toléré');
}

const total = pass + fails.length;
if (fails.length) {
  console.error(`\n  ÉCHEC — ${fails.length}/${total} :\n`);
  for (const f of fails) console.error('   ✗ ' + f);
  console.error('');
  process.exit(1);
}
console.log(`\n  OK — ${pass}/${total} vérifications de fusion passent.\n`);
