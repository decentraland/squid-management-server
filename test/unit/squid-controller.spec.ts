import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs'
import { IFetchComponent, IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { IPgComponent } from '@well-known-components/pg-component'
import { createSubsquidComponent } from '../../src/ports/squids/component'
import { getPromoteQuery } from '../../src/ports/squids/queries'

jest.mock('@aws-sdk/client-ecs')
jest.mock('../../src/ports/squids/queries')

describe('createSubsquidComponent', () => {
  let fetchMock: IFetchComponent
  let dappsDatabaseMock: IPgComponent
  let creditsDatabaseMock: IPgComponent
  let configMock: IConfigComponent
  let ecsClientMock: ECSClient
  let UpdateServiceCommandMock: jest.Mock
  let logsMock: ILoggerComponent

  beforeEach(() => {
    fetchMock = { fetch: jest.fn() } as IFetchComponent
    dappsDatabaseMock = { query: jest.fn() } as unknown as IPgComponent
    creditsDatabaseMock = { query: jest.fn() } as unknown as IPgComponent
    configMock = { requireString: jest.fn().mockResolvedValue('test-cluster') } as unknown as IConfigComponent
    logsMock = {
      getLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn()
      })
    } as unknown as ILoggerComponent

    ecsClientMock = new ECSClient({ region: 'us-east-1' })
    ;(ECSClient as jest.Mock).mockImplementation(() => ecsClientMock)

    UpdateServiceCommandMock = jest.fn()
    ;(UpdateServiceCommand as unknown as jest.Mock).mockImplementation(UpdateServiceCommandMock)
  })

  describe('list', () => {
    beforeEach(() => {
      const services = [{ serviceName: 'test-squid-service' }]
      const tasks = [
        {
          version: 1,
          createdAt: new Date(),
          healthStatus: 'HEALTHY',
          lastStatus: 'RUNNING',
          attachments: [
            {
              type: 'ElasticNetworkInterface',
              details: [{ name: 'privateIPv4Address', value: '127.0.0.1' }]
            }
          ]
        }
      ]

      ;(ecsClientMock.send as jest.Mock)
        .mockResolvedValueOnce({ serviceArns: ['arn:aws:squid-service'] }) // ListServicesCommand
        .mockResolvedValueOnce({ services }) // DescribeServicesCommand
        .mockResolvedValueOnce({ taskArns: ['arn:aws:ecs:task/test'] }) // ListTasksCommand
        .mockResolvedValueOnce({ tasks }) // DescribeTasksCommand
      ;(fetchMock.fetch as jest.Mock).mockResolvedValue({
        text: jest.fn().mockResolvedValue(`
          sqd_processor_last_block 1000
          sqd_processor_sync_eta_seconds 120
        `)
      })
      ;(dappsDatabaseMock.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ schema: 'test-schema' }] }) // getSchemaByServiceNameQuery
        .mockResolvedValueOnce({ rows: [{ schema: 'active-schema' }] }) // getActiveSchemaQuery
    })

    it('should list squid services and fetch metrics in parallel', async () => {
      const subsquid = await createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        creditsDatabase: creditsDatabaseMock,
        config: configMock,
        logs: logsMock
      })

      const result = await subsquid.list()

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('test-squid-service')
      expect(result[0].schema_name).toBe('test-schema')
      expect(result[0].project_active_schema).toBe('active-schema')
      expect(result[0].metrics?.ETHEREUM?.sqd_processor_last_block).toBe(1000)
      expect(result[0].metrics?.ETHEREUM?.sqd_processor_sync_eta_seconds).toBe(120)
    })
  })

  describe('promote', () => {
    beforeEach(() => {
      ;(getPromoteQuery as jest.Mock).mockReturnValue('PROMOTE QUERY')
      ;(dappsDatabaseMock.query as jest.Mock).mockResolvedValue({})
    })

    it('should execute the promote query', async () => {
      const subsquid = await createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        creditsDatabase: creditsDatabaseMock,
        config: configMock,
        logs: logsMock
      })

      await subsquid.promote('test-service-name')

      expect(getPromoteQuery).toHaveBeenCalledWith(
        'test-service-name',
        expect.stringMatching(/^squid_/), // Ensures schema name starts with "squid_"
        expect.stringMatching(/^test/) // Ensures project name starts with "test"
      )
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(dappsDatabaseMock.query).toHaveBeenCalledWith('PROMOTE QUERY')
    })
  })

  describe('downgrade', () => {
    beforeEach(() => {
      ;(ecsClientMock.send as jest.Mock).mockResolvedValue({})
    })

    it('should set desiredCount to 0', async () => {
      const subsquid = await createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        creditsDatabase: creditsDatabaseMock,
        config: configMock,
        logs: logsMock
      })

      await subsquid.downgrade('test-service-name')

      expect(UpdateServiceCommandMock).toHaveBeenCalledWith({
        cluster: 'test-cluster',
        service: 'test-service-name',
        desiredCount: 0
      })

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(ecsClientMock.send).toHaveBeenCalledWith(expect.any(UpdateServiceCommand))
    })
  })
})
