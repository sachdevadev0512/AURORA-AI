const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAllowedCertUrl,
  buildSnsStringToSign,
  verifyAmazonNotification,
} = require('../spApiNotificationVerifier');

test('isAllowedCertUrl accepts SNS signing certificate URLs', () => {
  assert.equal(
    isAllowedCertUrl(
      'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-1234567890abcdef.pem',
    ),
    true,
  );
});

test('isAllowedCertUrl rejects non-Amazon certificate URLs', () => {
  assert.equal(isAllowedCertUrl('https://evil.example.com/cert.pem'), false);
  assert.equal(isAllowedCertUrl('http://sns.us-east-1.amazonaws.com/cert.pem'), false);
});

test('buildSnsStringToSign builds canonical SNS notification string', () => {
  const message = {
    Type: 'Notification',
    MessageId: 'msg-1',
    TopicArn: 'arn:aws:sns:us-east-1:123:topic',
    Subject: 'Order changed',
    Message: '{"notificationType":"ORDER_CHANGE"}',
    Timestamp: '2026-01-01T00:00:00.000Z',
  };

  assert.equal(
    buildSnsStringToSign(message),
    [
      'Message',
      message.Message,
      'MessageId',
      message.MessageId,
      'Subject',
      message.Subject,
      'Timestamp',
      message.Timestamp,
      'TopicArn',
      message.TopicArn,
      'Type',
      message.Type,
      '',
    ].join('\n'),
  );
});

test('verifyAmazonNotification rejects missing signatures in production mode', async () => {
  const previousEnv = process.env.NODE_ENV;
  const previousSkip = process.env.SKIP_NOTIFICATION_SIGNATURE_VERIFY;
  process.env.NODE_ENV = 'production';
  delete process.env.SKIP_NOTIFICATION_SIGNATURE_VERIFY;

  try {
    const result = await verifyAmazonNotification({
      rawBody: Buffer.from('{"notificationType":"ORDER_CHANGE"}'),
      parsedBody: { notificationType: 'ORDER_CHANGE' },
      signature: null,
      certUrl: null,
    });
    assert.equal(result, false);
  } finally {
    process.env.NODE_ENV = previousEnv;
    process.env.SKIP_NOTIFICATION_SIGNATURE_VERIFY = previousSkip;
  }
});
