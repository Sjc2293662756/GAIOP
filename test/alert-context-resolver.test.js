'use strict';

const AlertContextResolver = require('../plugin/context-resolvers/AlertContextResolver');

describe('AlertContextResolver', () => {
  const resolver = new AlertContextResolver();

  test('exposes a minimal authoritative alert ranking candidate', () => {
    expect(resolver.getAdmissionCandidates({
      record: {
        sourceTool: 'napm-alert-query',
        turnId: 'turn-alerts',
        updatedAt: 200,
        result: {
          ok: true,
          events: [{ id: '369652', start: 1781488800, end: 1781492400, group: 'HTTPS' }]
        }
      }
    })).toEqual([expect.objectContaining({
      domain: 'ALERT',
      artifactId: 'alert-result:turn-alerts',
      objectType: 'AlertEvent',
      expectedTool: 'napm-alert-query',
      updatedAt: 200,
      items: [{
        ordinal: 1,
        eventId: '369652',
        start: 1781488800,
        end: 1781492400,
        label: 'HTTPS'
      }]
    })]);
  });

  test('builds alert detail params only from the selected authoritative event', () => {
    expect(resolver.buildContinuationToolParams({
      reasonCode: 'AUTHORITATIVE_RESULT_FOLLOWUP',
      sourceDomain: 'ALERT',
      selection: { action: 'DETAIL', ordinal: 1 },
      selectedItem: {
        ordinal: 1,
        eventId: '369652',
        start: 1781488800,
        end: 1781492400
      }
    })).toEqual({
      mode: 'detail',
      criteria: {
        eventIds: ['369652'],
        start: 1781488800,
        end: 1781492400
      },
      alertQuery: {
        mode: 'detail',
        criteria: {
          eventIds: ['369652'],
          start: 1781488800,
          end: 1781492400
        }
      }
    });
  });

  test('does not expose non-alert or empty results as candidates', () => {
    expect(resolver.getAdmissionCandidates({
      record: { sourceTool: 'napm-skill-query', result: { ok: true, events: [{ id: '1' }] } }
    })).toEqual([]);
    expect(resolver.getAdmissionCandidates({
      record: { sourceTool: 'napm-alert-query', result: { ok: true, events: [] } }
    })).toEqual([]);
  });
});
