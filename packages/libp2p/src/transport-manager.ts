import { CodeError } from '@libp2p/interface/errors'
import { trackedMap } from '@libp2p/interface/metrics/tracked-map'
import { FaultTolerance } from '@libp2p/interface/transport'
import { codes } from './errors.js'
import type { Libp2pEvents, AbortOptions, ComponentLogger, Logger } from '@libp2p/interface'
import type { Connection } from '@libp2p/interface/connection'
import type { TypedEventTarget } from '@libp2p/interface/events'
import type { Metrics } from '@libp2p/interface/metrics'
import type { Startable } from '@libp2p/interface/startable'
import type { Listener, Transport, Upgrader } from '@libp2p/interface/transport'
import type { AddressManager } from '@libp2p/interface-internal/address-manager'
import type { TransportManager } from '@libp2p/interface-internal/transport-manager'
import type { Multiaddr } from '@multiformats/multiaddr'

export interface TransportManagerInit {
  faultTolerance?: FaultTolerance
}

export interface DefaultTransportManagerComponents {
  metrics?: Metrics
  addressManager: AddressManager
  upgrader: Upgrader
  events: TypedEventTarget<Libp2pEvents>
  logger: ComponentLogger
}

export class DefaultTransportManager implements TransportManager, Startable {
  private readonly log: Logger
  private readonly components: DefaultTransportManagerComponents
  private readonly transports: Map<string, Transport>
  private readonly listeners: Map<string, Listener[]>
  private readonly faultTolerance: FaultTolerance
  private started: boolean

  constructor (components: DefaultTransportManagerComponents, init: TransportManagerInit = {}) {
    this.log = components.logger.forComponent('libp2p:transports')
    this.components = components
    this.started = false
    this.transports = new Map<string, Transport>()
    this.listeners = trackedMap({
      name: 'libp2p_transport_manager_listeners',
      metrics: this.components.metrics
    })
    this.faultTolerance = init.faultTolerance ?? FaultTolerance.FATAL_ALL
  }

  /**
   * Adds a `Transport` to the manager
   */
  add (transport: Transport): void {
    const tag = transport[Symbol.toStringTag]

    if (tag == null) {
      throw new CodeError('Transport must have a valid tag', codes.ERR_INVALID_KEY)
    }

    if (this.transports.has(tag)) {
      throw new CodeError(`There is already a transport with the tag ${tag}`, codes.ERR_DUPLICATE_TRANSPORT)
    }

    this.log('adding transport %s', tag)

    this.transports.set(tag, transport)

    if (!this.listeners.has(tag)) {
      this.listeners.set(tag, [])
    }
  }

  isStarted (): boolean {
    return this.started
  }

  start (): void {
    this.started = true
  }

  async afterStart (): Promise<void> {
    // Listen on the provided transports for the provided addresses
    const addrs = this.components.addressManager.getListenAddrs()

    await this.listen(addrs)
  }

  /**
   * Stops all listeners
   */
  async stop (): Promise<void> {
    const tasks = []
    for (const [key, listeners] of this.listeners) {
      this.log('closing listeners for %s', key)
      while (listeners.length > 0) {
        const listener = listeners.pop()

        if (listener == null) {
          continue
        }

        tasks.push(listener.close())
      }
    }

    await Promise.all(tasks)
    this.log('all listeners closed')
    for (const key of this.listeners.keys()) {
      this.listeners.set(key, [])
    }

    this.started = false
  }

  /**
   * Dials the given Multiaddr over it's supported transport
   */
  async dial (ma: Multiaddr, options?: AbortOptions): Promise<Connection> {
    const transport = this.transportForMultiaddr(ma)

    if (transport == null) {
      throw new CodeError(`No transport available for address ${String(ma)}`, codes.ERR_TRANSPORT_UNAVAILABLE)
    }

    try {
      return await transport.dial(ma, {
        ...options,
        upgrader: this.components.upgrader
      })
    } catch (err: any) {
      if (err.code == null) {
        err.code = codes.ERR_TRANSPORT_DIAL_FAILED
      }

      throw err
    }
  }

  /**
   * Returns all Multiaddr's the listeners are using
   */
  getAddrs (): Multiaddr[] {
    let addrs: Multiaddr[] = []
    for (const listeners of this.listeners.values()) {
      for (const listener of listeners) {
        addrs = [...addrs, ...listener.getAddrs()]
      }
    }
    return addrs
  }

