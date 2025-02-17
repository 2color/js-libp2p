/* eslint-env mocha */

import { TypedEventEmitter } from '@libp2p/interface/events'
import { mockUpgrader } from '@libp2p/interface-compliance-tests/mocks'
import { defaultLogger } from '@libp2p/logger'
import { multiaddr } from '@multiformats/multiaddr'
import { expect } from 'aegir/chai'
import all from 'it-all'
import { pipe } from 'it-pipe'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { isBrowser, isWebWorker } from 'wherearewe'
import { webSockets } from '../src/index.js'
import type { Connection } from '@libp2p/interface/connection'
import type { Transport } from '@libp2p/interface/transport'

const protocol = '/echo/1.0.0'

describe('libp2p-websockets', () => {
  const ma = multiaddr('/ip4/127.0.0.1/tcp/9095/ws')
  let ws: Transport
  let conn: Connection

  beforeEach(async () => {
    ws = webSockets()({
      logger: defaultLogger()
    })
    conn = await ws.dial(ma, {
      upgrader: mockUpgrader({
        events: new TypedEventEmitter()
      })
    })
  })

  afterEach(async () => {
    await conn.close()
  })

  it('echo', async () => {
    const data = uint8ArrayFromString('hey')
    const stream = await conn.newStream([protocol])

    const res = await pipe(
      [data],
      stream,
      async (source) => all(source)
    )

    expect(res[0].subarray()).to.equalBytes(data)
  })

  it('should filter out no wss websocket addresses', function () {
    const ma1 = multiaddr('/ip4/127.0.0.1/tcp/80/ws')
    const ma2 = multiaddr('/ip4/127.0.0.1/tcp/443/wss')
    const ma3 = multiaddr('/ip6/::1/tcp/80/ws')
    const ma4 = multiaddr('/ip6/::1/tcp/443/wss')

    const valid = ws.filter([ma1, ma2, ma3, ma4])

    if (isBrowser || isWebWorker) {
      expect(valid.length).to.equal(2)
      expect(valid).to.deep.equal([ma2, ma4])
    } else {
      expect(valid.length).to.equal(4)
    }
  })

  describe('stress', () => {
    it('one big write', async () => {
      const data = new Uint8Array(1000000).fill(5)
      const stream = await conn.newStream([protocol])

      const res = await pipe(
        [data],
        stream,
        async (source) => all(source)
      )

      expect(res[0].subarray()).to.deep.equal(data)
    })

    it('many writes', async function () {
      this.timeout(60000)

      const count = 20000
      const data = Array(count).fill(0).map(() => uint8ArrayFromString(Math.random().toString()))
      const stream = await conn.newStream([protocol])

      const res = await pipe(
        data,
        stream,
        async (source) => all(source)
      )

      expect(res.map(list => list.subarray())).to.deep.equal(data)
    })
  })

  it('.createServer throws in browser', () => {
    expect(webSockets()({
      logger: defaultLogger()
    }).createListener).to.throw()
  })
})
