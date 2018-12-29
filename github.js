const btoa = require('./snapshot').btoa;
const _ = require('lodash');

async function getFile(github, options) {
    return btoa((await github.repos.getContents(options)).data.content);
}

async function findFileInGithub(
    github,
    { filePath, owner, repo, number, page = 1, per_page = 100 }
) {
    const files = (await github.pullRequests.listFiles({
        owner,
        repo,
        number,
        page,
        per_page
    })).data;

    if (_.isEmpty(files)) {
        return null;
    }

    const foundFile = _.find(files, { filename: filePath });

    if (foundFile) {
        return foundFile;
    }

    return findFileInGithub(github, {
        filePath,
        owner,
        repo,
        number,
        page: page + 1,
        per_page
    });
}

function createCheckRun(github, options) {
    return github.checks.create({
        ...options,
        name: 'Pixophilic',
        details_url: `${process.env.HOST_URL}/pixophilic/complete_check/${
            options.head_sha
        }`
    });
}

function updateCheckRun(github, options) {
    return github.checks.update({
        ...options,
        name: 'Pixophilic',
        details_url: `${process.env.HOST_URL}/pixophilic/complete_check/${
            options.head_sha
            }`
    });
}

function getPullRequest(github, options) {
    return github.pullRequests.get(options);
}

module.exports = {
    getFile,
    findFileInGithub,
    createCheckRun,
    updateCheckRun,
    getPullRequest
};
