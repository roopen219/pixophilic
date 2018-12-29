const redis = require('redis');
const { promisify } = require('util');

const client = redis.createClient(process.env.REDIS_URL);

const REDIS_NAMESPACE = 'pixophilic';
const INFO_NAMESPACE = `${REDIS_NAMESPACE}:info`;
const PULL_NAMESPACE = `${REDIS_NAMESPACE}:pull`;

client.on('error', function(err) {
    console.log('Error ' + err);
});

client.on('ready', function() {
    console.log('Redis client connected');
});

const set = promisify(client.set).bind(client);
const get = promisify(client.get).bind(client);
// const mget = promisify(client.mget).bind(client);
// const hset = promisify(client.hset).bind(client);
const hmset = promisify(client.hmset).bind(client);
const hgetall = promisify(client.hgetall).bind(client);

function storeCommitInfo(commitSha, commitInfo) {
    return hmset(
        `${INFO_NAMESPACE}:${commitSha}`,
        commitInfo
    );
}

function getCommitInfo(commitSha) {
    return hgetall(`${INFO_NAMESPACE}:${commitSha}`);
}

function storePullRequestReference(identifier, pullRequestNumber) {
    return set(`${PULL_NAMESPACE}:${identifier}`, pullRequestNumber);
}

function getPullRequestReferences(identifier) {
    return get(`${PULL_NAMESPACE}:${identifier}`);
}

module.exports = {
    storeCommitInfo,
    getCommitInfo,
    storePullRequestReference,
    getPullRequestReferences
};
