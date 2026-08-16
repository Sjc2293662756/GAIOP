#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  inspectNapmSkillRuntimeContracts
} = require('../plugin/NapmSkillRuntimeContract');

const skillsRoot = process.env.OPENCLAW_SKILLS_ROOT
  || path.resolve(__dirname, '..', 'skills');
const results = inspectNapmSkillRuntimeContracts(skillsRoot, { reload: true });

process.stdout.write(`${JSON.stringify({
  ok: results.every((result) => result.ok),
  skillsRoot,
  results
}, null, 2)}\n`);

if (results.some((result) => !result.ok)) {
  process.exitCode = 1;
}
