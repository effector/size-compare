'use strict';

var core = require('@actions/core');
var github = require('@actions/github');

function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

var core__default = /*#__PURE__*/_interopDefaultLegacy(core);
var github__default = /*#__PURE__*/_interopDefaultLegacy(github);

try {
  // `who-to-greet` input defined in action metadata file
  const nameToGreet = core__default["default"].getInput('who-to-greet');
  console.log(`Hello ${nameToGreet}!`);
  const time = new Date().toTimeString();
  core__default["default"].setOutput('time', time); // Get the JSON webhook payload for the event that triggered the workflow

  const payload = JSON.stringify(github__default["default"].context.payload, undefined, 2);
  console.log(`The event payload: ${payload}`);
} catch (error) {
  if (error instanceof Error) {
    core__default["default"].setFailed(error.message);
  } else {
    core__default["default"].setFailed(String(error));
  }
}
//# sourceMappingURL=main.js.map
