# Squid Management Server

This server manages Decentraland squids.

## Features

### Squid Monitoring

The server includes a daemon that monitors active squids every minute. This daemon checks:

1. If active squids (those whose `schema_name` matches `project_active_schema`) have an estimated synchronization time (`sqd_processor_sync_eta_seconds`) greater than 10 seconds.
2. If the estimated synchronization time cannot be obtained.

In either case, the daemon sends an alert through Slack with detailed information about the affected squid.

### Sync progress

The `GET /list` endpoint returns, for every squid and network, a `metrics` object with the live
processor values scraped from each indexer. On top of the raw values it now includes a derived
`progress` field: the percentage of the chain that has been indexed, computed as
`sqd_processor_last_block / sqd_processor_chain_height` and clamped to the `[0, 100]` range. It is
`0` when the chain height is unknown. This lets clients render an indexing progress bar without
re-deriving the value.

### Topology caching (frequent polling)

The expensive part of `GET /list` is discovering the squid topology from ECS (listing/describing
services and tasks) and resolving each schema from the database. That topology changes rarely, so it
is cached in memory while the live processor metrics are always scraped fresh on every request. This
makes the endpoint cheap to poll every few seconds (e.g. to drive a live UI) without hammering the
ECS API. The cache is invalidated automatically after a `promote` or `stop`, so those changes are
reflected immediately.

The cache TTL is configurable:

```
SQUID_TOPOLOGY_CACHE_TTL_MS=30000
```

- `SQUID_TOPOLOGY_CACHE_TTL_MS`: how long (in milliseconds) the topology is cached before being
  re-discovered. Defaults to `30000`. Lower it to react faster to deploys; raise it to further
  reduce ECS load under frequent polling.

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
ENV=development
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