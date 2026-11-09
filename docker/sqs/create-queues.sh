#!/bin/sh
# One-shot provisioning of the SQS queues used by the service.
# Idempotent: CreateQueue returns the existing URL when attributes match.
set -eu

aws() { command aws --endpoint-url "$SQS_ENDPOINT" "$@"; }

DLQ_URL=$(aws sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl --output text)

DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

REDRIVE="{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"${SQS_MAX_RECEIVE_COUNT}\\\"}"
aws sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"${SQS_VISIBILITY_TIMEOUT}\",\"RedrivePolicy\":\"${REDRIVE}\"}" \
  >/dev/null

aws sqs create-queue \
  --queue-name wallet-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  >/dev/null

echo "SQS queues ready"
