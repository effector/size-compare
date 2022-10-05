import * as fs from 'fs';
import * as t from 'runtypes';
import {getInput, setFailed, setOutput} from '@actions/core';
import {context, getOctokit} from '@actions/github';
import {create as createGlob} from '@actions/glob';
import {markdownTable} from 'markdown-table';

const GIST_HISTORY_FILE_NAME = 'history.json';
const GIST_PACKAGE_VERSION = 0;

const SizeCompareLiteral = t.Literal(GIST_PACKAGE_VERSION);

const FilesSizes = t.Dictionary(t.Number, 'string');

const HistoryRecord = t.Record({
  unixtimestamp: t.Number,
  commitsha: t.String,
  files: FilesSizes,
});

type HistoryRecord = t.Static<typeof HistoryRecord>;

const HistoryFile = t.Record({
  'size-compare': SizeCompareLiteral,
  history: t.Array(HistoryRecord),
});

async function main() {
  const gistId = getInput('gist-id', {required: true});
  const token = getInput('token', {required: true});
  const files = getInput('files', {required: true});

  const {
    payload: {pull_request, repository, compare: compareLink, commits},
    repo: {owner, repo},
    sha,
    eventName,
    ref,
  } = context;

  const masterBranch = repository?.master_branch;

  const globber = await createGlob(files, {omitBrokenSymbolicLinks: true});
  const foundFilesList = await globber.glob();
  const filesSizes = foundFilesList.map((path) => ({
    name: path.replace(process.cwd() + '/', ''),
    relative: path.replace(process.cwd(), '.'),
    full: path,
    size: fs.statSync(path).size,
  }));

  const octokit = getOctokit(token);

  const gist = await octokit.rest.gists.get({gist_id: gistId});
  const gistFiles: Record<string, {content: string; filename: string}> = {};

  // Read each file from gist to do not lose them on updating gist
  Object.keys(gist.data.files!).forEach((key) => {
    const file = gist.data.files?.[key];
    if (file) {
      const filename = file.filename ?? key;
      gistFiles[filename] = {
        filename,
        content: file.content ?? '',
      };
    }
  });

  const currentHistoryRecord: HistoryRecord = {
    unixtimestamp: Date.now(),
    commitsha: sha,
    files: Object.fromEntries(filesSizes.map((file) => [file.name, file.size])),
  };

  const historyFile = getOrCreate(gistFiles, GIST_HISTORY_FILE_NAME, {
    filename: GIST_HISTORY_FILE_NAME,
    content: `{"size-compare": ${GIST_PACKAGE_VERSION}, "history": []}`,
  });
  const originalFileContent = historyFile.content;
  const historyFileContent = HistoryFile.check(JSON.parse(originalFileContent));

  // Note: a history is written in reversed chronological order: the latest is the first
  const latestRecord = historyFileContent.history[0];

  if (pull_request) {
    const masterFiles = latestRecord?.files ?? {};
    const prFiles = recordToList(currentHistoryRecord.files, 'path', 'size');

    type ChangeState = 'modified' | 'added' | 'removed' | 'not changed';

    const changes: {state: ChangeState; path: string; diff: string}[] = [];

    prFiles.forEach(({path, size}) => {
      const masterFile = masterFiles[path];
      if (typeof masterFile !== 'undefined') {
        const difference = size - masterFile;
        if (difference === 0) {
          changes.push({
            state: 'not changed',
            path,
            diff: '0',
          });
        } else {
          changes.push({
            state: 'modified',
            path,
            diff: String(difference),
          });
        }
        delete masterFiles[path];
      } else {
        changes.push({
          state: 'added',
          path,
          diff: String(size),
        });
      }
    });

    recordToList(latestRecord?.files ?? {}, 'path', 'size').forEach(({path, size}) => {
      changes.push({
        state: 'removed',
        path,
        diff: String(-size),
      });
    });

    const md = markdownTable([
      ['State', 'File', 'Diff'],
      ...changes.map(({state, path, diff}) => [state, path, diff]),
    ]);

    console.log(md);
  }

  if (!pull_request) {
    // check for the latest commit in the history
    const alreadyCheckedSizeByHistory = (latestRecord?.commitsha ?? '') === sha;

    if (!alreadyCheckedSizeByHistory) {
      historyFileContent.history.unshift(currentHistoryRecord);
    }

    const updatedHistoryContent = JSON.stringify(historyFileContent, null, 2);
    historyFile.content = updatedHistoryContent;

    // Do not commit GIST if no changes
    if (updatedHistoryContent !== originalFileContent) {
      console.log('History changed, updating GIST');
      await octokit.rest.gists.update({
        gist_id: gistId,
        files: gistFiles,
      });
    }
  }

  console.log(
    '>>',
    JSON.stringify(
      {
        files,
        list: filesSizes,
        pull_request,
        repository,
        owner,
        repo,
        ref,
        sha,
        compareLink,
        eventName,
        masterBranch,
      },
      null,
      2,
    ),
  );

  const time = new Date().toTimeString();
  setOutput('time', time);
  // Get the JSON webhook payload for the event that triggered the workflow
  // const payload = JSON.stringify(context.payload, undefined, 2);
  // console.log(`The event payload: ${payload}`);
  // console.log(
  //   markdownTable([
  //     ['Branch', 'Commit'],
  //     ['main', 'asdasda'],
  //   ]),
  // );
}

main().catch((error) => {
  if (error instanceof Error) {
    setFailed(error.message);
  } else {
    setFailed(String(error));
  }
});

function getOrCreate<T>(record: Record<string, T>, key: string, defaultValue: T): T {
  if (!record[key]) {
    record[key] = defaultValue;
  }
  return record[key];
}

type RecordedItem<K extends string, V extends string, T> = Record<K, string> & Record<V, T>;

function recordToList<T, K extends string, V extends string>(
  record: Record<string, T>,
  key: K,
  value: V,
): Array<RecordedItem<K, V, T>> {
  return Object.entries(record).map(([k, v]) => ({
    [key]: k,
    [value]: v,
  })) as Array<RecordedItem<K, V, T>>;
}
