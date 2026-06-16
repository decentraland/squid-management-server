import { computeSyncProgress } from '../../src/ports/squids/utils'

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
