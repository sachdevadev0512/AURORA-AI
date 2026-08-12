/**
 * Provision and validate the SQS queue used for SP-API ORDER_CHANGE notifications.
 */

const DEFAULT_QUEUE_NAME = 'aurora-sp-api-order-notifications';

/** Amazon SP-API notification sender accounts by selling region (AWS account IDs). */
const SP_API_NOTIFICATION_PRINCIPALS = {
  NA: '437568002678',
  EU: '507733088537',
  FE: '137659890050',
};

function getRegion() {
  return process.env.AWS_REGION || 'us-east-1';
}

function getSellingRegion() {
  const explicit = (process.env.AMAZON_SELLING_REGION || process.env.AMAZON_REGION || '').toUpperCase();
  if (explicit === 'NA' || explicit === 'EU' || explicit === 'FE') {
    return explicit;
  }

  const region = getRegion();
  if (region.startsWith('eu-')) return 'EU';
  if (region.startsWith('ap-') || region === 'us-west-2') return 'FE';
  return 'NA';
}

function getNotificationPrincipalAccountId() {
  if (process.env.AMAZON_NOTIFICATIONS_PRINCIPAL_AWS_ACCOUNT_ID) {
    return process.env.AMAZON_NOTIFICATIONS_PRINCIPAL_AWS_ACCOUNT_ID;
  }
  const sellingRegion = getSellingRegion();
  return SP_API_NOTIFICATION_PRINCIPALS[sellingRegion] || SP_API_NOTIFICATION_PRINCIPALS.NA;
}

function buildQueuePolicy(queueArn) {
  const principalAccountId = getNotificationPrincipalAccountId();

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'AllowSPAPINotifications',
        Effect: 'Allow',
        Principal: {
          AWS: principalAccountId,
        },
        Action: 'sqs:SendMessage',
        Resource: queueArn,
      },
    ],
  };
}

function getSqsClient() {
  const { SQSClient } = require('@aws-sdk/client-sqs');

  const config = { region: getRegion() };

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

function getDeadLetterQueueName(mainQueueName) {
  return process.env.AWS_SQS_DLQ_NAME || `${mainQueueName}-dlq`;
}

function getMaxReceiveCount() {
  return Math.max(1, parseInt(process.env.AWS_SQS_MAX_RECEIVE_COUNT || '5', 10));
}

function applyRuntimeEnv({ queueArn, queueUrl, destinationId, dlqArn, dlqUrl }) {
  if (queueArn) {
    process.env.AWS_SQS_QUEUE_ARN = queueArn;
  }
  if (queueUrl) {
    process.env.AWS_SQS_QUEUE_URL = queueUrl;
  }
  if (destinationId) {
    process.env.NOTIFICATION_DESTINATION_ID = destinationId;
  }
  if (dlqArn) {
    process.env.AWS_SQS_DLQ_ARN = dlqArn;
  }
  if (dlqUrl) {
    process.env.AWS_SQS_DLQ_URL = dlqUrl;
  }

  if (queueArn && queueUrl) {
    try {
      const { saveLocalSqsConfig } = require('../utils/sqsLocalConfig');
      saveLocalSqsConfig({
        queueArn,
        queueUrl,
        dlqArn,
        dlqUrl,
        region: getRegion(),
      });
    } catch (err) {
      console.warn('[SqsSetup] Could not persist local SQS config:', err.message);
    }
  }
}

async function getQueueArnFromUrl(client, queueUrl) {
  const { GetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
  const response = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['QueueArn', 'Policy'],
    })
  );
  return {
    queueArn: response.Attributes?.QueueArn,
    policy: response.Attributes?.Policy,
  };
}

async function ensureQueuePolicy(client, queueUrl, queueArn) {
  const { SetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
  const policy = buildQueuePolicy(queueArn);

  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: {
        Policy: JSON.stringify(policy),
      },
    })
  );

}

async function resolveExistingQueueLite(client, queueName) {
  const { GetQueueUrlCommand } = require('@aws-sdk/client-sqs');

  try {
    const response = await client.send(
      new GetQueueUrlCommand({
        QueueName: queueName,
      })
    );
    const queueUrl = response.QueueUrl;
    const { queueArn } = await getQueueArnFromUrl(client, queueUrl);
    return { queueArn, queueUrl, created: false };
  } catch (error) {
    if (error.name === 'QueueDoesNotExist' || error.Code === 'AWS.SimpleQueueService.NonExistentQueue') {
      return null;
    }
    throw error;
  }
}

