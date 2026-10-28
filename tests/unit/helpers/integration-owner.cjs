'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const OWNER = path.join(__dirname, '..', 'phase49-incremental-integration.test.cjs');

function loadOwner(names, transform = '') {
  const loaded = new Module(OWNER, module);
  loaded.filename = OWNER;
  loaded.paths = Module._nodeModulePaths(path.dirname(OWNER));
  let source = fs.readFileSync(OWNER, 'utf8');
  if (transform) source = source.replace(
    "const source = fs.readFileSync(path.join(__dirname, file), 'utf8');",
    "const source = fs.readFileSync(path.join(__dirname, file), 'utf8')" + transform + ';');
  const originalLoad = Module._load;
  try {
    Module._load = function(name, ...args) {
      return name === 'node:test' ? { test() {} } : originalLoad.call(this, name, ...args);
    };
    loaded._compile(source + '\nmodule.exports = { ' + names.join(', ') + ' };', OWNER);
  } finally { Module._load = originalLoad; }
  return loaded.exports;
}

module.exports = { loadOwner };
