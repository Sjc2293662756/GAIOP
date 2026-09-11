const packet = require('../skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis');

describe('openclaw-napm-packet-analysis preview risk assessment', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PACKET_PREVIEW_WARN_BYTES;
    delete process.env.PACKET_PREVIEW_BLOCK_BYTES;
    delete process.env.PACKET_PREVIEW_WARN_PACKETS;
    delete process.env.PACKET_PREVIEW_BLOCK_PACKETS;
    delete process.env.PACKET_PREVIEW_BLOCK_UNKNOWN;
    delete process.env.PACKET_PREVIEW_BLOCK_MEDIUM;
    delete process.env.PACKET_PREVIEW_CONFIRM_DOWNLOAD;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('should extract top-level packet count and estimated bytes from preview payload', () => {
    const overview = packet.normalizePreviewOverview({
      packetCount: 8280,
      totalBytes: '24 MB',
      endpoints: [{ ip: '101.254.114.238', totalBytes: 1024 }],
    }, {
      start: 1781147760,
      end: 1781151360,
    });

    expect(overview.packetCount).toBe(8280);
    expect(overview.estimatedBytes).toBe(24 * 1024 * 1024);
    expect(overview.estimatedSizeText).toBe('24.0 MB');
    expect(overview.avgPacketsPerSecond).toBeCloseTo(2.3, 1);
    expect(overview.rawFieldHints.packetCountField).toBe('packetCount');
    expect(overview.rawFieldHints.sizeField).toBe('totalBytes');
  });

  test('should aggregate row-level size and count when preview payload has rows only', () => {
    const overview = packet.normalizePreviewOverview({
      data: [
        { endpoint: '10.0.0.1', packetCount: 10, totalBytes: '1 MB' },
        { endpoint: '10.0.0.2', packets: 5, size: '512 KB' },
      ],
    }, {
      start: 1000,
      end: 1060,
    });

    expect(overview.packetCount).toBe(15);
    expect(overview.estimatedBytes).toBe(1572864);
    expect(overview.topEndpoints).toEqual([
      { label: '10.0.0.1', bytes: 1048576, packets: 10 },
      { label: '10.0.0.2', bytes: 524288, packets: 5 },
    ]);
  });

  test('should parse NetInside dashboard datasets instead of counting the four outer widgets', () => {
    const overview = packet.normalizePreviewOverview([
      {
        columnIds: ['TA', 'TB', 'Data', 'MIFG'],
        rows: [
          {
            id: 'TPROW 1',
            values: { TA: '10.0.0.1', TB: '8.8.8.8', Data: '2.00 kB' },
            comparableValues: { Data: 2048 },
          },
          {
            id: 'TPROW 2',
            values: { TA: '9.9.9.9', TB: '10.0.0.2', Data: '1.00 kB' },
            comparableValues: { Data: 1024 },
          },
          {
            id: 'TPROW 3',
            values: { TA: '10.0.0.1', TB: '10.0.0.2', Data: '512 B' },
            comparableValues: { Data: 512 },
          },
        ],
      },
      {
        columnIds: ['TN', 'Data', 'IPConv', 'MIFG'],
        rows: [
          { values: { TN: '10.0.0.1', Data: '2.50 kB', IPConv: '2' }, comparableValues: { Data: 2560, IPConv: 2 } },
          { values: { TN: '10.0.0.2', Data: '1.50 kB', IPConv: '2' }, comparableValues: { Data: 1536, IPConv: 2 } },
          { values: { TN: '8.8.8.8', Data: '2.00 kB', IPConv: '1' }, comparableValues: { Data: 2048, IPConv: 1 } },
          { values: { TN: '9.9.9.9', Data: '1.00 kB', IPConv: '1' }, comparableValues: { Data: 1024, IPConv: 1 } },
        ],
      },
      { edges: [], nodes: [] },
      { xValues: [], yValues: [] },
    ], {
      start: 1000,
      end: 1300,
      ipRanges: ['10.0.0.1-10.0.0.2'],
    });

    expect(overview.rowCount).toBe(3);
    expect(overview.trafficSummary).toMatchObject({
      conversationCount: 3,
      endpointCount: 4,
      trafficBytes: 3584,
      trafficSizeText: '3.50 KB',
      directions: {
        outbound: { conversationCount: 1, bytes: 2048 },
        inbound: { conversationCount: 1, bytes: 1024 },
        internal: { conversationCount: 1, bytes: 512 },
      },
    });
    expect(overview.trafficSummary.topGroupMembers).toEqual([
      { ip: '10.0.0.1', bytes: 2560, sizeText: '2.50 KB', conversationCount: 2 },
      { ip: '10.0.0.2', bytes: 1536, sizeText: '1.50 KB', conversationCount: 2 },
    ]);
    expect(overview.trafficSummary.topConversations[0]).toMatchObject({
      sourceIp: '10.0.0.1',
      destinationIp: '8.8.8.8',
      bytes: 2048,
      direction: 'outbound',
    });
  });

  test('should not treat preview HTTP response bytes as estimated pcap size', () => {
    const overview = packet.normalizePreviewOverview({}, {
      start: 1000,
      end: 1060,
    });

    expect(overview.estimatedBytes).toBeNull();
    expect(overview.packetCount).toBeNull();
    const risk = packet.assessPacketDownloadRisk(overview);
    expect(risk.level).toBe('unknown');
    expect(risk.recommendation).toBe('CONFIRM_DOWNLOAD');
  });

  test('should recommend narrowing time range when estimated size exceeds block threshold', () => {
    process.env.PACKET_PREVIEW_BLOCK_BYTES = '1000';

    const risk = packet.assessPacketDownloadRisk({
      estimatedBytes: 2048,
      estimatedSizeText: '2 KB',
      packetCount: 20,
    });

    expect(risk.level).toBe('high');
    expect(risk.recommendation).toBe('SUGGEST_NARROW_TIME_RANGE');
    expect(risk.reasons.join(' ')).toContain('2.00 KB');
  });

  test('should allow medium risk by default but support confirmation gate by env', () => {
    process.env.PACKET_PREVIEW_WARN_BYTES = '1000';
    process.env.PACKET_PREVIEW_BLOCK_BYTES = '1000000';

    const defaultRisk = packet.assessPacketDownloadRisk({
      estimatedBytes: 2048,
      estimatedSizeText: '2 KB',
      packetCount: 20,
    });

    expect(defaultRisk.level).toBe('medium');
    expect(defaultRisk.recommendation).toBe('CONTINUE_DOWNLOAD');

    process.env.PACKET_PREVIEW_BLOCK_MEDIUM = 'true';
    const gatedRisk = packet.assessPacketDownloadRisk({
      estimatedBytes: 2048,
      estimatedSizeText: '2 KB',
      packetCount: 20,
    });

    expect(gatedRisk.level).toBe('medium');
    expect(gatedRisk.recommendation).toBe('CONFIRM_DOWNLOAD');
  });
});
