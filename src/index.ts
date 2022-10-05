import core from '@actions/core';
import github from '@actions/github';
import {markdownTable} from 'markdown-table';

try {
  // `who-to-greet` input defined in action metadata file
  const nameToGreet = core.getInput('who-to-greet');
  console.log(`Hello ${nameToGreet}!`);
  const time = new Date().toTimeString();
  core.setOutput('time', time);
  // Get the JSON webhook payload for the event that triggered the workflow
  const payload = JSON.stringify(github.context.payload, undefined, 2);
  console.log(`The event payload: ${payload}`);
  console.log(
    markdownTable([
      ['Branch', 'Commit'],
      ['main', 'asdasda'],
    ]),
  );
} catch (error) {
  if (error instanceof Error) {
    core.setFailed(error.message);
  } else {
    core.setFailed(String(error));
  }
}
