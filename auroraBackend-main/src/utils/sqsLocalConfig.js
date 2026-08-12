/**
 * Persist SQS queue ARN/URL when provisioned via UI (survives restart if .env not updated).
 */
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', '..', '.sqs-local.json');

function loadLocalSqsConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.queueArn && data.queueUrl) {
      return data;
    }
  } catch (error) {
    console.warn('[SqsLocalConfig] Could not read:', error.message);
  }
  return null;
}

function saveLocalSqsConfig({ queueArn, queueUrl, region, destinationId, dlqArn, dlqUrl }) {
  try {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify(
        {
          queueArn,
          queueUrl,
          dlqArn: dlqArn || undefined,
          dlqUrl: dlqUrl || undefined,
          region: region || process.env.AWS_REGION || 'us-east-1',
          destinationId: destinationId || undefined,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (error) {
    console.warn('[SqsLocalConfig] Could not save:', error.message);
  }
}

function applyLocalSqsToEnv() {
  if (process.env.AWS_SQS_QUEUE_URL && process.env.AWS_SQS_QUEUE_ARN) {
    return false;
  }

  const local = loadLocalSqsConfig();
  if (!local) return false;

  process.env.AWS_SQS_QUEUE_ARN = local.queueArn;
  process.env.AWS_SQS_QUEUE_URL = local.queueUrl;
  if (local.region) {
    process.env.AWS_REGION = local.region;
  }
  if (local.destinationId && !process.env.NOTIFICATION_DESTINATION_ID) {
    process.env.NOTIFICATION_DESTINATION_ID = local.destinationId;
  }
  if (local.dlqArn && !process.env.AWS_SQS_DLQ_ARN) {
    process.env.AWS_SQS_DLQ_ARN = local.dlqArn;
  }
  if (local.dlqUrl && !process.env.AWS_SQS_DLQ_URL) {
    process.env.AWS_SQS_DLQ_URL = local.dlqUrl;
  }
  return true;
}

module.exports = {
  loadLocalSqsConfig,
  saveLocalSqsConfig,
  applyLocalSqsToEnv,
};
