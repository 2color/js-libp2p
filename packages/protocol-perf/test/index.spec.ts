/* eslint-env mocha */

import { start, stop } from '@libp2p/interface/startable'
import { streamPair } from '@libp2p/interface-compliance-tests/mocks'
import { defaultLogger } from '@libp2p/logger'
import { multiaddr } from '@multiformats/multiaddr'
import { expect } from 'aegir/chai'
import last from 'it-last'
import { duplexPair } from 'it-pair/duplex'
import { stubInterface, type StubbedInstance } from 'sinon-ts'
import { Perf } from '../src/perf-service.js'
import type { ComponentLogger } from '@libp2p/interface'
import type { Connection } from '@libp2p/interface/connection'
import type { ConnectionManager } from '@libp2p/interface-internal/connection-manager'
import type { Registrar } from '@libp2p/interface-internal/registrar'

interface StubbedPerfComponents {
  registrar: StubbedInstance<Registrar>
  connectionManager: StubbedInstance<ConnectionManager>
  logger: ComponentLogger
}

export function createComponents (): StubbedPerfComponents {
  return {
    registrar: stubInterface<Registrar>(),
    connectionManager: stubInterface<ConnectionManager>(),
    logger: defaultLogger()
  }
}

describe('perf', () => {
  let localComponents: StubbedPerfComponents
  let remoteComponents: StubbedPerfComponents

  beforeEach(async () => {
    localComponents = createComponents()
    remoteComponents = createComponents()

    await Promise.all([
      start(localComponents),
      start(remoteComponents)
    ])
  })

  afterEach(async () => {
    await Promise.all([
      stop(localComponents),
      stop(remoteComponents)
    ])
  })

  it('should run perf', async () => {
    const client = new Perf(localComponents)
    const server = new Perf(remoteComponents)

    await start(client)
    await start(server)

    // simulate connection between nodes
    const ma = multiaddr('/ip4/0.0.0.0')
    const duplexes = duplexPair<any>()
    const streams = streamPair({ duplex: duplexes[0] }, { duplex: duplexes[1] })

    const aToB = stubInterface<Connection>()
    aToB.newStream.resolves(streams[0])
    localComponents.connectionManager.openConnection.withArgs(ma, {
      force: true
    }).resolves(aToB)
    localComponents.connectionManager.getConnections.returns([])

    const bToA = stubInterface<Connection>()
    void server.handleMessage({ stream: streams[1], connection: bToA })

    // Run Perf
    const finalResult = await last(client.measurePerformance(ma, 1024, 1024))

    expect(finalResult).to.have.property('type', 'final')
    expect(finalResult).to.have.property('uploadBytes', 1024)

    expect(localComponents.connectionManager.openConnection.getCall(0).args[1]?.force).to.be.true('did not open new connection')
  })

  it('should reuse existing connection', async () => {
    const client = new Perf(localComponents)
    const server = new Perf(remoteComponents)

    await start(client)
    await start(server)

    // simulate connection between nodes
    const ma = multiaddr('/ip4/0.0.0.0')
    const duplexes = duplexPair<any>()
    const streams = streamPair({ duplex: duplexes[0] }, { duplex: duplexes[1] })

    const aToB = stubInterface<Connection>()
    aToB.newStream.resolves(streams[0])
    localComponents.connectionManager.openConnection.resolves(aToB)
    localComponents.connectionManager.getConnections.returns([])

    const bToA = stubInterface<Connection>()
    void server.handleMessage({ stream: streams[1], connection: bToA })

    // Run Perf
    const finalResult = await last(client.measurePerformance(ma, 1024, 1024, {
      reuseExistingConnection: true
    }))

    expect(finalResult).to.have.property('type', 'final')
    expect(finalResult).to.have.property('uploadBytes', 1024)

    expect(localComponents.connectionManager.openConnection.getCall(0).args[1]?.force).to.be.false('did not reuse existing connection')
  })
})