  /**
   * Returns all the transports instances
   */
  getTransports (): Transport[] {
    return Array.of(...this.transports.values())
  }

  /**
   * Returns all the listener instances
   */
  getListeners (): Listener[] {
    return Array.of(...this.listeners.values()).flat()
  }

  /**
   * Finds a transport that matches the given Multiaddr
   */
  transportForMultiaddr (ma: Multiaddr): Transport | undefined {
    for (const transport of this.transports.values()) {
      const addrs = transport.filter([ma])

      if (addrs.length > 0) {
        return transport
      }
    }
  }

  /**
   * Starts listeners for each listen Multiaddr
   */
  async listen (addrs: Multiaddr[]): Promise<void> {
    if (!this.isStarted()) {
      throw new CodeError('Not started', codes.ERR_NODE_NOT_STARTED)
    }

    if (addrs == null || addrs.length === 0) {
      this.log('no addresses were provided for listening, this node is dial only')
      return
    }

    const couldNotListen = []

    for (const [key, transport] of this.transports.entries()) {
      const supportedAddrs = transport.filter(addrs)
      const tasks = []

      // For each supported multiaddr, create a listener
      for (const addr of supportedAddrs) {
        this.log('creating listener for %s on %a', key, addr)
        const listener = transport.createListener({
          upgrader: this.components.upgrader
        })

        let listeners: Listener[] = this.listeners.get(key) ?? []

        if (listeners == null) {
          listeners = []
          this.listeners.set(key, listeners)
        }

        listeners.push(listener)

        // Track listen/close events
        listener.addEventListener('listening', () => {
          this.components.events.safeDispatchEvent('transport:listening', {
            detail: listener
          })
        })
        listener.addEventListener('close', () => {
          const index = listeners.findIndex(l => l === listener)

          // remove the listener
          listeners.splice(index, 1)

          this.components.events.safeDispatchEvent('transport:close', {
            detail: listener
          })
        })

        // We need to attempt to listen on everything
        tasks.push(listener.listen(addr))
      }

      // Keep track of transports we had no addresses for
      if (tasks.length === 0) {
        couldNotListen.push(key)
        continue
      }

      const results = await Promise.allSettled(tasks)
      // If we are listening on at least 1 address, succeed.
      // TODO: we should look at adding a retry (`p-retry`) here to better support
      // listening on remote addresses as they may be offline. We could then potentially
      // just wait for any (`p-any`) listener to succeed on each transport before returning
      const isListening = results.find(r => r.status === 'fulfilled')
      if ((isListening == null) && this.faultTolerance !== FaultTolerance.NO_FATAL) {
        throw new CodeError(`Transport (${key}) could not listen on any available address`, codes.ERR_NO_VALID_ADDRESSES)
      }
    }

    // If no transports were able to listen, throw an error. This likely
    // means we were given addresses we do not have transports for
    if (couldNotListen.length === this.transports.size) {
      const message = `no valid addresses were provided for transports [${couldNotListen.join(', ')}]`
      if (this.faultTolerance === FaultTolerance.FATAL_ALL) {
        throw new CodeError(message, codes.ERR_NO_VALID_ADDRESSES)
      }
      this.log(`libp2p in dial mode only: ${message}`)
    }
  }

  /**
   * Removes the given transport from the manager.
   * If a transport has any running listeners, they will be closed.
   */
  async remove (key: string): Promise<void> {
    const listeners = this.listeners.get(key) ?? []
    this.log.trace('removing transport %s', key)

    // Close any running listeners
    const tasks = []
    this.log.trace('closing listeners for %s', key)
    while (listeners.length > 0) {
      const listener = listeners.pop()

      if (listener == null) {
        continue
      }

      tasks.push(listener.close())
    }
    await Promise.all(tasks)

    this.transports.delete(key)
    this.listeners.delete(key)
  }

  /**
   * Removes all transports from the manager.
   * If any listeners are running, they will be closed.
   *
   * @async
   */
  async removeAll (): Promise<void> {
    const tasks = []
    for (const key of this.transports.keys()) {
      tasks.push(this.remove(key))
    }

    await Promise.all(tasks)
  }
}
