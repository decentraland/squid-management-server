import { HealthStatus } from "@aws-sdk/client-ecs";
import { Network } from "@dcl/schemas";

export type SquidMetric = {
  sqd_processor_sync_eta_seconds: number;
  sqd_processor_chain_height: number;
  sqd_processor_last_block: number;
  sqd_processor_mapping_blocks_per_second: number;
};

export type Squid = {
  name: string;
  created_at: Date | undefined;
  health_status: HealthStatus | undefined;
  service_name: string;
  service_status: string | undefined;
  version: number;
  metrics: Record<Network.ETHEREUM | Network.MATIC, SquidMetric>;
};

export type ISquidComponent = {
  list(): Promise<Squid[]>;
  downgrade(serviceName: string): Promise<void>;
  promote(serviceName: string): Promise<void>;
};
