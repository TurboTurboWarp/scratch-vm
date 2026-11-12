const fs = require('fs');
const path = require('path');
const {test} = require('node:test');
const assert = require('node:assert');
const VM = require('../../src/virtual-machine');
const BlockType = require('../../src/extension-support/block-type');
const ArgumentType = require('../../src/extension-support/argument-type');

const compilerAndInterpreter = (name, callback) => {
    test(`${name} - interpreted`, () => callback({
        enabled: false
    }));
    test(`${name} - compiled`, () => callback({
        enabled: true
    }));
};

const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'tw-hats-and-events.sb3'));

compilerAndInterpreter('hats and events', async co => {
    const vm = new VM();
    vm.setCompilerOptions(co);

    // ttw: list.value references are only valid until the project next operates on the list
    // (spec 03 §3), so always read the current array.
    let getLog = () => [];
    let hatReturns = false;
    class TestExtension {
        getInfo () {
            return {
                id: 'testpredicate',
                name: 'Test Predicate',
                blocks: [
                    {
                        opcode: 'event',
                        blockType: BlockType.EVENT,
                        text: 'event block',
                        isEdgeActivated: false
                    },
                    {
                        opcode: 'hat',
                        blockType: BlockType.HAT,
                        text: 'hat block',
                        isEdgeActivated: false
                    },
                    {
                        opcode: 'complexhat',
                        blockType: BlockType.HAT,
                        text: 'complex hat [MENU] if [INPUT]',
                        isEdgeActivated: false,
                        arguments: {
                            MENU: {
                                menu: 'test'
                            },
                            INPUT: {
                                type: ArgumentType.STRING,
                                defaultValue: 'default'
                            }
                        }
                    },
                    {
                        opcode: 'clickme',
                        blockType: BlockType.HAT,
                        text: 'stack click test [INPUT]',
                        isEdgeActivated: false,
                        arguments: {
                            INPUT: {
                                type: ArgumentType.STRING,
                                defaultValue: 'default'
                            }
                        }
                    }
                ],
                menus: {
                    test: {
                        acceptReporters: false,
                        items: ['a', 'b', 'c']
                    }
                }
            };
        }
        event () {
            getLog().push('this should never run');
        }
        hat () {
            getLog().push(`hat ${hatReturns}`);
            return hatReturns;
        }
        complexhat ({INPUT}) {
            getLog().push(`complex hat ${INPUT}`);
            return !!INPUT;
        }
        clickme () {
            getLog().push('clickme');
            return Promise.resolve(false);
        }
    }
    vm.extensionManager.addBuiltinExtension('testpredicate', TestExtension);

    vm.on('COMPILE_ERROR', () => {
        assert.fail('Compile error');
    });

    await vm.loadProject(fixture);
    const logList = vm.runtime.getTargetForStage().lookupVariableByNameAndType('log', 'list');
    getLog = () => logList.value;
    assert.deepEqual(getLog(), [], 'sanity check - log starts empty');

    // Let it run for a bit. Nothing should happen on its own.
    for (let i = 0; i < 5; i++) {
        vm.runtime._step();
    }
    assert.deepEqual(getLog(), [], 'nothing happens initially');

    // See if events work
    vm.runtime.startHats('testpredicate_event');
    assert.deepEqual(getLog(), [], 'event function does not get called, even if it exists');
    vm.runtime._step();
    assert.deepEqual(getLog(), ['event'], 'ran event script');

    getLog().length = 0;

    // Test hat that returns false
    hatReturns = false;
    vm.runtime.startHats('testpredicate_hat');
    assert.deepEqual(getLog(), ['hat false'], 'ran hat function');
    vm.runtime._step();
    assert.deepEqual(getLog(), ['hat false'], 'did not run hat script');

    // Test hat that returns true
    hatReturns = true;
    vm.runtime.startHats('testpredicate_hat');
    assert.deepEqual(getLog(), [
        'hat false',
        'hat true'
    ], 'ran hat function');
    vm.runtime._step();
    assert.deepEqual(getLog(), [
        'hat false',
        'hat true',
        'hat'
    ], 'ran hat script');

    getLog().length = 0;

    // Test hat that returns false in a Promise
    hatReturns = Promise.resolve(false);
    vm.runtime.startHats('testpredicate_hat');
    assert.deepEqual(getLog(), ['hat [object Promise]'], 'ran hat function');
    vm.runtime._step();
    assert.deepEqual(getLog(), ['hat [object Promise]'], 'hat script does not run before promise finishes');
    await Promise.resolve(); // Allow promise to be processed
    vm.runtime._step();
    assert.deepEqual(getLog(), ['hat [object Promise]'], 'hat script still does not run');

    getLog().length = 0;

    // Test hat that returns true in a Promise
    hatReturns = Promise.resolve(true);
    vm.runtime.startHats('testpredicate_hat');
    assert.deepEqual(getLog(), ['hat [object Promise]'], 'ran hat function');
    vm.runtime._step();
    assert.deepEqual(getLog(), ['hat [object Promise]'], 'hat script does not run before promise finishes');
    await Promise.resolve();
    vm.runtime._step();
    assert.deepEqual(getLog(), ['hat [object Promise]', 'hat'], 'hat script runs after promise finishes');

    getLog().length = 0;

    // Test complex hat
    vm.runtime.startHats('testpredicate_complexhat', {
        MENU: 'a'
    });
    assert.deepEqual(getLog(), [
        'complex hat ',
        'complex hat 1'
    ], 'ran complex hat functions');
    vm.runtime._step();
    assert.deepEqual(getLog(), [
        'complex hat ',
        'complex hat 1',
        'complex hat a 2'
    ], 'ran complex hat script');

    getLog().length = 0;

    // Test complex hat with a complex input
    vm.runtime.startHats('testpredicate_complexhat', {
        MENU: 'b'
    });
    assert.deepEqual(getLog(), [], 'control flow in complex inputs is not run immediately');
    vm.runtime._step();
    assert.deepEqual(getLog(), [
        'evaluated block ',
        'evaluated block 1'
    ], 'evaluated complex inputs but not hat function');
    vm.runtime._step();
    assert.deepEqual(getLog(), [
        'evaluated block ',
        'evaluated block 1',
        'complex hat ',
        'complex hat 1',
        'complex hat b 2'
    ], 'evaluated complex hat functions and scripts');

    getLog().length = 0;

    // Test that in stackClick mode, the hat block still gets run, but the result is ignored
    const sprite = vm.runtime.targets[1];
    const allBlocks = Object.values(sprite.sprite.blocks._blocks);
    const clickBlockId = allBlocks.find(i => i.opcode === 'testpredicate_clickme').id;
    vm.runtime._pushThread(clickBlockId, sprite, {
        stackClick: true
    });
    assert.deepEqual(getLog(), [], 'stackClick does not run anything immediately');
    vm.runtime._step();
    assert.deepEqual(getLog(), ['evaluated block something'], 'stackClick hat ran input');
    vm.runtime._step();
    assert.deepEqual(getLog(), ['evaluated block something', 'clickme'], 'stackClick hat input evaluated');
    await Promise.resolve(); // Allow promise to be processed
    vm.runtime._step();
    assert.deepEqual(getLog(), ['evaluated block something', 'clickme', 'stack click'], 'stackClick hat script ran');
});
