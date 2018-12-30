const _ = require('lodash');
const moment = require('moment');
const getPullRequest = require('./github').getPullRequest;
const getPullRequestReferences = require('./redis').getPullRequestReferences;
const uploadSnapshotsToS3 = require('./s3').uploadSnapshotsToS3;
const updateCheckRun = require('./github').updateCheckRun;
const createCheckRun = require('./github').createCheckRun;
const findFileInGithub = require('./github').findFileInGithub;
const compareSnapshots = require('./snapshot').compareSnapshots;

const getLatestSnapshotFilesAndExtractToFilesystem = require('./snapshot')
    .getLatestSnapshotFilesAndExtractToFilesystem;

const getFile = require('./github').getFile;

const storePullRequestReference = require('./redis').storePullRequestReference;
const getCommitInfo = require('./redis').getCommitInfo;
const storeCommitInfo = require('./redis').storeCommitInfo;

async function getSnapshotDiffForCommits({
    owner,
    repo,
    github,
    currentHeadCommitSha,
    baseHeadCommitSha,
    pixophilicLockFilePathOnGithub
}) {
    const currentBranchLockFile = await getFile(github, {
        owner,
        repo,
        ref: currentHeadCommitSha,
        path: pixophilicLockFilePathOnGithub
    });

    const baseBranchLockFile = await getFile(github, {
        owner,
        repo,
        ref: baseHeadCommitSha,
        path: pixophilicLockFilePathOnGithub
    });

    if (currentBranchLockFile !== baseBranchLockFile) {
        const currentShaPath = `${
            process.env.SNAPSHOT_FOLDER
        }/${currentHeadCommitSha}`;
        const currentSnapshotPath = `${currentShaPath}/current`;
        const baseSnapshotPath = `${currentShaPath}/base`;
        const diffPath = `${currentShaPath}/__diff__/`;

        await getLatestSnapshotFilesAndExtractToFilesystem({
            currentSnapshotPath,
            baseSnapshotPath,
            baseBranchLockFile,
            currentBranchLockFile
        });

        return await compareSnapshots({
            currentSnapshotPath,
            baseSnapshotPath,
            diffPath
        });
    }

    console.log('Lock file content is same');

    return {
        total: 0
    };
}

async function createOrUpdateCheckRunAndStoreRef(github, checkRunOptions) {
    const commitInfo = (await getCommitInfo(checkRunOptions.head_sha)) || {};
    let method = createCheckRun;
    let params = checkRunOptions;

    const isNewStatusCompleted = params.status === 'completed';
    const isRevertingToDifferentStatusAfterComplete =
        !isNewStatusCompleted && commitInfo.runStatus === 'completed';

    const hasImages = !_.isEmpty(_.get(params, 'output.images'));

    if (
        commitInfo.runId &&
        !isRevertingToDifferentStatusAfterComplete &&
        commitInfo.hasImages === 'false'
    ) {
        console.log(`Updating check run: ${commitInfo.runId}`);
        method = updateCheckRun;
        params = { ...params, check_run_id: commitInfo.runId };
    }

    if (isNewStatusCompleted) {
        params.completed_at = moment().toISOString();
    }

    const checkResult = (await method(github, params)).data;

    return storeCommitInfo(params.head_sha, {
        runId: checkResult.id,
        runStatus: checkResult.status,
        conclusion: checkResult.conclusion,
        hasImages
    });
}

async function getSnapshotDiffForCommitsAndUpdateCheckRun({
    baseHeadCommitSha,
    currentHeadCommitSha,
    owner,
    repo,
    github,
    pixophilicLockFilePathOnGithub
}) {
    const diffFiles = await getSnapshotDiffForCommits({
        baseHeadCommitSha,
        currentHeadCommitSha,
        owner,
        repo,
        github,
        pixophilicLockFilePathOnGithub
    });

    if (diffFiles.total) {
        await uploadSnapshotsToS3(
            currentHeadCommitSha,
            baseHeadCommitSha,
            diffFiles.all
        );

        const params = {
            owner,
            repo,
            head_sha: currentHeadCommitSha,
            status: 'completed',
            conclusion: 'action_required',
            output: {
                title: `${diffFiles.total} ${
                    diffFiles.total === 1 ? 'snapshot' : 'snapshots'
                } will be updated`,
                summary: 'View the differences below',
                images: diffFiles.all.map(diff => {
                    return {
                        alt: diff.displayPath,
                        image_url: `https://${
                            process.env.S3_BUCKET
                        }.s3.amazonaws.com/__diff__/${currentHeadCommitSha}:${baseHeadCommitSha}${
                            diff.displayPath
                        }`,
                        caption: diff.displayPath
                    };
                })
            }
        };

        await createOrUpdateCheckRunAndStoreRef(github, params);
    } else {
        await createOrUpdateCheckRunAndStoreRef(github, {
            owner,
            repo,
            status: 'completed',
            conclusion: 'success',
            head_sha: currentHeadCommitSha,
            output: {
                title: 'All good!',
                summary: 'No snapshot differences'
            }
        });
    }
}

// setInterval(() => {
//     console.log('-------------Memory usage-------------');
//     const used = process.memoryUsage();
//     for (let key in used) {
//         console.log(`${key} ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`);
//     }
// }, 5000);

