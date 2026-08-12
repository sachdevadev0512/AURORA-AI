const { createGrantlessClient, createSellerClient } = require('./spApiNotificationsClient');

const ORDER_CHANGE_TYPE = 'ORDER_CHANGE';

function isSpApiConflict(error) {
  const msg = [error?.message, error?.details, error?.code].filter(Boolean).join(' ');
  return (
    error?.statusCode === 409 ||
    error?.code === 409 ||
    error?.code === 'Conflict' ||
    /conflict/i.test(msg) ||
    /already exists/i.test(msg)
  );
}

function normalizeArn(arn) {
  return String(arn || '').trim().toLowerCase();
}

function extractSqsArnFromDestination(dest) {
  if (!dest || typeof dest !== 'object') return null;

  const specs = [
    dest.resource,
    dest.resourceSpecification,
    dest.Resource,
    dest.ResourceSpecification,
  ];

  for (const spec of specs) {
    if (!spec) continue;
    const arn =
      spec.sqs?.arn ||
      spec.Sqs?.arn ||
      spec.sqs?.Arn ||
      spec.SQS?.arn;
    if (arn) return arn;
  }

  try {
    const match = JSON.stringify(dest).match(/arn:aws:sqs:[a-z0-9\-:_]+/i);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/** SP-API returns payload as array OR { destinations: [] }. */
function normalizeDestinationsList(response) {
  if (!response) return [];

  const payload = response.payload !== undefined ? response.payload : response;

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.destinations)) {
    return payload.destinations;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  return [];
}

async function listDestinations(credentials = null) {
  const client = await createGrantlessClient(credentials);
  const response = await client.callAPI({
    operation: 'getDestinations',
    endpoint: 'notifications',
    options: { version: 'v1' },
  });

  return normalizeDestinationsList(response);
}

async function findDestinationIdBySqsArn(sqsArn, credentials = null) {
  const targetArn = normalizeArn(sqsArn);
  const queueName = sqsArn.split(':').pop();

  const destinations = await listDestinations(credentials);
  const sqsDestinations = [];

  for (const dest of destinations) {
    const arn = extractSqsArnFromDestination(dest);
    const id = dest.destinationId || dest.id;

    if (!id) continue;

    if (arn) {
      sqsDestinations.push({ id, arn });
      if (normalizeArn(arn) === targetArn || normalizeArn(arn).endsWith(`:${queueName.toLowerCase()}`)) {
        return id;
      }
    }
  }

  if (sqsDestinations.length === 1) {
    return sqsDestinations[0].id;
  }

  return null;
}

function parseArnFromConflictError(error) {
  const text = [error?.details, error?.message].filter(Boolean).join(' ');
  const match = text.match(/arn:aws:sqs:[a-z0-9\-:_]+/i);
  return match ? match[0] : null;
}

/**
 * Create or reuse SQS destination (grantless).
 * @returns {Promise<string>} destinationId
 */
async function ensureSqsDestination(sqsArn, credentials = null) {
  if (!sqsArn) {
    throw new Error('AWS_SQS_QUEUE_ARN is required to create an SP-API notification destination');
  }

  const existingId = await findDestinationIdBySqsArn(sqsArn, credentials);
  if (existingId) {
    return existingId;
  }

  const client = await createGrantlessClient(credentials);

  try {
    const response = await client.callAPI({
      operation: 'createDestination',
      endpoint: 'notifications',
      body: {
        name: process.env.NOTIFICATION_DESTINATION_NAME || 'Aurora Order Notifications',
        resourceSpecification: {
          sqs: { arn: sqsArn },
        },
      },
      options: { version: 'v1' },
    });

    const destinationId = response?.payload?.destinationId || response?.destinationId;
    if (!destinationId) {
      throw new Error('createDestination did not return destinationId');
    }

    return destinationId;
  } catch (error) {
    if (!isSpApiConflict(error)) {
      throw error;
    }

    const conflictArn = parseArnFromConflictError(error) || sqsArn;
    const reused = await findDestinationIdBySqsArn(conflictArn, credentials);
    if (reused) {
      return reused;
    }

    const all = await listDestinations(credentials);
    for (const dest of all) {
      const id = dest.destinationId || dest.id;
      if (id && extractSqsArnFromDestination(dest)) {
        return id;
      }
    }

    throw new Error(
      `SQS destination exists in Amazon but could not be listed. ARN: ${sqsArn}. ` +
        `Save NOTIFICATION_DESTINATION_ID in .env from Seller Central / SP-API console.`
    );
  }
}

/**
 * Subscribe seller to ORDER_CHANGE (seller-authorized). Idempotent.
 */
async function ensureOrderChangeSubscription(user, destinationId, sellerAppCredentials = null) {
  const existing = await getOrderChangeSubscription(user, sellerAppCredentials).catch((err) => {
    if (err?.statusCode === 404 || err?.code === 404 || err?.code === 'NotFound') {
      return null;
    }
    console.warn('[NotificationsApi] getSubscription warning:', err.message);
    return null;
  });

  const existingId =
    existing?.subscriptionId ||
    existing?.payload?.subscriptionId ||
    existing?.subscription?.subscriptionId;

  const existingDest =
    existing?.destinationId ||
    existing?.payload?.destinationId ||
    existing?.subscription?.destinationId;

  if (existingId) {
    return {
      subscriptionId: existingId,
      destinationId: existingDest || destinationId,
      notificationType: ORDER_CHANGE_TYPE,
      payload: existing,
      reused: true,
    };
  }

  const client = await createSellerClient(user, sellerAppCredentials);

  const body = {
    payloadVersion: '1.0',
    destinationId,
    processingDirective: {
      eventFilter: {
        eventFilterType: ORDER_CHANGE_TYPE,
        orderChangeTypes: ['OrderStatusChange', 'BuyerRequestedChange'],
      },
    },
  };

  try {
    const response = await client.callAPI({
      operation: 'createSubscription',
      endpoint: 'notifications',
      path: { notificationType: ORDER_CHANGE_TYPE },
      body,
      options: { version: 'v1' },
    });

    const subscriptionId = response?.payload?.subscriptionId || response?.subscriptionId;
    return {
      subscriptionId,
      destinationId,
      notificationType: ORDER_CHANGE_TYPE,
      payload: response?.payload || response,
      reused: false,
    };
  } catch (error) {
    if (!isSpApiConflict(error)) {
      throw error;
    }

    const after = await getOrderChangeSubscription(user, sellerAppCredentials).catch(() => null);
    const subId =
      after?.subscriptionId ||
      after?.payload?.subscriptionId ||
      after?.subscription?.subscriptionId;

    if (subId) {
      return {
        subscriptionId: subId,
        destinationId: after?.destinationId || after?.payload?.destinationId || destinationId,
        notificationType: ORDER_CHANGE_TYPE,
        payload: after,
        reused: true,
      };
    }

    throw error;
  }
}

/** @deprecated Use ensureOrderChangeSubscription */
async function createOrderChangeSubscription(user, destinationId, sellerAppCredentials = null) {
  return ensureOrderChangeSubscription(user, destinationId, sellerAppCredentials);
}

async function getOrderChangeSubscription(user, sellerAppCredentials = null) {
  const client = await createSellerClient(user, sellerAppCredentials);

  const response = await client.callAPI({
    operation: 'getSubscription',
    endpoint: 'notifications',
    path: { notificationType: ORDER_CHANGE_TYPE },
    options: { version: 'v1' },
  });

  return response?.payload || response;
}

async function deleteOrderChangeSubscription(subscriptionId, sellerAppCredentials = null, user = null) {
  const client = user
    ? await createSellerClient(user, sellerAppCredentials)
    : await createGrantlessClient(sellerAppCredentials);

  await client.callAPI({
    operation: 'deleteSubscriptionById',
    endpoint: 'notifications',
    path: {
      notificationType: ORDER_CHANGE_TYPE,
      subscriptionId,
    },
    options: { version: 'v1' },
  });

  return true;
}

module.exports = {
  ORDER_CHANGE_TYPE,
  ensureSqsDestination,
  ensureOrderChangeSubscription,
  createOrderChangeSubscription,
  getOrderChangeSubscription,
  deleteOrderChangeSubscription,
  listDestinations,
  isSpApiConflict,
  normalizeDestinationsList,
};
