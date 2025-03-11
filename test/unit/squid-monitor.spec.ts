import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { Network } from '@dcl/schemas'
import { createJobComponent } from '../../src/ports/job/component'
import { createSquidMonitorJob, ETA_CONSIDERED_OUT_OF_SYNC } from '../../src/ports/job/squid-monitor'
import { ISlackComponent, SlackMessageBlock } from '../../src/ports/slack/component'
import { ISquidComponent, Squid } from '../../src/ports/squids/types'

jest.mock('../../src/ports/job/component')

describe('Squid Monitor', () => {
  let logsMock: ILoggerComponent
  let loggerMock: { info: jest.Mock; error: jest.Mock }
  let squidsMock: ISquidComponent
  let configMock: IConfigComponent
  let slackComponentMock: ISlackComponent
  let mockSquids: Squid[]
  let jobFunction: () => Promise<void>

  beforeEach(() => {
    // Mock the logger
    loggerMock = {
      info: jest.fn(),
      error: jest.fn()
    }
    logsMock = {
      getLogger: jest.fn().mockReturnValue(loggerMock)
    } as unknown as ILoggerComponent

    // Mock the squids component
    squidsMock = {
      list: jest.fn().mockResolvedValue([]),
      downgrade: jest.fn(),
      promote: jest.fn()
    }

    // Mock the Slack component
    slackComponentMock = {
      sendMessage: jest.fn(),
      sendFormattedMessage: jest.fn(),
      start: jest.fn(),
      stop: jest.fn()
    } as unknown as ISlackComponent

    // Mock the config component
    configMock = {
      getString: jest.fn().mockImplementation((key: string) => {
        if (key === 'ENV') {
          return 'prd'
        }
        return 'false'
      })
    } as unknown as IConfigComponent

    // Mock the job component
    ;(createJobComponent as jest.Mock).mockImplementation(
      (_components: Record<string, unknown>, fn: () => Promise<void>, _interval: number, _options: Record<string, unknown>) => {
        jobFunction = fn
        return {
          start: jest.fn(),
          stop: jest.fn()
        }
      }
    )

    // Create test squids
    mockSquids = [
      {
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
      },
      {
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
      },
      {
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
    ]

    // Configure development environment for tests
    process.env.ENV = 'prd'
    process.env.USE_MOCK_SQUIDS = 'false'
    delete process.env.FORCE_ETA_UNAVAILABLE
  })

  afterEach(() => {
    // Clean all mocks
    jest.clearAllMocks()
  })

  describe('createSquidMonitorJob', () => {
    it('should create a job component with the correct parameters', async () => {
      const components = { logs: logsMock, squids: squidsMock, config: configMock, slack: slackComponentMock }

      await createSquidMonitorJob(components)

      // Verify that createJobComponent was called
      expect(createJobComponent).toHaveBeenCalled()

      // Verify that the correct components were passed
      const callArgs = (createJobComponent as jest.Mock).mock.calls[0]
      expect(callArgs[0]).toBe(components)

      // Verify that a function was passed as the second argument
      expect(typeof callArgs[1]).toBe('function')

      // Verify that the interval of one minute (60000 ms) was passed
      expect(callArgs[2]).toBe(60000)

      // Verify that the correct options were passed
      expect(callArgs[3]).toEqual({
        repeat: true,
        startupDelay: 0,
        onError: expect.any(Function)
      })
    })
  })

  describe('monitorSquids', () => {
    beforeEach(async () => {
      const components = { logs: logsMock, squids: squidsMock, config: configMock, slack: slackComponentMock }
      await createSquidMonitorJob(components)
    })

    describe('when squids have undefined or null ETA', () => {
      beforeEach(() => {
        // Configure the mock to return a squid with unavailable ETA
        squidsMock.list = jest.fn().mockResolvedValue([mockSquids[0]])
      })

      it('should send alerts for each network with unavailable ETA', async () => {
        // Execute the monitoring function
        await jobFunction()

        // Verify that sendFormattedMessage was called for the squid without ETA (twice, once for each network)
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(slackComponentMock.sendFormattedMessage).toHaveBeenCalledTimes(2)

        // Verify that the messages contain the correct information for unavailable ETA
        const calls = (slackComponentMock.sendFormattedMessage as jest.Mock).mock.calls

        // Verify that at least one of the messages is for unavailable ETA on Ethereum
        const etaUnavailableEthereumCall = calls.find(
          (call: [{ text: string; blocks?: SlackMessageBlock[] }]) =>
            call[0].text && call[0].text.includes('Cannot read ETA') && call[0].text.includes('ETHEREUM')
        )
        expect(etaUnavailableEthereumCall).toBeTruthy()

        // Verify that at least one of the messages is for unavailable ETA on Matic
        const etaUnavailableMaticCall = calls.find(
          (call: [{ text: string; blocks?: SlackMessageBlock[] }]) =>
            call[0].text && call[0].text.includes('Cannot read ETA') && call[0].text.includes('MATIC')
        )
        expect(etaUnavailableMaticCall).toBeTruthy()
      })
    })

    describe('when squids have ETA > ETA_CONSIDERED_OUT_OF_SYNC seconds', () => {
      beforeEach(() => {
        // Configure the mock to return an out of sync squid
        squidsMock.list = jest.fn().mockResolvedValue([mockSquids[1]])
      })

      it('should send alerts for networks with ETA > ETA_CONSIDERED_OUT_OF_SYNC seconds', async () => {
        // Execute the monitoring function
        await jobFunction()

        // Verify that sendFormattedMessage was called for the out of sync squid (only on Ethereum)
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(slackComponentMock.sendFormattedMessage).toHaveBeenCalledTimes(1)

        // Verify that the messages contain the correct information for desynchronization
        const calls = (slackComponentMock.sendFormattedMessage as jest.Mock).mock.calls

        // Verify that the message is for desynchronization on Ethereum
        const desyncCall = calls.find(
          (call: [{ text: string; blocks?: SlackMessageBlock[] }]) =>
            call[0].text && call[0].text.includes('out of sync') && call[0].text.includes('ETHEREUM')
        )
        expect(desyncCall).toBeTruthy()

        // Verify that the message contains the correct information
        expect(
          desyncCall &&
            desyncCall[0].blocks?.some(
              (block: SlackMessageBlock) =>
                block.type === 'section' &&
                block.fields &&
                block.fields.some(field => field.text.includes('Current ETA') && field.text.includes('5 seconds'))
            )
        ).toBeTruthy()
      })
    })

    describe('when squids have ETA <= 10 seconds', () => {
      beforeEach(() => {
        // Configure the mock to return a synchronized squid
        squidsMock.list = jest.fn().mockResolvedValue([mockSquids[2]])
      })

      it('should not send any alerts', async () => {
        // Execute the monitoring function
        await jobFunction()

        // Verify that no messages were sent
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(slackComponentMock.sendFormattedMessage).not.toHaveBeenCalled()
      })
    })
  })
})
