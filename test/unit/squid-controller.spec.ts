import { DescribeServicesCommand, ECSClient, ListServicesCommand, ListTasksCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs'
import { IConfigComponent, IFetchComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { IPgComponent } from '@dcl/pg-component'
import { createSubsquidComponent } from '../../src/ports/squids/component'
import { getPromoteQuery } from '../../src/ports/squids/queries'
import { PurgeResult, Squid } from '../../src/ports/squids/types'

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

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('list', () => {
    describe('when there is one running squid service with metrics on Ethereum', () => {
      let result: Squid[]

      beforeEach(async () => {
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
          .mockResolvedValueOnce({ serviceArns: ['arn:aws:squid-service'] })
          .mockResolvedValueOnce({ services })
          .mockResolvedValueOnce({ taskArns: ['arn:aws:ecs:task/test'] })
          .mockResolvedValueOnce({ tasks })
        ;(fetchMock.fetch as jest.Mock).mockResolvedValue({
          text: jest.fn().mockResolvedValue(`
            sqd_processor_last_block 1000
            sqd_processor_sync_eta_seconds 120
          `)
        })
        ;(dappsDatabaseMock.query as jest.Mock)
          .mockResolvedValueOnce({ rows: [{ schema: 'test-schema' }] })
          .mockResolvedValueOnce({ rows: [{ schema: 'active-schema' }] })

        const subsquid = await createSubsquidComponent({
          fetch: fetchMock,
          dappsDatabase: dappsDatabaseMock,
          creditsDatabase: creditsDatabaseMock,
          config: configMock,
          logs: logsMock
        })
        result = await subsquid.list()
      })

      it('should return the squid populated with its schema info and Ethereum metrics', () => {
        expect(result).toHaveLength(1)
        expect(result[0]).toMatchObject({
          name: 'test-squid-service',
          schema_name: 'test-schema',
          project_active_schema: 'active-schema'
        })
        expect(result[0].metrics?.ETHEREUM?.sqd_processor_last_block).toBe(1000)
        expect(result[0].metrics?.ETHEREUM?.sqd_processor_sync_eta_seconds).toBe(120)
      })
    })
  })

  describe('promote', () => {
    describe('when promoting a dapps-backed squid service', () => {
      beforeEach(async () => {
        ;(getPromoteQuery as jest.Mock).mockReturnValue('PROMOTE QUERY')
        ;(dappsDatabaseMock.query as jest.Mock).mockResolvedValue({})

        const subsquid = await createSubsquidComponent({
          fetch: fetchMock,
          dappsDatabase: dappsDatabaseMock,
          creditsDatabase: creditsDatabaseMock,
          config: configMock,
          logs: logsMock
        })
        await subsquid.promote('test-service-name')
      })

      it('should build the promote query from the service name with a squid_ schema and the test project', () => {
        expect(getPromoteQuery).toHaveBeenCalledWith('test-service-name', expect.stringMatching(/^squid_/), expect.stringMatching(/^test/))
      })

      it('should execute the promote query against the dapps database', () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(dappsDatabaseMock.query).toHaveBeenCalledWith('PROMOTE QUERY')
      })
    })
  })

  describe('downgrade', () => {
    describe('when downgrading a squid service', () => {
      beforeEach(async () => {
        ;(ecsClientMock.send as jest.Mock).mockResolvedValue({})

        const subsquid = await createSubsquidComponent({
          fetch: fetchMock,
          dappsDatabase: dappsDatabaseMock,
          creditsDatabase: creditsDatabaseMock,
          config: configMock,
          logs: logsMock
        })
        await subsquid.downgrade('test-service-name')
      })

      it('should build an UpdateService command with desiredCount 0 on the configured cluster', () => {
        expect(UpdateServiceCommandMock).toHaveBeenCalledWith({
          cluster: 'test-cluster',
          service: 'test-service-name',
          desiredCount: 0
        })
      })

      it('should send the UpdateService command to ECS', () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(ecsClientMock.send).toHaveBeenCalledWith(expect.any(UpdateServiceCommand))
      })
    })
  })

  describe('purgeOldSchemas', () => {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000
    const OLDER_THAN_MS = 2 * ONE_DAY_MS

    let dappsMock: MockDatabase
    let creditsMock: MockDatabase
    let oldDate: Date

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

    async function buildComponent() {
      return createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        creditsDatabase: creditsDatabaseMock,
        config: configMock,
        logs: logsMock
      })
    }

    beforeEach(() => {
      dappsMock = buildDatabaseMock()
      creditsMock = buildDatabaseMock()
      dappsDatabaseMock = dappsMock as unknown as IPgComponent
      creditsDatabaseMock = creditsMock as unknown as IPgComponent
      dappsMock.query = makeQueryRouter({})
      creditsMock.query = makeQueryRouter({})
      oldDate = new Date(Date.now() - 10 * ONE_DAY_MS)
    })

    describe('when ECS reports no running squid services', () => {
      let result: PurgeResult

      beforeEach(async () => {
        ;(ecsClientMock.send as jest.Mock).mockImplementation(async (cmd: unknown) => {
          if (cmd instanceof ListServicesCommand) return { serviceArns: [] }
          return {}
        })

        const subsquid = await buildComponent()
        result = await subsquid.purgeOldSchemas({ olderThanMs: OLDER_THAN_MS })
      })

      it('should return an empty deleted and skipped result', () => {
        expect(result).toEqual({ deleted: [], skipped: [] })
      })

      it('should not query the dapps database', () => {
        expect(dappsMock.query).not.toHaveBeenCalled()
      })

      it('should not query the credits database', () => {
        expect(creditsMock.query).not.toHaveBeenCalled()
      })
    })

    describe('when the ECS call to list running services throws', () => {
      let result: PurgeResult

      beforeEach(async () => {
        ;(ecsClientMock.send as jest.Mock).mockRejectedValue(new Error('ECS down'))

        const subsquid = await buildComponent()
        result = await subsquid.purgeOldSchemas({ olderThanMs: OLDER_THAN_MS })
      })

      it('should return an empty deleted and skipped result', () => {
        expect(result).toEqual({ deleted: [], skipped: [] })
      })

      it('should not open a transaction on the dapps database', () => {
        expect(dappsMock.withTransaction).not.toHaveBeenCalled()
      })
    })

    describe('when a service is running and the dapps database holds a mix of schema kinds', () => {
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
            { schema_name: 'squid_old_orphan' }, // old, not in use, not running — should be deleted
            { schema_name: 'squid_active' }, // currently promoted — skipped as 'active'
            { schema_name: 'squid_running_latest' }, // latest for a running service — skipped as 'running-service'
            { schema_name: 'squid_no_history' } // no indexers row — silently ignored
          ],
          indexerAges: [
            { schema: 'squid_old_orphan', max_created_at: oldDate },
            { schema: 'squid_active', max_created_at: oldDate },
            { schema: 'squid_running_latest', max_created_at: oldDate }
          ],
          activeSchemas: [{ schema: 'squid_active' }],
          latestBySvc: { 'marketplace-squid-server-a': 'squid_running_latest' }
        })
      })

      describe('and dryRun is false', () => {
        let result: PurgeResult

        beforeEach(async () => {
          const subsquid = await buildComponent()
          result = await subsquid.purgeOldSchemas({ olderThanMs: OLDER_THAN_MS })
        })

        it('should delete only the old orphan schema', () => {
          expect(result.deleted).toHaveLength(1)
          expect(result.deleted[0]).toMatchObject({ database: 'dapps', schema: 'squid_old_orphan' })
        })

        it('should report the actively promoted schema as skipped with reason "active"', () => {
          expect(result.skipped).toContainEqual(expect.objectContaining({ schema: 'squid_active', reason: 'active' }))
        })

        it('should report the running-service schema as skipped with reason "running-service"', () => {
          expect(result.skipped).toContainEqual(expect.objectContaining({ schema: 'squid_running_latest', reason: 'running-service' }))
        })

        it('should silently ignore the schema without any indexers history', () => {
          expect(result.skipped).toHaveLength(2)
          expect(result.skipped).not.toContainEqual(expect.objectContaining({ schema: 'squid_no_history' }))
        })

        it('should open exactly one transaction on the dapps database', () => {
          expect(dappsMock.withTransaction).toHaveBeenCalledTimes(1)
        })

        it('should DROP the orphan schema first inside the transaction', () => {
          expect(dappsMock.txClient.query).toHaveBeenNthCalledWith(1, expect.stringContaining('DROP SCHEMA'))
        })

        it('should DELETE the orphan schema rows from public.indexers after the DROP', () => {
          expect(dappsMock.txClient.query).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ text: expect.stringContaining('DELETE FROM public.indexers') })
          )
        })
      })

      describe('and dryRun is true', () => {
        let result: PurgeResult

        beforeEach(async () => {
          const subsquid = await buildComponent()
          result = await subsquid.purgeOldSchemas({ olderThanMs: OLDER_THAN_MS, dryRun: true })
        })

        it('should still report the orphan schema as a deletion candidate', () => {
          expect(result.deleted).toHaveLength(1)
          expect(result.deleted[0].schema).toBe('squid_old_orphan')
        })

        it('should not open any transaction on the dapps database', () => {
          expect(dappsMock.withTransaction).not.toHaveBeenCalled()
        })
      })
    })
  })
})
