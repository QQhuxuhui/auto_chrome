const test = require('node:test');
const assert = require('node:assert');
const { parseExplicitHostSelection, parseStageSelection } = require('../orchestrator');

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
