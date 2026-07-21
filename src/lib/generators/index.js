'use strict';

const { generateProjectScaffold } = require('./project-scaffold');
const { generateConfigFiles } = require('./config-generator');
const { generateComponentScripts } = require('./component-generator');
const { generateStateMachine } = require('./state-machine-generator');

module.exports = {
  generateProjectScaffold,
  generateConfigFiles,
  generateComponentScripts,
  generateStateMachine,
};
