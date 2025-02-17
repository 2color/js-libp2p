/* eslint-env mocha */

import { ERR_INVALID_PARAMETERS } from '@libp2p/interface/errors'
import { start, stop } from '@libp2p/interface/startable'
import { defaultLogger } from '@libp2p/logger'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { expect } from 'aegir/chai'
import { duplexPair } from 'it-pair/duplex'
import { pbStream } from 'it-protobuf-stream'
import sinon from 'sinon'
import { stubInterface, type StubbedInstance } from 'sinon-ts'
import { Fetch } from '../src/fetch.js'
import { FetchRequest, FetchResponse } from '../src/pb/proto.js'
import type { ComponentLogger } from '@libp2p/interface'
import type { Connection, Stream } from '@libp2p/interface/connection'
import type { PeerId } from '@libp2p/interface/peer-id'
import type { ConnectionManager } from '@libp2p/interface-internal/connection-manager'
import type { Registrar } from '@libp2p/interface-internal/registrar'

interface StubbedFetchComponents {
  registrar: StubbedInstance<Registrar>
  connectionManager: StubbedInstance<ConnectionManager>
  logger: ComponentLogger
}

async function createComponents (): Promise<StubbedFetchComponents> {
  return {
    registrar: stubInterface<Registrar>(),
    connectionManager: stubInterface<ConnectionManager>(),
    logger: defaultLogger()
  }
}

function createStreams (components: StubbedFetchComponents, remotePeer?: PeerId): { incomingStream: StubbedInstance<Stream>, outgoingStream: StubbedInstance<Stream>, connection: StubbedInstance<Connection> } {
  const duplex = duplexPair<any>()
  const outgoingStream = stubInterface<Stream>()
  outgoingStream.source = duplex[0].source
  outgoingStream.sink.callsFake(async source => duplex[0].sink(source))

  const incomingStream = stubInterface<Stream>()
  incomingStream.source = duplex[1].source
  incomingStream.sink.callsFake(async source => duplex[1].sink(source))

  const connection = stubInterface<Connection>()

  if (remotePeer != null) {
    connection.newStream.withArgs('/libp2p/fetch/0.0.1').resolves(outgoingStream)
    components.connectionManager.openConnection.withArgs(remotePeer).resolves(connection)
  }

  return {
    incomingStream,
    outgoingStream,
    connection
  }
}

describe('fetch', () => {
  let components: StubbedFetchComponents
  let fetch: Fetch

  beforeEach(async () => {
    components = await createComponents()
    fetch = new Fetch(components)
  })

  afterEach(async () => {
    sinon.restore()

    await stop(fetch)
  })

  it('should register for fetch protocol on startup', async () => {
    await start(fetch)

    expect(components.registrar.handle.called).to.be.true('handle was not called')
    expect(components.registrar.handle.getCall(0).args[0]).to.equal('/libp2p/fetch/0.0.1')
  })

  describe('outgoing', () => {
    it('should be able to fetch from another peer', async () => {
      const remotePeer = await createEd25519PeerId()
      const key = 'key'
      const value = Uint8Array.from([0, 1, 2, 3, 4])

      const {
        incomingStream
      } = createStreams(components, remotePeer)

      const result = fetch.fetch(remotePeer, key)

      const pb = pbStream(incomingStream)
      const request = await pb.read(FetchRequest)

      expect(request.identifier).to.equal(key)

      await pb.write({
        status: FetchResponse.StatusCode.OK,
        data: value
      }, FetchResponse)

      await expect(result).to.eventually.deep.equal(value)
    })

    it('should be handle NOT_FOUND from the other peer', async () => {
      const remotePeer = await createEd25519PeerId()
      const key = 'key'

      const {
        incomingStream
      } = createStreams(components, remotePeer)

      const result = fetch.fetch(remotePeer, key)

      const pb = pbStream(incomingStream)
      const request = await pb.read(FetchRequest)

      expect(request.identifier).to.equal(key)

      await pb.write({
        status: FetchResponse.StatusCode.NOT_FOUND
      }, FetchResponse)

      await expect(result).to.eventually.be.undefined()
    })

    it('should be handle ERROR from the other peer', async () => {
      const remotePeer = await createEd25519PeerId()
      const key = 'key'

      const {
        incomingStream
      } = createStreams(components, remotePeer)

      const result = fetch.fetch(remotePeer, key)

      const pb = pbStream(incomingStream)
      const request = await pb.read(FetchRequest)

      expect(request.identifier).to.equal(key)

      await pb.write({
        status: FetchResponse.StatusCode.ERROR
      }, FetchResponse)

      await expect(result).to.eventually.be.rejected
        .with.property('code', ERR_INVALID_PARAMETERS)
    })

    it('should time out fetching from another peer when waiting for the record', async () => {
      const remotePeer = await createEd25519PeerId()
      const key = 'key'

      const {
        outgoingStream
      } = createStreams(components, remotePeer)

      outgoingStream.abort.callsFake((err) => {
        void outgoingStream.source.throw(err)
      })

      await expect(fetch.fetch(remotePeer, key, {
        signal: AbortSignal.timeout(10)
      })).to.eventually.be.rejected
        .with.property('code', 'ABORT_ERR')

      expect(outgoingStream.abort.called).to.be.true()
    })
  })

  describe('incoming', () => {
    it('should be able to send to another peer', async () => {
      const key = '/test/key'
      const value = Uint8Array.from([0, 1, 2, 3, 4])

      const {
        incomingStream,
        outgoingStream,
        connection
      } = createStreams(components)

      fetch.registerLookupFunction('/test', async (k) => {
        expect(k).to.equal(key)
        return value
      })

      void fetch.handleMessage({
        stream: incomingStream,
        connection
      })

      const pb = pbStream(outgoingStream)

      await pb.write({
        identifier: key
      }, FetchRequest)

      const response = await pb.read(FetchResponse)
      expect(response.status).to.equal(FetchResponse.StatusCode.OK)
      expect(response.data).to.equalBytes(value)
    })

    it('should handle not having the requested data', async () => {
      const key = '/test/key'

      const {
        incomingStream,
        outgoingStream,
        connection
      } = createStreams(components)

      fetch.registerLookupFunction('/test', async (k) => {
        return undefined
      })

      void fetch.handleMessage({
        stream: incomingStream,
        connection
      })

      const pb = pbStream(outgoingStream)

      await pb.write({
        identifier: key
      }, FetchRequest)

      const response = await pb.read(FetchResponse)
      expect(response.status).to.equal(FetchResponse.StatusCode.NOT_FOUND)
    })

    it('should handle not having a handler for the key', async () => {
      const key = '/test/key'

      const {
        incomingStream,
        outgoingStream,
        connection
      } = createStreams(components)

      void fetch.handleMessage({
        stream: incomingStream,
        connection
      })

      const pb = pbStream(outgoingStream)

      await pb.write({
        identifier: key
      }, FetchRequest)

      const response = await pb.read(FetchResponse)
      expect(response.status).to.equal(FetchResponse.StatusCode.ERROR)
    })

    it('should time out sending data to another peer waiting for the request', async () => {
      fetch = new Fetch(components, {
        timeout: 10
      })

      const {
        incomingStream,
        connection
      } = createStreams(components)

      await fetch.handleMessage({
        stream: incomingStream,
        connection
      })

      expect(incomingStream.abort.called).to.be.true()
      expect(incomingStream.abort.getCall(0).args[0]).to.have.property('code', 'ABORT_ERR')
    })
  })
})
