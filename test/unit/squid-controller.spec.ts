import { DescribeServicesCommand, ECSClient, ListServicesCommand, ListTasksCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs'
import { IConfigComponent, IFetchComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { IPgComponent } from '@dcl/pg-component'
import { createSubsquidComponent } from '../../src/ports/squids/component'
import { getPromoteQuery } from '../../src/ports/squids/queries'

type MockDatabase = {
  query: jest.Mock
  withTransaction: jest.Mock
  txClient: { query: jest.Mock }
}

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
    configMock = { requireString: jest.fn().mockResolvedValue('test-cluster') } as unknown as IConfigComponent
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

  describe('purgeOldSchemas', () => {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000
    const OLDER_THAN_MS = 2 * ONE_DAY_MS
    const OLD_DATE = new Date(Date.now() - 10 * ONE_DAY_MS)

    let dappsMock: MockDatabase
    let creditsMock: MockDatabase

    function buildDatabaseMock(): MockDatabase {
      const txClient = { query: jest.fn() }
      const withTransaction = jest.fn().mockImplementation(async (cb: (c: { query: jest.Mock }) => Promise<unknown>) => cb(txClient))
      return { query: jest.fn(), withTransaction, txClient }
    }

    function makeQueryRouter(responses: {
      schemata?: Array<{ schema_name: string }>
      indexerAges?: Array<{ schema: string; max_created_at: Date }>
      activeSchemas?: Array<{ schema: string }>
      latestBySvc?: Record<string, string>
    }): jest.Mock {
      return jest.fn().mockImplementation(async (sql: unknown) => {
        const text = typeof sql === 'string' ? sql : (sql as { text: string }).text
        if (text.includes('information_schema.schemata')) return { rows: responses.schemata ?? [] }
        if (text.includes('MAX(created_at)')) return { rows: responses.indexerAges ?? [] }
        if (text.includes('FROM public.squids')) return { rows: responses.activeSchemas ?? [] }
        if (text.includes('FROM public.indexers WHERE service')) {
          const values = (sql as { values: unknown[] }).values ?? []
          const serviceName = String(values[0] ?? '')
          const schema = responses.latestBySvc?.[serviceName]
          return { rows: schema ? [{ schema }] : [] }
        }
        return { rows: [] }
      })
    }

    beforeEach(() => {
      dappsMock = buildDatabaseMock()
      creditsMock = buildDatabaseMock()
      dappsDatabaseMock = dappsMock as unknown as IPgComponent
      creditsDatabaseMock = creditsMock as unknown as IPgComponent
      // Default: both DBs empty so unscoped tests don't accidentally delete anything.
      dappsMock.query = makeQueryRouter({})
      creditsMock.query = makeQueryRouter({})
    })

    async function buildComponent() {
      return createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        creditsDatabase: creditsDatabaseMock,
        config: configMock,
        logs: logsMock
      })
    }

    describe('when ECS reports no running squid services', () => {
      beforeEach(() => {
        ;(ecsClientMock.send as jest.Mock).mockImplementation(async (cmd: unknown) => {
          if (cmd instanceof ListServicesCommand) return { serviceArns: [] }
          return {}
        })
      })

      it('should abort without querying the databases', async () => {
        const subsquid = await buildComponent()

        const result = await subsquid.purgeOldSchemas({ olderThanMs: OLDER_THAN_MS })

        expect(result).toEqual({ deleted: [], skipped: [] })
        expect(dappsMock.query).not.toHaveBeenCalled()
        expect(creditsMock.query).not.toHaveBeenCalled()
      })
    })

    describe('when getRunningSquidServiceNames throws', () => {
      beforeEach(() => {
        ;(ecsClientMock.send as jest.Mock).mockRejectedValue(new Error('ECS down'))
      })

      it('should abort without deleting anything', async () => {
        const subsquid = await buildComponent()

        const result = await subsquid.purgeOldSchemas({ olderThanMs: OLDER_THAN_MS })

        expect(result).toEqual({ deleted: [], skipped: [] })
        expect(dappsMock.withTransaction).not.toHaveBeenCalled()
      })
    })

    describe('when a service is running and databases hold schemas of different kinds', () => {
      beforeEach(() => {
        ;(ecsClientMock.send as jest.Mock).mockImplementation(async (cmd: unknown) => {
          if (cmd instanceof ListServicesCommand)
            return { serviceArns: ['arn:aws:ecs:us-east-1::service/cluster/marketplace-squid-server-a'] }
          if (cmd instanceof DescribeServicesCommand) return { services: [{ serviceName: 'marketplace-squid-server-a' }] }
          if (cmd instanceof ListTasksCommand) return { taskArns: ['task-arn'] }
          return {}
        })

        dappsMock.query = makeQueryRouter({
          schemata: [
            { schema_name: 'squid_old_orphan' }, // should be deleted
            { schema_name: 'squid_active' }, // promoted — skipped
            { schema_name: 'squid_running_latest' }, // latest for running service — skipped
            { schema_name: 'squid_no_history' } // no indexers row — silently ignored
          ],
          indexerAges: [
            { schema: 'squid_old_orphan', max_created_at: OLD_DATE },
            { schema: 'squid_active', max_created_at: OLD_DATE },
            { schema: 'squid_running_latest', max_created_at: OLD_DATE }
          ],
          activeSchemas: [{ schema: 'squid_active' }],
          latestBySvc: { 'marketplace-squid-server-a': 'squid_running_latest' }
        })
      })

      it('should delete only the old orphan and report the others as skipped', async () => {
        const subsquid = await buildComponent()

        const result = await subsquid.purgeOldSchemas({ olderThanMs: OLDER_THAN_MS })

        expect(result.deleted).toHaveLength(1)
        expect(result.deleted[0]).toMatchObject({ database: 'dapps', schema: 'squid_old_orphan' })
        expect(result.skipped).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ schema: 'squid_active', reason: 'active' }),
            expect.objectContaining({ schema: 'squid_running_latest', reason: 'running-service' })
          ])
        )
        expect(result.skipped).toHaveLength(2)
        expect(dappsMock.withTransaction).toHaveBeenCalledTimes(1)

        expect(dappsMock.txClient.query).toHaveBeenNthCalledWith(1, expect.stringContaining('DROP SCHEMA'))

        expect(dappsMock.txClient.query).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ text: expect.stringContaining('DELETE FROM public.indexers') })
        )
      })

      describe('and dryRun is true', () => {
        it('should report the target as deleted without executing any DROP', async () => {
          const subsquid = await buildComponent()

          const result = await subsquid.purgeOldSchemas({ olderThanMs: OLDER_THAN_MS, dryRun: true })

          expect(result.deleted).toHaveLength(1)
          expect(result.deleted[0].schema).toBe('squid_old_orphan')
          expect(dappsMock.withTransaction).not.toHaveBeenCalled()
        })
      })
    })
  })
})
