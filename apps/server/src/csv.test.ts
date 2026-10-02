/**
 * Unit tests for the P1 dataset CSV/JSON import parser (apps/server/src/csv.ts).
 * Run: npx tsx --test apps/server/src/csv.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DatasetParseError,
  parseCsvDataset,
  parseCsvMatrix,
  parseDatasetImport,
  parseJsonDataset,
} from './csv.js';

describe('parseCsvMatrix (RFC-4180 minimal)', () => {
  it('parses simple rows + CRLF + trailing newline', () => {
    assert.deepEqual(parseCsvMatrix('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsvMatrix('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  });

  it('handles quoted commas', () => {
    assert.deepEqual(parseCsvMatrix('name,city\n"Doe, Jane",Hanoi\n'), [
      ['name', 'city'],
      ['Doe, Jane', 'Hanoi'],
    ]);
  });

  it('handles doubled-quote escapes', () => {
    assert.deepEqual(parseCsvMatrix('q\n"He said ""hi"""\n'), [['q'], ['He said "hi"']]);
  });

  it('handles embedded newlines inside quoted fields (LF + CRLF)', () => {
    assert.deepEqual(parseCsvMatrix('a,b\n"l1\nl2",x\n'), [['a', 'b'], ['l1\nl2', 'x']]);
    assert.deepEqual(parseCsvMatrix('a,b\r\n"l1\r\nl2",x\r\n'), [['a', 'b'], ['l1\r\nl2', 'x']]);
  });

  it('rejects unterminated quoted fields explicitly', () => {
    assert.throws(() => parseCsvMatrix('a\n"oops\n'), DatasetParseError);
  });

  it('strips BOM and skips blank lines', () => {
    assert.deepEqual(parseCsvMatrix('\uFEFFa,b\n\n1,2\n\n'), [['a', 'b'], ['1', '2']]);
  });
});

describe('parseCsvDataset', () => {
  it('maps header row to record rows', () => {
    assert.deepEqual(parseCsvDataset('EMAIL,CITY\na@x.com,Hanoi\nb@x.com,Saigon\n'), [
      { EMAIL: 'a@x.com', CITY: 'Hanoi' },
      { EMAIL: 'b@x.com', CITY: 'Saigon' },
    ]);
  });

  it('pads short rows with empty strings', () => {
    assert.deepEqual(parseCsvDataset('A,B\n1\n'), [{ A: '1', B: '' }]);
  });

  it('rejects empty content; header-only yields zero rows (route rejects it)', () => {
    assert.throws(() => parseCsvDataset(''), DatasetParseError);
    // Zero data rows is a valid parse result; the import ROUTE rejects it
    // with "no data rows found" (covered by the integration test).
    assert.deepEqual(parseCsvDataset('A,B\n'), []);
    assert.deepEqual(parseDatasetImport('csv', 'A,B\n'), []);
  });

  it('rejects invalid / duplicate / empty column names explicitly', () => {
    assert.throws(() => parseCsvDataset('A,Has Space\n1,2\n'), /invalid column/);
    assert.throws(() => parseCsvDataset('A,A\n1,2\n'), /duplicate/);
    assert.throws(() => parseCsvDataset('A,\n1,2\n'), /empty column/);
  });
});

describe('parseJsonDataset', () => {
  it('accepts arrays of flat objects, coerces scalars', () => {
    assert.deepEqual(parseJsonDataset('[{"A":"x","N":3,"B":true,"Z":null}]'), [
      { A: 'x', N: '3', B: 'true', Z: '' },
    ]);
  });

  it('fills missing keys with empty strings', () => {
    assert.deepEqual(parseJsonDataset('[{"A":"1"},{"A":"2","B":"b"}]'), [
      { A: '1', B: '' },
      { A: '2', B: 'b' },
    ]);
  });

  it('rejects non-arrays, non-objects, nested values', () => {
    assert.throws(() => parseJsonDataset('{"A":1}'), /top-level array/);
    assert.throws(() => parseJsonDataset('[1]'), /only row objects/);
    assert.throws(() => parseJsonDataset('[]'), /empty/);
    assert.throws(() => parseJsonDataset('[{"A":{"x":1}}]'), /nested objects/);
    assert.throws(() => parseJsonDataset('not json'), /array of objects/);
  });

  it('rejects bad column names like CSV', () => {
    assert.throws(() => parseJsonDataset('[{"Has Space":1}]'), /invalid column/);
  });
});
