/**
 * Polls Amazon SP-API notification SQS queue and forwards messages to notificationService.
 * Processes messages concurrently and drains the queue continuously when work is available.
 */

const { parseSqsNotificationBody } = require('../utils/sqsMessageParser');

const { sleep, mapWithConcurrency } = require('../utils/async');

const MAX_MESSAGES = Math.min(
  10,
  Math.max(1, parseInt(process.env.AWS_SQS_MAX_MESSAGES || '10', 10))
);
const CONSUMER_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.AWS_SQS_CONSUMER_CONCURRENCY || '5', 10)
);
const POLL_INTERVAL_MS = Math.max(
  1000,
  parseInt(process.env.AWS_SQS_POLL_INTERVAL_MS || '5000', 10)
);
const IDLE_POLL_INTERVAL_MS = Math.max(
  POLL_INTERVAL_MS,
  parseInt(process.env.AWS_SQS_IDLE_POLL_INTERVAL_MS || '30000', 10)
);

let pollerActive = false;
let pollerLoopPromise = null;
let credentialFailureLogged = false;

function getQueueUrl() {
  return process.env.AWS_SQS_QUEUE_URL || null;
}

function hasAwsCredentialsConfigured() {
  return Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

function isCredentialError(error) {
  const message = String(error?.message || '');
  return (
    error?.name === 'CredentialsProviderError' ||
    /could not load credentials/i.test(message)
  );
}

function isEnabled() {
  return (
    process.env.ORDER_NOTIFICATIONS_SQS_POLL_ENABLED !== 'false' &&
    Boolean(getQueueUrl()) &&
    hasAwsCredentialsConfigured()
  );
}

function getSqsClient() {
  const { SQSClient } = require('@aws-sdk/client-sqs');
  const config = { region: process.env.AWS_REGION || 'us-east-1' };

  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    config.credentials = {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      ...(process.env.AWS_SESSION_TOKEN
        ? { sessionToken: process.env.AWS_SESSION_TOKEN }
        : {}),
    };
  }

  return new SQSClient(config);
}

function getSqsCommands() {
  try {
    return require('@aws-sdk/client-sqs');
  } catch (error) {
    console.error(
      '[SqsNotificationPoller] @aws-sdk/client-sqs is not installed. Run: npm install @aws-sdk/client-sqs'
    );
    return null;
  }
}


async function deleteMessage(client, DeleteMessageCommand, queueUrl, receiptHandle) {
  await client.send(
    new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
    })
  );
}

async function processOneMessage(client, DeleteMessageCommand, queueUrl, message) {
  const flow = require('./orderNotificationFlow');
  const receiveCount = parseInt(message.Attributes?.ApproximateReceiveCount || '1', 10);

  try {
    const parsedBody = parseSqsNotificationBody(message.Body || '{}');
    if (!parsedBody) {
      console.warn('[SqsNotificationPoller] Unparseable message body — discarding', {
        messageId: message.MessageId,
        receiveCount,
      });
      flow.recordStat('unparseableDiscarded');
      flow.pushEvent({
        step: 'unparseable_discarded',
        messageId: message.MessageId,
        receiveCount,
      });
      await deleteMessage(client, DeleteMessageCommand, queueUrl, message.ReceiptHandle);
      return { status: 'discarded' };
    }

    const notificationService = require('./notificationService');
    await notificationService.handleIncomingNotification(parsedBody);
    await deleteMessage(client, DeleteMessageCommand, queueUrl, message.ReceiptHandle);
    return { status: 'ok' };
  } catch (error) {
    console.error('[SqsNotificationPoller] Failed to process message:', error.message, {
      messageId: message.MessageId,
      receiveCount,
    });
    flow.recordStat('processingErrors');
    flow.pushEvent({
      step: 'processing_error',
      messageId: message.MessageId,
      receiveCount,
      error: error.message,
    });
    return { status: 'error', error };
  }
}

async function receiveMessageBatch(client, ReceiveMessageCommand, queueUrl) {
  const response = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: MAX_MESSAGES,
      WaitTimeSeconds: 20,
      VisibilityTimeout: parseInt(process.env.AWS_SQS_VISIBILITY_TIMEOUT || '60', 10),
      AttributeNames: ['All'],
      MessageAttributeNames: ['All'],
    })
  );

  return response.Messages || [];
}

async function drainQueueOnce() {
  const queueUrl = getQueueUrl();
  if (!queueUrl) return 0;

  const commands = getSqsCommands();
  if (!commands) return 0;

  const { ReceiveMessageCommand, DeleteMessageCommand } = commands;
  const client = getSqsClient();
  const messages = await receiveMessageBatch(client, ReceiveMessageCommand, queueUrl);
  if (messages.length === 0) return 0;

  const flow = require('./orderNotificationFlow');
  flow.pushEvent({
    step: 'sqs_poll_batch',
    count: messages.length,
    concurrency: CONSUMER_CONCURRENCY,
  });

  await mapWithConcurrency(messages, CONSUMER_CONCURRENCY, (message) =>
    processOneMessage(client, DeleteMessageCommand, queueUrl, message)
  );

  return messages.length;
}

async function runPollerLoop() {
  while (pollerActive) {
    try {
      let drained = 0;
      let batchSize;

      do {
        batchSize = await drainQueueOnce();
        drained += batchSize;
      } while (pollerActive && batchSize >= MAX_MESSAGES);

      if (!pollerActive) break;

      await sleep(drained > 0 ? POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS);
    } catch (error) {
      if (isCredentialError(error)) {
        if (!credentialFailureLogged) {
          console.error(
            '[SqsNotificationPoller] AWS credentials unavailable — poller stopped. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY on the server.'
          );
          credentialFailureLogged = true;
        }
        stop();
        return;
      }
      console.error('[SqsNotificationPoller] Poll error:', error.message);
      await sleep(IDLE_POLL_INTERVAL_MS);
    }
  }
}

async function pollOnce() {
  if (!pollerActive) {
    let total = 0;
    let batchSize;
    do {
      batchSize = await drainQueueOnce();
      total += batchSize;
    } while (batchSize >= MAX_MESSAGES);
    return total;
  }
  return 0;
}

function start() {
  if (!getQueueUrl()) {
    return;
  }

  if (!hasAwsCredentialsConfigured()) {
    if (!credentialFailureLogged) {
      console.warn(
        '[SqsNotificationPoller] Disabled — AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not configured.'
      );
      credentialFailureLogged = true;
    }
    return;
  }

  if (!isEnabled()) {
    return;
  }

  if (pollerActive) return;

  pollerActive = true;
  pollerLoopPromise = runPollerLoop().catch((error) => {
    console.error('[SqsNotificationPoller] Poller loop exited:', error.message);
    pollerActive = false;
    pollerLoopPromise = null;
  });

  console.log(
    `[SqsNotificationPoller] Started (concurrency=${CONSUMER_CONCURRENCY}, maxBatch=${MAX_MESSAGES}, activePoll=${POLL_INTERVAL_MS}ms, idlePoll=${IDLE_POLL_INTERVAL_MS}ms)`
  );
}

function stop() {
  pollerActive = false;
}

function getPollerConfig() {
  return {
    concurrency: CONSUMER_CONCURRENCY,
    maxMessages: MAX_MESSAGES,
    pollIntervalMs: POLL_INTERVAL_MS,
    idlePollIntervalMs: IDLE_POLL_INTERVAL_MS,
    running: pollerActive,
  };
}

module.exports = {
  start,
  stop,
  isEnabled,
  pollOnce,
  getPollerConfig,
};
