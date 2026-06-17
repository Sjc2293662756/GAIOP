const runner = require('../skills/openclaw-napm-inspection/scripts/run_inspection_snapshot');

describe('run_inspection_snapshot CLI helpers', () => {
  test('parses payload and applies CLI overrides', () => {
    const args = runner.parseArgs([
      '--payload', '{"format":"docx","customerName":"旧客户"}',
      '--format', 'word',
      '--customerName', '北京烟草',
      '--nowSeconds', '1710003600'
    ]);
    const payload = runner.applyCliOverrides(runner.parseJsonText('--payload', args.payload), args);

    expect(payload).toMatchObject({
      format: 'word',
      customerName: '北京烟草',
      nowSeconds: 1710003600
    });
  });
});