module.exports = app => {
    app.log('Yay, the app was loaded!');

    app.on('*', async context => {
        console.log(context.event);
        console.log(context.payload.action);
        console.log('==============================================');
    });

    app.on(
        [
            'pull_request.opened',
            'pull_request.reopened',
            'pull_request.synchronize',
            'pull_request.edited'
        ],
        async context => {
            const { pull_request } = context.payload;
            const pixophilicLockFilePathOnGithub = process.env.LOCK_FILE_PATH;

            const currentHeadCommitSha = pull_request.head.sha;
            const baseHeadCommitSha = pull_request.base.sha;

            console.log(currentHeadCommitSha, baseHeadCommitSha);

            const installationId = context.payload.installation.id;
            const { owner, repo } = context.repo();
            const { github } = context;

            await createOrUpdateCheckRunAndStoreRef(github, {
                owner,
                repo,
                status: 'queued',
                head_sha: currentHeadCommitSha
            });

            const isLockFileModifiedInPullRequest = await findFileInGithub(
                github,
                {
                    owner,
                    repo,
                    number: pull_request.number,
                    filePath: pixophilicLockFilePathOnGithub
                }
            );

            await storeCommitInfo(currentHeadCommitSha, {
                owner,
                repo,
                installationId
            });

            await storePullRequestReference(
                currentHeadCommitSha,
                pull_request.number
            );
            // await storePullRequestReference(
            //     `${pull_request.base.repo.full_name}:${pull_request.base.ref}`,
            //     pull_request.id,
            //     pull_request.number
            // );

            if (!isLockFileModifiedInPullRequest) {
                await createOrUpdateCheckRunAndStoreRef(github, {
                    owner,
                    repo,
                    status: 'completed',
                    conclusion: 'success',
                    head_sha: currentHeadCommitSha,
                    output: {
                        title: 'All good!',
                        summary: 'No lockfile changes in this PR'
                    }
                });
                return;
            }

            try {
                await getSnapshotDiffForCommitsAndUpdateCheckRun({
                    github,
                    baseHeadCommitSha,
                    currentHeadCommitSha,
                    repo,
                    owner,
                    pixophilicLockFilePathOnGithub
                });
            } catch (e) {
                if (e.status === 'Not Found') {
                    console.log('Lockfile not found');
                    await createOrUpdateCheckRunAndStoreRef(github, {
                        owner,
                        repo,
                        head_sha: currentHeadCommitSha,
                        status: 'completed',
                        conclusion: 'neutral',
                        output: {
                            title: 'Lockfile not found',
                            summary:
                                'Should not lead to any inconsistencies in snapshots'
                        }
                    });
                }

                if (e.code === 'NoSuchKey') {
                    console.log('Snapshots not found');
                    await createOrUpdateCheckRunAndStoreRef(github, {
                        owner,
                        repo,
                        status: 'in_progress',
                        head_sha: currentHeadCommitSha,
                        output: {
                            title: 'Waiting for snapshots',
                            summary:
                                'Waiting for the snapshots to be uploaded from CI'
                        }
                    });
                }

                console.log(e);
            }
        }
    );

    const router = app.route('/pixophilic');

    async function populateCommitInfo(req, res, next) {
        const commitSha = req.params.sha;
        const commitInfo = await getCommitInfo(commitSha);

        if (!commitInfo) {
            return res.send('🔍 Cannot find commit');
        }

        const github = await app.auth(commitInfo.installationId);

        req.commitInfo = commitInfo;
        req.github = github;

        next();
    }

    router.get(
        '/complete_check/:sha',
        populateCommitInfo,
        async (req, res, next) => {
            const { commitInfo, github } = req;

            const isActionRequired =
                commitInfo.conclusion === 'action_required';
            const isCheckComplete = commitInfo.runStatus === 'completed';

            if (isCheckComplete && isActionRequired) {
                try {
                    await createOrUpdateCheckRunAndStoreRef(github, {
                        owner: commitInfo.owner,
                        repo: commitInfo.repo,
                        head_sha: req.params.sha,
                        status: 'completed',
                        conclusion: 'success'
                    });
                } catch (e) {
                    return next(e);
                }

                return res.send('✅ Resolved. Check should be green.');
            }

            if (isCheckComplete && !isActionRequired) {
                return res.send('Already resolved.');
            }

            res.send('😏 Check has not completed yet smart-a**. Wait for it.');
        }
    );

    router.get(
        '/test_run_complete/:sha',
        populateCommitInfo,
        async (req, res, next) => {
            const { commitInfo, github } = req;
            const { owner, repo } = commitInfo;
            const currentHeadCommitSha = req.params.sha;

            const pixophilicLockFilePathOnGithub = process.env.LOCK_FILE_PATH;

            if (commitInfo.runStatus === 'in_progress') {
                const pullRequestRef = await getPullRequestReferences(
                    currentHeadCommitSha
                );
                const pullRequest = (await getPullRequest(github, {
                    owner,
                    repo,
                    number: pullRequestRef
                })).data;

                if (
                    pullRequest.state === 'open' &&
                    pullRequest.head.sha === currentHeadCommitSha
                ) {
                    const baseHeadCommitSha = pullRequest.base.sha;
                    res.send('Running diff');
                    try {
                        await getSnapshotDiffForCommitsAndUpdateCheckRun({
                            baseHeadCommitSha,
                            currentHeadCommitSha,
                            owner,
                            repo,
                            github,
                            pixophilicLockFilePathOnGithub
                        });
                    } catch (e) {
                        next(e);
                    }
                } else {
                    res.send('Commit no longer head, not running diff');
                }
            } else {
                res.send('Check already completed, not running diff');
            }
        }
    );
};
