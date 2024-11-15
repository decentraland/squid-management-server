import { ECSClient, UpdateServiceCommand } from '@aws-sdk/client-ecs'
import { IFetchComponent, IConfigComponent } from '@well-known-components/interfaces'
import { IPgComponent } from '@well-known-components/pg-component'
import { createSubsquidComponent } from '../../src/ports/squids/component'
import { getPromoteQuery } from '../../src/ports/squids/queries'

jest.mock('@aws-sdk/client-ecs')
jest.mock('../../src/ports/squids/queries')

describe('createSubsquidComponent', () => {
  let fetchMock: IFetchComponent
  let dappsDatabaseMock: IPgComponent
  let configMock: IConfigComponent
  let ecsClientMock: ECSClient

  beforeEach(() => {
    fetchMock = { fetch: jest.fn() } as IFetchComponent
    dappsDatabaseMock = { query: jest.fn() } as unknown as IPgComponent
    configMock = { requireString: jest.fn().mockResolvedValue('test-cluster') } as unknown as IConfigComponent

    ecsClientMock = new ECSClient({ region: 'us-east-1' })
    ;(ECSClient as jest.Mock).mockImplementation(() => ecsClientMock)
  })

  describe('list', () => {
    it('should list squid services', async () => {
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
        text: jest.fn().mockResolvedValue('sqd_processor_last_block 1000')
      })

      const subsquid = await createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        config: configMock
      })
      const result = await subsquid.list()

      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('test-squid-service')
      expect(result[0].metrics?.ETHEREUM?.sqd_processor_last_block).toBe(1000)
    })
  })

  describe('promote', () => {
    it('should execute the promote query', async () => {
      ;(getPromoteQuery as jest.Mock).mockReturnValue('PROMOTE QUERY')
      ;(dappsDatabaseMock.query as jest.Mock).mockResolvedValue({})

      const subsquid = await createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        config: configMock
      })
      await subsquid.promote('test-service-name')

      expect(getPromoteQuery).toHaveBeenCalledWith('test-service-name', expect.any(String), expect.any(String))
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(dappsDatabaseMock.query).toHaveBeenCalledWith('PROMOTE QUERY')
    })
  })

  describe('downgrade', () => {
    it('should set desiredCount to 0', async () => {
      ;(ecsClientMock.send as jest.Mock).mockResolvedValue({})

      const subsquid = await createSubsquidComponent({
        fetch: fetchMock,
        dappsDatabase: dappsDatabaseMock,
        config: configMock
      })
      await subsquid.downgrade('test-service-name')

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(ecsClientMock.send).toHaveBeenCalledWith(expect.any(UpdateServiceCommand))
    })
  })
})
