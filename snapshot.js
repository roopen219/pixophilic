const decompress = require('decompress');
const fs = require('fs-plus');
const YAML = require('yaml');
const _ = require('lodash');
const nanoid = require('nanoid');
const BlinkDiff = require('blink-diff');

const getSnapshotsFromS3Commit = require('./s3').getSnapshotsFromS3ForCommit;

function btoa(data) {
    return Buffer.from(data, 'base64').toString('utf-8');
}

function unarchiveSnapshots(archive, unarchive_path) {
    console.log('Unarchiving base snapshots');
    return decompress(archive, unarchive_path);
}

function getSnapshotFiles(path) {
    return new Promise(resolve => {
        let snapshots = [];
        fs.traverseTree(
            path,
            file => snapshots.push(file),
            () => true,
            () => {
                let snapshotsWithRelativePath = snapshots.map(filePath =>
                    filePath.replace(path, '')
                );

                return resolve({
                    absolute: snapshots,
                    relative: snapshotsWithRelativePath
                });
            }
        );
    });
}

function getLastUpdateCommitFromLockFile(lockFileContent) {
    return YAML.parse(lockFileContent, 'utf8').last_update_commit;
}

async function getLatestSnapshotFilesAndExtractToFilesystem({
    currentBranchLockFile,
    baseBranchLockFile,
    currentSnapshotPath,
    baseSnapshotPath
}) {
    const lastSnapshotUpdateCommitOnCurrentBranch = getLastUpdateCommitFromLockFile(
        currentBranchLockFile
    );
    const lastSnapshotUpdateCommitOnBaseBranch = getLastUpdateCommitFromLockFile(
        baseBranchLockFile
    );

    const currentSnapshotArchive = await getSnapshotsFromS3Commit(
        lastSnapshotUpdateCommitOnCurrentBranch
    );

    await unarchiveSnapshots(currentSnapshotArchive.Body, currentSnapshotPath);

    const baseSnapshotArchive = await getSnapshotsFromS3Commit(
        lastSnapshotUpdateCommitOnBaseBranch
    );

    await unarchiveSnapshots(baseSnapshotArchive.Body, baseSnapshotPath);
}

async function compareSnapshots({
    currentSnapshotPath,
    baseSnapshotPath,
    diffPath
}) {
    const currentSnapshotFiles = await getSnapshotFiles(currentSnapshotPath);
    const baseSnapshotFiles = await getSnapshotFiles(baseSnapshotPath);

    const snapshotsToCompare = _.intersection(
        currentSnapshotFiles.relative,
        baseSnapshotFiles.relative
    );

    const snapshotsOnlyInCurrent = _.chain(currentSnapshotFiles.relative)
        .difference(baseSnapshotFiles.relative)
        .map(relativePath => {
            return {
                filePath: `${currentSnapshotPath}${relativePath}`,
                displayPath: relativePath
            };
        })
        .value();

    const snapshotsOnlyInBase = _.chain(baseSnapshotFiles.relative)
        .difference(currentSnapshotFiles.relative)
        .map(relativePath => {
            return {
                filePath: `${baseSnapshotPath}${relativePath}`,
                displayPath: relativePath
            };
        })
        .value();

    fs.makeTreeSync(diffPath);

    const imageComparisonThreshold = 300;

    let diffFiles = await _compareSnapshots(snapshotsToCompare, {
        diffPath,
        currentSnapshotPath,
        baseSnapshotPath,
        imageComparisonThreshold
    });

    diffFiles = _.compact(diffFiles);

    return {
        total:
            diffFiles.length +
            snapshotsOnlyInBase.length +
            snapshotsOnlyInCurrent.length,
        all: [...diffFiles, ...snapshotsOnlyInCurrent, ...snapshotsOnlyInBase],
        different: diffFiles,
        notInCurrent: snapshotsOnlyInBase,
        notInBase: snapshotsOnlyInCurrent
    };
}

async function _compareSnapshots(
    snapshotsToCompare,
    {
        diffPath,
        baseSnapshotPath,
        currentSnapshotPath,
        imageComparisonThreshold
    },
    result = []
) {
    if (_.isEmpty(snapshotsToCompare)) {
        return result;
    }

    const relativePath = snapshotsToCompare[0];

    const diffResult = await new Promise((resolve, reject) => {
        const diffFilePath = `${diffPath}${nanoid(5)}-${_.last(
            relativePath.split('/')
        )}`;

        const diff = new BlinkDiff({
            imageAPath: `${baseSnapshotPath}${relativePath}`,
            imageBPath: `${currentSnapshotPath}${relativePath}`,

            thresholdType: BlinkDiff.THRESHOLD_PIXEL,
            threshold: imageComparisonThreshold,

            imageOutputPath: diffFilePath,
            imageOutputLimit: BlinkDiff.OUTPUT_DIFFERENT,

            composeLeftToRight: true
        });

        diff.run(function(error, result) {
            if (error) {
                return reject(error);
            }

            if (result.differences >= imageComparisonThreshold) {
                resolve({
                    filePath: diffFilePath,
                    displayPath: relativePath
                });
            } else {
                resolve('');
            }
        });
    });

    result.push(diffResult);

    return _compareSnapshots(
        _.tail(snapshotsToCompare),
        {
            diffPath,
            baseSnapshotPath,
            currentSnapshotPath,
            imageComparisonThreshold
        },
        result
    );
}

module.exports = {
    btoa,
    getLatestSnapshotFilesAndExtractToFilesystem,
    compareSnapshots
};
