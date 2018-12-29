const AWS = require('aws-sdk');
const { promisify } = require('util');
const fs = require('fs');
const _ = require('lodash');
const readFileAsync = promisify(fs.readFile);

AWS.config.update({ region: 'us-east-1' });

const s3 = new AWS.S3({
    accessKeyId: process.env.S3_ACCESS_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    params: {
        Bucket: process.env.S3_BUCKET
    }
});

function getSnapshotsFromS3ForCommit(commitSha) {
    return s3.getObject({ Key: `${commitSha}.tgz` }).promise();
}

async function uploadSnapshotsToS3(currentSha, baseSha, snapshots) {
    if (!_.isEmpty(snapshots)) {
        const fileToUpload = snapshots[0];
        const fileContent = await readFileAsync(fileToUpload.filePath);

        console.log('uploading', fileToUpload.filePath);

        await s3.putObject({
            Key: `__diff__/${currentSha}:${baseSha}${fileToUpload.displayPath}`,
            Body: fileContent,
            ACL: 'public-read',
            ContentType: 'image/png'
        }).promise();

        return uploadSnapshotsToS3(currentSha, baseSha, _.tail(snapshots));
    }

    return true;
}

module.exports = {
    getSnapshotsFromS3ForCommit,
    uploadSnapshotsToS3
};
