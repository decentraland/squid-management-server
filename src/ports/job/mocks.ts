import { Network } from '@dcl/schemas'
import { Squid } from '../squids/types'

// MOCK DATA to test locally
export const MOCK_SQUIDS: Squid[] = [
  {
    name: 'mock-marketplace-squid',
    service_name: 'mock-marketplace-squid-server',
    schema_name: 'squid_marketplace',
    project_active_schema: 'squid_marketplace',
    version: 1,
    created_at: new Date(),
    health_status: 'HEALTHY',
    service_status: 'RUNNING',
    metrics: {
      [Network.ETHEREUM]: {
        sqd_processor_sync_eta_seconds: 30, // Intentionally out of sync for testing
        sqd_processor_mapping_blocks_per_second: 5.2,
        sqd_processor_last_block: 18500000,
        sqd_processor_chain_height: 18500100
      },
      [Network.MATIC]: {
        // Note: In real data, this value might be null or undefined even though
        // the type definition doesn't allow it. Our code handles this case.
        sqd_processor_sync_eta_seconds: 0, // We'll use 0 for the mock but the code will still check for null
        sqd_processor_mapping_blocks_per_second: 10.5,
        sqd_processor_last_block: 45600000,
        sqd_processor_chain_height: 45600200
      }
    }
  }
]
