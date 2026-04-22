import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { Network } from '@dcl/schemas'
import { ISlackComponent } from '@dcl/slack-component'
import {
  ETA_CONSIDERED_OUT_OF_SYNC,
  FIVE_MINUTES,
  SlackMessageBlock,
  clearNoMetricsThrottleState,
  createSquidMonitor,
  noMetricsFirstDetected
} from '../../src/ports/job/squid-monitor'
import { ISquidComponent, Squid, SquidMetric } from '../../src/ports/squids/types'

type SendMessageCall = [{ text: string; blocks?: SlackMessageBlock[] }]

describe('Squid Monitor', () => {
  let logsMock: ILoggerComponent
  let loggerMock: { info: jest.Mock; error: jest.Mock; warn: jest.Mock }
  let squidsMock: ISquidComponent
  let configMock: IConfigComponent
  let slackComponentMock: ISlackComponent
  let monitorSquids: () => Promise<void>

  beforeEach(() => {
    clearNoMetricsThrottleState()

    loggerMock = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn()
    }
    logsMock = {
      getLogger: jest.fn().mockReturnValue(loggerMock)
    }

    squidsMock = {
      list: jest.fn().mockResolvedValue([]),
      downgrade: jest.fn(),
      promote: jest.fn(),
      purgeOldSchemas: jest.fn()
    }

    slackComponentMock = {
      sendMessage: jest.fn()
    }

    configMock = {
      getString: jest.fn().mockImplementation((key: string) => {
        if (key === 'ENV') {
          return 'prd'
        }
        return 'false'
      })
    } as unknown as IConfigComponent

    process.env.ENV = 'prd'
    process.env.USE_MOCK_SQUIDS = 'false'
    delete process.env.FORCE_ETA_UNAVAILABLE
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('monitorSquids', () => {
    beforeEach(async () => {
      monitorSquids = await createSquidMonitor({ logs: logsMock, squids: squidsMock, config: configMock, slack: slackComponentMock })
    })

    describe('when the active squid has undefined or null ETA on both networks', () => {
      let sendMessageCalls: SendMessageCall[]

      beforeEach(async () => {
        const squidWithoutEta: Squid = {
          name: 'Squid Without ETA',
          service_name: 'squid-without-eta',
          schema_name: 'active-schema',
          project_active_schema: 'active-schema',
          created_at: undefined,
          health_status: undefined,
          service_status: undefined,
          version: 1,
          metrics: {
            [Network.ETHEREUM]: {
              sqd_processor_sync_eta_seconds: null as unknown as number,
              sqd_processor_last_block: 1000,
              sqd_processor_chain_height: 1010,
              sqd_processor_mapping_blocks_per_second: 5
            },
            [Network.MATIC]: {
              sqd_processor_sync_eta_seconds: undefined as unknown as number,
              sqd_processor_last_block: 2000,
              sqd_processor_chain_height: 2010,
              sqd_processor_mapping_blocks_per_second: 7
            }
          }
        }
        squidsMock.list = jest.fn().mockResolvedValue([squidWithoutEta])

        await monitorSquids()
        sendMessageCalls = (slackComponentMock.sendMessage as jest.Mock).mock.calls
      })

      it('should send one alert per network', () => {
        expect(sendMessageCalls).toHaveLength(2)
      })

      it('should send a "cannot read ETA" alert for Ethereum', () => {
        const call = sendMessageCalls.find(c => c[0].text?.includes('Cannot read ETA') && c[0].text?.includes('ETHEREUM'))
        expect(call).toBeTruthy()
      })

      it('should send a "cannot read ETA" alert for Matic', () => {
        const call = sendMessageCalls.find(c => c[0].text?.includes('Cannot read ETA') && c[0].text?.includes('MATIC'))
        expect(call).toBeTruthy()
      })
    })

    describe('when the active squid is out of sync on Ethereum only', () => {
      let sendMessageCalls: SendMessageCall[]

      beforeEach(async () => {
        const outOfSyncSquid: Squid = {
          name: 'Out of Sync Squid',
          service_name: 'out-of-sync-squid',
          schema_name: 'active-schema',
          project_active_schema: 'active-schema',
          created_at: undefined,
          health_status: undefined,
          service_status: undefined,
          version: 1,
          metrics: {
            [Network.ETHEREUM]: {
              sqd_processor_sync_eta_seconds: ETA_CONSIDERED_OUT_OF_SYNC + 5,
              sqd_processor_last_block: 1000,
              sqd_processor_chain_height: 1020,
              sqd_processor_mapping_blocks_per_second: 8
            },
            [Network.MATIC]: {
              sqd_processor_sync_eta_seconds: 5,
              sqd_processor_last_block: 2000,
              sqd_processor_chain_height: 2005,
              sqd_processor_mapping_blocks_per_second: 12
            }
          }
        }
        squidsMock.list = jest.fn().mockResolvedValue([outOfSyncSquid])

        await monitorSquids()
        sendMessageCalls = (slackComponentMock.sendMessage as jest.Mock).mock.calls
      })

      it('should send exactly one alert', () => {
        expect(sendMessageCalls).toHaveLength(1)
      })

      it('should send a desync alert for Ethereum', () => {
        const call = sendMessageCalls.find(c => c[0].text?.includes('out of sync') && c[0].text?.includes('ETHEREUM'))
        expect(call).toBeTruthy()
      })

      it('should include the current ETA value in the desync alert', () => {
        const call = sendMessageCalls.find(c => c[0].text?.includes('out of sync') && c[0].text?.includes('ETHEREUM'))
        const hasCurrentEta = call?.[0].blocks?.some(
          block =>
            block.type === 'section' &&
            block.fields !== undefined &&
            block.fields.some(field => field.text.includes('Current ETA') && field.text.includes('5 seconds'))
        )
        expect(hasCurrentEta).toBe(true)
      })
    })

    describe('when every active squid has an ETA at or below the threshold', () => {
      beforeEach(async () => {
        const synchronizedSquid: Squid = {
          name: 'Synchronized Squid',
          service_name: 'synchronized-squid',
          schema_name: 'active-schema',
          project_active_schema: 'active-schema',
          created_at: undefined,
          health_status: undefined,
          service_status: undefined,
          version: 1,
          metrics: {
            [Network.ETHEREUM]: {
              sqd_processor_sync_eta_seconds: 5,
              sqd_processor_last_block: 1000,
              sqd_processor_chain_height: 1005,
              sqd_processor_mapping_blocks_per_second: 10
            },
            [Network.MATIC]: {
              sqd_processor_sync_eta_seconds: 3,
              sqd_processor_last_block: 2000,
              sqd_processor_chain_height: 2002,
              sqd_processor_mapping_blocks_per_second: 15
            }
          }
        }
        squidsMock.list = jest.fn().mockResolvedValue([synchronizedSquid])

        await monitorSquids()
      })

      it('should not send any slack alerts', () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(slackComponentMock.sendMessage).not.toHaveBeenCalled()
      })
    })

    describe('when the active squid has no metrics on either network', () => {
      const serviceName = 'squid-without-metrics'
      const ethereumKey = `${serviceName}-ETHEREUM-no-metrics`
      const maticKey = `${serviceName}-MATIC-no-metrics`

      let squidWithoutMetrics: Squid

      beforeEach(() => {
        squidWithoutMetrics = {
          name: 'Squid Without Metrics',
          service_name: serviceName,
          schema_name: 'active-schema',
          project_active_schema: 'active-schema',
          created_at: undefined,
          health_status: undefined,
          service_status: undefined,
          version: 1,
          metrics: {
            [Network.ETHEREUM]: undefined,
            [Network.MATIC]: undefined
          } as unknown as Record<Network.ETHEREUM | Network.MATIC, SquidMetric>
        }
        squidsMock.list = jest.fn().mockResolvedValue([squidWithoutMetrics])
      })

      describe('and it is the first detection', () => {
        beforeEach(async () => {
          await monitorSquids()
        })

        it('should not send any slack alerts', () => {
          // eslint-disable-next-line @typescript-eslint/unbound-method
          expect(slackComponentMock.sendMessage).not.toHaveBeenCalled()
        })

        it('should warn that metrics are missing on Ethereum', () => {
          expect(loggerMock.warn).toHaveBeenCalledWith(`No metrics found for squid ${serviceName} on network ETHEREUM`)
        })

        it('should warn that metrics are missing on Matic', () => {
          expect(loggerMock.warn).toHaveBeenCalledWith(`No metrics found for squid ${serviceName} on network MATIC`)
        })

        it('should log that it will send an alert after 5 minutes for Ethereum', () => {
          expect(loggerMock.info).toHaveBeenCalledWith(
            `First detection of no metrics for ${serviceName} on ETHEREUM. Will send alert after 5 minutes.`
          )
        })

        it('should log that it will send an alert after 5 minutes for Matic', () => {
          expect(loggerMock.info).toHaveBeenCalledWith(
            `First detection of no metrics for ${serviceName} on MATIC. Will send alert after 5 minutes.`
          )
        })

        it('should record the first-detection timestamp for both networks', () => {
          expect(noMetricsFirstDetected.size).toBe(2)
          expect(noMetricsFirstDetected.has(ethereumKey)).toBe(true)
          expect(noMetricsFirstDetected.has(maticKey)).toBe(true)
        })
      })

      describe('and more than 5 minutes have passed since the first detection', () => {
        let sendMessageCalls: SendMessageCall[]

        beforeEach(async () => {
          const fiveMinutesAgo = Date.now() - FIVE_MINUTES - 1000
          noMetricsFirstDetected.set(ethereumKey, fiveMinutesAgo)
          noMetricsFirstDetected.set(maticKey, fiveMinutesAgo)

          await monitorSquids()
          sendMessageCalls = (slackComponentMock.sendMessage as jest.Mock).mock.calls
        })

        it('should send one slack alert per network', () => {
          expect(sendMessageCalls).toHaveLength(2)
        })

        it('should send a "no metrics found" alert for Ethereum', () => {
          const call = sendMessageCalls.find(c => c[0].text?.includes('No metrics found') && c[0].text?.includes('ETHEREUM'))
          expect(call).toBeTruthy()
        })

        it('should send a "no metrics found" alert for Matic', () => {
          const call = sendMessageCalls.find(c => c[0].text?.includes('No metrics found') && c[0].text?.includes('MATIC'))
          expect(call).toBeTruthy()
        })

        it('should include the issue duration in the Ethereum alert', () => {
          const call = sendMessageCalls.find(c => c[0].text?.includes('No metrics found') && c[0].text?.includes('ETHEREUM'))
          const hasDuration = call?.[0].blocks?.some(
            block =>
              block.type === 'section' &&
              block.text !== undefined &&
              block.text.text.includes('Issue duration:') &&
              block.text.text.includes('minutes')
          )
          expect(hasDuration).toBe(true)
        })
      })

      describe('and an alert was just sent in the previous tick', () => {
        beforeEach(async () => {
          const fiveMinutesAgo = Date.now() - FIVE_MINUTES - 1000
          noMetricsFirstDetected.set(ethereumKey, fiveMinutesAgo)
          noMetricsFirstDetected.set(maticKey, fiveMinutesAgo)

          await monitorSquids()
          ;(slackComponentMock.sendMessage as jest.Mock).mockClear()

          await monitorSquids()
        })

        it('should not send any additional slack alerts on the second run', () => {
          // eslint-disable-next-line @typescript-eslint/unbound-method
          expect(slackComponentMock.sendMessage).not.toHaveBeenCalled()
        })
      })
    })

    describe('when a previously-alerting squid reports metrics again', () => {
      const serviceName = 'squid-without-metrics'
      const ethereumKey = `${serviceName}-ETHEREUM-no-metrics`
      const maticKey = `${serviceName}-MATIC-no-metrics`

      beforeEach(async () => {
        const recoveredSquid: Squid = {
          name: 'Squid Without Metrics',
          service_name: serviceName,
          schema_name: 'active-schema',
          project_active_schema: 'active-schema',
          created_at: undefined,
          health_status: undefined,
          service_status: undefined,
          version: 1,
          metrics: {
            [Network.ETHEREUM]: {
              sqd_processor_sync_eta_seconds: 5,
              sqd_processor_last_block: 1000,
              sqd_processor_chain_height: 1005,
              sqd_processor_mapping_blocks_per_second: 10
            },
            [Network.MATIC]: {
              sqd_processor_sync_eta_seconds: 3,
              sqd_processor_last_block: 2000,
              sqd_processor_chain_height: 2002,
              sqd_processor_mapping_blocks_per_second: 15
            }
          }
        }
        noMetricsFirstDetected.set(ethereumKey, Date.now())
        noMetricsFirstDetected.set(maticKey, Date.now())
        squidsMock.list = jest.fn().mockResolvedValue([recoveredSquid])

        await monitorSquids()
      })

      it('should clear the throttle state for both networks', () => {
        expect(noMetricsFirstDetected.size).toBe(0)
      })

      it('should log that metrics recovered for Ethereum', () => {
        expect(loggerMock.info).toHaveBeenCalledWith(`Metrics recovered for ${serviceName} on ETHEREUM. Clearing throttle state.`)
      })

      it('should log that metrics recovered for Matic', () => {
        expect(loggerMock.info).toHaveBeenCalledWith(`Metrics recovered for ${serviceName} on MATIC. Clearing throttle state.`)
      })
    })
  })
})
