'use strict';

const path = require('node:path');
const pluginManifest = require('../openclaw.plugin.json');
const {
  NAPM_SKILL_RUNTIME_ENTRIES,
  inspectNapmSkillRuntimeContracts
} = require('../plugin/NapmSkillRuntimeContract');

describe('NAPM production Skill runtime registry', () => {
  test('matches every production NAPM tool declared by the plugin manifest', () => {
    const manifestTools = pluginManifest.contracts.tools
      .filter((toolName) => !['napm-resolve-query', 'napm-mainflow-query'].includes(toolName))
      .sort();
    const runtimeTools = NAPM_SKILL_RUNTIME_ENTRIES
      .map((entry) => entry.toolName)
      .sort();

    expect(runtimeTools).toEqual(manifestTools);
  });

  test('loads every production Skill and requires an in-process entry point', () => {
    const results = inspectNapmSkillRuntimeContracts(
      path.resolve(__dirname, '..', 'skills'),
      { reload: true }
    );

    expect(results).toHaveLength(8);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'napm-skill-query', ok: true }),
      expect.objectContaining({ toolName: 'napm-packet-analysis', ok: true }),
      expect.objectContaining({ toolName: 'napm-alert-packet-analysis', ok: true })
    ]));
    expect(results.every((result) => result.ok)).toBe(true);
  });
});
