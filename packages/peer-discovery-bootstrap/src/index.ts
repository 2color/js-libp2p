/**
 * @packageDocumentation
 *
 * The configured bootstrap peers will be discovered after the configured timeout. This will ensure there are some peers in the peer store for the node to use to discover other peers.
 *
 * They will be tagged with a tag with the name `'bootstrap'` tag, the value `50` and it will expire after two minutes which means the nodes connections may be closed if the maximum number of connections is reached.
 *
 * Clients that need constant connections to bootstrap nodes (e.g. browsers) can set the TTL to `Infinity`.
 *
 * ```JavaScript
 * import { createLibp2p } from 'libp2p'
 * import { bootstrap } from '@libp2p/bootstrap'
 * import { tcp } from 'libp2p/tcp'
 * import { noise } from '@libp2p/noise'
 * import { mplex } from '@libp2p/mplex'
 *
 * let options = {
 *   transports: [
 *     tcp()
 *   ],
 *   streamMuxers: [
 *     mplex()
 *   ],
 *   connectionEncryption: [
 *     noise()
 *   ],
 *   peerDiscovery: [
 *     bootstrap({
 *       list: [ // a list of bootstrap peer multiaddrs to connect to on node startup
 *         "/ip4/104.131.131.82/tcp/4001/ipfs/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
 *         "/dnsaddr/bootstrap.libp2p.io/ipfs/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
 *         "/dnsaddr/bootstrap.libp2p.io/ipfs/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa"
 *       ],
 *       timeout: 1000, // in ms,
 *       tagName: 'bootstrap',
 *       tagValue: 50,
 *       tagTTL: 120000 // in ms
 *     })
 *   ]
 * }
 *
 * const libp2p = await createLibp2p(options)
 *
 * libp2p.on('peer:discovery', function (peerId) {
 *   console.this.log('found peer: ', peerId.toB58String())
 * })
 * ```
 */

import { TypedEventEmitter } from '@libp2p/interface/events'
import { peerDiscovery } from '@libp2p/interface/peer-discovery'
import { peerIdFromString } from '@libp2p/peer-id'
import { P2P } from '@multiformats/mafmt'
import { multiaddr } from '@multiformats/multiaddr'
import type { ComponentLogger, Logger } from '@libp2p/interface'
import type { PeerDiscovery, PeerDiscoveryEvents } from '@libp2p/interface/peer-discovery'
import type { PeerInfo } from '@libp2p/interface/peer-info'
import type { PeerStore } from '@libp2p/interface/peer-store'
import type { Startable } from '@libp2p/interface/startable'

const DEFAULT_BOOTSTRAP_TAG_NAME = 'bootstrap'
const DEFAULT_BOOTSTRAP_TAG_VALUE = 50
const DEFAULT_BOOTSTRAP_TAG_TTL = 120000
const DEFAULT_BOOTSTRAP_DISCOVERY_TIMEOUT = 1000

export interface BootstrapInit {
  /**
   * The list of peer addresses in multi-address format
   */
  list: string[]

  /**
   * How long to wait before discovering bootstrap nodes
   */
  timeout?: number

  /**
   * Tag a bootstrap peer with this name before "discovering" it (default: 'bootstrap')
   */
  tagName?: string

  /**
   * The bootstrap peer tag will have this value (default: 50)
   */
  tagValue?: number

  /**
   * Cause the bootstrap peer tag to be removed after this number of ms (default: 2 minutes)
   */
  tagTTL?: number
}

export interface BootstrapComponents {
  peerStore: PeerStore
  logger: ComponentLogger
}

/**
 * Emits 'peer' events on a regular interval for each peer in the provided list.
 */
class Bootstrap extends TypedEventEmitter<PeerDiscoveryEvents> implements PeerDiscovery, Startable {
  static tag = 'bootstrap'

  private readonly log: Logger
  private timer?: ReturnType<typeof setTimeout>
  private readonly list: PeerInfo[]
  private readonly timeout: number
  private readonly components: BootstrapComponents
  private readonly _init: BootstrapInit

  constructor (components: BootstrapComponents, options: BootstrapInit = { list: [] }) {
    if (options.list == null || options.list.length === 0) {
      throw new Error('Bootstrap requires a list of peer addresses')
    }
    super()

    this.components = components
    this.log = components.logger.forComponent('libp2p:bootstrap')
    this.timeout = options.timeout ?? DEFAULT_BOOTSTRAP_DISCOVERY_TIMEOUT
    this.list = []

    for (const candidate of options.list) {
      if (!P2P.matches(candidate)) {
        this.log.error('Invalid multiaddr')
        continue
      }

      const ma = multiaddr(candidate)
      const peerIdStr = ma.getPeerId()

      if (peerIdStr == null) {
        this.log.error('Invalid bootstrap multiaddr without peer id')
        continue
      }

      const peerData: PeerInfo = {
        id: peerIdFromString(peerIdStr),
        multiaddrs: [ma]
      }

      this.list.push(peerData)
    }

    this._init = options
  }

  readonly [peerDiscovery] = this

  readonly [Symbol.toStringTag] = '@libp2p/bootstrap'

  isStarted (): boolean {
    return Boolean(this.timer)
  }

  /**
   * Start emitting events
   */
  start (): void {
    if (this.isStarted()) {
      return
    }

    this.log('Starting bootstrap node discovery, discovering peers after %s ms', this.timeout)
    this.timer = setTimeout(() => {
      void this._discoverBootstrapPeers()
        .catch(err => {
          this.log.error(err)
        })
    }, this.timeout)
  }

  /**
   * Emit each address in the list as a PeerInfo
   */
  async _discoverBootstrapPeers (): Promise<void> {
    if (this.timer == null) {
      return
    }

    for (const peerData of this.list) {
      await this.components.peerStore.merge(peerData.id, {
        tags: {
          [this._init.tagName ?? DEFAULT_BOOTSTRAP_TAG_NAME]: {
            value: this._init.tagValue ?? DEFAULT_BOOTSTRAP_TAG_VALUE,
            ttl: this._init.tagTTL ?? DEFAULT_BOOTSTRAP_TAG_TTL
          }
        }
      })

      // check we are still running
      if (this.timer == null) {
        return
      }

      this.safeDispatchEvent('peer', { detail: peerData })
    }
  }

  /**
   * Stop emitting events
   */
  stop (): void {
    if (this.timer != null) {
      clearTimeout(this.timer)
    }

    this.timer = undefined
  }
}

export function bootstrap (init: BootstrapInit): (components: BootstrapComponents) => PeerDiscovery {
  return (components: BootstrapComponents) => new Bootstrap(components, init)
}