async function resolveExistingQueue(client, queueName) {
  const existing = await resolveExistingQueueLite(client, queueName);
  if (!existing) return null;

  await ensureQueuePolicy(client, existing.queueUrl, existing.queueArn);
  const dlq = await ensureDeadLetterConfiguration(
    client,
    existing.queueUrl,
    existing.queueArn,
    queueName
  );
  return { ...existing, dlqArn: dlq.queueArn, dlqUrl: dlq.queueUrl };
}

async function createDeadLetterQueue(dlqName) {
  const client = getSqsClient();
  const existing = await resolveExistingQueueLite(client, dlqName);
  if (existing) {
    return existing;
  }

  const { CreateQueueCommand } = require('@aws-sdk/client-sqs');
  const createResponse = await client.send(
    new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: {
        MessageRetentionPeriod: String(process.env.AWS_SQS_DLQ_RETENTION_SECONDS || 1209600),
      },
    })
  );

  const queueUrl = createResponse.QueueUrl;
  const { queueArn } = await getQueueArnFromUrl(client, queueUrl);
  return { queueArn, queueUrl, created: true };
}

async function ensureRedrivePolicy(client, queueUrl, dlqArn) {
  const { SetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
  const redrivePolicy = JSON.stringify({
    deadLetterTargetArn: dlqArn,
    maxReceiveCount: getMaxReceiveCount(),
  });

  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: queueUrl,
      Attributes: {
        RedrivePolicy: redrivePolicy,
      },
    })
  );
}

async function ensureDeadLetterConfiguration(client, queueUrl, queueArn, queueName) {
  const dlqName = getDeadLetterQueueName(queueName);
  const dlq = await createDeadLetterQueue(dlqName);
  await ensureRedrivePolicy(client, queueUrl, dlq.queueArn);
  return dlq;
}

async function createNotificationQueue(queueName = DEFAULT_QUEUE_NAME) {
  const client = getSqsClient();
  const existing = await resolveExistingQueue(client, queueName);
  if (existing) {
    return existing;
  }

  const dlqName = getDeadLetterQueueName(queueName);
  const dlq = await createDeadLetterQueue(dlqName);
  const { CreateQueueCommand } = require('@aws-sdk/client-sqs');

  const createResponse = await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        MessageRetentionPeriod: String(process.env.AWS_SQS_MESSAGE_RETENTION_SECONDS || 1209600),
        ReceiveMessageWaitTimeSeconds: '20',
        VisibilityTimeout: String(process.env.AWS_SQS_VISIBILITY_TIMEOUT || 60),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlq.queueArn,
          maxReceiveCount: getMaxReceiveCount(),
        }),
      },
    })
  );

  const queueUrl = createResponse.QueueUrl;
  const { queueArn } = await getQueueArnFromUrl(client, queueUrl);
  await ensureQueuePolicy(client, queueUrl, queueArn);

  return { queueArn, queueUrl, dlqArn: dlq.queueArn, dlqUrl: dlq.queueUrl, created: true };
}

/**
 * Ensure ARN + URL are available (from env, queue name, or auto-create).
 */
async function ensureConfigured() {
  const queueName = process.env.AWS_SQS_QUEUE_NAME || DEFAULT_QUEUE_NAME;
  let queueArn = process.env.AWS_SQS_QUEUE_ARN || null;
  let queueUrl = process.env.AWS_SQS_QUEUE_URL || null;

  const client = getSqsClient();

  if (queueUrl && !queueArn) {
    const resolved = await getQueueArnFromUrl(client, queueUrl);
    queueArn = resolved.queueArn;
    await ensureQueuePolicy(client, queueUrl, queueArn);
  }

  if (!queueUrl && queueArn) {
    const nameFromArn = queueArn.split(':').pop();
    const resolved = await resolveExistingQueue(client, nameFromArn);
    if (resolved) {
      queueUrl = resolved.queueUrl;
      queueArn = resolved.queueArn;
    }
  }

  if (!queueUrl && !queueArn) {
    const autoCreate =
      process.env.ORDER_NOTIFICATIONS_AUTO_CREATE_SQS === 'true' ||
      process.env.ORDER_NOTIFICATIONS_AUTO_CREATE_SQS === '1';

    if (!autoCreate && !process.env.AWS_SQS_QUEUE_NAME) {
      return {
        configured: false,
        queueArn: null,
        queueUrl: null,
        message:
          'Set AWS_SQS_QUEUE_ARN + AWS_SQS_QUEUE_URL, or AWS_SQS_QUEUE_NAME, or ORDER_NOTIFICATIONS_AUTO_CREATE_SQS=true',
      };
    }

    const created = await createNotificationQueue(queueName);
    queueArn = created.queueArn;
    queueUrl = created.queueUrl;
  } else if (queueUrl && queueArn) {
    try {
      await ensureQueuePolicy(client, queueUrl, queueArn);
    } catch (error) {
      console.warn('[SqsSetup] Could not refresh queue policy:', error.message);
    }
  }

  let dlqArn = process.env.AWS_SQS_DLQ_ARN || null;
  let dlqUrl = process.env.AWS_SQS_DLQ_URL || null;

  if (queueUrl && queueArn) {
    try {
      const dlq = await ensureDeadLetterConfiguration(client, queueUrl, queueArn, queueName);
      dlqArn = dlq.queueArn;
      dlqUrl = dlq.queueUrl;
    } catch (error) {
      console.warn('[SqsSetup] Could not ensure dead-letter queue:', error.message);
    }
  }

  applyRuntimeEnv({ queueArn, queueUrl, dlqArn, dlqUrl });

  return {
    configured: Boolean(queueArn && queueUrl),
    queueArn,
    queueUrl,
    dlqArn,
    dlqUrl,
    dlqName: getDeadLetterQueueName(queueName),
    maxReceiveCount: getMaxReceiveCount(),
    queueName,
    region: getRegion(),
    sellingRegion: getSellingRegion(),
    principalAccountId: getNotificationPrincipalAccountId(),
  };
}

