import { CodeError } from '@libp2p/interface/errors'
import { isPeerId, type PeerId } from '@libp2p/interface/peer-id'
import { PeerMap } from '@libp2p/peer-collections'
import { peerIdFromString } from '@libp2p/peer-id'
import { isMultiaddr, type Multiaddr } from '@multiformats/multiaddr'
import { connectionPair } from './connection.js'
import type { ComponentLogger, Libp2pEvents, PendingDial } from '@libp2p/interface'
import type { Connection } from '@libp2p/interface/connection'
import type { TypedEventTarget } from '@libp2p/interface/events'
import type { PubSub } from '@libp2p/interface/pubsub'
import type { Startable } from '@libp2p/interface/startable'
import type { ConnectionManager } from '@libp2p/interface-internal/connection-manager'
import type { Registrar } from '@libp2p/interface-internal/registrar'

export interface MockNetworkComponents {
  peerId: PeerId
  registrar: Registrar
  connectionManager: ConnectionManager
  events: TypedEventTarget<Libp2pEvents>
  pubsub?: PubSub
  logger: ComponentLogger
}

class MockNetwork {
  private components: MockNetworkComponents[] = []

  addNode (components: MockNetworkComponents): void {
    this.components.push(components)
  }

  getNode (peerId: PeerId | Multiaddr []): MockNetworkComponents {
    if (Array.isArray(peerId) && peerId.length > 0) {
      peerId = peerIdFromString(peerId[0].getPeerId() ?? '')
    } else if (isPeerId(peerId)) {
      for (const components of this.components) {
        if (peerId.equals(components.peerId)) {
          return components
        }
      }
    }

    throw new CodeError('Peer not found', 'ERR_PEER_NOT_FOUND')
  }

  reset (): void {
    this.components = []
  }
}

export const mockNetwork = new MockNetwork()

export interface MockConnectionManagerComponents {
  peerId: PeerId
  registrar: Registrar
  events: TypedEventTarget<Libp2pEvents>
}

class MockConnectionManager implements ConnectionManager, Startable {
  private connections: Connection[] = []
  private readonly components: MockConnectionManagerComponents
  private started = false

  constructor (components: MockConnectionManagerComponents) {
    this.components = components
  }

  isStarted (): boolean {
    return this.started
  }

  async start (): Promise<void> {
    this.started = true
  }

  async stop (): Promise<void> {
    for (const connection of this.connections) {
      await this.closeConnections(connection.remotePeer)
    }

    this.started = false
  }

  getConnections (peerId?: PeerId): Connection[] {
    if (peerId != null) {
      return this.connections
        .filter(c => c.remotePeer.toString() === peerId.toString())
    }

    return this.connections
  }

  getConnectionsMap (): PeerMap<Connection[]> {
    const map = new PeerMap<Connection[]>()

    for (const conn of this.connections) {
      const conns: Connection[] = map.get(conn.remotePeer) ?? []
      conns.push(conn)

      map.set(conn.remotePeer, conns)
    }

    return map
  }

  async openConnection (peerId: PeerId | Multiaddr | Multiaddr[]): Promise<Connection> {
    if (this.components == null) {
      throw new CodeError('Not initialized', 'ERR_NOT_INITIALIZED')
    }

    if (isMultiaddr(peerId)) {
      throw new CodeError('Dialing multiaddrs not supported', 'ERR_NOT_SUPPORTED')
    }

    let existingConnections: Connection[] = []

    if (Array.isArray(peerId) && peerId.length > 0) {
      existingConnections = this.getConnections(peerIdFromString(peerId[0].getPeerId() ?? ''))
    } else if (isPeerId(peerId)) {
      existingConnections = this.getConnections(peerId)
    }

    if (existingConnections.length > 0) {
      return existingConnections[0]
    }

    const componentsB = mockNetwork.getNode(peerId)

    const [aToB, bToA] = connectionPair(this.components, componentsB)

    // track connections
    this.connections.push(aToB)
    ;(componentsB.connectionManager as MockConnectionManager).connections.push(bToA)

    this.components.events.safeDispatchEvent('connection:open', {
      detail: aToB
    })

    for (const protocol of this.components.registrar.getProtocols()) {
      for (const topology of this.components.registrar.getTopologies(protocol)) {
        topology.onConnect?.(componentsB.peerId, aToB)
      }
    }

    this.components.events.safeDispatchEvent('peer:connect', { detail: componentsB.peerId })

    componentsB.events.safeDispatchEvent('connection:open', {
      detail: bToA
    })

    for (const protocol of componentsB.registrar.getProtocols()) {
      for (const topology of componentsB.registrar.getTopologies(protocol)) {
        topology.onConnect?.(this.components.peerId, bToA)
      }
    }

    componentsB.events.safeDispatchEvent('peer:connect', { detail: this.components.peerId })

    return aToB
  }

  async closeConnections (peerId: PeerId): Promise<void> {
    if (this.components == null) {
      throw new CodeError('Not initialized', 'ERR_NOT_INITIALIZED')
    }

    const connections = this.getConnections(peerId)

    if (connections.length === 0) {
      return
    }

    const componentsB = mockNetwork.getNode(peerId)

    for (const protocol of this.components.registrar.getProtocols()) {
      this.components.registrar.getTopologies(protocol).forEach(topology => {
        topology.onDisconnect?.(componentsB.peerId)
      })
    }

    for (const conn of connections) {
      await conn.close()
    }

    this.connections = this.connections.filter(c => !c.remotePeer.equals(peerId))

    if (this.connections.filter(c => !c.remotePeer.equals(peerId)).length === 0) {
      componentsB.events.safeDispatchEvent('peer:disconnect', { detail: peerId })
    }

    await componentsB.connectionManager?.closeConnections(this.components.peerId)

    if (componentsB.connectionManager?.getConnectionsMap().get(this.components.peerId) == null) {
      componentsB.events.safeDispatchEvent('peer:disconnect', { detail: this.components.peerId })
    }
  }

  async acceptIncomingConnection (): Promise<boolean> {
    return true
  }

  afterUpgradeInbound (): void {

  }

  getDialQueue (): PendingDial[] {
    return []
  }
}

export function mockConnectionManager (components: MockConnectionManagerComponents): ConnectionManager {
  return new MockConnectionManager(components)
}
