const test = require('node:test');
const assert = require('node:assert');
const { parseExplicitHostSelection, parseStageSelection, shouldRunReconcile } = require('../orchestrator');

test('parseExplicitHostSelection: absent flags mean no explicit filter', () => {
    assert.deepEqual(parseExplicitHostSelection({}), {
        hostFilter: undefined,
        hostIds: undefined,
        explicitFilter: false,
    });
});

test('parseExplicitHostSelection: invalid host-ids still counts as explicit empty filter', () => {
    assert.deepEqual(parseExplicitHostSelection({ 'host-ids': 'foo,bar' }), {
        hostFilter: undefined,
        hostIds: [],
        explicitFilter: true,
    });
});

test('parseExplicitHostSelection: empty hosts still counts as explicit empty filter', () => {
    assert.deepEqual(parseExplicitHostSelection({ hosts: '' }), {
        hostFilter: [],
        hostIds: undefined,
        explicitFilter: true,
    });
});

test('parseStageSelection: default stages are 1,2,3 without inline reconcile', () => {
    assert.deepEqual(parseStageSelection(undefined), {
        stages: ['1', '2', '3'],
        runInlineReconcile: false,
        runStage1: true,
        runStage2: true,
        runStage3: true,
    });
});

test('parseStageSelection: stage 2,3 does not force reconcile', () => {
    assert.deepEqual(parseStageSelection('2,3'), {
        stages: ['2', '3'],
        runInlineReconcile: false,
        runStage1: false,
        runStage2: true,
        runStage3: true,
    });
});

test('parseStageSelection: reconcile must be explicitly requested', () => {
    assert.deepEqual(parseStageSelection('reconcile,3'), {
        stages: ['reconcile', '3'],
        runInlineReconcile: true,
        runStage1: false,
        runStage2: false,
        runStage3: true,
    });
});

// shouldRunReconcile — gates the reconcile prelude before stages 1/2/3.
// True = run reconcile; false = skip.

test('shouldRunReconcile: stage 3 only in auto mode → skip (original gate)', () => {
    assert.equal(shouldRunReconcile(parseStageSelection('3'), {}), false);
});

test('shouldRunReconcile: stage 3 only in manual mode → skip', () => {
    assert.equal(shouldRunReconcile(parseStageSelection('3'), { ACCEPT_MODE: 'manual' }), false);
});

test('shouldRunReconcile: stage 2 only in auto mode → run (host-authoritative needs it)', () => {
    assert.equal(shouldRunReconcile(parseStageSelection('2'), {}), true);
});

test('shouldRunReconcile: stage 2 only in manual mode → skip', () => {
    assert.equal(shouldRunReconcile(parseStageSelection('2'), { ACCEPT_MODE: 'manual' }), false);
});

test('shouldRunReconcile: stage 2+3 in manual mode → skip', () => {
    assert.equal(shouldRunReconcile(parseStageSelection('2,3'), { ACCEPT_MODE: 'manual' }), false);
});

test('shouldRunReconcile: stage 2+3 in auto mode → run', () => {
    assert.equal(shouldRunReconcile(parseStageSelection('2,3'), {}), true);
});

test('shouldRunReconcile: stage 1+2+3 in manual mode → run (stage 1 needs capacity)', () => {
    assert.equal(shouldRunReconcile(parseStageSelection('1,2,3'), { ACCEPT_MODE: 'manual' }), true);
});

test('shouldRunReconcile: stage 1+2 in manual mode → run (stage 1 needs capacity)', () => {
    assert.equal(shouldRunReconcile(parseStageSelection('1,2'), { ACCEPT_MODE: 'manual' }), true);
});

test('shouldRunReconcile: stage 1 only in manual mode → run', () => {
    assert.equal(shouldRunReconcile(parseStageSelection('1'), { ACCEPT_MODE: 'manual' }), true);
});

test('shouldRunReconcile: ACCEPT_MODE is case-insensitive', () => {
    assert.equal(shouldRunReconcile(parseStageSelection('2'), { ACCEPT_MODE: 'MANUAL' }), false);
    assert.equal(shouldRunReconcile(parseStageSelection('2'), { ACCEPT_MODE: 'Manual' }), false);
});

test('shouldRunReconcile: ACCEPT_MODE=auto or unset behaves the same', () => {
    assert.equal(shouldRunReconcile(parseStageSelection('2'), { ACCEPT_MODE: 'auto' }), true);
    assert.equal(shouldRunReconcile(parseStageSelection('2'), {}), true);
});

test('shouldRunReconcile: explicit reconcile token always wins', () => {
    assert.equal(shouldRunReconcile(parseStageSelection('reconcile,3'), { ACCEPT_MODE: 'manual' }), true);
    assert.equal(shouldRunReconcile(parseStageSelection('reconcile,2'), { ACCEPT_MODE: 'manual' }), true);
    assert.equal(shouldRunReconcile(parseStageSelection('reconcile,2,3'), { ACCEPT_MODE: 'manual' }), true);
});
