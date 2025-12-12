#!/bin/bash

# Start ngrok to expose the webhook server
# Run this in a separate terminal alongside `npm run dev`

PORT=${WEBHOOK_PORT:-3000}

echo "Starting ngrok on port $PORT..."
echo ""
echo "After ngrok starts, copy the HTTPS URL and:"
echo "1. Go to Linear Settings > API > Webhooks"
echo "2. Create a new webhook with URL: <ngrok-url>/webhook"
echo "3. Select events: Issue, Comment"
echo "4. Copy the signing secret and add to .env as LINEAR_WEBHOOK_SECRET"
echo ""

ngrok http $PORT
