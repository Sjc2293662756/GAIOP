'use strict';

const AssistantOutputLedger = require('../plugin/AssistantOutputLedger');

describe('AssistantOutputLedger', () => {
  test('consumes only a recorded tool progress output for the same scope and turn', () => {
    const ledger = new AssistantOutputLedger({ now: () => 1000 });
    const recorded = ledger.recordToolProgress({
      scope: 'session:one',
      turnId: 'turn-1',
      text: 'Querying the alert summary.',
      stopReason: 'toolUse'
    });

    expect(recorded).toMatchObject({
      phase: 'progress',
      hasToolCall: true,
      stopReason: 'toolUse',
      state: 'PENDING_DELIVERY'
    });
    expect(ledger.consumeProgressDelivery({
      scope: 'session:two',
      turnId: 'turn-1',
      text: 'Querying the alert summary.'
    })).toBeNull();
    expect(ledger.consumeProgressDelivery({
      scope: 'session:one',
      turnId: 'turn-1',
      text: 'Querying the alert summary.'
    })).toMatchObject({
      outputId: recorded.outputId,
      state: 'PROGRESS_DELIVERY_SUPPRESSED'
    });
    expect(ledger.consumeProgressDelivery({
      scope: 'session:one',
      turnId: 'turn-1',
      text: 'Querying the alert summary.'
    })).toBeNull();
  });

  test('consumes two explicitly recorded equal progress outputs independently', () => {
    const ledger = new AssistantOutputLedger({ now: () => 1000 });
    const first = ledger.recordToolProgress({ scope: 'session:one', turnId: 'turn-1', text: 'Working.' });
    const second = ledger.recordToolProgress({ scope: 'session:one', turnId: 'turn-1', text: 'Working.' });

    expect(ledger.consumeProgressDelivery({
      scope: 'session:one', turnId: 'turn-1', text: 'Working.'
    })?.outputId).toBe(first.outputId);
    expect(ledger.consumeProgressDelivery({
      scope: 'session:one', turnId: 'turn-1', text: 'Working.'
    })?.outputId).toBe(second.outputId);
    expect(ledger.consumeProgressDelivery({
      scope: 'session:one', turnId: 'turn-1', text: 'Working.'
    })).toBeNull();
  });

  test('never consumes terminal output as progress even when its text is equal', () => {
    const ledger = new AssistantOutputLedger({ now: () => 1000 });
    ledger.recordOutput({
      scope: 'session:one',
      turnId: 'turn-1',
      text: 'Same visible text.',
      phase: 'terminal',
      stopReason: 'stop'
    });

    expect(ledger.consumeProgressDelivery({
      scope: 'session:one', turnId: 'turn-1', text: 'Same visible text.'
    })).toBeNull();
  });

  test('expires old records, enforces the entry cap, and clears one scope', () => {
    let now = 1000;
    const ledger = new AssistantOutputLedger({ now: () => now, maxAgeMs: 50, maxEntries: 2 });
    ledger.recordToolProgress({ scope: 'session:one', turnId: 'turn-1', text: 'one' });
    ledger.recordToolProgress({ scope: 'session:one', turnId: 'turn-1', text: 'two' });
    ledger.recordToolProgress({ scope: 'session:two', turnId: 'turn-2', text: 'three' });

    expect(ledger.getRecords()).toHaveLength(2);
    expect(ledger.getRecords().map((record) => record.textLength)).toEqual([3, 5]);
    expect(ledger.clearScope('session:one')).toBe(1);
    expect(ledger.getRecords('session:two')).toHaveLength(1);

    now = 1100;
    ledger.evictExpired();
    expect(ledger.getRecords()).toEqual([]);
  });
});
