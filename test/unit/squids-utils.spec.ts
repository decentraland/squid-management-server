import { Network } from '@dcl/schemas'
import { AVERAGE_BLOCK_TIME_SECONDS, computeSyncProgress, formatDuration, getBlocksBehind } from '../../src/ports/squids/utils'

describe('computeSyncProgress', () => {
  describe('when the chain height is zero', () => {
    it('should return 0 to avoid dividing by zero', () => {
      expect(computeSyncProgress(1000, 0)).toBe(0)
    })
  })

  describe('when the chain height is negative', () => {
    it('should return 0', () => {
      expect(computeSyncProgress(1000, -10)).toBe(0)
    })
  })

  describe('when the last processed block is behind the chain height', () => {
    it('should return the percentage rounded to two decimals', () => {
      expect(computeSyncProgress(500, 1000)).toBe(50)
    })

    describe('and the division is not exact', () => {
      it('should round the percentage to two decimals', () => {
        expect(computeSyncProgress(1000, 1010)).toBe(99.01)
      })
    })
  })

  describe('when the last processed block equals the chain height', () => {
    it('should return 100', () => {
      expect(computeSyncProgress(1000, 1000)).toBe(100)
    })
  })

  describe('when the last processed block is ahead of the chain height', () => {
    it('should cap the progress at 100', () => {
      expect(computeSyncProgress(1100, 1000)).toBe(100)
    })
  })
})

describe('getBlocksBehind', () => {
  describe('when the last processed block is behind the chain height', () => {
    it('should return the difference', () => {
      expect(getBlocksBehind(88943857, 88945450)).toBe(1593)
    })
  })

  describe('when the last processed block is at the chain height', () => {
    it('should return 0', () => {
      expect(getBlocksBehind(1000, 1000)).toBe(0)
    })
  })

  describe('when the last processed block is ahead of a stale chain height', () => {
    it('should clamp to 0 instead of going negative', () => {
      expect(getBlocksBehind(1010, 1000)).toBe(0)
    })
  })
})

describe('formatDuration', () => {
  describe('when the duration is non-positive', () => {
    it('should return "0s"', () => {
      expect(formatDuration(0)).toBe('0s')
    })

    describe('and the value is negative', () => {
      it('should return "0s"', () => {
        expect(formatDuration(-5)).toBe('0s')
      })
    })
  })

  describe('when the duration is under a minute', () => {
    it('should return only seconds', () => {
      expect(formatDuration(45)).toBe('45s')
    })
  })

  describe('when the duration spans minutes and seconds', () => {
    it('should return the two most significant units', () => {
      expect(formatDuration(105)).toBe('1m 45s')
    })
  })

  describe('when the duration spans hours and minutes', () => {
    it('should return the two most significant units and drop the seconds', () => {
      expect(formatDuration(4395.8)).toBe('1h 13m')
    })
  })

  describe('when a unit in the middle is zero', () => {
    it('should drop the zero unit instead of printing it', () => {
      expect(formatDuration(3605)).toBe('1h')
    })
  })
})

describe('AVERAGE_BLOCK_TIME_SECONDS', () => {
  describe('when used to estimate the time behind real-time', () => {
    it('should use ~1.75s per block for Polygon', () => {
      expect(AVERAGE_BLOCK_TIME_SECONDS[Network.MATIC]).toBe(1.75)
    })

    it('should use 12s per block for Ethereum', () => {
      expect(AVERAGE_BLOCK_TIME_SECONDS[Network.ETHEREUM]).toBe(12)
    })
  })
})
