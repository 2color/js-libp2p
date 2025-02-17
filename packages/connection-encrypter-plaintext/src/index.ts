/**
 * @packageDocumentation
 *
 * A connection encrypter that does no connection encryption.
 *
 * This should not be used in production should be used for research purposes only.
 *
 * @example
 *
 * ```typescript
 * import { createLibp2p } from 'libp2p'
 * import { plaintext } from '@libp2p/plaintext'
 *
 * const node = await createLibp2p({
 *   // ...other options
 *   connectionEncryption: [
 *     plaintext()
 *   ]
 * })
 * ```
 */

import { UnexpectedPeerError, InvalidCryptoExchangeError } from '@libp2p/interface/errors'
import { peerIdFromBytes, peerIdFromKeys } from '@libp2p/peer-id'
import { handshake } from 'it-handshake'
import * as lp from 'it-length-prefixed'
import map from 'it-map'
import { Exchange, KeyType } from './pb/proto.js'
import type { ComponentLogger, Logger } from '@libp2p/interface'
import type { ConnectionEncrypter, SecuredConnection } from '@libp2p/interface/connection-encrypter'
import type { PeerId } from '@libp2p/interface/peer-id'
import type { Duplex, Source } from 'it-stream-types'
import type { Uint8ArrayList } from 'uint8arraylist'

const PROTOCOL = '/plaintext/2.0.0'

function lpEncodeExchange (exchange: Exchange): Uint8ArrayList {
  const pb = Exchange.encode(exchange)

  return lp.encode.single(pb)
}

export interface PlaintextComponents {
  logger: ComponentLogger
}

class Plaintext implements ConnectionEncrypter {
  public protocol: string = PROTOCOL
  private readonly log: Logger

  constructor (components: PlaintextComponents) {
    this.log = components.logger.forComponent('libp2p:plaintext')
  }

  async secureInbound (localId: PeerId, conn: Duplex<AsyncGenerator<Uint8Array>, Source<Uint8Array>, Promise<void>>, remoteId?: PeerId): Promise<SecuredConnection> {
    return this._encrypt(localId, conn, remoteId)
  }

  async secureOutbound (localId: PeerId, conn: Duplex<AsyncGenerator<Uint8Array>, Source<Uint8Array>, Promise<void>>, remoteId?: PeerId): Promise<SecuredConnection> {
    return this._encrypt(localId, conn, remoteId)
  }

  /**
   * Encrypt connection
   */
  async _encrypt (localId: PeerId, conn: Duplex<AsyncGenerator<Uint8Array>, Source<Uint8Array>, Promise<void>>, remoteId?: PeerId): Promise<SecuredConnection> {
    const shake = handshake(conn)

    let type = KeyType.RSA

    if (localId.type === 'Ed25519') {
      type = KeyType.Ed25519
    } else if (localId.type === 'secp256k1') {
      type = KeyType.Secp256k1
    }

    // Encode the public key and write it to the remote peer
    shake.write(
      lpEncodeExchange({
        id: localId.toBytes(),
        pubkey: {
          Type: type,
          Data: localId.publicKey ?? new Uint8Array(0)
        }
      }).subarray()
    )

    this.log('write pubkey exchange to peer %p', remoteId)

    // Get the Exchange message
    const response = (await lp.decode.fromReader(shake.reader).next()).value

    if (response == null) {
      throw new Error('Did not read response')
    }

    const id = Exchange.decode(response)
    this.log('read pubkey exchange from peer %p', remoteId)

    let peerId
    try {
      if (id.pubkey == null) {
        throw new Error('Public key missing')
      }

      if (id.pubkey.Data.length === 0) {
        throw new Error('Public key data too short')
      }

      if (id.id == null) {
        throw new Error('Remote id missing')
      }

      peerId = await peerIdFromKeys(id.pubkey.Data)

      if (!peerId.equals(peerIdFromBytes(id.id))) {
        throw new Error('Public key did not match id')
      }
    } catch (err: any) {
      this.log.error(err)
      throw new InvalidCryptoExchangeError('Remote did not provide its public key')
    }

    if (remoteId != null && !peerId.equals(remoteId)) {
      throw new UnexpectedPeerError()
    }

    this.log('plaintext key exchange completed successfully with peer %p', peerId)

    shake.rest()

    return {
      conn: {
        sink: shake.stream.sink,
        source: map(shake.stream.source, (buf) => buf.subarray())
      },
      remotePeer: peerId
    }
  }
}

export function plaintext (): (components: PlaintextComponents) => ConnectionEncrypter {
  return (components) => new Plaintext(components)
}
