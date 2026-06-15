const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const packet = require('../skills/openclaw-napm-packet-analysis/scripts/run_packet_analysis');

async function makeArtifact(baseDir, name, { createdAt, files = {} } = {}) {
  const dir = path.join(baseDir, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, '.packet-artifact'), JSON.stringify({
    schema: 'openclaw_napm_packet_artifact.v1',
    createdAt,
  }, null, 2));
  await fsp.writeFile(path.join(dir, 'download.meta.json'), JSON.stringify({
    downloadedAt: createdAt,
  }, null, 2));
  for (const [fileName, content] of Object.entries(files)) {
    await fsp.writeFile(path.join(dir, fileName), content);
  }
  return dir;
}

describe('openclaw-napm-packet-analysis storage governance', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'napm-packet-storage-'));
  });

  afterEach(async () => {
    if (tempDir && fs.existsSync(tempDir)) {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('should allow download when disk usage and free space are safe', () => {
    const decision = packet.buildStorageDecision({
      usedPercent: 50,
      freeBytes: 10 * 1024 * 1024 * 1024,
    }, {
      estimatedDownloadBytes: 100 * 1024 * 1024,
      requiredFreeBytes: 3 * 1024 * 1024 * 1024,
      policy: packet.normalizeStoragePolicy({
        warnPercent: 75,
        blockPercent: 90,
      }),
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('ENOUGH_SPACE');
  });

  test('should block download when disk usage exceeds block watermark', () => {
    const decision = packet.buildStorageDecision({
      usedPercent: 92,
      freeBytes: 100 * 1024 * 1024 * 1024,
    }, {
      estimatedDownloadBytes: 100,
      requiredFreeBytes: 100,
      policy: packet.normalizeStoragePolicy({
        blockPercent: 90,
      }),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('DISK_USAGE_BLOCKED');
  });

  test('should block download when free space is below required reserve', () => {
    const decision = packet.buildStorageDecision({
      usedPercent: 60,
      freeBytes: 1024,
    }, {
      estimatedDownloadBytes: 2048,
      requiredFreeBytes: 4096,
      policy: packet.normalizeStoragePolicy({
        blockPercent: 90,
      }),
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('FREE_SPACE_NOT_ENOUGH');
  });

  test('should list managed artifacts ordered by downloaded time only when marker exists', async () => {
    await makeArtifact(tempDir, 'newer', {
      createdAt: '2026-06-12T10:00:00.000Z',
      files: { 'newer.pcap': 'newer' },
    });
    await makeArtifact(tempDir, 'older', {
      createdAt: '2026-06-12T09:00:00.000Z',
      files: { 'older.pcap': 'older' },
    });
    const unmanaged = path.join(tempDir, 'unmanaged');
    await fsp.mkdir(unmanaged);
    await fsp.writeFile(path.join(unmanaged, 'do-not-delete.pcap'), 'safe');

    const artifacts = await packet.listManagedPacketArtifacts(tempDir);

    expect(artifacts.map((artifact) => path.basename(artifact.dir))).toEqual(['older', 'newer']);
  });

  test('should delete only packet payload files inside managed artifact', async () => {
    const dir = await makeArtifact(tempDir, 'artifact', {
      createdAt: '2026-06-12T09:00:00.000Z',
      files: {
        'capture.pcap': 'pcap-data',
        'capture.cap': 'cap-data',
        'analysis.json': '{}',
        'notes.txt': 'keep',
      },
    });

    const result = await packet.deletePacketPayloadFiles(dir);

    expect(result.deletedFiles).toBe(2);
    expect(fs.existsSync(path.join(dir, 'capture.pcap'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'capture.cap'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'analysis.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
  });

  test('should not delete payload files from unmanaged directories', async () => {
    const dir = path.join(tempDir, 'unmanaged');
    await fsp.mkdir(dir);
    await fsp.writeFile(path.join(dir, 'capture.pcap'), 'pcap-data');

    const result = await packet.deletePacketPayloadFiles(dir);

    expect(result.deletedFiles).toBe(0);
    expect(fs.existsSync(path.join(dir, 'capture.pcap'))).toBe(true);
  });

  test('should cleanup old managed artifact payloads before newer ones', async () => {
    await makeArtifact(tempDir, 'older', {
      createdAt: '2026-06-12T09:00:00.000Z',
      files: { 'older.pcap': 'older' },
    });
    await makeArtifact(tempDir, 'newer', {
      createdAt: '2026-06-12T10:00:00.000Z',
      files: { 'newer.pcap': 'newer' },
    });
    let calls = 0;
    const getDiskUsageFn = async () => {
      calls += 1;
      return { usedPercent: calls <= 2 ? 90 : 60, freeBytes: 1000, totalBytes: 10000, usedBytes: 9000 };
    };

    const result = await packet.cleanupArtifactsByWatermark(tempDir, {
      targetPercent: 70,
      getDiskUsageFn,
    });

    expect(result.deletedFiles).toBe(2);
    expect(fs.existsSync(path.join(tempDir, 'older', 'older.pcap'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'newer', 'newer.pcap'))).toBe(false);
  });
});
