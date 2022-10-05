import * as fs from 'fs';
import * as t from 'runtypes';
import {getInput, setFailed} from '@actions/core';
import {context, getOctokit} from '@actions/github';
import {create as createGlob} from '@actions/glob';
import {markdownTable} from 'markdown-table';
import prettyBytes from 'pretty-bytes';

const GIST_HISTORY_FILE_NAME = 'history.json';
const GIST_PACKAGE_VERSION = 0;

const SIZE_COMPARE_HEADING = '## 🚛 size-compare report'; // add link https://github.com/effector/size-compare

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
  const gistId = getInput('gist_id', {required: true});
  const gistToken = getInput('gist_token', {required: true});
  const githubToken = getInput('github_token', {required: false}) ?? gistToken;
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

  const gistOctokit = getOctokit(gistToken);
  const baseOctokit = getOctokit(githubToken);

  const gist = await gistOctokit.rest.gists.get({gist_id: gistId});
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
    const previousCommentPromise = fetchPreviousComment(
      baseOctokit,
      {owner, repo},
      {number: pull_request.number},
    );
    const masterFiles = {...(latestRecord?.files ?? {})};
    const prFiles = recordToList(currentHistoryRecord.files, 'path', 'size');

    type ChangeState = 'modified' | 'added' | 'removed' | 'not changed';

    const changes: {state: ChangeState; path: string; diff: string; size: number}[] = [];

    prFiles.forEach(({path, size}) => {
      const masterFile = masterFiles[path];
      if (typeof masterFile !== 'undefined') {
        const difference = size - masterFile;
        if (difference === 0) {
          changes.push({
            state: 'not changed',
            path,
            diff: '',
            size,
          });
        } else {
          changes.push({
            state: 'modified',
            path,
            diff: prettyBytes(difference, {signed: true}),
            size,
          });
        }
        delete masterFiles[path];
      } else {
        changes.push({
          state: 'added',
          path,
          diff: prettyBytes(size, {signed: true}),
          size,
        });
      }
    });

    recordToList(masterFiles, 'path', 'size').forEach(({path, size}) => {
      changes.push({
        state: 'removed',
        path,
        diff: prettyBytes(-size, {signed: true}),
        size,
      });
    });

    const commentBody = [
      SIZE_COMPARE_HEADING,
      markdownTable([
        ['File', 'State', 'Diff', 'Current size', 'Original size'],
        ...changes.map(({state, path, diff, size}) => {
          const originalSize = latestRecord?.files[path] ?? 0;
          return [
            path,
            state,
            diff,
            prettyBytes(size),
            originalSize ? prettyBytes(originalSize) : '',
          ];
        }),
      ]),
    ].join('\r\n');

    const previousComment = await previousCommentPromise;

    if (previousComment) {
      try {
        await baseOctokit.rest.issues.updateComment({
          repo,
          owner,
          comment_id: previousComment.id,
          body: commentBody,
        });
      } catch (error) {
        console.log(
          "Error updating comment. This can happen for PR's originating from a fork without write permissions.",
          error,
        );
      }
    } else {
      try {
        await baseOctokit.rest.issues.createComment({
          repo,
          owner,
          issue_number: pull_request.number,
          body: commentBody,
        });
      } catch (error) {
        console.log(
          "Error creating comment. This can happen for PR's originating from a fork without write permissions.",
          error,
        );
      }
    }
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
      await gistOctokit.rest.gists.update({
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
}

async function fetchPreviousComment(
  octokit: ReturnType<typeof getOctokit>,
  repo: {owner: string; repo: string},
  pr: {number: number},
) {
  const comments = await octokit.rest.issues.listComments({
    owner: repo.owner,
    repo: repo.repo,
    issue_number: pr.number,
  });

  const sizeCompareComment = comments.data.find((comment) =>
    comment.body?.startsWith(SIZE_COMPARE_HEADING),
  );

  return sizeCompareComment ?? null;
}

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

main().catch((error) => {
  if (error instanceof Error) {
    setFailed(error.message);
  } else {
    setFailed(String(error));
  }
});