function hasExplicitAwsCredentials() {
  return Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

async function probeAwsCredentials() {
  if (hasExplicitAwsCredentials()) {
    return { available: true, method: 'env' };
  }

  try {
    const { SQSClient, ListQueuesCommand } = require('@aws-sdk/client-sqs');
    const client = new SQSClient({ region: getRegion() });
    await client.send(new ListQueuesCommand({ MaxResults: 1 }));
    return { available: true, method: 'default_chain' };
  } catch (error) {
    return {
      available: false,
      method: null,
      error: error.message,
    };
  }
}

function getStatus() {
  const sqsNotificationPoller = require('./sqsNotificationPoller');
  return {
    configured: Boolean(process.env.AWS_SQS_QUEUE_URL && process.env.AWS_SQS_QUEUE_ARN),
    credentialsInEnv: hasExplicitAwsCredentials(),
    queueArn: process.env.AWS_SQS_QUEUE_ARN || null,
    queueUrl: process.env.AWS_SQS_QUEUE_URL || null,
    dlqArn: process.env.AWS_SQS_DLQ_ARN || null,
    dlqUrl: process.env.AWS_SQS_DLQ_URL || null,
    dlqName: getDeadLetterQueueName(process.env.AWS_SQS_QUEUE_NAME || DEFAULT_QUEUE_NAME),
    maxReceiveCount: getMaxReceiveCount(),
    queueName: process.env.AWS_SQS_QUEUE_NAME || DEFAULT_QUEUE_NAME,
    region: getRegion(),
    sellingRegion: getSellingRegion(),
    principalAccountId: getNotificationPrincipalAccountId(),
    pollingEnabled: process.env.ORDER_NOTIFICATIONS_SQS_POLL_ENABLED !== 'false',
    poller: sqsNotificationPoller.getPollerConfig(),
    autoCreateSqs:
      process.env.ORDER_NOTIFICATIONS_AUTO_CREATE_SQS === 'true' ||
      process.env.ORDER_NOTIFICATIONS_AUTO_CREATE_SQS === '1',
    autoCreateDestination:
      process.env.ORDER_NOTIFICATIONS_AUTO_CREATE_DESTINATION === 'true' ||
      process.env.ORDER_NOTIFICATIONS_AUTO_CREATE_DESTINATION === '1',
    destinationId: process.env.NOTIFICATION_DESTINATION_ID || null,
  };
}

async function getStatusAsync() {
  const base = getStatus();
  const credentials = await probeAwsCredentials();

  return {
    ...base,
    credentialsAvailable: credentials.available,
    credentialsMethod: credentials.method,
    awsAccount: credentials.account || null,
    ready: base.configured && credentials.available,
    nextStep: !credentials.available
      ? 'add_aws_credentials'
      : !base.configured
        ? 'provision_queue'
        : 'subscribe_amazon',
  };
}

module.exports = {
  DEFAULT_QUEUE_NAME,
  buildQueuePolicy,
  createNotificationQueue,
  createDeadLetterQueue,
  ensureConfigured,
  ensureDeadLetterConfiguration,
  ensureQueuePolicy,
  ensureRedrivePolicy,
  getStatus,
  getStatusAsync,
  probeAwsCredentials,
  hasExplicitAwsCredentials,
  applyRuntimeEnv,
  getNotificationPrincipalAccountId,
  getDeadLetterQueueName,
  getMaxReceiveCount,
};
