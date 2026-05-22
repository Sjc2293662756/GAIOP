const plugin = require('../napm-openclaw-plugin.remote');

describe('napm-openclaw-plugin topn display boundary', () => {
  test('should not expose legacy TopN business-output renderer from plugin', () => {
    expect(plugin.__test__.buildTopnUserFacingText).toBeUndefined();
  });
});
