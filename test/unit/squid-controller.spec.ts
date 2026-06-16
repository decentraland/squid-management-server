import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs'
import { IConfigComponent, IFetchComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { IPgComponent } from '@dcl/pg-component'
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
    fetchMock = { fetch: jest.fn() }
    dappsDatabaseMock = { query: jest.fn() } as unknown as IPgComponent
    creditsDatabaseMock = { query: jest.fn() } as unknown as IPgComponent
    configMock = {
      requireString: jest.fn().mockResolvedValue('test-cluster'),
      getNumber: jest.fn().mockResolvedValue(undefined)
    } as unknown as IConfigComponent
    logsMock = {
      getLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn()
      })
    }

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

    describe('and the metrics expose both the last block and the chain height', () => {
      beforeEach(() => {
        ;(fetchMock.fetch as jest.Mock).mockResolvedValue({
          text: jest.fn().mockResolvedValue(`
            sqd_processor_last_block 500
            sqd_processor_chain_height 1000
            sqd_processor_sync_eta_seconds 120
          `)
        })
      })

      it('should include the derived sync progress in the metrics', async () => {
        const subsquid = await createSubsquidComponent({
          fetch: fetchMock,
          dappsDatabase: dappsDatabaseMock,
          creditsDatabase: creditsDatabaseMock,
          config: configMock,
          logs: logsMock
        })

        const result = await subsquid.list()

        expect(result[0].metrics?.ETHEREUM?.progress).toBe(50)
      })
    })

    describe('and list is called more than once within the cache window', () => {
      it('should reuse the cached topology and not hit the ECS API again', async () => {
        const subsquid = await createSubsquidComponent({
          fetch: fetchMock,
          dappsDatabase: dappsDatabaseMock,
          creditsDatabase: creditsDatabaseMock,
          config: configMock,
          logs: logsMock
        })

        await subsquid.list()
        const ecsCallsAfterFirstList = (ecsClientMock.send as jest.Mock).mock.calls.length

        await subsquid.list()

        expect((ecsClientMock.send as jest.Mock).mock.calls.length).toBe(ecsCallsAfterFirstList)
      })
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

  describe('isLive', () => {
    it('returns live=true when one of the slot services has its latest schema matching the active schema', async () => {
      ;(dappsDatabaseMock.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ schema: 'marketplace_squid_20250101' }] }) // getActiveSchemaByProjectQuery
        .mockResolvedValueOnce({
          rows: [
            { service: 'marketplace-squid-server-a-blue-92e812a', schema: 'marketplace_squid_20250101' },
            { service: 'marketplace-squid-server-a-green-abc1234', schema: 'marketplace_squid_20250105' }
          ]
        }) // getLatestSlotServicesQuery

      const subsquid = await createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        creditsDatabase: creditsDatabaseMock,
        config: configMock,
        logs: logsMock
      })

      const result = await subsquid.isLive('marketplace', 'a')

      expect(result).toEqual({
        live: true,
        activeSchema: 'marketplace_squid_20250101',
        liveService: 'marketplace-squid-server-a-blue-92e812a',
        services: [
          { service: 'marketplace-squid-server-a-blue-92e812a', schema: 'marketplace_squid_20250101' },
          { service: 'marketplace-squid-server-a-green-abc1234', schema: 'marketplace_squid_20250105' }
        ]
      })
    })

    it('returns live=false when no slot service matches the active schema', async () => {
      ;(dappsDatabaseMock.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ schema: 'marketplace_squid_20250101' }] })
        .mockResolvedValueOnce({
          rows: [{ service: 'marketplace-squid-server-b-blue-1', schema: 'marketplace_squid_20250105' }]
        })

      const subsquid = await createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        creditsDatabase: creditsDatabaseMock,
        config: configMock,
        logs: logsMock
      })

      const result = await subsquid.isLive('marketplace', 'b')

      expect(result.live).toBe(false)
      expect(result.liveService).toBeNull()
      expect(result.activeSchema).toBe('marketplace_squid_20250101')
    })

    it('returns live=false when project has no entry in squids table', async () => {
      ;(dappsDatabaseMock.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [] }) // no active schema
        .mockResolvedValueOnce({
          rows: [{ service: 'marketplace-squid-server-a-blue-1', schema: 'marketplace_squid_20250101' }]
        })

      const subsquid = await createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        creditsDatabase: creditsDatabaseMock,
        config: configMock,
        logs: logsMock
      })

      const result = await subsquid.isLive('marketplace', 'a')

      expect(result).toEqual({
        live: false,
        activeSchema: null,
        liveService: null,
        services: [{ service: 'marketplace-squid-server-a-blue-1', schema: 'marketplace_squid_20250101' }]
      })
    })

    it('returns live=false with empty services when slot has no indexer rows', async () => {
      ;(dappsDatabaseMock.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [{ schema: 'marketplace_squid_20250101' }] })
        .mockResolvedValueOnce({ rows: [] })

      const subsquid = await createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        creditsDatabase: creditsDatabaseMock,
        config: configMock,
        logs: logsMock
      })

      const result = await subsquid.isLive('marketplace', 'a')

      expect(result).toEqual({
        live: false,
        activeSchema: 'marketplace_squid_20250101',
        liveService: null,
        services: []
      })
    })

    it('routes to creditsDatabase when project is "credits"', async () => {
      ;(creditsDatabaseMock.query as jest.Mock).mockResolvedValueOnce({ rows: [{ schema: 'squid_credits' }] }).mockResolvedValueOnce({
        rows: [{ service: 'credits-squid-server-a-blue-1', schema: 'squid_credits' }]
      })

      const subsquid = await createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        creditsDatabase: creditsDatabaseMock,
        config: configMock,
        logs: logsMock
      })

      const result = await subsquid.isLive('credits', 'a')

      expect(result.live).toBe(true)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(creditsDatabaseMock.query).toHaveBeenCalledTimes(2)
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(dappsDatabaseMock.query).not.toHaveBeenCalled()
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

  describe('topology cache invalidation', () => {
    let services: { serviceName: string }[]
    let tasks: unknown[]

    beforeEach(() => {
      services = [{ serviceName: 'test-squid-service' }]
      tasks = [
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
      ;(fetchMock.fetch as jest.Mock).mockResolvedValue({
        text: jest.fn().mockResolvedValue('sqd_processor_last_block 1000')
      })
      ;(dappsDatabaseMock.query as jest.Mock).mockResolvedValue({ rows: [{ schema: 'test-schema' }] })
    })

    describe('when a squid is downgraded after the topology was cached', () => {
      beforeEach(() => {
        ;(ecsClientMock.send as jest.Mock)
          .mockResolvedValueOnce({ serviceArns: ['arn:aws:squid-service'] }) // list #1 - ListServices
          .mockResolvedValueOnce({ services }) // list #1 - DescribeServices
          .mockResolvedValueOnce({ taskArns: ['arn:aws:ecs:task/test'] }) // list #1 - ListTasks
          .mockResolvedValueOnce({ tasks }) // list #1 - DescribeTasks
          .mockResolvedValueOnce({}) // downgrade - UpdateService
          .mockResolvedValueOnce({ serviceArns: ['arn:aws:squid-service'] }) // list #2 - ListServices
          .mockResolvedValueOnce({ services }) // list #2 - DescribeServices
          .mockResolvedValueOnce({ taskArns: ['arn:aws:ecs:task/test'] }) // list #2 - ListTasks
          .mockResolvedValueOnce({ tasks }) // list #2 - DescribeTasks
      })

      it('should re-discover the topology on the next list call', async () => {
        const subsquid = await createSubsquidComponent({
          fetch: fetchMock,
          dappsDatabase: dappsDatabaseMock,
          creditsDatabase: creditsDatabaseMock,
          config: configMock,
          logs: logsMock
        })

        await subsquid.list()
        await subsquid.downgrade('test-squid-service')
        await subsquid.list()

        // 4 (first discovery) + 1 (downgrade) + 4 (re-discovery) = 9 ECS calls
        expect((ecsClientMock.send as jest.Mock).mock.calls.length).toBe(9)
      })
    })

    describe('when the cache is invalidated while a discovery is still in flight', () => {
      let resolveHeldDescribe: (value: unknown) => void

      beforeEach(() => {
        ;(getPromoteQuery as jest.Mock).mockReturnValue('PROMOTE QUERY')
        ;(ecsClientMock.send as jest.Mock)
          .mockResolvedValueOnce({ serviceArns: ['arn:aws:squid-service'] }) // list #1 - ListServices
          .mockImplementationOnce(
            () =>
              new Promise(resolve => {
                resolveHeldDescribe = resolve
              })
          ) // list #1 - DescribeServices (held in flight)
          .mockResolvedValueOnce({ taskArns: ['arn:aws:ecs:task/test'] }) // list #1 - ListTasks
          .mockResolvedValueOnce({ tasks }) // list #1 - DescribeTasks
          .mockResolvedValueOnce({ serviceArns: ['arn:aws:squid-service'] }) // list #2 - ListServices
          .mockResolvedValueOnce({ services }) // list #2 - DescribeServices
          .mockResolvedValueOnce({ taskArns: ['arn:aws:ecs:task/test'] }) // list #2 - ListTasks
          .mockResolvedValueOnce({ tasks }) // list #2 - DescribeTasks
      })

      it('should not resurrect the stale topology and re-discover on the next list', async () => {
        const subsquid = await createSubsquidComponent({
          fetch: fetchMock,
          dappsDatabase: dappsDatabaseMock,
          creditsDatabase: creditsDatabaseMock,
          config: configMock,
          logs: logsMock
        })

        // Start a discovery that parks on the held DescribeServices call.
        const firstList = subsquid.list()
        await new Promise(resolve => setImmediate(resolve))

        // Invalidate the cache (promote performs no ECS calls) while the discovery is in flight.
        await subsquid.promote('test-squid-service')

        // Let the in-flight discovery finish; its result must NOT be written back to the cache.
        resolveHeldDescribe({ services })
        await firstList

        // The next list must re-discover instead of serving the stale in-flight result.
        await subsquid.list()

        // list #1 (4) + list #2 re-discovery (4) = 8 ECS calls; promote adds none.
        expect((ecsClientMock.send as jest.Mock).mock.calls.length).toBe(8)
      })
    })
  })
})
