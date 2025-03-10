# Squid Management Server

This server manages Decentraland squids.

## Features

### Squid Monitoring

The server includes a daemon that monitors active squids every minute. This daemon checks:

1. If active squids (those whose `schema_name` matches `project_active_schema`) have an estimated synchronization time (`sqd_processor_sync_eta_seconds`) greater than 10 seconds.
2. If the estimated synchronization time cannot be obtained.

In either case, the daemon sends an alert through Slack with detailed information about the affected squid.

## Configuration

To enable Slack alerts, you need to configure the following environment variables:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_CHANNEL=alerts
```

- `SLACK_BOT_TOKEN`: Slack bot token with permissions to send messages.
- `SLACK_CHANNEL`: Slack channel where alerts will be sent (optional, default is 'general').

## Local Testing

For local development and testing without AWS access, you can use the following environment variables:

```
NODE_ENV=development
# or
USE_MOCK_SQUIDS=true
```

This will enable mock data with a simulated out-of-sync squid.

To test the "ETA unavailable" scenario, you can set:

```
FORCE_ETA_UNAVAILABLE=true
```

## Development

### Requirements

- Node.js
- npm

### Installation

```bash
npm install
```

### Running

```bash
npm start
```

### Tests

```bash
npm test
``` 